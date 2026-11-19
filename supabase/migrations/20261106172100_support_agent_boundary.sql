-- Dedicated support authority. This release does not enable the help entry.
DO $roles$
BEGIN
  IF current_user <> 'postgres' THEN RAISE EXCEPTION 'Apply as postgres'; END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gugu_support_data') THEN
    CREATE ROLE gugu_support_data LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'gugu_support_control') THEN
    CREATE ROLE gugu_support_control LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname IN ('gugu_support_data', 'gugu_support_control')
    AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolinherit))
    OR EXISTS (SELECT FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.member
      WHERE r.rolname IN ('gugu_support_data', 'gugu_support_control')) THEN
    RAISE EXCEPTION 'Support roles must not inherit broader authority';
  END IF;
END $roles$;
ALTER ROLE gugu_support_data SET log_parameter_max_length = 0;
ALTER ROLE gugu_support_data SET log_parameter_max_length_on_error = 0;
ALTER ROLE gugu_support_control SET log_parameter_max_length = 0;
ALTER ROLE gugu_support_control SET log_parameter_max_length_on_error = 0;

CREATE SCHEMA IF NOT EXISTS support_agent AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA support_agent FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA support_agent TO gugu_support_data, gugu_support_control;

-- Provisioning is deliberately postgres-only. Neither API role can approve its
-- own runtime, register an Agent, publish configuration or enable the help entry.
DO $dependency$ BEGIN
  IF to_regclass('support_help.configuration') IS NULL THEN
    RAISE EXCEPTION 'Install the support-help configuration release first';
  END IF;
END $dependency$;
CREATE TABLE IF NOT EXISTS support_agent.controllers (
  user_id text NOT NULL REFERENCES identity.users(id),
  configuration_id uuid NOT NULL REFERENCES support_help.configuration(id),
  PRIMARY KEY (user_id, configuration_id)
);
CREATE TABLE IF NOT EXISTS support_agent.agents (
  agent_id text PRIMARY KEY REFERENCES identity.users(id),
  configuration_id uuid NOT NULL REFERENCES support_help.configuration(id),
  runtime_id uuid NOT NULL,
  device_id text NOT NULL REFERENCES identity.gugu_devices(device_id),
  approved_until timestamptz NOT NULL,
  revoked_at timestamptz,
  attestation_reference text NOT NULL CHECK (length(attestation_reference) BETWEEN 1 AND 200),
  topic_ids text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS support_agent.grants (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  agent_id text NOT NULL REFERENCES support_agent.agents(agent_id),
  configuration_version bigint NOT NULL,
  issued_by text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS support_agent.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grant_id uuid,
  agent_id text,
  action text NOT NULL,
  result text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS support_agent.replies (
  message_id text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES support_agent.grants(id),
  agent_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON ALL TABLES IN SCHEMA support_agent FROM PUBLIC, anon, authenticated, service_role,
  gugu_support_data, gugu_support_control;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA support_agent FROM PUBLIC, anon, authenticated, service_role,
  gugu_support_data, gugu_support_control;

CREATE OR REPLACE FUNCTION support_agent.same_hash(a bytea, b bytea) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE difference integer := 0; i integer;
BEGIN
  IF a IS NULL OR b IS NULL OR octet_length(a) <> 32 OR octet_length(b) <> 32 THEN RETURN false; END IF;
  FOR i IN 0..31 LOOP difference := difference | (get_byte(a, i) # get_byte(b, i)); END LOOP;
  RETURN difference = 0;
END $$;

-- One identity predicate for the controller, duty human and Agent. A human
-- needs a live Auth record as well as a live chat identity; Agents never borrow
-- that human's token or Auth subject.
CREATE OR REPLACE FUNCTION support_agent.active_identity(p_id text, p_type text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM identity.users u WHERE u.id = p_id AND u.type = p_type
      AND u.removed_at IS NULL AND u.session_archived_at IS NULL
      AND (p_type <> 'agent' OR u.desired_status = 'online')
      AND (p_type = 'agent' OR EXISTS (
        SELECT 1 FROM auth.users h WHERE h.id::text = u.id AND h.deleted_at IS NULL
          AND (h.banned_until IS NULL OR h.banned_until <= statement_timestamp())
      ))
  )
$$;

-- Every operation locks and checks the SAME live rows in its own transaction.
-- Revocation/configuration/membership changes serialize against publication.
CREATE OR REPLACE FUNCTION support_agent.request(p_token text, p_action text, p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  g support_agent.grants%ROWTYPE; a support_agent.agents%ROWTYPE;
  c support_help.configuration%ROWTYPE;
  owner_id text; target text; rows jsonb; source chat.messages%ROWTYPE;
  result text := 'unauthorized'; status integer := 401; reply_id text;
BEGIN
  IF p_token ~ '^gsa1\.[0-9a-f-]{36}\.[0-9a-f]{64}$' THEN
    BEGIN
      SELECT x.* INTO g FROM support_agent.grants x
        WHERE x.id = split_part(p_token, '.', 2)::uuid;
    EXCEPTION WHEN invalid_text_representation THEN NULL; END;
  END IF;
  IF NOT support_agent.same_hash(extensions.digest(coalesce(p_token, ''), 'sha256'),
    coalesce(g.token_hash, extensions.digest('invalid-support-grant', 'sha256')))
    OR g.id IS NULL OR g.revoked_at IS NOT NULL OR g.expires_at <= clock_timestamp() THEN
    INSERT INTO support_agent.audit(action, result) VALUES ('authenticate', 'unauthorized');
    RETURN jsonb_build_object('status', 401, 'error', 'unauthorized');
  END IF;
  SELECT x.* INTO a FROM support_agent.agents x WHERE x.agent_id = g.agent_id;
  SELECT x.* INTO c FROM support_help.configuration x WHERE x.id = a.configuration_id FOR SHARE;
  SELECT u.owner_user_id INTO owner_id FROM identity.users u
    WHERE u.id = a.agent_id AND support_agent.active_identity(u.id, 'agent') AND u.device_id = a.device_id FOR SHARE;
  PERFORM 1 FROM identity.users u WHERE u.id = c.duty_human_user_id AND support_agent.active_identity(u.id, 'human') FOR SHARE;
  IF FOUND THEN
    PERFORM 1 FROM auth.users h WHERE h.id::text = c.duty_human_user_id FOR SHARE;
    IF FOUND AND NOT support_agent.active_identity(c.duty_human_user_id, 'human') THEN
      owner_id := NULL;
    END IF;
  END IF;
  IF FOUND AND owner_id = c.duty_human_user_id AND a.agent_id = ANY(c.assistant_agent_ids) AND c.version = g.configuration_version
    AND a.revoked_at IS NULL AND a.approved_until > clock_timestamp() THEN
    PERFORM 1 FROM chat.chats x WHERE x.id = c.help_group_id AND x.kind = 'group' AND x.status = 'active' FOR SHARE;
    IF FOUND THEN
      PERFORM 1 FROM chat.chat_members m WHERE m.chat_id = c.help_group_id AND m.user_id = owner_id FOR SHARE;
      IF FOUND THEN
        PERFORM 1 FROM chat.chat_members m WHERE m.chat_id = c.help_group_id AND m.user_id = a.agent_id FOR SHARE;
        IF FOUND THEN
          SELECT x.* INTO a FROM support_agent.agents x WHERE x.agent_id = g.agent_id
            AND x.configuration_id = c.id AND x.revoked_at IS NULL AND x.approved_until > clock_timestamp() FOR SHARE;
          IF FOUND THEN
            SELECT x.* INTO g FROM support_agent.grants x WHERE x.id = g.id AND x.revoked_at IS NULL
              AND x.expires_at > clock_timestamp() AND x.configuration_version = c.version FOR SHARE;
            IF FOUND THEN status := 403; result := 'forbidden'; END IF;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  IF status = 403 AND p_action = 'authorize' THEN status := 200; result := 'allowed'; END IF;
  IF status = 403 AND p_action IN ('events', 'history', 'search', 'reply') THEN
    target := p_body->>'chat_id';
    IF target = c.help_group_id OR target = ANY(a.topic_ids) THEN
      PERFORM 1 FROM chat.chats t WHERE t.id = target AND t.status = 'active'
        AND (t.id = c.help_group_id OR (t.kind = 'topic' AND t.source_chat_id = c.help_group_id
          AND EXISTS (SELECT 1 FROM chat.messages m WHERE m.id = t.source_message_id
            AND m.chat_id = c.help_group_id AND NOT m.is_whisper AND m.deleted_at IS NULL
            AND m.retracted_at IS NULL AND m.content_type = 'text'))) FOR SHARE;
      IF FOUND THEN
        status := 200; result := 'allowed';
        IF p_action <> 'reply' THEN
          SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'seq', m.seq,
            'sender_user_id', m.sender_user_id, 'content', m.content, 'created_at', m.created_at)
            ORDER BY m.seq), '[]'::jsonb) INTO rows FROM (
              SELECT m.id, m.seq, m.sender_user_id, m.content, m.created_at
              FROM chat.messages m JOIN chat.chat_members cm ON cm.chat_id = c.help_group_id AND cm.user_id = a.agent_id
              WHERE m.chat_id = target AND NOT m.is_whisper AND m.deleted_at IS NULL
                AND m.retracted_at IS NULL AND m.content_type = 'text' AND m.forwarded_from_message_id IS NULL
                AND (cm.hide_history_before IS NULL OR m.created_at >= cm.hide_history_before)
                AND (p_body->>'after_seq' IS NULL OR m.seq > (p_body->>'after_seq')::bigint)
                AND (p_action <> 'search' OR strpos(lower(m.content), lower(p_body->>'query')) > 0)
              ORDER BY m.seq LIMIT 50
            ) m;
        ELSE
          -- Serialize all grants for the same Agent for an independent reply limit.
          PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('support-reply:' || a.agent_id, 0));
          SELECT m.* INTO source FROM chat.messages m WHERE m.id = p_body->>'reply_to_message_id'
            AND m.chat_id = target AND NOT m.is_whisper AND m.deleted_at IS NULL
            AND m.retracted_at IS NULL AND m.content_type = 'text' FOR SHARE;
          IF NOT FOUND OR source.sender_user_id = a.agent_id OR
            coalesce(length(btrim(p_body->>'content')), 0) NOT BETWEEN 1 AND 8000 THEN
            status := 403; result := 'forbidden';
          ELSIF (SELECT count(*) FROM support_agent.replies r WHERE r.agent_id = a.agent_id
            AND r.created_at > clock_timestamp() - interval '1 minute') >= 10 THEN
            status := 429; result := 'rate_limited';
          ELSIF g.expires_at <= clock_timestamp() THEN
            status := 401; result := 'unauthorized';
          ELSE
            reply_id := p_body->>'message_id';
            IF reply_id IS NULL OR reply_id !~ '^[0-9a-f-]{36}$' THEN
              status := 400; result := 'invalid_request';
            ELSIF EXISTS (SELECT FROM support_agent.replies r WHERE r.message_id = reply_id) THEN
              status := 409; result := 'duplicate_message';
            ELSE
              INSERT INTO support_agent.replies(message_id, grant_id, agent_id) VALUES (reply_id, g.id, a.agent_id);
              INSERT INTO chat.messages(id, chat_id, sender_user_id, content, content_type, client_message_id,
                reply_to_message_id, to_user_ids, is_whisper)
              VALUES (reply_id, target, a.agent_id, '[Support Agent] ' || (p_body->>'content'), 'text', reply_id,
                source.id, ARRAY[source.sender_user_id], false);
              rows := jsonb_build_object('id', reply_id, 'source', 'support_agent');
            END IF;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  INSERT INTO support_agent.audit(grant_id, agent_id, action, result)
    VALUES (g.id, a.agent_id, CASE WHEN p_action IN ('authorize','events','history','search','reply') THEN p_action ELSE 'unknown' END, result);
  IF status <> 200 THEN RETURN jsonb_build_object('status', status, 'error', result); END IF;
  RETURN jsonb_build_object('status', 200, 'data', rows, 'expires_at', g.expires_at);
END $$;

CREATE OR REPLACE FUNCTION support_agent.manage(p_caller text, p_action text, p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c support_help.configuration%ROWTYPE; a support_agent.agents%ROWTYPE;
  gid uuid; token text; expiry timestamptz; checked jsonb;
BEGIN
  SELECT x.* INTO c FROM support_help.configuration x JOIN support_agent.controllers d ON d.configuration_id = x.id
    JOIN identity.users u ON u.id = d.user_id AND support_agent.active_identity(u.id, 'human')
    WHERE d.user_id = p_caller AND x.id::text = p_body->>'configuration_id' FOR SHARE OF x, d, u;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 403, 'error', 'forbidden'); END IF;
  PERFORM 1 FROM auth.users h WHERE h.id::text = p_caller FOR SHARE;
  IF NOT FOUND OR NOT support_agent.active_identity(p_caller, 'human') THEN
    RETURN jsonb_build_object('status', 403, 'error', 'forbidden');
  END IF;
  IF p_action = 'revoke' THEN
    UPDATE support_agent.grants g SET revoked_at = clock_timestamp()
      FROM support_agent.agents x WHERE g.agent_id = x.agent_id AND x.configuration_id = c.id
      AND g.id::text = p_body->>'grant_id' RETURNING g.id INTO gid;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 403, 'error', 'forbidden'); END IF;
    INSERT INTO support_agent.audit(grant_id, action, result) VALUES (gid, 'revoke', 'allowed');
    RETURN jsonb_build_object('status', 200, 'revoked', true);
  END IF;
  IF p_action <> 'issue' THEN RETURN jsonb_build_object('status', 400, 'error', 'invalid_request'); END IF;
  SELECT x.* INTO a FROM support_agent.agents x WHERE x.agent_id = p_body->>'agent_id'
    AND x.configuration_id = c.id AND x.runtime_id::text = p_body->>'runtime_id'
    AND c.version::text = p_body->>'config_version' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 403, 'error', 'forbidden'); END IF;
  gid := extensions.gen_random_uuid();
  token := 'gsa1.' || gid::text || '.' || encode(extensions.gen_random_bytes(32), 'hex');
  expiry := least(clock_timestamp() + interval '5 minutes', a.approved_until);
  INSERT INTO support_agent.grants(id, token_hash, agent_id, configuration_version, issued_by, expires_at)
    VALUES (gid, extensions.digest(token, 'sha256'), a.agent_id, c.version, p_caller, expiry);
  checked := support_agent.request(token, 'events', jsonb_build_object('chat_id', c.help_group_id));
  IF checked->>'status' <> '200' THEN
    UPDATE support_agent.grants SET revoked_at = clock_timestamp() WHERE id = gid;
    RETURN jsonb_build_object('status', 403, 'error', 'forbidden');
  END IF;
  INSERT INTO support_agent.audit(grant_id, agent_id, action, result) VALUES (gid, a.agent_id, 'issue', 'allowed');
  RETURN jsonb_build_object('status', 200, 'grant_id', gid, 'token', token, 'expires_at', expiry,
    'group_id', c.help_group_id, 'agent_id', a.agent_id);
END $$;

-- A registered support identity never receives the broad owner's device queue.
-- This guard deliberately also covers revoked/expired Agents: revoking authority
-- must not silently turn them back into ordinary owner-backed Agents.
CREATE OR REPLACE FUNCTION support_agent.block_owner_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.type = 'agent.deliver' AND EXISTS (SELECT FROM support_agent.agents a
    WHERE a.agent_id = NEW.payload->>'agent_user_id') THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS support_agent_delivery_boundary ON identity.gugu_device_commands;
CREATE TRIGGER support_agent_delivery_boundary BEFORE INSERT ON identity.gugu_device_commands
  FOR EACH ROW EXECUTE FUNCTION support_agent.block_owner_delivery();

CREATE OR REPLACE FUNCTION support_agent.block_owner_send() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT (current_setting('role') = 'gugu_support_data'
    OR (current_setting('role') = 'none' AND session_user IN ('postgres', 'gugu_support_data')))
    AND EXISTS (SELECT FROM support_agent.agents a WHERE a.agent_id = NEW.sender_user_id) THEN
    RAISE EXCEPTION 'Support identity requires the restricted support endpoint' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS support_agent_sender_boundary ON chat.messages;
CREATE TRIGGER support_agent_sender_boundary BEFORE INSERT OR UPDATE ON chat.messages
  FOR EACH ROW EXECUTE FUNCTION support_agent.block_owner_send();

CREATE OR REPLACE FUNCTION support_help.agent_isolation_verified(
  p_agent_id text, p_configuration_id uuid, p_configuration_version bigint
) RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM support_agent.agents a JOIN support_help.configuration c ON c.id = a.configuration_id
      JOIN identity.users u ON u.id = a.agent_id AND support_agent.active_identity(u.id, 'agent') AND u.device_id = a.device_id
    WHERE a.agent_id = p_agent_id AND c.id = p_configuration_id
      AND p_configuration_version IN (c.version, c.version + 1)
      AND a.revoked_at IS NULL AND a.approved_until > statement_timestamp()
  )
$$;
REVOKE ALL ON FUNCTION support_help.agent_isolation_verified(text,uuid,bigint)
  FROM PUBLIC, anon, authenticated, service_role, gugu_support_data, gugu_support_control;

-- Removing/readding a member or replacing a host must not revive an old grant.
CREATE OR REPLACE FUNCTION support_agent.revoke_changed_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'agents' THEN
    UPDATE support_agent.grants SET revoked_at = coalesce(revoked_at, clock_timestamp()) WHERE agent_id = OLD.agent_id;
  ELSIF TG_TABLE_NAME = 'chat_members' THEN
    UPDATE support_agent.grants g SET revoked_at = coalesce(g.revoked_at, clock_timestamp())
      FROM support_agent.agents a JOIN support_help.configuration c ON c.id = a.configuration_id
      WHERE g.agent_id = a.agent_id AND OLD.chat_id = c.help_group_id
        AND OLD.user_id IN (a.agent_id, c.duty_human_user_id);
  ELSIF TG_TABLE_NAME = 'chats' THEN
    UPDATE support_agent.grants g SET revoked_at = coalesce(g.revoked_at, clock_timestamp())
      FROM support_agent.agents a JOIN support_help.configuration c ON c.id = a.configuration_id
      WHERE g.agent_id = a.agent_id AND (OLD.id = c.help_group_id OR OLD.id = ANY(a.topic_ids));
  ELSIF TG_TABLE_SCHEMA = 'auth' THEN
    UPDATE support_agent.agents a SET revoked_at = coalesce(a.revoked_at, clock_timestamp())
      FROM support_help.configuration c WHERE c.id = a.configuration_id AND c.duty_human_user_id = OLD.id::text;
    UPDATE support_agent.grants SET revoked_at = coalesce(revoked_at, clock_timestamp()) WHERE issued_by = OLD.id::text;
  ELSE
    UPDATE support_agent.agents a SET revoked_at = coalesce(a.revoked_at, clock_timestamp())
      FROM support_help.configuration c WHERE c.id = a.configuration_id
        AND OLD.id IN (a.agent_id, c.duty_human_user_id);
    UPDATE support_agent.grants SET revoked_at = coalesce(revoked_at, clock_timestamp()) WHERE issued_by = OLD.id;
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION support_help.configuration_version_changed(
  p_configuration_id uuid, p_old_version bigint, p_new_version bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_new_version <> p_old_version + 1 THEN RAISE EXCEPTION 'Configuration version must increase by one'; END IF;
  UPDATE support_agent.grants g SET revoked_at = coalesce(g.revoked_at, clock_timestamp())
    FROM support_agent.agents a WHERE g.agent_id = a.agent_id AND a.configuration_id = p_configuration_id
      AND g.configuration_version <> p_new_version;
END $$;
REVOKE ALL ON FUNCTION support_help.configuration_version_changed(uuid,bigint,bigint)
  FROM PUBLIC, anon, authenticated, service_role, gugu_support_data, gugu_support_control;
DROP TRIGGER IF EXISTS support_grants_host_changed ON support_agent.agents;
CREATE TRIGGER support_grants_host_changed AFTER UPDATE ON support_agent.agents
  FOR EACH ROW EXECUTE FUNCTION support_agent.revoke_changed_authority();
DROP TRIGGER IF EXISTS support_grants_membership_changed ON chat.chat_members;
CREATE TRIGGER support_grants_membership_changed AFTER DELETE OR UPDATE OF chat_id, user_id ON chat.chat_members
  FOR EACH ROW EXECUTE FUNCTION support_agent.revoke_changed_authority();
DROP TRIGGER IF EXISTS support_grants_identity_changed ON identity.users;
CREATE TRIGGER support_grants_identity_changed AFTER UPDATE OF owner_user_id, device_id, type, desired_status, removed_at, session_archived_at OR DELETE ON identity.users
  FOR EACH ROW EXECUTE FUNCTION support_agent.revoke_changed_authority();
DROP TRIGGER IF EXISTS support_grants_group_changed ON chat.chats;
CREATE TRIGGER support_grants_group_changed AFTER UPDATE OF status, source_chat_id, source_message_id ON chat.chats
  FOR EACH ROW EXECUTE FUNCTION support_agent.revoke_changed_authority();
DROP TRIGGER IF EXISTS support_grants_auth_changed ON auth.users;
CREATE TRIGGER support_grants_auth_changed AFTER UPDATE OF banned_until, deleted_at OR DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION support_agent.revoke_changed_authority();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA support_agent FROM PUBLIC, anon, authenticated, service_role,
  gugu_support_data, gugu_support_control;
GRANT EXECUTE ON FUNCTION support_agent.request(text,text,jsonb) TO gugu_support_data;
GRANT EXECUTE ON FUNCTION support_agent.manage(text,text,jsonb) TO gugu_support_control;
