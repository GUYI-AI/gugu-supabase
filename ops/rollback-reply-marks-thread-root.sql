-- Roll back 20261110050000_reply_marks_thread_root: a reply no longer marks its root, and chat.thread_summaries again also
-- lists an unmarked root that has a visible reply. The function bodies below are the definitions that release replaced.
-- Roots the release marked stay marked: each has (or had) a reply, so the restored thread_summaries lists them either way;
-- only chat.list_unread_locators_for_chats keeps counting their replies. Messages are otherwise not touched.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION chat.update_chat_last_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'public'
AS $function$
BEGIN
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
$function$

;
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
    -- root 行:is_thread_root 的话题根(含零回复，#1243),或历史上有可见回复的根(兼容旧未标记 root，不回退)
    SELECT r.id AS root_id, r.sender_user_id, r.created_at, r.seq, false AS is_reply
    FROM chat.messages r
    WHERE r.chat_id = p_chat_id
      AND r.thread_root_id IS NULL
      AND r.deleted_at IS NULL
      AND NOT (r.deleted_for_user_ids @> to_jsonb(ARRAY[(auth.uid())::text]))
      AND (
        r.is_thread_root = true
        OR EXISTS (
          SELECT 1 FROM chat.messages rep
          WHERE rep.thread_root_id = r.id
            AND rep.deleted_at IS NULL
            AND NOT (rep.deleted_for_user_ids @> to_jsonb(ARRAY[(auth.uid())::text]))
        )
      )
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
$function$

;
REVOKE ALL ON FUNCTION chat.thread_summaries(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.thread_summaries(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
