-- Topics left live by sources archived before 20261107130000, archived by the same rule as the cascade.
-- Its own release, after the triggers have committed: only row locks on the topics it changes, no table lock.
SET LOCAL lock_timeout = '5s';
UPDATE chat.chats t SET status = 'archived'
  FROM chat.chats s
 WHERE t.kind = 'topic' AND t.source_chat_id = s.id AND s.status = 'archived' AND t.status <> 'archived';
