-- Realtime caches subscription authorization. A live RLS predicate alone
-- cannot evict an old connection: publishers must leave its namespace behind.
CREATE FUNCTION identity.team_realtime_namespace_for(p_actor uuid,p_session_id uuid DEFAULT NULL) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT 'gugu:team:'||m.team_id||':member:'||m.id||':r:'||m.revision||':session:'||s.id||':'
    FROM team_private.members m JOIN auth.sessions s ON s.user_id=m.principal_user_id
    WHERE m.principal_user_id=p_actor AND s.id=p_session_id AND (s.not_after IS NULL OR s.not_after>now())
      AND team_private.principal_is_active(p_actor)
$$;
ALTER FUNCTION identity.team_realtime_namespace_for(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.team_realtime_namespace_for(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.team_realtime_namespace_for(uuid,uuid) TO service_role;

CREATE FUNCTION team_private.event_topics(p_topic text) RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text; prefix text; recipient uuid; sid uuid; family text;
BEGIN
  IF p_topic IS NULL OR p_topic LIKE 'gugu:team:%' THEN
    RAISE EXCEPTION 'expected an original realtime topic' USING ERRCODE='22023';
  END IF;
  IF p_topic~'^gugu:user:[^:]+:(events|agents)$' THEN actor:=split_part(p_topic,':',3);
  ELSIF p_topic~'^gugu:[^:]+:(commands|rpc(:[^:]+)*)$' THEN
    SELECT d.user_id::text INTO actor FROM identity.gugu_devices d WHERE d.device_id=split_part(p_topic,':',2);
  END IF;
  IF actor IS NOT NULL THEN
    IF actor~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND team_private.principal_is_team(actor::uuid) THEN
      FOR sid IN SELECT s.id FROM auth.sessions s WHERE s.user_id=actor::uuid AND (s.not_after IS NULL OR s.not_after>now()) LOOP
        prefix:=identity.team_realtime_namespace_for(actor::uuid,sid);
        IF prefix IS NOT NULL THEN RETURN NEXT prefix||p_topic; END IF;
      END LOOP;
      RETURN;
    END IF;
    RETURN NEXT p_topic; RETURN;
  END IF;

  -- Existing personal subscribers retain their original shared topics. Team
  -- subscribers can only join their own current private namespace below.
  RETURN NEXT p_topic;
  family:=CASE WHEN p_topic~'^gugu:preview:[^:]+:[^:]+$' THEN 'preview'
    WHEN p_topic~'^agent:[^:]+:presence$' THEN 'presence'
    WHEN p_topic='gugu:identity:lifecycle' OR p_topic~'^gugu:forum:[^:]+$' THEN 'global' END;
  IF family IS NULL THEN RETURN; END IF;
  FOR recipient,sid IN SELECT m.principal_user_id,s.id FROM team_private.members m
    JOIN auth.sessions s ON s.user_id=m.principal_user_id AND (s.not_after IS NULL OR s.not_after>now())
    WHERE m.principal_user_id IS NOT NULL AND team_private.principal_is_active(m.principal_user_id)
      AND (family='global' OR family='preview' AND EXISTS(SELECT 1 FROM chat.chat_members cm JOIN identity.users u ON u.id=cm.user_id
        WHERE cm.chat_id=split_part(p_topic,':',3) AND u.removed_at IS NULL
          AND (u.id=m.principal_user_id::text OR u.owner_user_id=m.principal_user_id::text))
        OR family='presence' AND (EXISTS(SELECT 1 FROM identity.users u WHERE u.id=split_part(p_topic,':',2)
            AND u.type='agent' AND u.owner_user_id=m.principal_user_id::text)
          OR EXISTS(SELECT 1 FROM identity.friendships f
            WHERE (f.user_a_id=m.principal_user_id::text AND f.user_b_id=split_part(p_topic,':',2))
              OR (f.user_b_id=m.principal_user_id::text AND f.user_a_id=split_part(p_topic,':',2)))
          OR EXISTS(SELECT 1 FROM chat.chat_members self JOIN chat.chat_members agent ON agent.chat_id=self.chat_id
            WHERE self.user_id=m.principal_user_id::text AND agent.user_id=split_part(p_topic,':',2))
          OR EXISTS(SELECT 1 FROM identity.agent_lifecycle_tombstones t WHERE t.agent_user_id=split_part(p_topic,':',2)
            AND t.presence_viewer_user_ids @> ARRAY[m.principal_user_id::text])))
  LOOP
    RETURN NEXT identity.team_realtime_namespace_for(recipient,sid)||p_topic;
  END LOOP;
END $$;
ALTER FUNCTION team_private.event_topics(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION team_private.event_topics(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.send_team_realtime(p_payload jsonb,p_event text,p_topic text,p_private boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target text;
BEGIN
  IF p_private IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'community realtime events must be private' USING ERRCODE='22023';
  END IF;
  FOR target IN SELECT team_private.event_topics(p_topic) LOOP
    PERFORM realtime.send(p_payload,p_event,target,true);
  END LOOP;
END $$;
ALTER FUNCTION identity.send_team_realtime(jsonb,text,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.send_team_realtime(jsonb,text,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.send_team_realtime(jsonb,text,text,boolean) TO service_role;

-- Replace only calls in the installed community producers, preserving their
-- bodies, signatures, ownership, security attributes and exact EXECUTE roles.
DO $$ DECLARE r record; old_grants record; definition text; entry jsonb; grants jsonb; BEGIN
  FOR r IN SELECT p.oid,p.oid::regprocedure signature,p.prosrc FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('chat','identity','moments','public')
      AND p.prosrc LIKE '%realtime.send(%' AND p.oid<>'identity.send_team_realtime(jsonb,text,text,boolean)'::regprocedure
  LOOP
    SELECT pg_get_functiondef(r.oid),COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantable',a.is_grantable))
      FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.privilege_type='EXECUTE'),'[]'::jsonb)
      INTO definition,grants FROM pg_proc p WHERE p.oid=r.oid;
    EXECUTE replace(definition,r.prosrc,replace(r.prosrc,'realtime.send(','identity.send_team_realtime('));
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,gugu_files',r.signature);
    FOR entry IN SELECT value FROM jsonb_array_elements(grants) LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',r.signature,
        CASE WHEN entry->>'role'='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(entry->>'role') END,
        CASE WHEN (entry->>'grantable')::boolean THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END $$;

CREATE FUNCTION identity.team_realtime_access(p_topic text,p_write boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prefix text; original text; actor uuid:=auth.uid();
BEGIN
  IF NOT identity.team_session_is_active() OR NOT team_private.principal_is_team(actor) THEN RETURN false; END IF;
  prefix:=identity.team_realtime_namespace_for(actor,(auth.jwt()->>'session_id')::uuid);
  IF prefix IS NULL OR left(p_topic,length(prefix)) IS DISTINCT FROM prefix THEN RETURN false; END IF;
  original:=substr(p_topic,length(prefix)+1);
  IF original~'^gugu:[^:]+:rpc(:[^:]+)*$' OR NOT p_write AND original~'^gugu:[^:]+:commands$' THEN
    RETURN EXISTS(SELECT 1 FROM identity.gugu_devices d WHERE d.device_id=split_part(original,':',2) AND d.user_id=actor);
  END IF;
  IF original~'^gugu:preview:[^:]+:[^:]+$' THEN
    RETURN chat.is_chat_member(split_part(original,':',3),split_part(original,':',4))
      AND (identity.can_write_agent_runtime_state(split_part(original,':',4))
        OR NOT p_write AND chat.is_member(split_part(original,':',3)));
  END IF;
  IF p_write THEN RETURN false; END IF;
  IF original IN ('gugu:user:'||actor||':events','gugu:user:'||actor||':agents','gugu:identity:lifecycle') THEN RETURN true; END IF;
  IF original~'^agent:[^:]+:presence$' THEN RETURN identity.can_view_agent_runtime_state(split_part(original,':',2)); END IF;
  RETURN original~'^gugu:forum:[^:]+$';
END $$;
ALTER FUNCTION identity.team_realtime_access(text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.team_realtime_access(text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION identity.team_realtime_access(text,boolean) TO authenticated,service_role;

CREATE FUNCTION identity.team_realtime_fence(p_topic text,p_write boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT identity.team_session_is_active() AND CASE WHEN team_private.principal_is_team(auth.uid())
    THEN NOT p_write AND identity.team_realtime_access(p_topic,false) ELSE p_topic NOT LIKE 'gugu:team:%' END
$$;
ALTER FUNCTION identity.team_realtime_fence(text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.team_realtime_fence(text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION identity.team_realtime_fence(text,boolean) TO authenticated,service_role;
CREATE POLICY team_realtime_fence ON realtime.messages AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT identity.team_realtime_fence(topic,false))) WITH CHECK ((SELECT identity.team_realtime_fence(topic,true)));
CREATE POLICY team_realtime_read ON realtime.messages FOR SELECT TO authenticated
  USING ((SELECT identity.team_realtime_access(topic,false)));
-- Never cache a team's raw WebSocket publish permission: an already joined
-- sender could otherwise keep broadcasting to its old namespace after revoke.
-- Only the current-session RPC below publishes team client messages.

-- Clients send device RPCs and previews through this current-session gate so a broadcast
-- is fanned to each recipient's current namespace instead of a shared old one.
CREATE FUNCTION public.team_publish_realtime(p_topic text,p_payload jsonb,p_event text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE prefix text;
BEGIN
  IF NOT identity.team_session_is_active() OR NOT team_private.principal_is_team(auth.uid())
    OR p_topic IS NULL OR p_payload IS NULL OR octet_length(p_payload::text)>1048576
    OR p_event IS NULL OR length(p_event) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'team_broadcast_denied' USING ERRCODE='42501';
  END IF;
  prefix:=identity.team_realtime_namespace_for(auth.uid(),(auth.jwt()->>'session_id')::uuid);
  IF NOT identity.team_realtime_access(prefix||p_topic,true) THEN
    RAISE EXCEPTION 'team_broadcast_denied' USING ERRCODE='42501';
  END IF;
  PERFORM identity.send_team_realtime(p_payload,p_event,p_topic,true);
END $$;
ALTER FUNCTION public.team_publish_realtime(text,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.team_publish_realtime(text,jsonb,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.team_publish_realtime(text,jsonb,text) TO authenticated;

-- An old channel receives only this content-free invalidation. No ordinary
-- producer can publish new content to a disabled/revision-stale namespace.
CREATE FUNCTION team_private.notify_member_gate_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sid uuid;
BEGIN
  IF OLD.principal_user_id IS NOT NULL AND (OLD.state,OLD.revision) IS DISTINCT FROM (NEW.state,NEW.revision) THEN
    FOR sid IN SELECT s.id FROM auth.sessions s WHERE s.user_id=OLD.principal_user_id LOOP
      PERFORM realtime.send(jsonb_build_object('membership_revision',NEW.revision,'state',NEW.state),
        'team_context_changed','gugu:team:'||OLD.team_id||':member:'||OLD.id||':r:'||OLD.revision||':session:'||sid||':gugu:user:'||OLD.principal_user_id||':events',true);
    END LOOP;
    PERFORM pg_notify('files_member_removed',jsonb_build_object('team_member_id',NEW.id)::text);
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION team_private.notify_member_gate_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION team_private.notify_member_gate_change() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER team_member_gate_changed AFTER UPDATE OF state,revision ON team_private.members
  FOR EACH ROW EXECUTE FUNCTION team_private.notify_member_gate_change();
