-- publish_user_revision delegates validation and writes to append_user_revision.
-- Keep the installed human-only recipient rule and the existing function attributes.
DO $migration$
DECLARE
    definition TEXT := pg_get_functiondef('chat.append_user_revision(text,text,jsonb,boolean)'::regprocedure);
    anchor CONSTANT TEXT := '''message_deleted'',';
BEGIN
    IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
        RAISE EXCEPTION 'expected one message_deleted event in append_user_revision';
    END IF;
    EXECUTE replace(definition, anchor, anchor || E'\n      ''messages_cleared'',');
END;
$migration$;

-- The same captured boundary governs both the update and the private revision.
CREATE OR REPLACE FUNCTION chat.clear_messages_for_me(p_chat_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'chat', 'public'
    AS $$
DECLARE
    v_uid TEXT := (SELECT auth.uid()::text);
    v_through_seq BIGINT;
BEGIN
    IF NOT chat.is_member(p_chat_id) THEN
        RAISE EXCEPTION 'not a member of chat: %', p_chat_id;
    END IF;

    SELECT COALESCE(MAX(m.seq), 0) INTO v_through_seq
    FROM chat.messages m WHERE m.chat_id = p_chat_id;

    UPDATE chat.messages
    SET
        deleted_for_user_ids =
            CASE
                WHEN deleted_for_user_ids @> jsonb_build_array(v_uid) THEN deleted_for_user_ids
                ELSE deleted_for_user_ids || jsonb_build_array(v_uid)
            END,
        updated_at = now()
    WHERE chat_id = p_chat_id
      AND seq <= v_through_seq
      AND deleted_at IS NULL;

    PERFORM chat.publish_user_revision(v_uid, 'messages_cleared',
        jsonb_build_object('chat_id', p_chat_id, 'through_seq', v_through_seq), true);
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
