-- A topic lives inside its source conversation. Archiving the source archives its topics, whichever path archives it:
-- a live topic under an archived source stays in its participants' lists, and opening it shows the source, which is gone.
-- Unarchiving the source restores exactly the topics its archive took, to the status they had; a topic archived on its own
-- stays archived. No topic is opened, or brought back, under an archived source.
-- The backfill is the next release: this one only takes the brief trigger lock on chat.chats.
SET LOCAL lock_timeout = '5s';

CREATE TABLE chat.topic_source_archives (
    topic_id TEXT PRIMARY KEY REFERENCES chat.chats(id) ON DELETE CASCADE,
    prior_status TEXT NOT NULL CHECK (prior_status IN ('active', 'stopped', 'paused'))
);
ALTER TABLE chat.topic_source_archives ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.topic_source_archives FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION chat.archive_topics_with_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.kind = 'topic' THEN
        -- A topic that is no longer archived owes nothing to its source's archive (restored, or unarchived by hand).
        IF NEW.status <> 'archived' THEN DELETE FROM chat.topic_source_archives WHERE topic_id = NEW.id; END IF;
    ELSIF NEW.status = 'archived' THEN
        INSERT INTO chat.topic_source_archives(topic_id, prior_status)
        SELECT id, status FROM chat.chats WHERE kind = 'topic' AND source_chat_id = NEW.id AND status <> 'archived'
        ON CONFLICT (topic_id) DO NOTHING;
        UPDATE chat.chats SET status = 'archived'
         WHERE kind = 'topic' AND source_chat_id = NEW.id AND status <> 'archived';
    ELSIF OLD.status = 'archived' THEN
        UPDATE chat.chats c SET status = a.prior_status
          FROM chat.topic_source_archives a
         WHERE a.topic_id = c.id AND c.source_chat_id = NEW.id AND c.status = 'archived';
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION chat.archive_topics_with_source() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER chats_archive_topics_with_source
AFTER UPDATE OF status ON chat.chats
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION chat.archive_topics_with_source();

-- A topic is opened or made live only while its source is not archived. FOR SHARE orders it against the source's archive:
-- an archive that commits first is seen here and refuses the topic; a topic that commits first is seen by the cascade.
CREATE FUNCTION chat.refuse_topic_under_archived_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_status TEXT;
BEGIN
    -- Lock first, then read: a status filter in the locking query would skip the row an uncommitted archive is changing.
    SELECT s.status INTO v_status FROM chat.chats s WHERE s.id = NEW.source_chat_id FOR SHARE;
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
