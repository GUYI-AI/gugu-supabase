-- A topic root is a message marked is_thread_root, and nothing else.
--
-- Two criteria answered "is this a topic root": the explicit mark, set by a separate best-effort RPC the client calls when
-- a topic is opened (chat.mark_thread_root), and "it has a visible reply", which chat.thread_summaries accepted for roots
-- that were never marked. Replies never marked their root, so roots kept being created unmarked: a reply an agent writes
-- under a root nobody opened in the UI, or any reply whose mark RPC failed. chat.list_unread_locators_for_chats reads only
-- the mark, so those topics were listed with their reply counts but their new replies were never unread.
--
-- Now the reply marks its root: inserting a message with thread_root_id marks that root (a main-line, non-whisper message of
-- the same chat, as chat.mark_thread_root does). Every root that already has a live reply is marked once here, and
-- chat.thread_summaries reads the mark only. chat.mark_thread_root stays: it marks a topic opened before its first reply.
--
-- Locks: no column, trigger or constraint is added. The marking lives in the body of the existing AFTER INSERT trigger
-- function chat.update_chat_last_message (replacing a function locks no table); the backfill takes ROW EXCLUSIVE on
-- chat.messages, as any message write does. Rollback: ops/rollback-reply-marks-thread-root.sql.
SET LOCAL lock_timeout = '5s';

UPDATE chat.messages r
   SET is_thread_root = true
 WHERE r.thread_root_id IS NULL
   AND NOT r.is_thread_root
   AND NOT r.is_whisper
   AND EXISTS (SELECT 1 FROM chat.messages rep
                WHERE rep.thread_root_id = r.id AND rep.chat_id = r.chat_id AND rep.deleted_at IS NULL);

CREATE OR REPLACE FUNCTION chat.update_chat_last_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'public'
AS $function$
BEGIN
    -- @@@reply-marks-root - a reply makes its root a topic root (20261110050000). Kept in this AFTER INSERT function, which
    -- every message insert already runs, so no trigger is added to chat.messages. Only the first reply writes the root.
    IF NEW.thread_root_id IS NOT NULL THEN
        UPDATE chat.messages
           SET is_thread_root = true
         WHERE id = NEW.thread_root_id
           AND chat_id = NEW.chat_id
           AND thread_root_id IS NULL
           AND NOT is_whisper
           AND NOT is_thread_root;
    END IF;
    IF NEW.is_whisper THEN
        -- whisper 不进共享预览;这一次写只为把分配过的 seq 发布出去(见文件头)。
        UPDATE chat.chats SET updated_at = now() WHERE id = NEW.chat_id;
        RETURN NEW;
    END IF;
    UPDATE chat.chats
    SET
        last_message_at      = NEW.created_at,
        last_message_preview = chat.message_preview(NEW.content, NEW.content_type),
        updated_at           = now()
    WHERE id = NEW.chat_id;
    RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION chat.update_chat_last_message() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION chat.thread_summaries(p_chat_id text)
 RETURNS TABLE(thread_root_id text, reply_count bigint, participant_count bigint, last_reply_at timestamp with time zone, last_reply_seq bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'chat', 'public', 'pg_catalog'
AS $function$
  WITH thread_msgs AS (
    -- 回复行
    SELECT m.thread_root_id AS root_id, m.sender_user_id, m.created_at, m.seq, true AS is_reply
    FROM chat.messages m
    WHERE m.chat_id = p_chat_id
      AND m.thread_root_id IS NOT NULL
      AND m.deleted_at IS NULL
      AND NOT (m.deleted_for_user_ids @> to_jsonb(ARRAY[(auth.uid())::text]))
    UNION ALL
    -- root 行:is_thread_root 的话题根(含零回复，#1243)。回复会标记它的根(20261110050000)。
    SELECT r.id AS root_id, r.sender_user_id, r.created_at, r.seq, false AS is_reply
    FROM chat.messages r
    WHERE r.chat_id = p_chat_id
      AND r.thread_root_id IS NULL
      AND r.deleted_at IS NULL
      AND NOT (r.deleted_for_user_ids @> to_jsonb(ARRAY[(auth.uid())::text]))
      AND r.is_thread_root = true
  )
  SELECT t.root_id AS thread_root_id,
         count(*) FILTER (WHERE t.is_reply) AS reply_count,
         count(DISTINCT t.sender_user_id) AS participant_count,
         COALESCE(
           max(t.created_at) FILTER (WHERE t.is_reply),
           max(t.created_at) FILTER (WHERE NOT t.is_reply)
         ) AS last_reply_at,
         COALESCE(
           max(t.seq) FILTER (WHERE t.is_reply),
           max(t.seq) FILTER (WHERE NOT t.is_reply)
         ) AS last_reply_seq
  FROM thread_msgs t
  GROUP BY t.root_id
$function$;
REVOKE ALL ON FUNCTION chat.thread_summaries(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.thread_summaries(text) TO authenticated;
