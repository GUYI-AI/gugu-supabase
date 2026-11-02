-- Thread read state must reach the same durable account journal as main-stream
-- reads. Keep the legacy broadcast intact for clients still listening to it.
CREATE FUNCTION chat.publish_member_stream_read_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.last_read_seq IS NOT DISTINCT FROM NEW.last_read_seq
       AND OLD.is_marked_unread IS NOT DISTINCT FROM NEW.is_marked_unread
       AND OLD.version IS NOT DISTINCT FROM NEW.version THEN
        RETURN NEW;
    END IF;

    -- The recipient is the read-state owner, never the whole group. The existing
    -- publisher filters out agents and sends im_revision_advanced after append.
    PERFORM chat.publish_user_revision(
        NEW.user_id,
        'member_stream_read_changed',
        jsonb_build_object(
            'chat_id', NEW.chat_id,
            'entity_id', NEW.user_id,
            'stream_id', NEW.stream_id,
            'stream_kind', NEW.stream_kind,
            'thread_root_id', NEW.thread_root_id,
            'last_read_seq', NEW.last_read_seq,
            'is_marked_unread', NEW.is_marked_unread,
            'version', NEW.version
        ),
        false
    );
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.publish_member_stream_read_revision() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.publish_member_stream_read_revision() TO service_role;

CREATE TRIGGER chat_member_stream_read_publish_account_revision
AFTER INSERT OR UPDATE OF last_read_seq, is_marked_unread, version
ON chat.chat_member_stream_read_state
FOR EACH ROW EXECUTE FUNCTION chat.publish_member_stream_read_revision();
