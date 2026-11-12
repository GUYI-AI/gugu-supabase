-- Name the first unread message addressed to the caller, beside the count of them. Clients land a topic there.
-- The predicate is the same one addressed_count has always used, now evaluated once per unread row and skipping
-- the reply lookup for messages that reply to nothing, which pays for the new columns.
-- A manual unread mark has no such message: both columns stay NULL. Clients ignoring the new columns are unaffected.
-- A changed return type needs a drop, so both grants are restated below.
DROP FUNCTION chat.list_unread_locators(text);
DROP FUNCTION chat.list_unread_locators_for_chats(text[]);

CREATE FUNCTION chat.list_unread_locators_for_chats(p_chat_ids text[])
 RETURNS TABLE(chat_id text, stream_id text, stream_kind text, thread_root_id text, message_id text, message_seq bigint, unread_count bigint, cursor_seq bigint, version integer, is_marked_unread boolean, addressed_count bigint, first_addressed_message_id text, first_addressed_seq bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'chat', 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user TEXT := (SELECT auth.uid()::text);
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  -- Own membership predicates below provide the per-chat bound; check caller liveness once.
  IF p_chat_ids IS NOT NULL AND NOT chat.is_acting_as(v_user) THEN RETURN; END IF;

  RETURN QUERY
  WITH streams AS (
    SELECT source.chat_id, source.stream_id, source.stream_kind, source.thread_root_id,
           source.last_read_seq, source.is_marked_unread, source.version,
           COUNT(message.id)::BIGINT AS unread_count,
           -- 叫到你的:点名你、@all(谁发的都算,自己的 agent 也算)、或回复你说过的那条 —— 但自己的 agent 回复你不算
           -- (它每轮收尾引着你那条回话、回合失败卡都挂在你那条下面;它要你回话会点名你,或停在等你批准 / 回答上)。
           COUNT(message.id) FILTER (WHERE addressed.is_addressed)::BIGINT AS addressed_count,
           MIN(message.seq) FILTER (WHERE addressed.is_addressed) AS first_addressed_seq,
           MIN(message.seq) AS first_seq,
           (ARRAY_AGG(message.id ORDER BY message.seq, message.id)
             FILTER (WHERE message.id IS NOT NULL))[1] AS first_id
    FROM (
      SELECT member.chat_id, 'main:' || member.chat_id AS stream_id, 'main'::TEXT AS stream_kind,
             NULL::TEXT AS thread_root_id, member.last_read_seq, member.is_marked_unread,
             member.version, member.hide_history_before
      FROM chat.active_members member
      JOIN chat.chats conversation ON conversation.id = member.chat_id
      WHERE member.user_id = v_user
        AND member.inbox_published_at IS NOT NULL
        AND member.conversation_deleted_at IS NULL
        AND conversation.status IN ('active', 'stopped', 'paused')
        AND (p_chat_ids IS NULL OR member.chat_id = ANY(p_chat_ids))
      UNION ALL
      SELECT stream.chat_id, stream.stream_id, stream.stream_kind, stream.thread_root_id,
             stream.last_read_seq, stream.is_marked_unread, stream.version, member.hide_history_before
      FROM chat.chat_member_stream_read_state stream
      JOIN chat.active_members member
        ON member.chat_id = stream.chat_id AND member.user_id = stream.user_id
      JOIN chat.chats conversation ON conversation.id = stream.chat_id
      WHERE stream.user_id = v_user
        AND stream.stream_kind = 'thread'
        AND member.inbox_published_at IS NOT NULL
        AND member.conversation_deleted_at IS NULL
        AND conversation.status IN ('active', 'stopped', 'paused')
        AND (p_chat_ids IS NULL OR stream.chat_id = ANY(p_chat_ids))
      UNION ALL
      SELECT root.chat_id, 'thread:' || root.chat_id || ':' || root.id, 'thread'::TEXT, root.id,
             0, false, 0, member.hide_history_before
      FROM chat.messages root
      JOIN chat.active_members member ON member.chat_id = root.chat_id AND member.user_id = v_user
      JOIN chat.chats conversation ON conversation.id = root.chat_id
      WHERE root.thread_root_id IS NULL
        AND root.is_thread_root = true
        AND NOT COALESCE(
          root.client_message_id ~ '^session-import-root:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          false
        )
        AND root.deleted_at IS NULL
        AND member.inbox_published_at IS NOT NULL
        AND member.conversation_deleted_at IS NULL
        AND conversation.kind = 'group'
        AND conversation.status IN ('active', 'stopped', 'paused')
        AND (p_chat_ids IS NULL OR root.chat_id = ANY(p_chat_ids))
        AND EXISTS (
          SELECT 1 FROM chat.messages reply
          WHERE reply.chat_id = root.chat_id
            AND reply.thread_root_id = root.id
            AND reply.deleted_at IS NULL
            AND NOT (reply.deleted_for_user_ids @> jsonb_build_array(v_user))
            AND reply.seq > 0
            AND reply.sender_user_id <> v_user
            AND NOT chat.is_pending_delivery(reply.id, reply.content_type, reply.sender_user_id, reply.client_message_id)
            AND chat.message_visible_at(COALESCE(member.hide_history_before, '-infinity'::timestamptz),
                  reply.created_at, reply.is_whisper, reply.sender_user_id, reply.to_user_ids, v_user)
        )
        AND NOT EXISTS (
          SELECT 1 FROM chat.chat_member_stream_read_state existing
          WHERE existing.chat_id = root.chat_id
            AND existing.user_id = v_user
            AND existing.stream_id = 'thread:' || root.chat_id || ':' || root.id
        )
    ) source
    LEFT JOIN chat.messages message
      ON message.chat_id = source.chat_id
     AND message.deleted_at IS NULL
     AND NOT (message.deleted_for_user_ids @> jsonb_build_array(v_user))
     AND message.seq > source.last_read_seq
     AND message.sender_user_id <> v_user
     AND NOT chat.is_pending_delivery(message.id, message.content_type, message.sender_user_id, message.client_message_id)
     AND chat.message_visible_at(COALESCE(source.hide_history_before, '-infinity'::timestamptz),
           message.created_at, message.is_whisper, message.sender_user_id, message.to_user_ids, v_user)
     AND ((source.stream_kind = 'main' AND message.thread_root_id IS NULL)
       OR (source.stream_kind = 'thread' AND message.thread_root_id = source.thread_root_id))
    LEFT JOIN LATERAL (SELECT v_user = ANY (message.to_user_ids) OR '*' = ANY (message.to_user_ids) OR (message.reply_to_message_id IS NOT NULL AND chat.message_reply_routing_target(message.reply_to_message_id) = v_user AND NOT chat.is_owned_agent_user(message.sender_user_id)) AS is_addressed) addressed ON message.id IS NOT NULL
    GROUP BY source.chat_id, source.stream_id, source.stream_kind, source.thread_root_id,
             source.last_read_seq, source.is_marked_unread, source.version, source.hide_history_before
  )
  SELECT streams.chat_id, streams.stream_id, streams.stream_kind, streams.thread_root_id,
         COALESCE(streams.first_id, manual.message_id),
         COALESCE(streams.first_seq, manual.message_seq),
         GREATEST(streams.unread_count, CASE WHEN streams.is_marked_unread THEN 1 ELSE 0 END),
         streams.last_read_seq, streams.version, streams.is_marked_unread,
         -- 手动标未读是自己叫自己:同未读数一样至少算 1。
         GREATEST(streams.addressed_count, CASE WHEN streams.is_marked_unread THEN 1 ELSE 0 END),
         first_addressed.id, streams.first_addressed_seq
  FROM streams
  LEFT JOIN LATERAL (
    SELECT message.id AS message_id, message.seq AS message_seq
    FROM chat.messages message
    JOIN chat.active_members member
      ON member.chat_id = streams.chat_id AND member.user_id = v_user
    WHERE streams.is_marked_unread
      AND streams.first_id IS NULL
      AND message.chat_id = streams.chat_id
      AND message.deleted_at IS NULL
      AND NOT (message.deleted_for_user_ids @> jsonb_build_array(v_user))
      AND NOT chat.is_pending_delivery(message.id, message.content_type, message.sender_user_id, message.client_message_id)
      AND chat.message_visible_at(COALESCE(member.hide_history_before, '-infinity'::timestamptz),
            message.created_at, message.is_whisper, message.sender_user_id, message.to_user_ids, v_user)
      AND ((streams.stream_kind = 'main' AND message.thread_root_id IS NULL)
        OR (streams.stream_kind = 'thread' AND message.thread_root_id = streams.thread_root_id))
    ORDER BY message.seq DESC, message.id DESC
    LIMIT 1
  ) manual ON true
  -- Only the few streams that call the caller look their message up; sorting every unread row was measurably slower.
  LEFT JOIN LATERAL (
    SELECT message.id FROM chat.messages message
    WHERE message.chat_id = streams.chat_id AND message.seq = streams.first_addressed_seq
    ORDER BY message.id
    LIMIT 1
  ) first_addressed ON streams.first_addressed_seq IS NOT NULL
  WHERE streams.unread_count > 0 OR manual.message_id IS NOT NULL
  ORDER BY COALESCE(streams.first_seq, manual.message_seq), streams.stream_id;
END;
$function$;
REVOKE ALL ON FUNCTION chat.list_unread_locators_for_chats(text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.list_unread_locators_for_chats(text[]) TO authenticated;

-- Keep the legacy signature, defaults, security attributes and authorization error.
CREATE FUNCTION chat.list_unread_locators(p_chat_id text DEFAULT NULL::text)
 RETURNS TABLE(chat_id text, stream_id text, stream_kind text, thread_root_id text, message_id text, message_seq bigint, unread_count bigint, cursor_seq bigint, version integer, is_marked_unread boolean, addressed_count bigint, first_addressed_message_id text, first_addressed_seq bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'chat', 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user TEXT := (SELECT auth.uid()::text);
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_chat_id IS NOT NULL AND NOT chat.can_act_as(v_user, p_chat_id) THEN
    RAISE EXCEPTION 'not authorized to read unread locator for chat %', p_chat_id;
  END IF;
  RETURN QUERY SELECT * FROM chat.list_unread_locators_for_chats(
    CASE WHEN p_chat_id IS NULL THEN NULL::text[] ELSE ARRAY[p_chat_id] END);
END;
$function$;
REVOKE ALL ON FUNCTION chat.list_unread_locators(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.list_unread_locators(text) TO authenticated;
