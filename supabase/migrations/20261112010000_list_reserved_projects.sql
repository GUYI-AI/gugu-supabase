-- identity.list_my_projects also lists a project whose group id is reserved but whose group does not exist yet
-- (older clients reserve the id first; the group is created when the first agent joins). Such a project already has a
-- chat.project_groups row (20261109210000) and a device row of the caller binding it, but list_my_projects joined
-- chat.chats, so it was missing from the account's project list while the machine still showed it.
-- It is listed by the name on the caller's device row (there is no group name yet), status active, no folders lost.
-- Same output shape; replacing the function locks no table.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION identity.list_my_projects() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE me text := auth.uid()::text;
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(p.row ORDER BY p.active_at DESC)
        FROM (
            SELECT jsonb_build_object(
                'chat_id', c.id, 'name', c.name, 'status', c.status, 'avatar_url', c.avatar_url,
                'created_at', c.created_at, 'last_message_at', c.last_message_at,
                'bindings', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'device_id', dp.device_id, 'local_project_id', dp.local_project_id, 'name', dp.name,
                        'root_path', dp.root_path, 'folders', dp.folders, 'created_at', dp.created_at,
                        'removal_requested_at', dp.removal_requested_at) ORDER BY dp.created_at)
                    FROM identity.device_projects dp WHERE dp.chat_id = c.id AND dp.user_id::text = me), '[]'::jsonb)
            ) AS row, COALESCE(c.last_message_at, c.created_at) AS active_at
            FROM chat.project_groups g JOIN chat.chats c ON c.id = g.chat_id
            WHERE c.kind = 'group' AND chat.is_project_owner(c.id, me)
            UNION ALL
            -- Reserved: recorded, no group yet, bound by one of the caller's devices.
            SELECT jsonb_build_object(
                'chat_id', g.chat_id, 'name', b.bindings -> 0 ->> 'name', 'status', 'active', 'avatar_url', NULL,
                'created_at', b.first_at, 'last_message_at', NULL, 'bindings', b.bindings
            ), b.first_at
            FROM chat.project_groups g
            CROSS JOIN LATERAL (
                SELECT jsonb_agg(jsonb_build_object(
                           'device_id', dp.device_id, 'local_project_id', dp.local_project_id, 'name', dp.name,
                           'root_path', dp.root_path, 'folders', dp.folders, 'created_at', dp.created_at,
                           'removal_requested_at', dp.removal_requested_at) ORDER BY dp.created_at) AS bindings,
                       min(dp.created_at) AS first_at
                FROM identity.device_projects dp WHERE dp.chat_id = g.chat_id AND dp.user_id::text = me
            ) b
            WHERE b.bindings IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = g.chat_id)
        ) p
    ), '[]'::jsonb);
END;
$$;
-- The installation event trigger closes replaced functions; restate the grant.
REVOKE ALL ON FUNCTION identity.list_my_projects() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.list_my_projects() TO authenticated;
