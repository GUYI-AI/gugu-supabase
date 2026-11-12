-- Undo ops/close-removed-agent-dms-backfill.sql: reopen exactly the seats that run closed, unless the
-- member changed them since (deleted again or reopened); those are left as they are and counted.
-- The backup rows stay, marked rolled_back_at, as the record of both runs.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DROP TABLE IF EXISTS pg_temp.reopen_targets;
CREATE TEMP TABLE reopen_targets ON COMMIT DROP AS
  SELECT b.chat_id, b.user_id, b.closed_at, (m.conversation_deleted_at = b.closed_at) AS untouched
    FROM chat_private.removed_agent_dm_close_backup b
    LEFT JOIN chat.chat_members m ON m.chat_id = b.chat_id AND m.user_id = b.user_id
   WHERE b.rolled_back_at IS NULL;

DO $locks$
BEGIN
  PERFORM 1 FROM chat.chats c WHERE c.id IN (SELECT chat_id FROM reopen_targets) ORDER BY c.id FOR UPDATE;
  PERFORM chat.lock_revision_heads(ARRAY(SELECT DISTINCT m.user_id FROM chat.active_members m
    WHERE m.chat_id IN (SELECT chat_id FROM reopen_targets) ORDER BY 1));
END $locks$;

UPDATE chat.chat_members m SET conversation_deleted_at = NULL
  FROM reopen_targets t
 WHERE t.untouched AND m.chat_id = t.chat_id AND m.user_id = t.user_id AND m.conversation_deleted_at = t.closed_at;

UPDATE chat_private.removed_agent_dm_close_backup b SET rolled_back_at = clock_timestamp()
  FROM reopen_targets t WHERE b.chat_id = t.chat_id AND b.user_id = t.user_id AND b.closed_at = t.closed_at;

SELECT count(*) FILTER (WHERE untouched) AS seats_reopened, count(*) FILTER (WHERE untouched IS NOT TRUE) AS seats_changed_since_left_alone
  FROM reopen_targets;

COMMIT;
