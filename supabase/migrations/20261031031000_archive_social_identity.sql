-- Social removal changes the identity, not its seats or its historical messages.
ALTER TABLE identity.users ADD COLUMN removed_at timestamptz;
GRANT SELECT (removed_at) ON identity.users TO authenticated;

CREATE FUNCTION identity.user_is_live(p_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM identity.users u WHERE u.id = p_user_id AND u.removed_at IS NULL)
$$;
REVOKE ALL ON FUNCTION identity.user_is_live(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.user_is_live(text) TO authenticated, service_role, gugu_files;

CREATE VIEW chat.active_members WITH (security_invoker = true) AS
  SELECT m.* FROM chat.chat_members m WHERE identity.user_is_live(m.user_id);
REVOKE ALL ON chat.active_members FROM PUBLIC, anon;
GRANT SELECT ON chat.active_members TO authenticated, service_role, gugu_files;

CREATE FUNCTION identity.guard_removed_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'identity_removed: restoring requires a new identity' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.guard_removed_identity() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER users_guard_removed_identity BEFORE UPDATE ON identity.users
  FOR EACH ROW EXECUTE FUNCTION identity.guard_removed_identity();

CREATE FUNCTION identity.archive_user(p_user_id text, p_remove_social_identity boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target identity.users%ROWTYPE; caller text := auth.uid()::text;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_remove_social_identity IS NULL THEN
    RAISE EXCEPTION 'remove_social_identity must be a boolean' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO target FROM identity.users u
    WHERE u.id = p_user_id AND (u.id = caller OR (u.type = 'agent' AND u.owner_user_id = caller))
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Identity is not owned by current user' USING ERRCODE = '42501'; END IF;
  IF target.removed_at IS NOT NULL AND NOT p_remove_social_identity THEN
    RAISE EXCEPTION 'identity_removed: restoring requires a new identity' USING ERRCODE = '55000';
  END IF;
  IF target.removed_at IS NULL AND NOT identity.user_is_live(caller) THEN
    RAISE EXCEPTION 'Identity is not active' USING ERRCODE = '42501';
  END IF;
  IF p_remove_social_identity AND target.removed_at IS NULL THEN
    UPDATE identity.users SET removed_at = clock_timestamp() WHERE id = target.id
      RETURNING * INTO target;
  END IF;
  -- false leaves social state alone; the host keeps its existing revisioned
  -- set_agent_session_archival/offline-interval path. No membership DML here.
  RETURN jsonb_build_object('user_id', target.id, 'removed_at', target.removed_at,
    'remove_social_identity', p_remove_social_identity);
END;
$$;
REVOKE ALL ON FUNCTION identity.archive_user(text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.archive_user(text,boolean) TO authenticated;

-- Compatibility entry, with the same irreversible archive semantics. The client
-- offers archive only; old callers must not retain a destructive second path.
CREATE OR REPLACE FUNCTION identity.remove_owned_agent(p_agent_user_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity.users u WHERE u.id = p_agent_user_id
    AND u.type = 'agent' AND u.owner_user_id = auth.uid()::text) THEN
    RAISE EXCEPTION 'Agent is not owned by current user' USING ERRCODE = '42501';
  END IF;
  PERFORM identity.archive_user(p_agent_user_id, true);
END;
$$;
REVOKE ALL ON FUNCTION identity.remove_owned_agent(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.remove_owned_agent(text) TO authenticated;

-- A directory is a live projection; historical sender reads keep using users.
CREATE VIEW identity.active_users WITH (security_invoker = true) AS
  SELECT id, type, display_name, avatar, bio, mycel_id, owner_user_id,
    agent_config_id, created_at, updated_at, device_id, local_path, prompt_path,
    desired_status, agent_public, gugu_number, category, inherit_memory,
    special_focus, onboarded_at, is_official, session_archived_at,
    session_lifecycle_revision, session_lifecycle_operation_id, removed_at
  FROM identity.users WHERE identity.user_is_live(id);
REVOKE ALL ON identity.active_users FROM PUBLIC, anon;
GRANT SELECT ON identity.active_users TO authenticated, service_role;

CREATE VIEW identity.active_friendships WITH (security_invoker = true) AS
  SELECT f.* FROM identity.friendships f
  WHERE identity.user_is_live(f.user_a_id) AND identity.user_is_live(f.user_b_id);
REVOKE ALL ON identity.active_friendships FROM PUBLIC, anon;
GRANT SELECT ON identity.active_friendships TO authenticated, service_role;

ALTER POLICY members_select_peer ON chat.chat_members
  USING (identity.user_is_live(user_id) AND chat.is_member(chat_id));
CREATE POLICY members_live_write ON chat.chat_members AS RESTRICTIVE FOR ALL TO authenticated
  USING (identity.user_is_live(user_id) AND identity.user_is_live(auth.uid()::text))
  WITH CHECK (identity.user_is_live(user_id) AND identity.user_is_live(auth.uid()::text));
CREATE POLICY friendships_live ON identity.friendships AS RESTRICTIVE FOR ALL TO authenticated
  USING (identity.user_is_live(user_a_id) AND identity.user_is_live(user_b_id))
  WITH CHECK (identity.user_is_live(user_a_id) AND identity.user_is_live(user_b_id));
CREATE POLICY friend_requests_live ON identity.friend_requests AS RESTRICTIVE FOR ALL TO authenticated
  USING (identity.user_is_live(sender_id) AND identity.user_is_live(receiver_id))
  WITH CHECK (identity.user_is_live(sender_id) AND identity.user_is_live(receiver_id));
CREATE POLICY contacts_live ON chat.contacts AS RESTRICTIVE FOR ALL TO authenticated
  USING (identity.user_is_live(owner_user_id) AND identity.user_is_live(contact_user_id))
  WITH CHECK (identity.user_is_live(owner_user_id) AND identity.user_is_live(contact_user_id));
CREATE POLICY contact_group_members_live ON identity.contact_group_members AS RESTRICTIVE FOR ALL TO authenticated
  USING (identity.user_is_live(contact_user_id)) WITH CHECK (identity.user_is_live(contact_user_id));
CREATE POLICY contact_overrides_live ON identity.contact_overrides AS RESTRICTIVE FOR ALL TO authenticated
  USING (identity.user_is_live(owner_user_id) AND (target_kind='group' OR identity.user_is_live(contact_user_id)))
  WITH CHECK (identity.user_is_live(owner_user_id) AND (target_kind='group' OR identity.user_is_live(contact_user_id)));

-- Move installed SQL/PLpgSQL read sites, retaining their complete predecessor
-- bodies, signatures, volatility, owners and ACLs. Published release files are
-- immutable. DML targets remain physical seats (ON CONFLICT requires a table).
-- The inventory and catalog assertion tests cover every installed definition.
DO $live_member_reads$
DECLARE r record; definition text; previous text; permission record;
BEGIN
  FOR r IN SELECT p.oid, p.oid::regprocedure AS signature,
      COALESCE(p.proacl, acldefault('f',p.proowner)) AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname IN ('chat','identity','file_private','public')
      AND l.lanname IN ('sql','plpgsql') AND p.prokind='f'
      AND (p.prosrc ~* '\m(FROM|JOIN|USING)[[:space:]]+chat\.chat_members\M'
        OR p.prosrc ~* '\m(FROM|JOIN)[[:space:]]+identity\.friendships\M')
  LOOP
    definition := pg_get_functiondef(r.oid); previous := definition;
    IF r.signature::text LIKE 'chat.chats_membership_invariants(%'
      OR r.signature::text LIKE 'chat.chats_status_invariants(%' THEN
      -- Retained owner seats are a structural invariant, not live membership.
      -- The topic-only-agent check, however, applies only to live participants.
      definition := replace(definition, 'FROM chat.chat_members m' || chr(10) || '        JOIN identity.users u',
        'FROM chat.active_members m' || chr(10) || '        JOIN identity.users u');
    ELSE
      definition := regexp_replace(definition,
        '(\mDELETE[[:space:]]+FROM[[:space:]]+)chat\.chat_members\M',
        '\1__archive_member_delete_target__', 'gi');
      definition := regexp_replace(definition,
        '(\m(FROM|JOIN|USING)[[:space:]]+)chat\.chat_members\M', '\1chat.active_members', 'gi');
      -- Unaliased column qualifiers belong to the redirected relation too.
      definition := regexp_replace(definition, '\mchat_members\.', 'active_members.', 'g');
      definition := replace(definition, '__archive_member_delete_target__', 'chat.chat_members');
    END IF;
    definition := regexp_replace(definition,
      '(\m(FROM|JOIN)[[:space:]]+)identity\.friendships\M', '\1identity.active_friendships', 'gi');
    IF definition = previous THEN CONTINUE; END IF;
    EXECUTE definition;
    -- The installation's DDL event trigger revokes API execution on CREATE OR
    -- REPLACE too. Restore precisely the prior grants, never default PUBLIC.
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
      FROM aclexplode(r.acl) WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',r.signature,
        CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END $live_member_reads$;

-- Policies are parsed trees, so changing function source cannot redirect their
-- direct relation references. Keep the original expressions except that read.
DO $live_member_policies$
DECLARE r record; expression text;
BEGIN
  FOR r IN SELECT p.*, n.nspname, c.relname FROM pg_policy p
    JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('chat','identity','storage','realtime')
  LOOP
    IF pg_get_expr(r.polqual,r.polrelid) ~ '\mchat_members\M' THEN
      expression := regexp_replace(pg_get_expr(r.polqual,r.polrelid), '\mchat_members\M', 'active_members','g');
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', r.polname,r.nspname,r.relname,expression);
    END IF;
    IF pg_get_expr(r.polwithcheck,r.polrelid) ~ '\mchat_members\M' THEN
      expression := regexp_replace(pg_get_expr(r.polwithcheck,r.polrelid), '\mchat_members\M', 'active_members','g');
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', r.polname,r.nspname,r.relname,expression);
    END IF;
  END LOOP;
END $live_member_policies$;

CREATE OR REPLACE FUNCTION chat.is_acting_as(p_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT identity.user_is_live(p_user_id) AND (
    auth.uid() IS NULL OR (identity.user_is_live(auth.uid()::text) AND (
      p_user_id = auth.uid()::text OR EXISTS (SELECT 1 FROM identity.users u
        WHERE u.id=p_user_id AND u.type='agent' AND u.owner_user_id=auth.uid()::text))))
$$;
REVOKE ALL ON FUNCTION chat.is_acting_as(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.is_acting_as(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION chat.can_act_as(p_sender_user_id text,p_chat_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL AND chat.is_acting_as(p_sender_user_id)
    AND chat.is_chat_member(p_chat_id,p_sender_user_id)
$$;
REVOKE ALL ON FUNCTION chat.can_act_as(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.can_act_as(text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION identity.can_write_agent_runtime_state(p_agent_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT identity.user_is_live(p_agent_user_id) AND identity.user_is_live(auth.uid()::text)
    AND EXISTS (SELECT 1 FROM identity.users u WHERE u.id=p_agent_user_id
      AND u.type='agent' AND u.owner_user_id=auth.uid()::text)
$$;
REVOKE ALL ON FUNCTION identity.can_write_agent_runtime_state(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.can_write_agent_runtime_state(text) TO authenticated, service_role;

-- One notification is a cache invalidation hint, never another removal ledger.
CREATE FUNCTION identity.broadcast_identity_removal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM realtime.send(jsonb_build_object('id',NEW.id,'removed_at',NEW.removed_at),
    'identity_removed','gugu:identity:lifecycle',true);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.broadcast_identity_removal() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER users_broadcast_identity_removal AFTER UPDATE OF removed_at ON identity.users
  FOR EACH ROW WHEN (OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL)
  EXECUTE FUNCTION identity.broadcast_identity_removal();
CREATE POLICY identity_lifecycle_events_select ON realtime.messages FOR SELECT TO authenticated
  USING (topic='gugu:identity:lifecycle' AND identity.user_is_live(auth.uid()::text));

-- The global hint replaces the old owner-only notifications for this transition;
-- no per-group/per-contact semantic row or revision head is advanced on removal.
DO $identity_projections$
DECLARE r record; definition text; permission record;
BEGIN
  FOR r IN SELECT p.oid,p.oid::regprocedure AS signature,
      COALESCE(p.proacl,acldefault('f',p.proowner)) AS acl
    FROM pg_proc p WHERE p.oid IN (
      'identity.broadcast_user_agent_changed()'::regprocedure,
      'identity.publish_owned_agent_revision()'::regprocedure,
      'identity.build_agent_presence_payload(text)'::regprocedure,
      'identity.search_users(text)'::regprocedure,
      'chat.sync_snapshot()'::regprocedure)
  LOOP
    definition := pg_get_functiondef(r.oid);
    CASE r.signature::text
      WHEN 'identity.broadcast_user_agent_changed()', 'identity.publish_owned_agent_revision()' THEN
        definition := regexp_replace(definition,'\mBEGIN\M',
          'BEGIN' || chr(10) || '    IF TG_OP = ''UPDATE'' AND OLD.removed_at IS DISTINCT FROM NEW.removed_at THEN RETURN NEW; END IF;');
      WHEN 'identity.build_agent_presence_payload(text)' THEN
        definition := replace(definition, 'AND u.type = ''agent'';', 'AND u.type = ''agent'' AND identity.user_is_live(u.id);');
        definition := replace(definition, 'FROM identity.agent_lifecycle_tombstones t',
          'FROM (SELECT agent_user_id,removed_at FROM identity.agent_lifecycle_tombstones UNION ALL SELECT id,removed_at FROM identity.users WHERE removed_at IS NOT NULL AND type=''agent'') t');
      WHEN 'identity.search_users(text)' THEN
        definition := replace(definition,'WHERE u.id <> COALESCE(v_me, '''')',
          'WHERE identity.user_is_live(u.id) AND u.id <> COALESCE(v_me, '''')');
      WHEN 'chat.sync_snapshot()' THEN
        definition := replace(definition,'u.session_archived_at, u.session_lifecycle_revision,',
          'u.session_archived_at, u.session_lifecycle_revision, u.removed_at,');
    END CASE;
    IF definition=pg_get_functiondef(r.oid) THEN RAISE EXCEPTION 'Unexpected identity projection predecessor: %',r.signature; END IF;
    EXECUTE definition;
    FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable
      FROM aclexplode(r.acl) WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',r.signature,
        CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END $identity_projections$;

-- Fail at the existing admission boundaries, including direct/runtime calls
-- which do not need a chat membership (rather than reviving a retained row).
DO $live_admission$
DECLARE r record; definition text; previous text; permission record;
BEGIN
  FOR r IN SELECT p.oid,p.oid::regprocedure AS signature,
      COALESCE(p.proacl,acldefault('f',p.proowner)) AS acl
    FROM pg_proc p WHERE p.oid IN (
      'identity.set_agent_session_archival(text,text,uuid,bigint,timestamp with time zone,jsonb)'::regprocedure,
      'identity.storage_actor_is_live()'::regprocedure,
      'identity.assert_device_command_post_context(uuid,uuid,text,text,text,text[])'::regprocedure,
      'identity.assert_provision_owner_live(text)'::regprocedure,
      'identity.recheck_device_command_execution(uuid,uuid)'::regprocedure,
      'identity.settle_provision_cancellation(uuid)'::regprocedure,
      'chat.group_add_denial(text,text,text,boolean,boolean)'::regprocedure,
      'chat.gugu_can_send_as(text,text,text)'::regprocedure)
      OR (p.pronamespace='identity'::regnamespace
        AND p.proname IN ('create_owned_agent','provision_taskpage_agent')
        AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql'))
  LOOP
    definition:=pg_get_functiondef(r.oid); previous:=definition;
    CASE
      WHEN r.signature::text LIKE 'identity.create_owned_agent(%'
        OR r.signature::text LIKE 'identity.provision_taskpage_agent(%' THEN
        definition:=regexp_replace(definition,'\mBEGIN\M','BEGIN' || chr(10) ||
          '  IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id=p_agent_id::text AND u.removed_at IS NOT NULL) THEN RAISE EXCEPTION ''identity_removed: restoring requires a new identity'' USING ERRCODE = ''55000''; END IF;');
      WHEN r.signature::text LIKE 'identity.set_agent_session_archival(%' THEN
        definition:=regexp_replace(definition,'\mBEGIN\M','BEGIN' || chr(10) ||
          '  IF NOT identity.user_is_live(p_agent_user_id) THEN RAISE EXCEPTION ''identity_removed: restoring requires a new identity'' USING ERRCODE = ''55000''; END IF;');
      WHEN r.signature::text='identity.storage_actor_is_live()' THEN
        definition:=replace(definition,'WHERE id = actor_id AND type = ''human''',
          'WHERE id = actor_id AND type = ''human'' AND identity.user_is_live(id)');
      WHEN r.signature::text LIKE 'identity.assert_device_command_post_context(%' THEN
        definition:=replace(definition,'WHERE u.id = ANY(COALESCE(required_identity_ids, ARRAY[]::TEXT[]))',
          'WHERE identity.user_is_live(u.id) AND u.id = ANY(COALESCE(required_identity_ids, ARRAY[]::TEXT[]))');
      WHEN r.signature::text='identity.assert_provision_owner_live(text)' THEN
        definition:=replace(definition,'WHERE id = p_owner_user_id AND type = ''human''',
          'WHERE id = p_owner_user_id AND type = ''human'' AND identity.user_is_live(id)');
      WHEN r.signature::text='identity.recheck_device_command_execution(uuid,uuid)' THEN
        definition:=replace(definition,'IF command_row.type <> ''agent.deliver'' THEN RETURN true; END IF;',
          'IF NOT identity.user_is_live(command_row.user_id::text) OR (command_row.payload ? ''agent_user_id'' AND NOT identity.user_is_live(command_row.payload->>''agent_user_id'')) THEN RETURN false; END IF;' || chr(10) ||
          '    IF command_row.type <> ''agent.deliver'' THEN RETURN true; END IF;');
      WHEN r.signature::text='identity.settle_provision_cancellation(uuid)' THEN
        -- Old physical-removal postconditions remain valid for already-issued
        -- cancellation records; new archives prove termination on the identity.
        definition:=replace(definition,'IF v_removed THEN',
          'IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id=r.provisioned_agent_user_id::text AND u.owner_user_id=v_owner AND u.removed_at IS NOT NULL) THEN v_removed:=true; END IF;' || chr(10) ||
          '        IF v_removed THEN');
      WHEN r.signature::text LIKE 'chat.group_add_denial(%' THEN
        definition:=regexp_replace(definition,'\mBEGIN\M','BEGIN' || chr(10) ||
          '  IF NOT identity.user_is_live(p_actor_user_id) THEN RETURN ''actor_not_member''; END IF;' || chr(10) ||
          '  IF NOT identity.user_is_live(p_user_id) THEN RETURN ''user_removed''; END IF;');
      WHEN r.signature::text LIKE 'chat.gugu_can_send_as(%' THEN
        definition:=replace(definition,'SELECT EXISTS (', 'SELECT identity.user_is_live(p_owner_user_id) AND EXISTS (');
    END CASE;
    IF definition=previous THEN RAISE EXCEPTION 'Unexpected live admission predecessor: %',r.signature; END IF;
    EXECUTE definition;
    FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable
      FROM aclexplode(r.acl) WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',r.signature,
        CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END $live_admission$;

-- A retained DM seat is historical identity, never current member authority.
-- Only a current participant may resolve it; group rosters use active_members.
CREATE FUNCTION chat.historical_dm_peer(p_chat_id text)
RETURNS TABLE(user_id text,removed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT chat.is_member(p_chat_id) OR NOT EXISTS (
    SELECT 1 FROM chat.chats c WHERE c.id=p_chat_id AND c.kind IN ('dm','ai')) THEN
    RAISE EXCEPTION 'DM history is not visible to current user' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT u.id,u.removed_at FROM chat.chat_members m
    JOIN identity.users u ON u.id=m.user_id
    WHERE m.chat_id=p_chat_id AND m.user_id<>auth.uid()::text;
END;
$$;
REVOKE ALL ON FUNCTION chat.historical_dm_peer(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.historical_dm_peer(text) TO authenticated;
NOTIFY pgrst,'reload schema';
