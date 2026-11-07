-- Topics left active by sources archived before 20261107130000: archived as if their source's archive had taken them.
-- Its own release, after the triggers have committed: only row locks on the topics it changes, no table lock.
SET LOCAL lock_timeout = '5s';
INSERT INTO chat.topic_source_archives(topic_id, prior_status)
SELECT t.id, t.status FROM chat.chats t JOIN chat.chats s ON s.id = t.source_chat_id
 WHERE t.kind = 'topic' AND t.status = 'active' AND s.status = 'archived';
UPDATE chat.chats t SET status = 'archived'
  FROM chat.chats s
 WHERE t.kind = 'topic' AND t.source_chat_id = s.id AND s.status = 'archived' AND t.status = 'active';
