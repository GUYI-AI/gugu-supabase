-- Join requests of every group the actor manages, in one read.
--
-- The client lists join requests for each group it manages (the inbox of "new requests"). With only the
-- per-group `list_group_join_requests`, that is one round trip per managed group on every start and on
-- every request change. This returns the same rows for all of them at once.
--
-- Authority is the per-group function's, applied to each group: the actor passes `require_group_actor`,
-- and a group is included only when `chat.group_is_manager(group, actor)` holds — the predicate
-- `require_group_manager` uses for groups (owner/admin of a non-archived group). Candidates come from the
-- actor's own memberships, so the read is bounded by the actor's groups, not by the table.
-- Additive only: `list_group_join_requests` is unchanged for released clients.

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
