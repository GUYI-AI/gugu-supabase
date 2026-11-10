-- Roll back 20261110030000_list_reserved_projects: list_my_projects lists only project groups that exist (its
-- 20261109210000 definition). Run on the release's own schema only.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION identity.list_my_projects() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE me text := auth.uid()::text;
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'chat_id', c.id, 'name', c.name, 'status', c.status, 'avatar_url', c.avatar_url,
            'created_at', c.created_at, 'last_message_at', c.last_message_at,
            'bindings', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'device_id', dp.device_id, 'local_project_id', dp.local_project_id, 'name', dp.name,
                    'root_path', dp.root_path, 'folders', dp.folders, 'created_at', dp.created_at,
                    'removal_requested_at', dp.removal_requested_at) ORDER BY dp.created_at)
                FROM identity.device_projects dp WHERE dp.chat_id = c.id AND dp.user_id::text = me), '[]'::jsonb)
        ) ORDER BY COALESCE(c.last_message_at, c.created_at) DESC)
        FROM chat.project_groups g JOIN chat.chats c ON c.id = g.chat_id
        WHERE c.kind = 'group' AND chat.is_project_owner(c.id, me)
    ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION identity.list_my_projects() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.list_my_projects() TO authenticated;
COMMIT;
