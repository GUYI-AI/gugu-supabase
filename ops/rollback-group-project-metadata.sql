-- Apply only through the approved rollback workflow. Older clients ignore the added key;
-- clients without this key retain their existing local project-group judgment.
-- Keep the release ledger intact. No membership, project binding or admission rule changes.
BEGIN;
CREATE OR REPLACE FUNCTION chat.group_info_as(p_chat_id TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id); v_group chat.chats%ROWTYPE; v_authority RECORD;
BEGIN
    SELECT * INTO v_group FROM chat.chats WHERE id = p_chat_id AND kind IN ('group', 'topic');
    IF NOT FOUND OR NOT (
        chat.is_chat_member(p_chat_id, v_actor) OR chat.is_chat_member(p_chat_id, auth.uid()::text)
        OR (v_group.kind = 'topic' AND (chat.is_chat_member(v_group.source_chat_id, v_actor)
            OR chat.is_chat_member(v_group.source_chat_id, auth.uid()::text)))
    ) THEN RAISE EXCEPTION 'group_not_visible' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v_authority FROM chat.management_authority(p_chat_id, v_actor);
    RETURN jsonb_build_object(
        'id', v_group.id, 'public_id', v_group.public_id, 'creator_user_id', v_group.creator_user_id,
        'name', v_group.name, 'status', v_group.status, 'group_prompt', v_group.group_prompt,
        'default_agent_type', v_group.default_agent_type, 'join_token', v_group.join_token,
        'description', v_group.description, 'max_members', v_group.max_members,
        'allow_member_invite', v_group.allow_member_invite, 'invite_link_enabled', v_group.invite_link_enabled,
        'agent_join_approval', v_group.agent_join_approval, 'join_mode', v_group.join_mode,
        'hide_history', v_group.hide_history, 'avatar_url', v_group.avatar_url,
        'is_discoverable', v_group.is_discoverable, 'agent_flood_threshold', v_group.agent_flood_threshold,
        'agent_flood_threshold_effective', chat.agent_flood_threshold_for(p_chat_id),
        'my_role', v_authority.my_role, 'can_manage', COALESCE(v_authority.can_manage, false),
        'can_archive_topic', v_group.kind = 'topic' AND COALESCE(v_authority.can_manage, false),
        'can_dissolve', v_group.kind = 'group' AND COALESCE(v_authority.my_role = 'owner', false)
    );
END;
$$;
REVOKE ALL ON FUNCTION chat.group_info_as(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.group_info_as(TEXT, TEXT) TO authenticated;
COMMIT;
