-- Clearing a chat reuses the deletion event understood by every client.
-- Publish only rows marked by this update, within the captured seq boundary.
CREATE OR REPLACE FUNCTION chat.clear_messages_for_me(p_chat_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'chat', 'public'
    AS $$
DECLARE
    v_uid TEXT := (SELECT auth.uid()::text);
    v_through_seq BIGINT;
    v_message_id TEXT;
    v_last_revision BIGINT;
BEGIN
    IF NOT chat.is_member(p_chat_id) THEN
        RAISE EXCEPTION 'not a member of chat: %', p_chat_id;
    END IF;

    SELECT COALESCE(MAX(m.seq), 0) INTO v_through_seq
    FROM chat.messages m WHERE m.chat_id = p_chat_id;

    FOR v_message_id IN
        WITH cleared AS (
            UPDATE chat.messages
            SET deleted_for_user_ids = deleted_for_user_ids || jsonb_build_array(v_uid),
                updated_at = now()
            WHERE chat_id = p_chat_id
              AND seq <= v_through_seq
              AND deleted_at IS NULL
              AND NOT deleted_for_user_ids @> jsonb_build_array(v_uid)
            RETURNING id, seq
        )
        SELECT id FROM cleared ORDER BY seq
    LOOP
        v_last_revision := chat.append_user_revision(v_uid, 'message_deleted',
            jsonb_build_object('chat_id', p_chat_id, 'entity_id', v_message_id), true);
    END LOOP;

    IF v_last_revision IS NOT NULL THEN
        PERFORM chat.send_user_event(
            jsonb_build_object('revision', v_last_revision), 'im_revision_advanced',
            'gugu:user:' || v_uid || ':events', true);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION chat.delete_message(p_message_id text) RETURNS TABLE(chat_id text, globally_deleted boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'chat', 'public'
    AS $$
DECLARE
    v_uid       TEXT := (SELECT auth.uid()::text);
    v_chat_id   TEXT;
    v_sender_id TEXT;
BEGIN
    SELECT m.chat_id, m.sender_user_id
    INTO v_chat_id, v_sender_id
    FROM chat.messages m
    WHERE m.id = p_message_id
      AND m.deleted_at IS NULL;

    IF v_chat_id IS NULL THEN
        RAISE EXCEPTION 'message not found: %', p_message_id;
    END IF;

    IF NOT chat.is_member(v_chat_id) THEN
        RAISE EXCEPTION 'not a member of chat: %', v_chat_id;
    END IF;

    IF v_sender_id = v_uid THEN
        UPDATE chat.messages
        SET
            deleted_at = now(),
            updated_at = now()
        WHERE id = p_message_id;
        PERFORM chat.recompute_chat_last_message(v_chat_id);
        RETURN QUERY SELECT v_chat_id, TRUE;
        RETURN;
    END IF;

    UPDATE chat.messages
    SET
        deleted_for_user_ids =
            CASE
                WHEN deleted_for_user_ids @> jsonb_build_array(v_uid) THEN deleted_for_user_ids
                ELSE deleted_for_user_ids || jsonb_build_array(v_uid)
            END,
        updated_at = now()
    WHERE id = p_message_id;

    PERFORM chat.publish_user_revision(v_uid, 'message_deleted',
        jsonb_build_object('chat_id', v_chat_id, 'entity_id', p_message_id), true);

    RETURN QUERY SELECT v_chat_id, FALSE;
END;
$$;

REVOKE ALL ON FUNCTION chat.clear_messages_for_me(TEXT), chat.delete_message(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.clear_messages_for_me(TEXT), chat.delete_message(TEXT) TO authenticated;
