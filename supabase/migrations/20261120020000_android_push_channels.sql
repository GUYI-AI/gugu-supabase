-- Extend the existing durable transport; no account-revision events are changed.
SET LOCAL lock_timeout = '5s';
ALTER TABLE identity.mobile_push_registrations ADD COLUMN provider text NOT NULL DEFAULT 'apns'
  CHECK (provider IN ('apns','fcm','huawei','honor','xiaomi','oppo','vivo'));
-- Drop only the old token/topic checks; retain installation/session/device fences.
DO $checks$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'identity.mobile_push_registrations'::regclass
    AND contype = 'c' AND conkey && ARRAY[
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'identity.mobile_push_registrations'::regclass AND attname = 'token'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'identity.mobile_push_registrations'::regclass AND attname = 'topic')
    ]::smallint[]
  LOOP EXECUTE format('ALTER TABLE identity.mobile_push_registrations DROP CONSTRAINT %I',c.conname); END LOOP;
END $checks$;
-- Visible ASCII can be decoded without a locale-dependent text conversion.
-- Doubling backslashes keeps opaque tokens byte-for-byte distinct.
CREATE FUNCTION identity.mobile_push_token_hash(p_provider text,p_token text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT sha256(decode(p_provider || ':','escape') || CASE WHEN p_provider = 'apns'
    THEN decode(p_token,'hex') ELSE decode(replace(p_token,chr(92),chr(92)||chr(92)),'escape') END);
$$;
REVOKE ALL ON FUNCTION identity.mobile_push_token_hash(text,text) FROM PUBLIC,anon,authenticated,service_role,gugu_files,gugu_push;

-- CASCADE removes the old token hash's unique index; the replacement includes provider.
ALTER TABLE identity.mobile_push_registrations DROP COLUMN token_hash CASCADE;
ALTER TABLE identity.mobile_push_registrations
  ADD COLUMN token_hash bytea GENERATED ALWAYS AS (identity.mobile_push_token_hash(provider,token)) STORED,
  ADD CONSTRAINT mobile_push_provider_token UNIQUE(provider,token_hash,environment,topic),
  ADD CONSTRAINT mobile_push_provider_topic CHECK (CASE WHEN provider = 'apns' THEN topic = 'app.gugu.chat'
    ELSE topic IN ('app.gugu.chat','app.gugu.chat.beta') AND environment = 'production' END),
  ADD CONSTRAINT mobile_push_provider_token_format CHECK (octet_length(token) <= 4096 AND
    CASE WHEN provider = 'apns' THEN token ~ '^([0-9a-f]{2})+$' ELSE token COLLATE "C" ~ '^[!-~]+$' END);
CREATE INDEX mobile_push_provider_scan_idx ON identity.mobile_push_registrations(provider,environment,scan_order,id);
ALTER TABLE identity.mobile_push_attempts ADD COLUMN provider_message_id text
  CHECK (provider_message_id IS NULL OR octet_length(provider_message_id) <= 512);


CREATE FUNCTION identity.mobile_push_register(p_installation_id uuid, p_device_id text,
  p_provider text, p_token text, p_environment text, p_topic text, p_chat_enabled boolean,
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
    OR p_provider IS NULL OR p_provider NOT IN ('apns','fcm','huawei','honor','xiaomi','oppo','vivo')
    OR p_token IS NULL OR octet_length(p_token) > 4096
    OR CASE WHEN p_provider = 'apns' THEN p_token !~ '^([0-9a-f]{2})+$'
      ELSE p_token COLLATE "C" !~ '^[!-~]+$' END
    OR p_environment IS NULL OR p_environment NOT IN ('sandbox','production')
    OR p_topic IS NULL OR CASE WHEN p_provider = 'apns' THEN p_topic <> 'app.gugu.chat'
      ELSE p_topic NOT IN ('app.gugu.chat','app.gugu.chat.beta') OR p_environment <> 'production' END
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
  IF prior.id IS NOT NULL AND prior.owner_user_id <> owner_id AND (prior.provider,prior.token) IS DISTINCT FROM (p_provider,p_token) THEN
    RAISE EXCEPTION 'Installation is bound to another account' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE((SELECT revision FROM chat.account_revision_heads WHERE user_id = owner_id), 0) INTO head;
  IF prior.id IS NOT NULL AND (prior.owner_user_id <> owner_id OR prior.session_id <> session) THEN
    DELETE FROM identity.mobile_push_registrations WHERE id = prior.id;
    prior.id := NULL;
  END IF;
  -- Knowing another registration's installation ID must not expose or move its token.
  IF EXISTS (SELECT 1 FROM identity.mobile_push_registrations WHERE provider = p_provider AND token_hash = identity.mobile_push_token_hash(p_provider,p_token)
    AND environment = p_environment AND topic = p_topic AND installation_id <> p_installation_id) THEN
    RAISE EXCEPTION 'Push token already bound to an installation' USING ERRCODE = '42501';
  END IF;
  INSERT INTO identity.mobile_push_registrations(owner_user_id, installation_id, device_id,
    session_id, provider, token, environment, topic, chat_enabled, task_enabled,
    chat_sound_enabled, task_sound_enabled, cursor_revision)
  VALUES(owner_id, p_installation_id, p_device_id, session, p_provider, p_token, p_environment, p_topic,
    p_chat_enabled, p_task_enabled, p_chat_sound_enabled, p_task_sound_enabled, head)
  ON CONFLICT (installation_id, topic) DO UPDATE SET
    generation = CASE WHEN (mobile_push_registrations.provider, mobile_push_registrations.token, mobile_push_registrations.environment,
        mobile_push_registrations.chat_enabled, mobile_push_registrations.task_enabled,
        mobile_push_registrations.chat_sound_enabled, mobile_push_registrations.task_sound_enabled)
      IS DISTINCT FROM (excluded.provider, excluded.token, excluded.environment, excluded.chat_enabled, excluded.task_enabled,
        excluded.chat_sound_enabled, excluded.task_sound_enabled)
      THEN gen_random_uuid() ELSE mobile_push_registrations.generation END,
    provider = excluded.provider, token = excluded.token, environment = excluded.environment,
    chat_enabled = excluded.chat_enabled, task_enabled = excluded.task_enabled,
    chat_sound_enabled = excluded.chat_sound_enabled, task_sound_enabled = excluded.task_sound_enabled,
    registered_at = clock_timestamp()
  RETURNING * INTO result;
  RETURN jsonb_build_object('registration_id', result.id, 'generation', result.generation);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Push binding conflict' USING ERRCODE = '23505';
END;
$$;

CREATE OR REPLACE FUNCTION identity.mobile_push_register(p_installation_id uuid, p_device_id text,
  p_token text, p_environment text, p_topic text, p_chat_enabled boolean,
  p_task_enabled boolean, p_chat_sound_enabled boolean, p_task_sound_enabled boolean) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT identity.mobile_push_register(p_installation_id,p_device_id,'apns',p_token,p_environment,p_topic,
    p_chat_enabled,p_task_enabled,p_chat_sound_enabled,p_task_sound_enabled);
$$;

CREATE FUNCTION identity.mobile_push_reserve(p_environment text, p_providers text[], p_limit integer)
RETURNS SETOF uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE endpoint identity.mobile_push_registrations%ROWTYPE; revision_row record;
  candidate jsonb; event_key text; attempt uuid; count_reserved integer := 0;
BEGIN
  IF p_environment IS NULL OR p_environment NOT IN ('sandbox','production') OR p_limit IS NULL
    OR p_providers IS NULL OR cardinality(p_providers) = 0
    OR array_position(p_providers,NULL) IS NOT NULL
    OR NOT p_providers <@ ARRAY['apns','fcm','huawei','honor','xiaomi','oppo','vivo']::text[]
    OR p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'Invalid push reservation bounds'; END IF;
  FOR endpoint IN SELECT r.* FROM identity.mobile_push_registrations r
    JOIN auth.sessions s ON s.id = r.session_id AND s.user_id::text = r.owner_user_id
    WHERE r.provider = ANY(p_providers) AND r.environment = p_environment AND (s.not_after IS NULL OR s.not_after > now())
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

CREATE OR REPLACE FUNCTION identity.mobile_push_reserve(p_environment text, p_limit integer DEFAULT 20)
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT identity.mobile_push_reserve(p_environment,ARRAY['apns']::text[],p_limit);
$$;

CREATE OR REPLACE FUNCTION identity.mobile_push_prepare(p_attempt uuid) RETURNS jsonb
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
  RETURN jsonb_build_object('provider',endpoint.provider,'token',endpoint.token,'environment',endpoint.environment,'topic',endpoint.topic,
    'sound',CASE candidate->>'kind' WHEN 'chat_message' THEN endpoint.chat_sound_enabled
      WHEN 'task_attention' THEN endpoint.task_sound_enabled ELSE false END,
    'registeredAt',endpoint.registered_at,
    'gugu',candidate || jsonb_build_object('v',1,'notificationId',attempt.id,'ownerId',endpoint.owner_user_id,
      'installationId',endpoint.installation_id,'registrationId',endpoint.id,'generation',endpoint.generation,
      'revision',attempt.revision::text));
END;
$$;

CREATE FUNCTION identity.mobile_push_finish(p_attempt uuid, p_outcome text,
  p_invalid_before timestamptz, p_provider_message_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_provider_message_id IS NOT NULL AND (p_outcome <> 'accepted' OR octet_length(p_provider_message_id) > 512) THEN
    RAISE EXCEPTION 'Invalid provider message identifier';
  END IF;
  UPDATE identity.mobile_push_attempts SET provider_message_id = p_provider_message_id
    WHERE id = p_attempt AND outcome = 'attempted';
  PERFORM identity.mobile_push_finish(p_attempt,p_outcome,p_invalid_before);
END;
$$;

REVOKE ALL ON FUNCTION identity.mobile_push_register(uuid,text,text,text,text,text,boolean,boolean,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role,gugu_files,gugu_push;
REVOKE ALL ON FUNCTION identity.mobile_push_register(uuid,text,text,text,text,boolean,boolean,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role,gugu_files,gugu_push;
REVOKE ALL ON FUNCTION identity.mobile_push_reserve(text,text[],integer) FROM PUBLIC,anon,authenticated,service_role,gugu_files,gugu_push;
REVOKE ALL ON FUNCTION identity.mobile_push_reserve(text,integer) FROM PUBLIC,anon,authenticated,service_role,gugu_files,gugu_push;
REVOKE ALL ON FUNCTION identity.mobile_push_prepare(uuid) FROM PUBLIC,anon,authenticated,service_role,gugu_files,gugu_push;
REVOKE ALL ON FUNCTION identity.mobile_push_finish(uuid,text,timestamptz,text) FROM PUBLIC,anon,authenticated,service_role,gugu_files,gugu_push;
GRANT EXECUTE ON FUNCTION identity.mobile_push_register(uuid,text,text,text,text,boolean,boolean,boolean,boolean) TO authenticated;
-- gugu-allow-intentional-overload: identity.mobile_push_register - Keep the released nine-argument iOS API while Android supplies an explicit provider.
GRANT EXECUTE ON FUNCTION identity.mobile_push_register(uuid,text,text,text,text,text,boolean,boolean,boolean,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION identity.mobile_push_reserve(text,text[],integer) TO gugu_push;
GRANT EXECUTE ON FUNCTION identity.mobile_push_reserve(text,integer) TO gugu_push;
GRANT EXECUTE ON FUNCTION identity.mobile_push_prepare(uuid) TO gugu_push;
GRANT EXECUTE ON FUNCTION identity.mobile_push_finish(uuid,text,timestamptz,text) TO gugu_push;
