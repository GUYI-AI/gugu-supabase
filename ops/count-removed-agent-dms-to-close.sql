-- Read-only: how many seats ops/close-removed-agent-dms-backfill.sql would close, with the same predicate.
-- Writes nothing; safe on any environment.
BEGIN READ ONLY;
SELECT count(*) AS seats_to_close, count(DISTINCT t.user_id) AS accounts, count(DISTINCT t.agent_user_id) AS agents,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM chat.messages msg WHERE msg.chat_id = t.chat_id)) AS with_messages
  FROM (
    SELECT DISTINCT peer.chat_id, peer.user_id, agent.id AS agent_user_id
      FROM identity.users agent
      JOIN chat.chat_members seat ON seat.user_id = agent.id
      JOIN chat.chats c ON c.id = seat.chat_id AND c.kind = 'dm'
      JOIN chat.active_members peer ON peer.chat_id = c.id AND peer.user_id <> agent.id
     WHERE agent.type = 'agent' AND agent.removed_at IS NOT NULL
       AND peer.conversation_deleted_at IS NULL
  ) t;
ROLLBACK;
