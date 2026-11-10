-- One-time cleanup for #228 (20261109200000_close_removed_agent_dms): agents removed before that
-- release still have open DMs. Close them for the other member exactly as archive_user now does at
-- removal: set conversation_deleted_at on the other live member's seat in each kind='dm' chat where
-- the removed agent holds a seat. Seats that are already deleted keep their time. Messages, seats,
-- identities, groups and topics are not touched; history stays readable (see #228).
--
-- Run only after 20261109200000 is installed. Rehearse first with the same body ending in ROLLBACK
-- instead of COMMIT; the final SELECT reports what would change. Undo with
-- ops/rollback-close-removed-agent-dms-backfill.sql. A second run refuses while an applied run is
-- recorded (roll it back first), so the backup always describes one run. Count first, read-only:
-- ops/count-removed-agent-dms-to-close.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
BEGIN
  -- Nested: the table may not exist yet, and the inner query is planned only when it does.
  IF to_regclass('chat_private.removed_agent_dm_close_backup') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM chat_private.removed_agent_dm_close_backup WHERE rolled_back_at IS NULL) THEN
      RAISE EXCEPTION 'removed_agent_dm_close_backup holds an applied run; roll it back or keep it before running again';
    END IF;
  END IF;
END $guard$;

-- The backup lives beside the other unexposed definer helpers; no API role can read or write it.
CREATE TABLE IF NOT EXISTS chat_private.removed_agent_dm_close_backup (
  chat_id text NOT NULL,
  user_id text NOT NULL,
  agent_user_id text NOT NULL,
  closed_at timestamptz NOT NULL,
  rolled_back_at timestamptz,
  PRIMARY KEY (chat_id, user_id, closed_at)
);
REVOKE ALL ON chat_private.removed_agent_dm_close_backup FROM PUBLIC, anon, authenticated, service_role, gugu_files;

DROP TABLE IF EXISTS pg_temp.close_targets;
CREATE TEMP TABLE close_targets ON COMMIT DROP AS
  SELECT DISTINCT peer.chat_id, peer.user_id, agent.id AS agent_user_id
    FROM identity.users agent
    JOIN chat.chat_members seat ON seat.user_id = agent.id
    JOIN chat.chats c ON c.id = seat.chat_id AND c.kind = 'dm'
    JOIN chat.active_members peer ON peer.chat_id = c.id AND peer.user_id <> agent.id
   WHERE agent.type = 'agent' AND agent.removed_at IS NOT NULL
     AND peer.conversation_deleted_at IS NULL;

-- Same lock order as archive_user and delete_my_dm_conversation: chat rows (sorted), then every
-- affected member's revision head, then the seats.
DO $locks$
BEGIN
  PERFORM 1 FROM chat.chats c WHERE c.id IN (SELECT chat_id FROM close_targets) ORDER BY c.id FOR UPDATE;
  PERFORM chat.lock_revision_heads(ARRAY(SELECT DISTINCT m.user_id FROM chat.active_members m
    WHERE m.chat_id IN (SELECT chat_id FROM close_targets) ORDER BY 1));
END $locks$;

WITH closed AS (
  UPDATE chat.chat_members m SET conversation_deleted_at = clock_timestamp()
    FROM close_targets t
   WHERE m.chat_id = t.chat_id AND m.user_id = t.user_id AND m.conversation_deleted_at IS NULL
  RETURNING m.chat_id, m.user_id, t.agent_user_id, m.conversation_deleted_at
)
INSERT INTO chat_private.removed_agent_dm_close_backup(chat_id, user_id, agent_user_id, closed_at)
  SELECT chat_id, user_id, agent_user_id, conversation_deleted_at FROM closed;

SELECT count(*) AS seats_closed, count(DISTINCT user_id) AS accounts, count(DISTINCT agent_user_id) AS agents,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM chat.messages msg WHERE msg.chat_id = b.chat_id)) AS with_messages
  FROM chat_private.removed_agent_dm_close_backup b WHERE rolled_back_at IS NULL;

COMMIT;
