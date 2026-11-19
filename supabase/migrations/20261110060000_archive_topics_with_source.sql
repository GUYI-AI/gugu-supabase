-- A topic lives inside its source conversation. Archiving the source archives its topics, whichever path archives it:
-- a live topic under an archived source stays in its participants' lists, and opening it shows the source, which is gone.
-- No topic is opened, or made live again, under an archived source. Archival is one-way (20261105100000_gone_conversation_bytes).
-- The backfill is the next release: this one only takes the brief trigger lock on chat.chats.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION chat.archive_topics_with_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    UPDATE chat.chats SET status = 'archived'
     WHERE kind = 'topic' AND source_chat_id = NEW.id AND status <> 'archived';
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION chat.archive_topics_with_source() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER chats_archive_topics_with_source
AFTER UPDATE OF status ON chat.chats
FOR EACH ROW WHEN (NEW.status = 'archived' AND OLD.status IS DISTINCT FROM 'archived' AND NEW.kind <> 'topic')
EXECUTE FUNCTION chat.archive_topics_with_source();

-- A topic is opened or made live only while its source is not archived. The source row is locked FOR NO KEY UPDATE, the
-- lock create_topic's notice into the source takes anyway (a weaker FOR SHARE here deadlocks two concurrent openers when
-- both upgrade). It also orders the topic against the source's archive: an archive that commits first is seen here and
-- refuses the topic; a topic that commits first is seen by the cascade.
CREATE FUNCTION chat.refuse_topic_under_archived_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_status TEXT;
BEGIN
    -- Lock first, then read: a status filter in the locking query would skip the row an uncommitted archive is changing.
    SELECT s.status INTO v_status FROM chat.chats s WHERE s.id = NEW.source_chat_id FOR NO KEY UPDATE;
    IF v_status = 'archived' THEN
        RAISE EXCEPTION 'Source conversation % is archived', NEW.source_chat_id USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.refuse_topic_under_archived_source() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER chats_refuse_topic_under_archived_source
BEFORE INSERT OR UPDATE OF status, source_chat_id ON chat.chats
FOR EACH ROW WHEN (NEW.kind = 'topic' AND NEW.status <> 'archived')
EXECUTE FUNCTION chat.refuse_topic_under_archived_source();
