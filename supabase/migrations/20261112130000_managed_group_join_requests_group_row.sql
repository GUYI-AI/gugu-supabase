-- Managed join requests: each row names its group, and only the actor's owner/admin seats in groups are candidates.
--
-- 20261112050000 checked `chat.group_is_manager` once per membership of the actor (every DM, topic and member seat),
-- and returned rows without their group, so the client looked the group up in its own group list and dropped the rows
-- of groups its (possibly late) list did not have. This restates the function in full:
--   * candidates are the actor's owner/admin seats in groups (an indexed narrowing on the actor's memberships);
--     `group_is_manager` stays the final authority, so the rows and their authority are unchanged;
--   * each row carries `chat_name` and `chat_avatar_url`.
-- Measured as `authenticated` (10 managed groups, median of 7): 100 / 1000 / 5000 seats → 3.3 / 16.0 / 73.1 ms before,
-- 1.7 / 2.0 / 2.1 ms after. No released client calls this function yet, so its result shape can change.
-- Rollback: ops/rollback-managed-group-join-requests-group-row.sql.
SET LOCAL lock_timeout = '5s';

DROP FUNCTION chat.list_managed_group_join_requests(BOOLEAN, TEXT);

CREATE FUNCTION chat.list_managed_group_join_requests(p_include_decided BOOLEAN, p_as_user_id TEXT)
RETURNS TABLE(
    id TEXT, chat_id TEXT, chat_name TEXT, chat_avatar_url TEXT, requester_user_id TEXT, requester_name TEXT, requester_avatar TEXT,
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
    SELECT r.id, r.chat_id, c.name, c.avatar_url, r.requester_user_id, u.display_name, u.avatar, r.message, r.status, r.created_at,
           u.type, r.requested_by_user_id, b.display_name
      FROM chat.active_members m
      JOIN chat.chats c ON c.id = m.chat_id AND c.kind = 'group'
      JOIN chat.group_join_requests r ON r.chat_id = m.chat_id
      JOIN identity.users u ON u.id = r.requester_user_id
      LEFT JOIN identity.users b ON b.id = r.requested_by_user_id
     WHERE m.user_id = v_actor
       AND m.role IN ('owner', 'admin')
       AND chat.group_is_manager(m.chat_id, v_actor)
       AND (p_include_decided OR r.status = 'pending')
     ORDER BY (r.status = 'pending') DESC, r.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION chat.list_managed_group_join_requests(BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_managed_group_join_requests(BOOLEAN, TEXT) TO authenticated;
