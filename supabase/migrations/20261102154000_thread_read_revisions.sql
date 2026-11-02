-- Thread read state must reach the same durable account journal as main-stream
-- reads. Keep the legacy broadcast intact for clients still listening to it.
CREATE FUNCTION chat.publish_member_stream_read_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    read_state chat.chat_member_stream_read_state%ROWTYPE;
BEGIN
    -- mark_stream_read first ensures a default row exists, then advances it.
    -- An absent row already means 0/false/v0, so initialization changes nothing.
    IF TG_OP = 'INSERT'
       AND NEW.last_read_seq = 0 AND NOT NEW.is_marked_unread AND NEW.version = 0 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.last_read_seq IS NOT DISTINCT FROM NEW.last_read_seq
       AND OLD.is_marked_unread IS NOT DISTINCT FROM NEW.is_marked_unread
       AND OLD.version IS NOT DISTINCT FROM NEW.version THEN
        RETURN NEW;
    END IF;

    -- Authenticated members may delete their own cursor under the existing RLS
    -- policy. Publish the removed row's key so clients reload the implicit cursor.
    IF TG_OP = 'DELETE' THEN
        read_state := OLD;
    ELSE
        read_state := NEW;
    END IF;

    -- The recipient is the read-state owner, never the whole group. The existing
    -- publisher filters out agents and sends im_revision_advanced after append.
    PERFORM chat.publish_user_revision(
        read_state.user_id,
        'member_stream_read_changed',
        jsonb_build_object(
            'chat_id', read_state.chat_id,
            'entity_id', read_state.user_id,
            'stream_id', read_state.stream_id,
            'stream_kind', read_state.stream_kind,
            'thread_root_id', read_state.thread_root_id,
            'last_read_seq', read_state.last_read_seq,
            'is_marked_unread', read_state.is_marked_unread,
            'version', read_state.version
        ),
        TG_OP = 'DELETE'
    );
    RETURN read_state;
END;
$$;
REVOKE ALL ON FUNCTION chat.publish_member_stream_read_revision() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.publish_member_stream_read_revision() TO service_role;

CREATE TRIGGER chat_member_stream_read_publish_account_revision
AFTER INSERT OR DELETE OR UPDATE OF last_read_seq, is_marked_unread, version
ON chat.chat_member_stream_read_state
FOR EACH ROW EXECUTE FUNCTION chat.publish_member_stream_read_revision();
