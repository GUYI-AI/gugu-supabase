-- Explicit recovery after a local project mapping failure. Local inventory
-- reconciliation does not authorize this operation; only the human owner does.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION chat.restore_group_as(p_chat_id TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id);
BEGIN
    PERFORM 1 FROM chat.chats c
      JOIN chat.chat_members m ON m.chat_id = c.id
      JOIN identity.users u ON u.id = m.user_id
    WHERE c.id = p_chat_id AND c.kind = 'group'
      AND m.user_id = v_actor AND m.role = 'owner' AND u.type = 'human'
    FOR UPDATE OF c;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'human_group_owner_required' USING ERRCODE = '42501';
    END IF;
    -- An already active group is a true no-op: no new revisions, timestamps,
    -- memberships or child-topic state. Repeated calls return the same receipt.
    UPDATE chat.chats SET status = 'active'
    WHERE id = p_chat_id AND status = 'archived';
    RETURN jsonb_build_object('chat_id', p_chat_id, 'status', 'active');
END;
$$;
REVOKE ALL ON FUNCTION chat.restore_group_as(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.restore_group_as(TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
