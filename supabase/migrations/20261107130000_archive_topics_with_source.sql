-- A topic lives inside its source conversation. Archiving the source archives its topics, whichever path archives it:
-- a live topic under an archived source stays in its participants' lists, and opening it shows the source, which is gone.
-- Unarchiving the source restores exactly the topics its archive took, to the status they had; a topic archived on its own
-- stays archived.
CREATE TABLE chat.topic_source_archives (
    topic_id TEXT PRIMARY KEY REFERENCES chat.chats(id) ON DELETE CASCADE,
    prior_status TEXT NOT NULL CHECK (prior_status IN ('active', 'stopped', 'paused'))
);
ALTER TABLE chat.topic_source_archives ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.topic_source_archives FROM PUBLIC, anon, authenticated;

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
REVOKE ALL ON FUNCTION chat.archive_topics_with_source() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER chats_archive_topics_with_source
AFTER UPDATE OF status ON chat.chats
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION chat.archive_topics_with_source();

-- Topics left active by sources archived before this release: archived as if their source's archive had taken them.
INSERT INTO chat.topic_source_archives(topic_id, prior_status)
SELECT t.id, t.status FROM chat.chats t JOIN chat.chats s ON s.id = t.source_chat_id
 WHERE t.kind = 'topic' AND t.status = 'active' AND s.status = 'archived';
UPDATE chat.chats t SET status = 'archived'
  FROM chat.chats s
 WHERE t.kind = 'topic' AND t.source_chat_id = s.id AND s.status = 'archived' AND t.status = 'active';
