-- Listen mode is an agent setting, independent of protected group roles.
-- Preserve human-owner control and reuse current source-group administration.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION chat.set_agent_listen_mode_as(p_chat_id TEXT, p_agent_user_id TEXT, p_mode TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id);
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM identity.users a JOIN identity.users h ON h.id = a.owner_user_id
        WHERE a.id = p_agent_user_id AND a.type = 'agent' AND h.type = 'human'
          AND (h.id = v_actor OR EXISTS (
              SELECT 1 FROM chat.management_authority(p_chat_id, v_actor) authority
              JOIN chat.chats c ON c.id = p_chat_id
              WHERE authority.source_kind = 'group' AND authority.can_manage AND c.status <> 'archived'
          ))
    ) THEN
        RAISE EXCEPTION 'agent_owner_or_group_manager_required' USING ERRCODE = '42501';
    END IF;
    IF p_mode IS NULL OR p_mode NOT IN ('active', 'passive') THEN RAISE EXCEPTION 'invalid_listen_mode'; END IF;
    UPDATE chat.chat_members SET listen_mode = p_mode WHERE chat_id = p_chat_id AND user_id = p_agent_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'group_member_not_found'; END IF;
    RETURN jsonb_build_object('chat_id', p_chat_id, 'user_id', p_agent_user_id, 'listen_mode', p_mode);
END;
$$;
REVOKE ALL ON FUNCTION chat.set_agent_listen_mode_as(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.set_agent_listen_mode_as(TEXT, TEXT, TEXT, TEXT) TO authenticated;
