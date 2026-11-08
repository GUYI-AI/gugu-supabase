-- One published chats change per message.
--
-- Inserting a message wrote chat.chats twice: the BEFORE INSERT seq allocation (assign_message_seq) and the AFTER
-- INSERT last-message update (update_chat_last_message). chats_publish_account_revision published each write, so
-- every member got message_created + 2 x chat_changed: 3 journal rows per member per message (504 in a 168-member group).
--
-- The seq allocation stays where it is: it must set NEW.seq before the row exists, and its row lock on the chat is
-- what serializes concurrent inserts (no duplicate or skipped seq). What changes is only who publishes:
--   * a chats update that changed nothing but next_message_seq is not published by itself;
--   * the AFTER INSERT write is the message's one published chats change, so it also carries the new
--     next_message_seq. A whisper does not move the shared preview, so for it the write bumps updated_at only:
--     members who cannot see the whisper still learn the new seq, as before.
-- Result: message_created + 1 x chat_changed = 2 rows per member. The AFTER write only runs for a row that was
-- actually inserted, so a deduplicated retry (ON CONFLICT DO NOTHING) still leaves the preview alone.

CREATE OR REPLACE FUNCTION chat.publish_chat_row_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'chat', 'public', 'pg_catalog'
    AS $$
DECLARE
    target_chat_id TEXT := COALESCE(NEW.id, OLD.id);
BEGIN
    -- The seq allocation of a message insert; the insert's own AFTER write publishes it (update_chat_last_message).
    -- Only a write that moved next_message_seq and nothing else; an unchanged-row write (two equal messages in one
    -- transaction) is still published, as it always was.
    IF TG_OP = 'UPDATE' AND NEW.next_message_seq IS DISTINCT FROM OLD.next_message_seq
       AND to_jsonb(NEW) - 'next_message_seq' = to_jsonb(OLD) - 'next_message_seq' THEN
        RETURN NEW;
    END IF;
    PERFORM chat.broadcast_to_chat_member_user_events(
      target_chat_id,
      'chat_changed',
      jsonb_build_object('op', lower(TG_OP), 'chat', to_jsonb(COALESCE(NEW, OLD)))
    );
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION chat.update_chat_last_message() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'chat', 'public'
    AS $$
BEGIN
    IF NEW.is_whisper THEN
        -- whisper 不进共享预览;这一次写只为把分配过的 seq 发布出去(见文件头)。
        UPDATE chat.chats SET updated_at = now() WHERE id = NEW.chat_id;
        RETURN NEW;
    END IF;
    UPDATE chat.chats
    SET
        last_message_at      = NEW.created_at,
        last_message_preview = chat.message_preview(NEW.content, NEW.content_type),
        updated_at           = now()
    WHERE id = NEW.chat_id;
    RETURN NEW;
END;
$$;
