-- Optional transport over the existing account revision stream. No new events.
SET LOCAL lock_timeout = '5s';
DO $role$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gugu_push') THEN
    CREATE ROLE gugu_push NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
  END IF;
END $role$;
GRANT USAGE ON SCHEMA identity TO gugu_push;
CREATE SEQUENCE identity.mobile_push_scan_sequence;
REVOKE ALL ON SEQUENCE identity.mobile_push_scan_sequence
  FROM PUBLIC, anon, authenticated, service_role, gugu_files, gugu_push;

CREATE TABLE identity.mobile_push_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  device_id text NOT NULL,
  session_id uuid NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
  token text NOT NULL,
  token_hash bytea GENERATED ALWAYS AS (sha256(decode(token,'hex'))) STORED,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  topic text NOT NULL CHECK (topic = 'app.gugu.chat'),
  chat_enabled boolean NOT NULL,
  task_enabled boolean NOT NULL,
  chat_sound_enabled boolean NOT NULL,
  task_sound_enabled boolean NOT NULL,
  cursor_revision bigint NOT NULL CHECK (cursor_revision >= 0),
  scan_order bigint NOT NULL DEFAULT 0,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (installation_id, topic),
  UNIQUE (token_hash, environment, topic),
  CHECK (device_id = 'phone-' || installation_id::text || '-' || owner_user_id),
  CHECK (token ~ '^([0-9a-f]{2})+$' AND octet_length(token) <= 4096)
);
CREATE INDEX mobile_push_owner_idx ON identity.mobile_push_registrations(owner_user_id);
CREATE INDEX mobile_push_session_idx ON identity.mobile_push_registrations(session_id);
CREATE INDEX mobile_push_scan_idx ON identity.mobile_push_registrations(environment,scan_order,id);
-- Irreversible for this login session and native installation. Auth deletion
-- removes the fence too, after which the absent session still refuses register.
CREATE TABLE identity.mobile_push_closures (
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  fence_id uuid NOT NULL DEFAULT gen_random_uuid(),
  closed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_user_id,session_id,installation_id)
);
CREATE INDEX mobile_push_closures_session_idx ON identity.mobile_push_closures(session_id);
CREATE TABLE identity.mobile_push_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid NOT NULL REFERENCES identity.mobile_push_registrations(id) ON DELETE CASCADE,
  generation uuid NOT NULL,
  revision bigint NOT NULL,
  event text NOT NULL,
  resource_key jsonb NOT NULL,
  event_key text NOT NULL,
  outcome text NOT NULL DEFAULT 'reserved' CHECK (outcome IN ('reserved','attempted','accepted','rejected','unknown','suppressed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (registration_id, event_key)
);
ALTER TABLE identity.mobile_push_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.mobile_push_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.mobile_push_closures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.mobile_push_registrations, identity.mobile_push_attempts, identity.mobile_push_closures
  FROM PUBLIC, anon, authenticated, service_role, gugu_files, gugu_push;

CREATE FUNCTION identity.mobile_push_register(p_installation_id uuid, p_device_id text,
  p_token text, p_environment text, p_topic text, p_chat_enabled boolean,
  p_task_enabled boolean, p_chat_sound_enabled boolean, p_task_sound_enabled boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE owner_id text := auth.uid()::text; session uuid; prior identity.mobile_push_registrations%ROWTYPE;
  result identity.mobile_push_registrations%ROWTYPE; head bigint;
BEGIN
  session := NULLIF(auth.jwt()->>'session_id','')::uuid;
  IF owner_id IS NULL OR session IS NULL THEN
    RAISE EXCEPTION 'Active human login session required' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM auth.sessions s JOIN auth.users a ON a.id = s.user_id
      JOIN identity.users u ON u.id = a.id::text
    WHERE s.id = session AND s.user_id::text = owner_id AND (s.not_after IS NULL OR s.not_after > now())
      AND a.deleted_at IS NULL AND (a.banned_until IS NULL OR a.banned_until <= now())
      AND u.type = 'human' AND u.removed_at IS NULL FOR KEY SHARE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active human login session required' USING ERRCODE = '42501'; END IF;
  IF p_installation_id IS NULL OR p_device_id IS DISTINCT FROM
      'phone-' || p_installation_id::text || '-' || owner_id
    OR p_token IS NULL OR p_token !~ '^([0-9a-f]{2})+$' OR octet_length(p_token) > 4096
    OR p_environment IS NULL OR p_environment NOT IN ('sandbox','production')
    OR p_topic IS DISTINCT FROM 'app.gugu.chat'
    OR p_chat_enabled IS NULL OR p_task_enabled IS NULL
    OR p_chat_sound_enabled IS NULL OR p_task_sound_enabled IS NULL THEN
    RAISE EXCEPTION 'Invalid mobile push binding' USING ERRCODE = '22023';
  END IF;
  -- Serialize a native installation's account and token transitions.
  PERFORM pg_advisory_xact_lock(hashtextextended('mobile-push:' || p_installation_id::text, 0));
  IF EXISTS (SELECT 1 FROM identity.mobile_push_closures c WHERE c.owner_user_id = auth.uid()
    AND c.session_id = session AND c.installation_id = p_installation_id) THEN
    RAISE EXCEPTION 'Push installation is closed for this login session' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO prior FROM identity.mobile_push_registrations
    WHERE installation_id = p_installation_id AND topic = p_topic FOR UPDATE;
  IF prior.id IS NOT NULL AND prior.owner_user_id <> owner_id AND prior.token <> p_token THEN
    RAISE EXCEPTION 'Installation is bound to another account' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE((SELECT revision FROM chat.account_revision_heads WHERE user_id = owner_id), 0) INTO head;
  IF prior.id IS NOT NULL AND (prior.owner_user_id <> owner_id OR prior.session_id <> session) THEN
    DELETE FROM identity.mobile_push_registrations WHERE id = prior.id;
    prior.id := NULL;
  END IF;
  -- Knowing another registration's installation ID must not expose or move its token.
  IF EXISTS (SELECT 1 FROM identity.mobile_push_registrations WHERE token_hash = sha256(decode(p_token,'hex'))
    AND environment = p_environment AND topic = p_topic AND installation_id <> p_installation_id) THEN
    RAISE EXCEPTION 'Push token already bound to an installation' USING ERRCODE = '42501';
  END IF;
  INSERT INTO identity.mobile_push_registrations(owner_user_id, installation_id, device_id,
    session_id, token, environment, topic, chat_enabled, task_enabled,
    chat_sound_enabled, task_sound_enabled, cursor_revision)
  VALUES(owner_id, p_installation_id, p_device_id, session, p_token, p_environment, p_topic,
    p_chat_enabled, p_task_enabled, p_chat_sound_enabled, p_task_sound_enabled, head)
  ON CONFLICT (installation_id, topic) DO UPDATE SET
    generation = CASE WHEN (mobile_push_registrations.token, mobile_push_registrations.environment,
        mobile_push_registrations.chat_enabled, mobile_push_registrations.task_enabled,
        mobile_push_registrations.chat_sound_enabled, mobile_push_registrations.task_sound_enabled)
      IS DISTINCT FROM (excluded.token, excluded.environment, excluded.chat_enabled, excluded.task_enabled,
        excluded.chat_sound_enabled, excluded.task_sound_enabled)
      THEN gen_random_uuid() ELSE mobile_push_registrations.generation END,
    token = excluded.token, environment = excluded.environment,
    chat_enabled = excluded.chat_enabled, task_enabled = excluded.task_enabled,
    chat_sound_enabled = excluded.chat_sound_enabled, task_sound_enabled = excluded.task_sound_enabled,
    registered_at = clock_timestamp()
  RETURNING * INTO result;
  RETURN jsonb_build_object('registration_id', result.id, 'generation', result.generation);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Push binding conflict' USING ERRCODE = '23505';
END;
$$;

CREATE FUNCTION identity.mobile_push_revoke(p_installation_id uuid, p_registration_id uuid,
  p_generation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  DELETE FROM identity.mobile_push_registrations WHERE id = p_registration_id
    AND installation_id = p_installation_id AND owner_user_id = auth.uid()::text
    AND session_id = NULLIF(auth.jwt()->>'session_id','')::uuid AND generation = p_generation;
  RETURN FOUND;
END;
$$;

-- No token or RAM registration receipt is needed. The verified JWT fixes the
-- old owner/session; callers cannot target another session with a newer ticket.
CREATE FUNCTION identity.mobile_push_close_installation(p_installation_id uuid,
  p_device_id text, p_original_session_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE owner_id uuid := auth.uid(); session uuid; fence uuid; scope jsonb;
BEGIN
  session := NULLIF(auth.jwt()->>'session_id','')::uuid;
  IF owner_id IS NULL OR session IS NULL OR p_original_session_id IS DISTINCT FROM session THEN
    RAISE EXCEPTION 'Original authenticated login session required' USING ERRCODE = '42501';
  END IF;
  IF p_installation_id IS NULL OR p_device_id IS DISTINCT FROM
    'phone-' || p_installation_id::text || '-' || owner_id::text THEN
    RAISE EXCEPTION 'Invalid mobile push binding' USING ERRCODE = '22023';
  END IF;
  scope := jsonb_build_object('v',1,'closed',true,'owner_id',owner_id,'session_id',session,
    'installation_id',p_installation_id,'device_id',p_device_id);
  -- Same lock order as register: session first, installation second.
  PERFORM 1 FROM auth.sessions s WHERE s.id = session AND s.user_id = owner_id FOR KEY SHARE OF s;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id = session) THEN
      RAISE EXCEPTION 'Login session ownership mismatch' USING ERRCODE = '42501';
    END IF;
    -- FK cascade plus register's session lock/check makes absence authoritative.
    RETURN scope || jsonb_build_object('evidence','session_absent','fence_id',NULL);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mobile-push:' || p_installation_id::text, 0));
  INSERT INTO identity.mobile_push_closures(owner_user_id,session_id,installation_id)
    VALUES(owner_id,session,p_installation_id) ON CONFLICT DO NOTHING;
  SELECT c.fence_id INTO fence FROM identity.mobile_push_closures c
    WHERE c.owner_user_id = owner_id AND c.session_id = session AND c.installation_id = p_installation_id;
  DELETE FROM identity.mobile_push_registrations r WHERE r.owner_user_id = owner_id::text
    AND r.session_id = session AND r.installation_id = p_installation_id;
  RETURN scope || jsonb_build_object('evidence','installation_fenced','fence_id',fence);
END;
$$;

-- Canonical state is checked at reservation AND immediately before transport.
-- Only identifiers leave the database; neither message bodies nor task prompts do.
CREATE FUNCTION identity.mobile_push_candidate(p_owner text, p_event text, p_key jsonb,
  p_revision bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb; previous jsonb; current_presence jsonb;
BEGIN
  IF p_event = 'message_created' THEN
    SELECT jsonb_build_object('kind','chat_message','chatId',m.chat_id,'messageId',m.id)
      INTO result FROM chat.messages m JOIN chat.chats c ON c.id = m.chat_id
      JOIN chat.active_members member ON member.chat_id = c.id AND member.user_id = p_owner
      LEFT JOIN chat.messages reply ON reply.id = m.reply_to_message_id
      LEFT JOIN chat.chat_member_stream_read_state read_state ON read_state.chat_id = m.chat_id
        AND read_state.user_id = p_owner AND read_state.stream_id = CASE WHEN m.thread_root_id IS NULL
          THEN 'main:' || m.chat_id ELSE 'thread:' || m.chat_id || ':' || m.thread_root_id END
    WHERE m.id = p_key->>'entity_id' AND m.chat_id = p_key->>'chat_id'
      AND m.sender_user_id IS DISTINCT FROM p_owner AND m.deleted_at IS NULL AND m.retracted_at IS NULL
      AND NOT (m.deleted_for_user_ids @> jsonb_build_array(p_owner))
      AND NOT COALESCE(m.client_message_id ~ '^session-import-root:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',false)
      AND member.notification_level <> 'none'
      AND m.seq > CASE WHEN m.thread_root_id IS NULL
        THEN GREATEST(member.last_read_seq, COALESCE(read_state.last_read_seq,0))
        ELSE COALESCE(read_state.last_read_seq,0) END
      AND chat.message_visible_to(m.chat_id,m.created_at,m.is_whisper,m.sender_user_id,m.to_user_ids,p_owner)
      AND (c.kind IN ('dm','ai') OR p_owner = ANY(m.to_user_ids) OR '*' = ANY(m.to_user_ids)
        OR reply.sender_user_id = p_owner);
    RETURN result;
  ELSIF p_event = 'presence_changed' AND p_key#>>'{presence,agent_status}' = 'needs_user' THEN
    -- Do not replay an earlier wait after the task left it and entered a new wait.
    IF EXISTS (SELECT 1 FROM chat.account_revisions WHERE user_id = p_owner
      AND event = 'presence_changed' AND revision > p_revision
      AND resource_key->>'agent_user_id' = p_key->>'agent_user_id'
      AND (resource_key#>>'{presence,agent_status}' IS DISTINCT FROM 'needs_user'
        OR resource_key#>>'{presence,agent_status_detail}' IS DISTINCT FROM p_key#>>'{presence,agent_status_detail}'))
    THEN RETURN NULL; END IF;
    SELECT resource_key->'presence' INTO previous FROM chat.account_revisions
      WHERE user_id = p_owner AND event = 'presence_changed' AND revision < p_revision
        AND resource_key->>'agent_user_id' = p_key->>'agent_user_id'
      ORDER BY revision DESC LIMIT 1;
    IF previous->>'agent_status' = 'needs_user' AND previous->>'agent_status_detail'
      IS NOT DISTINCT FROM p_key#>>'{presence,agent_status_detail}' THEN RETURN NULL; END IF;
    SELECT identity.build_agent_presence_payload(u.id)->'presence' INTO current_presence
      FROM identity.users u WHERE u.id = p_key->>'agent_user_id' AND u.type = 'agent'
        AND u.owner_user_id = p_owner AND u.removed_at IS NULL AND u.session_archived_at IS NULL;
    IF current_presence->>'agent_status' = 'needs_user' AND current_presence->>'agent_status_detail'
      IS NOT DISTINCT FROM p_key#>>'{presence,agent_status_detail}' THEN
      RETURN jsonb_strip_nulls(jsonb_build_object('kind','task_attention','agentId',p_key->>'agent_user_id',
        'chatId',CASE WHEN EXISTS (SELECT 1 FROM chat.active_members WHERE user_id = p_owner
          AND chat_id = current_presence->>'active_chat_id') THEN current_presence->>'active_chat_id' END));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- Cursor advancement and unique reservations commit before any APNs request.
-- Reservations are never replayed: a crash can lose an alert, not duplicate it.
CREATE FUNCTION identity.mobile_push_reserve(p_environment text, p_limit integer DEFAULT 20)
RETURNS SETOF uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE endpoint identity.mobile_push_registrations%ROWTYPE; revision_row record;
  candidate jsonb; event_key text; attempt uuid; count_reserved integer := 0;
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('sandbox','production') OR p_limit IS NULL
    OR p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'Invalid push reservation bounds'; END IF;
  FOR endpoint IN SELECT r.* FROM identity.mobile_push_registrations r
    JOIN auth.sessions s ON s.id = r.session_id AND s.user_id::text = r.owner_user_id
    WHERE r.environment = p_environment AND (s.not_after IS NULL OR s.not_after > now())
      AND EXISTS (SELECT 1 FROM chat.account_revisions a WHERE a.user_id = r.owner_user_id AND a.revision > r.cursor_revision)
    ORDER BY r.scan_order, r.id LIMIT 100 FOR UPDATE OF r SKIP LOCKED
  LOOP
    -- Move every visited endpoint behind the others, even when its first page
    -- fills the batch. Cursor progress alone does not provide fairness.
    UPDATE identity.mobile_push_registrations
      SET scan_order = nextval('identity.mobile_push_scan_sequence'::regclass) WHERE id = endpoint.id;
    FOR revision_row IN SELECT * FROM chat.account_revisions
      WHERE user_id = endpoint.owner_user_id AND revision > endpoint.cursor_revision
      ORDER BY revision LIMIT 100
    LOOP
      UPDATE identity.mobile_push_registrations SET cursor_revision = revision_row.revision WHERE id = endpoint.id;
      IF revision_row.tombstone OR NOT ((revision_row.event = 'message_created' AND endpoint.chat_enabled)
        OR (revision_row.event = 'presence_changed' AND endpoint.task_enabled)) THEN CONTINUE; END IF;
      candidate := identity.mobile_push_candidate(endpoint.owner_user_id, revision_row.event,
        revision_row.resource_key, revision_row.revision);
      IF candidate IS NULL THEN CONTINUE; END IF;
      event_key := CASE WHEN revision_row.event = 'message_created'
        THEN 'message:' || (candidate->>'messageId') ELSE 'attention:' || revision_row.revision::text END;
      INSERT INTO identity.mobile_push_attempts(registration_id,generation,revision,event,resource_key,event_key)
        VALUES(endpoint.id,endpoint.generation,revision_row.revision,revision_row.event,
          CASE WHEN revision_row.event = 'message_created' THEN
            jsonb_build_object('chat_id',candidate->>'chatId','entity_id',candidate->>'messageId')
          ELSE jsonb_build_object('agent_user_id',candidate->>'agentId','presence',
            jsonb_build_object('agent_status','needs_user','agent_status_detail',revision_row.resource_key#>>'{presence,agent_status_detail}')) END,
          event_key)
        ON CONFLICT DO NOTHING RETURNING id INTO attempt;
      IF attempt IS NOT NULL THEN
        RETURN NEXT attempt;
        count_reserved := count_reserved + 1;
        IF count_reserved >= p_limit THEN RETURN; END IF;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

-- This transition commits separately, before the network side effect. Even an
-- accidental duplicate worker invocation cannot admit the same attempt twice.
CREATE FUNCTION identity.mobile_push_admit(p_attempt uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE identity.mobile_push_attempts SET outcome = 'attempted' WHERE id = p_attempt AND outcome = 'reserved';
  RETURN FOUND;
END;
$$;

-- The worker holds this registration lock through its bounded HTTP/2 request.
-- Revoke/rotation then serialize with requests already admitted to transport.
CREATE FUNCTION identity.mobile_push_prepare(p_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE attempt identity.mobile_push_attempts%ROWTYPE; endpoint identity.mobile_push_registrations%ROWTYPE; candidate jsonb;
BEGIN
  SELECT * INTO attempt FROM identity.mobile_push_attempts WHERE id = p_attempt;
  IF attempt.id IS NULL OR attempt.outcome <> 'attempted' THEN RETURN NULL; END IF;
  SELECT * INTO endpoint FROM identity.mobile_push_registrations WHERE id = attempt.registration_id FOR UPDATE;
  IF endpoint.id IS NULL OR endpoint.generation <> attempt.generation OR NOT EXISTS (
    SELECT 1 FROM auth.sessions s JOIN auth.users a ON a.id = s.user_id
      JOIN identity.users u ON u.id = a.id::text
    WHERE s.id = endpoint.session_id AND s.user_id::text = endpoint.owner_user_id
      AND (s.not_after IS NULL OR s.not_after > now()) AND a.deleted_at IS NULL
      AND (a.banned_until IS NULL OR a.banned_until <= now()) AND u.removed_at IS NULL
  ) THEN RETURN NULL; END IF;
  candidate := identity.mobile_push_candidate(endpoint.owner_user_id,attempt.event,attempt.resource_key,attempt.revision);
  IF candidate IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('token',endpoint.token,'environment',endpoint.environment,'topic',endpoint.topic,
    'sound',CASE candidate->>'kind' WHEN 'chat_message' THEN endpoint.chat_sound_enabled
      WHEN 'task_attention' THEN endpoint.task_sound_enabled ELSE false END,
    'registeredAt',endpoint.registered_at,
    'gugu',candidate || jsonb_build_object('v',1,'notificationId',attempt.id,'ownerId',endpoint.owner_user_id,
      'installationId',endpoint.installation_id,'registrationId',endpoint.id,'generation',endpoint.generation,
      'revision',attempt.revision::text));
END;
$$;

CREATE FUNCTION identity.mobile_push_finish(p_attempt uuid, p_outcome text, p_invalid_before timestamptz DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE attempt identity.mobile_push_attempts%ROWTYPE;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','rejected','unknown','suppressed') THEN
    RAISE EXCEPTION 'Invalid push outcome'; END IF;
  SELECT * INTO attempt FROM identity.mobile_push_attempts WHERE id = p_attempt;
  IF attempt.id IS NULL OR attempt.outcome <> 'attempted' THEN RETURN; END IF;
  UPDATE identity.mobile_push_attempts SET outcome = p_outcome WHERE id = p_attempt;
  IF p_invalid_before IS NOT NULL AND p_outcome = 'rejected' THEN
    DELETE FROM identity.mobile_push_registrations WHERE id = attempt.registration_id
      AND generation = attempt.generation AND registered_at <= p_invalid_before;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION identity.mobile_push_register(uuid,text,text,text,text,boolean,boolean,boolean,boolean),
  identity.mobile_push_revoke(uuid,uuid,uuid), identity.mobile_push_candidate(text,text,jsonb,bigint),
  identity.mobile_push_close_installation(uuid,text,uuid),
  identity.mobile_push_reserve(text,integer), identity.mobile_push_admit(uuid), identity.mobile_push_prepare(uuid),
  identity.mobile_push_finish(uuid,text,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role, gugu_files, gugu_push;
GRANT EXECUTE ON FUNCTION identity.mobile_push_register(uuid,text,text,text,text,boolean,boolean,boolean,boolean),
  identity.mobile_push_revoke(uuid,uuid,uuid), identity.mobile_push_close_installation(uuid,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION identity.mobile_push_reserve(text,integer), identity.mobile_push_admit(uuid), identity.mobile_push_prepare(uuid),
  identity.mobile_push_finish(uuid,text,timestamptz) TO gugu_push;
