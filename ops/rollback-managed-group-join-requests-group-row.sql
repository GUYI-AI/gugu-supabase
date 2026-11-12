-- Roll back 20261112130000_managed_group_join_requests_group_row: list_managed_group_join_requests exactly as
-- 20261112050000 created it (no group name/avatar, every membership checked). Run on that schema only.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION chat.list_managed_group_join_requests(BOOLEAN, TEXT);

CREATE FUNCTION chat.list_managed_group_join_requests(p_include_decided BOOLEAN, p_as_user_id TEXT)
RETURNS TABLE(
    id TEXT, chat_id TEXT, requester_user_id TEXT, requester_name TEXT, requester_avatar TEXT,
    message TEXT, status TEXT, created_at TIMESTAMPTZ,
    requester_type TEXT, requested_by_user_id TEXT, requested_by_name TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = chat, identity, public, pg_catalog
AS $$
DECLARE
    v_actor TEXT := chat.require_group_actor(p_as_user_id);
BEGIN
    RETURN QUERY
    SELECT r.id, r.chat_id, r.requester_user_id, u.display_name, u.avatar, r.message, r.status, r.created_at,
           u.type, r.requested_by_user_id, b.display_name
      FROM chat.active_members m
      JOIN chat.group_join_requests r ON r.chat_id = m.chat_id
      JOIN identity.users u ON u.id = r.requester_user_id
      LEFT JOIN identity.users b ON b.id = r.requested_by_user_id
     WHERE m.user_id = v_actor
       AND chat.group_is_manager(m.chat_id, v_actor)
       AND (p_include_decided OR r.status = 'pending')
     ORDER BY (r.status = 'pending') DESC, r.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION chat.list_managed_group_join_requests(BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_managed_group_join_requests(BOOLEAN, TEXT) TO authenticated;

COMMIT;
