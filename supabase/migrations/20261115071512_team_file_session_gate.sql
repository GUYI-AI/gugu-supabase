-- Existing delegated-actor helpers, active membership views and file service
-- authorization must observe a disabled team owner even outside PostgREST.
CREATE OR REPLACE FUNCTION identity.user_is_live(p_user_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id text; item identity.users;
BEGIN
  SELECT * INTO item FROM identity.users WHERE id=p_user_id;
  IF NOT FOUND OR item.removed_at IS NOT NULL THEN RETURN false; END IF;
  owner_id:=CASE WHEN item.type='agent' THEN item.owner_user_id ELSE item.id END;
  IF owner_id~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND team_private.principal_is_team(owner_id::uuid) THEN
    RETURN team_private.principal_is_active(owner_id::uuid);
  END IF;
  RETURN true;
END $$;
ALTER FUNCTION identity.user_is_live(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.user_is_live(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION identity.user_is_live(text) TO authenticated,service_role,gugu_files;

-- Only the trusted file server supplies the session_id it verified in the JWT.
-- Personal clients preserve the community behavior. No API role may name an
-- arbitrary user/session or call the file-server authorization capability.
CREATE FUNCTION chat.files_authorize(p_item_id uuid,p_user_id text,p_as_user_id text,p_auth_session text)
RETURNS TABLE(chat_id text,epoch integer,content_type text,kind text,actor_id text,actor_name text,team_session_required boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid;
BEGIN
  IF p_user_id!~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN; END IF;
  actor:=p_user_id::uuid;
  IF team_private.principal_is_team(actor) THEN
    IF NOT team_private.principal_is_active(actor) OR p_auth_session IS NULL
      OR p_auth_session!~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR NOT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=p_auth_session::uuid AND s.user_id=actor
        AND (s.not_after IS NULL OR s.not_after>now())) THEN RETURN; END IF;
  END IF;
  RETURN QUERY SELECT f.*,team_private.principal_is_team(actor) FROM chat.files_authorize(p_item_id,p_user_id,p_as_user_id) f;
END $$;
ALTER FUNCTION chat.files_authorize(uuid,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.files_authorize(uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.files_authorize(uuid,text,text,text) TO gugu_files;

CREATE FUNCTION team_private.notify_auth_session_closed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m record;
BEGIN
  IF team_private.principal_is_team(OLD.user_id) THEN
    PERFORM pg_notify('files_member_removed','team_session_closed');
    FOR m IN SELECT * FROM team_private.members WHERE principal_user_id=OLD.user_id LOOP
      PERFORM realtime.send(jsonb_build_object('session_ended',true),'team_context_changed',
        'gugu:team:'||m.team_id||':member:'||m.id||':r:'||m.revision||':session:'||OLD.id||':gugu:user:'||OLD.user_id||':events',true);
    END LOOP;
  END IF;
  RETURN OLD;
END $$;
ALTER FUNCTION team_private.notify_auth_session_closed() OWNER TO postgres;
REVOKE ALL ON FUNCTION team_private.notify_auth_session_closed() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER team_file_session_closed AFTER DELETE ON auth.sessions
  FOR EACH ROW EXECUTE FUNCTION team_private.notify_auth_session_closed();
