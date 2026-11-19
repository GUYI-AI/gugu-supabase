-- Execute as postgres, in the release installer's transaction.
-- Rollback / emergency disable: UPDATE support_help.release_gate SET support_help_entry_enabled=false;
-- Keep this additive release and its audit history installed. Closed data-plane calls return only false.
SET LOCAL ROLE postgres;
CREATE SCHEMA IF NOT EXISTS support_help;
REVOKE ALL ON SCHEMA support_help FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS support_help.configuration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL UNIQUE DEFAULT true CHECK(singleton),
  help_group_id text,
  duty_human_user_id text,
  assistant_agent_ids text[] NOT NULL DEFAULT '{}',
  version bigint NOT NULL DEFAULT 0 CHECK(version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((version=0 AND help_group_id IS NULL AND duty_human_user_id IS NULL AND cardinality(assistant_agent_ids)=0)
    OR (version>0 AND help_group_id IS NOT NULL AND duty_human_user_id IS NOT NULL))
);
INSERT INTO support_help.configuration(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS support_help.release_gate (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  support_help_entry_enabled boolean NOT NULL DEFAULT false,
  review_reference text,
  environment text NOT NULL DEFAULT 'unconfigured',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO support_help.release_gate(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS support_help.configuration_admins (
  user_id text PRIMARY KEY REFERENCES identity.users(id) ON DELETE CASCADE,
  can_publish boolean NOT NULL DEFAULT false,
  can_release boolean NOT NULL DEFAULT false,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS support_help.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operator_user_id text NOT NULL,
  action text NOT NULL CHECK(action IN ('publish','release_gate')),
  environment text NOT NULL,
  reason text NOT NULL,
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support_help.rate_limits (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  calls integer NOT NULL
);
ALTER TABLE support_help.configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_help.release_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_help.configuration_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_help.audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_help.rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON support_help.configuration, support_help.release_gate, support_help.configuration_admins, support_help.audit, support_help.rate_limits FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE support_help.audit_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- The isolation release replaces these hooks. Reinstallation must not replace its reviewed implementation.
DO $install$ BEGIN
  IF to_regprocedure('support_help.agent_isolation_verified(text,uuid,bigint)') IS NULL THEN
    EXECUTE $definition$CREATE FUNCTION support_help.agent_isolation_verified(text,uuid,bigint)
      RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS 'SELECT false'$definition$;
  END IF;
  IF to_regprocedure('support_help.configuration_version_changed(uuid,bigint,bigint)') IS NULL THEN
    EXECUTE $definition$CREATE FUNCTION support_help.configuration_version_changed(uuid,bigint,bigint)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $body$
      BEGIN
        IF EXISTS(SELECT 1 FROM support_help.configuration c WHERE c.id=$1 AND cardinality(c.assistant_agent_ids)>0) THEN
          RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='support_isolation_not_installed';
        END IF;
      END; $body$$definition$;
  END IF;
END; $install$;

CREATE OR REPLACE FUNCTION support_help.allow_call(p_operation text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count integer; v_now timestamptz := date_trunc('minute',clock_timestamp());
  v_actor text := auth.uid()::text;
BEGIN
  -- One bounded anonymous bucket, independent of caller-controlled forwarding headers.
  -- Authenticated buckets are verified JWT subjects; rows are replaced each minute.
  INSERT INTO support_help.rate_limits(bucket,window_start,calls)
    VALUES(p_operation||':'||CASE WHEN v_actor IS NULL THEN 'anonymous' ELSE (hashtextextended(v_actor,0) & 1023)::text END,v_now,1)
  ON CONFLICT(bucket) DO UPDATE SET
    window_start=excluded.window_start,
    calls=CASE WHEN rate_limits.window_start=excluded.window_start THEN rate_limits.calls+1 ELSE 1 END
  RETURNING calls INTO v_count;
  RETURN v_count <= CASE WHEN v_actor IS NULL THEN 600 ELSE 60 END;
END; $$;

CREATE OR REPLACE FUNCTION support_help.live_human(p_user_id text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM identity.users u WHERE u.id=p_user_id AND u.type='human' AND u.removed_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM auth.users a WHERE a.id::text=p_user_id AND a.banned_until>now())
$$;

CREATE OR REPLACE FUNCTION support_help.valid_configuration(p_id uuid,p_version bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c support_help.configuration%ROWTYPE; v_agent text;
BEGIN
  SELECT * INTO c FROM support_help.configuration WHERE id=p_id;
  IF NOT FOUND OR c.version=0 THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM chat.chats g WHERE g.id=c.help_group_id AND g.kind='group' AND g.source_chat_id IS NULL)
    OR EXISTS(SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id=c.help_group_id)
    OR NOT support_help.live_human(c.duty_human_user_id)
    OR NOT EXISTS(SELECT 1 FROM chat.active_members m WHERE m.user_id=c.duty_human_user_id AND m.chat_id=c.help_group_id)
    THEN RETURN false; END IF;
  FOREACH v_agent IN ARRAY c.assistant_agent_ids LOOP
    IF NOT EXISTS(SELECT 1 FROM identity.users u JOIN chat.active_members m ON m.user_id=u.id
      WHERE u.id=v_agent AND u.type='agent' AND u.removed_at IS NULL AND u.session_archived_at IS NULL
        AND u.owner_user_id=c.duty_human_user_id AND m.chat_id=c.help_group_id)
      OR NOT support_help.agent_isolation_verified(v_agent,c.id,p_version) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION identity.official_help_info() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c support_help.configuration%ROWTYPE; g chat.chats%ROWTYPE; v_enabled boolean;
  v_allowed boolean; v_uid text; v_member boolean; v_pending boolean; v_availability text;
  v_duty jsonb; v_agents jsonb := '[]'::jsonb;
BEGIN
  -- Do not read configuration, identity, membership or isolation state until this fixed branch passes.
  -- Every disabled caller takes the same branch and gets the identical shape, without state-dependent errors.
  SELECT support_help_entry_enabled INTO v_enabled FROM support_help.release_gate WHERE singleton FOR SHARE;
  v_allowed := support_help.allow_call('info');
  IF v_enabled IS DISTINCT FROM true THEN RETURN '{"support_help_entry_enabled":false}'::jsonb; END IF;
  IF NOT v_allowed THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='support_help_rate_limited'; END IF;
  SELECT * INTO c FROM support_help.configuration WHERE singleton FOR SHARE;
  IF NOT FOUND OR c.version=0 THEN RETURN '{"support_help_entry_enabled":false}'::jsonb; END IF;
  SELECT * INTO g FROM chat.chats WHERE id=c.help_group_id FOR SHARE;
  IF NOT FOUND OR NOT support_help.valid_configuration(c.id,c.version) THEN
    RETURN '{"support_help_entry_enabled":false}'::jsonb;
  END IF;
  v_uid := auth.uid()::text;
  SELECT EXISTS(SELECT 1 FROM chat.active_members m WHERE m.chat_id=g.id AND m.user_id=v_uid) INTO v_member;
  SELECT EXISTS(SELECT 1 FROM chat.group_join_requests r WHERE r.chat_id=g.id AND r.requester_user_id=v_uid AND r.status='pending') INTO v_pending;
  v_availability := CASE WHEN g.status='archived' THEN 'archived'
    WHEN g.invite_link_enabled IS NOT TRUE OR g.join_token IS NULL THEN 'closed'
    WHEN g.join_mode='invite_only' THEN 'invite_only'
    WHEN (SELECT count(*) FROM chat.active_members m WHERE m.chat_id=g.id)>=g.max_members THEN 'full'
    ELSE 'available' END;
  IF v_uid IS NOT NULL THEN
    SELECT jsonb_build_object('id',u.id,'display_name',u.display_name) INTO v_duty FROM identity.users u WHERE u.id=c.duty_human_user_id;
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'display_name',u.display_name) ORDER BY u.id),'[]'::jsonb)
      INTO v_agents FROM identity.users u WHERE u.id=ANY(c.assistant_agent_ids);
  END IF;
  RETURN jsonb_build_object('support_help_entry_enabled',true,'version',c.version,
    'group',jsonb_build_object('id',CASE WHEN v_uid IS NOT NULL THEN g.id ELSE NULL END,
      'public_id',g.public_id,'name',g.name,'join_mode',g.join_mode,'is_member',v_member,
      'join_request_status',CASE WHEN v_pending THEN 'pending' ELSE NULL END,'availability',v_availability),
    'duty_human',v_duty,'assistants',v_agents);
END; $$;

CREATE OR REPLACE FUNCTION identity.official_help_join(p_expected_version bigint,p_expected_group_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c support_help.configuration%ROWTYPE; g chat.chats%ROWTYPE; v_enabled boolean;
  v_uid text := auth.uid()::text; v_result text;
BEGIN
  SELECT support_help_entry_enabled INTO v_enabled FROM support_help.release_gate WHERE singleton FOR SHARE;
  IF v_enabled IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('status','unavailable','info','{"support_help_entry_enabled":false}'::jsonb);
  END IF;
  IF v_uid IS NULL OR NOT support_help.live_human(v_uid) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='support_help_human_required';
  END IF;
  IF NOT support_help.allow_call('join') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='support_help_rate_limited'; END IF;
  -- Revalidation below returns an info snapshot. Take its rate-bucket lock before the configuration
  -- lock too, so an ordinary concurrent info read cannot invert that order and deadlock a join.
  IF NOT support_help.allow_call('info') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='support_help_rate_limited'; END IF;
  -- Serialize preview validation with all configuration publishers, then with normal group join/admin paths.
  SELECT * INTO c FROM support_help.configuration WHERE singleton FOR UPDATE;
  IF c.version IS DISTINCT FROM p_expected_version OR c.help_group_id IS DISTINCT FROM p_expected_group_id THEN
    RETURN jsonb_build_object('status','config_changed','info',identity.official_help_info());
  END IF;
  SELECT * INTO g FROM chat.chats WHERE id=c.help_group_id FOR UPDATE;
  IF NOT FOUND OR NOT support_help.valid_configuration(c.id,c.version) THEN
    RETURN jsonb_build_object('status','unavailable','info','{"support_help_entry_enabled":false}'::jsonb);
  END IF;
  IF EXISTS(SELECT 1 FROM chat.active_members m WHERE m.chat_id=g.id AND m.user_id=v_uid) THEN
    RETURN jsonb_build_object('status','joined','chat_id',g.id);
  END IF;
  IF g.status='archived' OR g.invite_link_enabled IS NOT TRUE OR g.join_token IS NULL OR g.join_mode='invite_only'
    OR (SELECT count(*) FROM chat.active_members m WHERE m.chat_id=g.id)>=g.max_members THEN
    RETURN jsonb_build_object('status','unavailable','info',identity.official_help_info());
  END IF;
  IF EXISTS(SELECT 1 FROM chat.group_join_requests r WHERE r.chat_id=g.id AND r.requester_user_id=v_uid AND r.status='pending') THEN
    RETURN jsonb_build_object('status','pending','info',identity.official_help_info());
  END IF;
  -- No bespoke membership write: these existing paths retain their checks, approvals and triggers.
  IF g.join_mode='approval' THEN
    SELECT chat.request_group_join(g.public_id,g.join_token,NULL) INTO v_result;
  ELSE
    PERFORM chat.join_public_group(g.public_id,g.join_token);
    v_result := 'joined';
  END IF;
  IF v_result='joined' THEN RETURN jsonb_build_object('status','joined','chat_id',g.id); END IF;
  RETURN jsonb_build_object('status','pending','info',identity.official_help_info());
END; $$;

CREATE OR REPLACE FUNCTION identity.publish_support_help_configuration(
  p_expected_version bigint,p_help_group_id text,p_duty_human_user_id text,p_assistant_agent_ids text[],p_environment text,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c support_help.configuration%ROWTYPE; v_before jsonb; v_actor text := auth.uid()::text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM support_help.configuration_admins a JOIN identity.users u ON u.id=a.user_id
    WHERE a.user_id=v_actor AND a.can_publish AND a.revoked_at IS NULL AND support_help.live_human(u.id) FOR SHARE OF a,u) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='support_help_publish_forbidden';
  END IF;
  IF nullif(btrim(p_reason),'') IS NULL OR nullif(btrim(p_environment),'') IS NULL OR p_assistant_agent_ids IS NULL
    OR array_position(p_assistant_agent_ids,NULL) IS NOT NULL
    OR cardinality(p_assistant_agent_ids)<>(SELECT count(DISTINCT a) FROM unnest(p_assistant_agent_ids) a) THEN
    RAISE EXCEPTION 'support_help_invalid_publication';
  END IF;
  IF p_environment='unconfigured' OR p_environment IS DISTINCT FROM (SELECT environment FROM support_help.release_gate WHERE singleton) THEN
    RAISE EXCEPTION 'support_help_environment_mismatch';
  END IF;
  SELECT * INTO c FROM support_help.configuration WHERE singleton FOR UPDATE;
  IF c.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'support_help_version_conflict'; END IF;
  v_before := to_jsonb(c);
  PERFORM 1 FROM chat.chats WHERE id=p_help_group_id FOR UPDATE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM chat.chats WHERE id=p_help_group_id AND status='archived') THEN RAISE EXCEPTION 'support_help_invalid_group'; END IF;
  UPDATE support_help.configuration SET help_group_id=p_help_group_id,duty_human_user_id=p_duty_human_user_id,
    assistant_agent_ids=p_assistant_agent_ids,version=c.version+1,updated_at=clock_timestamp() WHERE id=c.id;
  IF NOT support_help.valid_configuration(c.id,c.version+1) THEN RAISE EXCEPTION 'support_help_invalid_configuration'; END IF;
  PERFORM support_help.configuration_version_changed(c.id,c.version,c.version+1);
  INSERT INTO support_help.audit(operator_user_id,action,environment,reason,before_value,after_value)
    SELECT v_actor,'publish',r.environment,p_reason,v_before,to_jsonb(n)
      FROM support_help.configuration n CROSS JOIN support_help.release_gate r WHERE n.id=c.id AND r.singleton;
  RETURN jsonb_build_object('configuration_id',c.id,'version',c.version+1);
END; $$;

-- Narrow service-only operation for the official release controller. Actor is its verified JWT subject,
-- never a client-supplied body field; the official broker verifies that identity before invoking this RPC.
CREATE OR REPLACE FUNCTION identity.set_support_help_release_gate(
  p_operator_user_id text,p_enabled boolean,p_review_reference text,p_environment text,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_before jsonb; c support_help.configuration%ROWTYPE;
BEGIN
  IF p_enabled IS NULL OR nullif(btrim(p_review_reference),'') IS NULL OR nullif(btrim(p_environment),'') IS NULL
    OR nullif(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'support_help_invalid_release'; END IF;
  IF NOT EXISTS(SELECT 1 FROM support_help.configuration_admins a JOIN identity.users u ON u.id=a.user_id
    WHERE a.user_id=p_operator_user_id AND a.can_release AND a.revoked_at IS NULL AND support_help.live_human(u.id) FOR SHARE OF a,u) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='support_help_release_forbidden';
  END IF;
  SELECT to_jsonb(r) INTO v_before FROM support_help.release_gate r WHERE singleton FOR UPDATE;
  SELECT * INTO c FROM support_help.configuration WHERE singleton FOR SHARE;
  IF p_enabled AND (NOT support_help.valid_configuration(c.id,c.version)
    OR EXISTS(SELECT 1 FROM chat.chats WHERE id=c.help_group_id AND status='archived')) THEN RAISE EXCEPTION 'support_help_invalid_configuration'; END IF;
  UPDATE support_help.release_gate SET support_help_entry_enabled=p_enabled,review_reference=p_review_reference,environment=p_environment,updated_at=clock_timestamp() WHERE singleton;
  INSERT INTO support_help.audit(operator_user_id,action,environment,reason,before_value,after_value)
    SELECT p_operator_user_id,'release_gate',p_environment,p_reason,v_before,to_jsonb(r) FROM support_help.release_gate r WHERE singleton;
  RETURN jsonb_build_object('support_help_entry_enabled',p_enabled);
END; $$;

REVOKE ALL ON FUNCTION support_help.agent_isolation_verified(text,uuid,bigint),
  support_help.configuration_version_changed(uuid,bigint,bigint), support_help.allow_call(text),
  support_help.live_human(text), support_help.valid_configuration(uuid,bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION identity.official_help_info() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION identity.official_help_join(bigint,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION identity.publish_support_help_configuration(bigint,text,text,text[],text,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION identity.set_support_help_release_gate(text,boolean,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION identity.official_help_info() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.official_help_join(bigint,text) TO authenticated;
GRANT EXECUTE ON FUNCTION identity.publish_support_help_configuration(bigint,text,text,text[],text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION identity.set_support_help_release_gate(text,boolean,text,text,text) TO service_role;
