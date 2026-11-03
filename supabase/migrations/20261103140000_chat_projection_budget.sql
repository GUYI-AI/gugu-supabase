-- Share one reply projection per message; conversation previews never ask for replies.
SET LOCAL lock_timeout = '5s';

-- Effective predecessor read from PostgreSQL, retaining column order, file metadata and invoker RLS.
CREATE OR REPLACE VIEW chat.messages_view WITH (security_invoker=true) AS
 SELECT id,
    chat_id,
    sender_user_id,
    to_user_ids,
    sender_name,
    sender_avatar,
    seq,
    content,
    content_type,
    reply_to_message_id,
    reply_to_sender_user_id,
    reply_to_sender_name,
    reply_to_content,
    deleted_at,
    deleted_for_user_ids,
    retracted_at,
    created_at,
    forwarded_from_message_id,
    thread_root_id,
    edited_at,
    is_whisper,
    is_thread_root,
    client_message_id,
    is_imported_history_root,
    via_app,
    file_item_id,
    file_version,
    sent_by_agent,
    agent_sender,
    file_blob_id,
        CASE
            WHEN content_type = 'attachment'::text AND (file_version IS NOT NULL OR file_blob_id IS NOT NULL) AND (( SELECT auth.uid() AS uid)) IS NOT NULL THEN chat.file_resolve_as(jsonb_build_object('message_id', id), (( SELECT auth.uid() AS uid))::text) - ARRAY['bucket_id'::text, 'object_name'::text]
            ELSE NULL::jsonb
        END AS file_metadata
   FROM ( SELECT m_1.id,
            m_1.chat_id,
            m_1.sender_user_id,
            m_1.to_user_ids,
            COALESCE(su.display_name, '未知用户'::text) AS sender_name,
            su.avatar AS sender_avatar,
            m_1.seq,
            m_1.content,
            m_1.content_type,
            m_1.reply_to_message_id,
            rp.reply[1] AS reply_to_sender_user_id,
            rp.reply[2] AS reply_to_sender_name,
            rp.reply[3] AS reply_to_content,
            m_1.deleted_at,
            m_1.deleted_for_user_ids,
            m_1.retracted_at,
            m_1.created_at,
            m_1.forwarded_from_message_id,
            m_1.thread_root_id,
            m_1.edited_at,
            m_1.is_whisper,
            m_1.is_thread_root,
            m_1.client_message_id,
            COALESCE(m_1.client_message_id ~ '^session-import-root:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text, false) AS is_imported_history_root,
            m_1.via_app,
            m_1.file_item_id,
            m_1.file_version,
            m_1.sent_by_agent,
                CASE
                    WHEN m_1.sender_user_id = (( SELECT auth.uid()::text AS uid)) THEN ( SELECT jsonb_build_object('id', a.agent_user_id, 'name', a.agent_name) AS jsonb_build_object
                       FROM chat.message_agent_sends a
                      WHERE a.message_id = m_1.id AND a.owner_user_id = (( SELECT auth.uid()::text AS uid)))
                    ELSE NULL::jsonb
                END AS agent_sender,
            m_1.file_blob_id
           FROM chat.messages m_1
             LEFT JOIN identity.users su ON su.id = m_1.sender_user_id
             -- Keep one scalar result for the three columns. OFFSET prevents flattening it
             -- into three calls; readers omitting reply columns can still prune the subplan.
             LEFT JOIN LATERAL (
               SELECT (SELECT ARRAY[r.reply_to_sender_user_id,r.reply_to_sender_name,r.reply_to_content]
                       FROM chat.message_reply_preview_for(m_1.reply_to_message_id, (SELECT auth.uid()::text)) r) AS reply
               OFFSET 0
             ) rp ON true) m;

CREATE FUNCTION chat.list_chat_previews(p_chat_ids text[])
RETURNS TABLE(id text, chat_id text, created_at timestamptz, preview text, seq bigint,
    content_type text, sender_user_id text, client_message_id text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
    IF p_chat_ids IS NULL THEN RAISE EXCEPTION 'chat ids are required'; END IF;
    RETURN QUERY
    SELECT latest.id, latest.chat_id, latest.created_at,
           chat.message_preview(latest.content, latest.content_type), latest.seq,
           latest.content_type, latest.sender_user_id, latest.client_message_id
    FROM (
        SELECT DISTINCT member.chat_id AS id
        FROM chat.active_members member
        WHERE member.chat_id = ANY(p_chat_ids) AND member.user_id = (SELECT auth.uid()::text)
          AND member.conversation_deleted_at IS NULL
    ) requested
    CROSS JOIN LATERAL (
        SELECT m.id, m.chat_id, m.created_at, m.seq, m.content, m.content_type,
               m.sender_user_id, m.client_message_id
        FROM chat.messages m
        WHERE m.chat_id = requested.id AND NOT m.is_whisper
          AND NOT chat.is_pending_delivery(m.id,m.content_type,m.sender_user_id,m.client_message_id)
        ORDER BY m.seq DESC
        LIMIT 1
    ) latest;
END;
$function$;
REVOKE ALL ON FUNCTION chat.list_chat_previews(text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.list_chat_previews(text[]) TO authenticated;

-- One set query serves hydrate, scoped revisions and the legacy single-chat API.
CREATE FUNCTION chat.list_unread_locators_for_chats(p_chat_ids text[])
 RETURNS TABLE(chat_id text, stream_id text, stream_kind text, thread_root_id text, message_id text, message_seq bigint, unread_count bigint, cursor_seq bigint, version integer, is_marked_unread boolean, addressed_count bigint)
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
           COUNT(message.id) FILTER (
             WHERE v_user = ANY (message.to_user_ids) OR '*' = ANY (message.to_user_ids)
                OR (chat.message_reply_routing_target(message.reply_to_message_id) = v_user
                    AND NOT chat.is_owned_agent_user(message.sender_user_id))
           )::BIGINT AS addressed_count,
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
    GROUP BY source.chat_id, source.stream_id, source.stream_kind, source.thread_root_id,
             source.last_read_seq, source.is_marked_unread, source.version, source.hide_history_before
  )
  SELECT streams.chat_id, streams.stream_id, streams.stream_kind, streams.thread_root_id,
         COALESCE(streams.first_id, manual.message_id),
         COALESCE(streams.first_seq, manual.message_seq),
         GREATEST(streams.unread_count, CASE WHEN streams.is_marked_unread THEN 1 ELSE 0 END),
         streams.last_read_seq, streams.version, streams.is_marked_unread,
         -- 手动标未读是自己叫自己:同未读数一样至少算 1。
         GREATEST(streams.addressed_count, CASE WHEN streams.is_marked_unread THEN 1 ELSE 0 END)
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
  WHERE streams.unread_count > 0 OR manual.message_id IS NOT NULL
  ORDER BY COALESCE(streams.first_seq, manual.message_seq), streams.stream_id;
END;
$function$;
REVOKE ALL ON FUNCTION chat.list_unread_locators_for_chats(text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.list_unread_locators_for_chats(text[]) TO authenticated;

-- Keep the legacy signature, defaults, security attributes and authorization error.
CREATE OR REPLACE FUNCTION chat.list_unread_locators(p_chat_id text DEFAULT NULL::text)
 RETURNS TABLE(chat_id text, stream_id text, stream_kind text, thread_root_id text, message_id text, message_seq bigint, unread_count bigint, cursor_seq bigint, version integer, is_marked_unread boolean, addressed_count bigint)
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

-- Add only the shared computed preview to the existing authorized message payload.
CREATE OR REPLACE FUNCTION chat.sync_since(p_after_revision bigint DEFAULT 0, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'chat', 'public', 'pg_catalog'
AS $function$
DECLARE
    current_user_id TEXT := auth.uid()::text;
    head_revision BIGINT := 0;
    first_available BIGINT;
    page JSONB;
    page_last_revision BIGINT;
BEGIN
    IF current_user_id IS NULL OR current_user_id = '' THEN
        RAISE EXCEPTION 'authenticated account is required';
    END IF;
    IF p_after_revision IS NULL OR p_after_revision < 0 THEN
        RAISE EXCEPTION 'revision cursor must be non-negative';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'revision page limit must be between 1 and 500';
    END IF;

    SELECT h.revision
      INTO head_revision
      FROM chat.account_revision_heads h
     WHERE h.user_id = current_user_id;
    head_revision := COALESCE(head_revision, 0);

    IF p_after_revision > head_revision THEN
        RAISE EXCEPTION 'revision cursor % is ahead of head %', p_after_revision, head_revision;
    END IF;

    SELECT min(r.revision)
      INTO first_available
      FROM chat.account_revisions r
     WHERE r.user_id = current_user_id
       AND r.revision > p_after_revision;

    IF p_after_revision < head_revision
       AND first_available IS DISTINCT FROM p_after_revision + 1 THEN
        RAISE EXCEPTION 'revision gap after %, first available %', p_after_revision, first_available;
    END IF;

    SELECT COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'revision', selected.revision::text,
                 'event', selected.event,
                 'payload', selected.resource_key
                   || jsonb_build_object('tombstone', selected.tombstone)
                   -- #5649 message_created 带上消息行本身(messages_view 同形);行已不在(硬删)则不带,客户端按旧路补洞。
                   || CASE
                        WHEN selected.event = 'message_created' THEN COALESCE(
                          (SELECT jsonb_build_object('message', to_jsonb(v) || jsonb_build_object('preview', chat.preview(v)))
                             FROM chat.messages_view v
                            WHERE v.id::text = selected.resource_key ->> 'entity_id'),
                          '{}'::jsonb)
                        ELSE '{}'::jsonb
                      END
               ) ORDER BY selected.revision
             ),
             '[]'::jsonb
           ),
           max(selected.revision)
      INTO page, page_last_revision
      FROM (
        SELECT r.revision, r.event, r.resource_key, r.tombstone
          FROM chat.account_revisions r
         WHERE r.user_id = current_user_id
           AND r.revision > p_after_revision
         ORDER BY r.revision
         LIMIT p_limit
      ) selected;

    RETURN jsonb_build_object(
      'operations', page,
      'has_more', COALESCE(page_last_revision, p_after_revision) < head_revision
    );
END;
$function$
;
GRANT EXECUTE ON FUNCTION chat.sync_since(bigint,integer) TO authenticated;

-- Forward the read tuple already available on NEW, without another database lookup.
CREATE OR REPLACE FUNCTION chat.broadcast_member_read_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'realtime', 'public', 'pg_catalog'
AS $function$
BEGIN
    IF OLD.last_read_seq IS NOT DISTINCT FROM NEW.last_read_seq THEN
        RETURN NEW;
    END IF;

    PERFORM chat.broadcast_to_chat_member_user_events(
        NEW.chat_id,
        'member_read_changed',
        jsonb_build_object(
            'member', jsonb_build_object(
                'chat_id', NEW.chat_id,
                'user_id', NEW.user_id,
                'last_read_seq', NEW.last_read_seq,
                'stream_id', 'main:' || NEW.chat_id,
                'version', NEW.version,
                'is_marked_unread', NEW.is_marked_unread
            )
        )
    );
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION chat.broadcast_to_chat_member_user_events(p_chat_id text, p_event text, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'realtime', 'public', 'pg_catalog'
AS $function$
DECLARE
    target_user_id TEXT;
    v_about chat.messages%ROWTYPE;
    revision_key JSONB;
    revision_tombstone BOOLEAN;
BEGIN
    PERFORM chat.lock_chat_revision_recipients(p_chat_id);
    -- #6835 关于一条悄悄话的事件(它的新建、删除、投递/已读回执、回应,以及它在话题里引起的来源线动静)
    -- 只发给看得见它的人,判据就是 chat.message_visible_to。事件说的是哪条消息:message.id / receipt.message_id /
    -- reaction.message_id,话题动静带 about_message_id。只有悄悄话才逐人判,公开消息只多一次主键查询。
    -- 只取判定要用的列:m.* 会连 content 一起解 TOAST。
    SELECT m.id, m.chat_id, m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids
      INTO v_about.id, v_about.chat_id, v_about.created_at, v_about.is_whisper, v_about.sender_user_id, v_about.to_user_ids
      FROM chat.messages m
     WHERE m.id = COALESCE(p_payload #>> '{message,id}', p_payload #>> '{receipt,message_id}',
                           p_payload #>> '{reaction,message_id}', p_payload ->> 'about_message_id')
       AND m.is_whisper;
    revision_key := jsonb_strip_nulls(jsonb_build_object(
      'chat_id', p_chat_id,
      'entity_id', COALESCE(
        p_payload #>> '{message,id}',
        p_payload #>> '{receipt,message_id}',
        p_payload #>> '{member,user_id}',
        p_payload #>> '{event,id}',
        p_payload #>> '{reaction,message_id}',
        p_payload #>> '{workspace,id}'
      ),
      -- #5649 仅 member_read_changed 带值:读者(entity_id)读到的主线 seq。
      'last_read_seq', CASE
        WHEN p_event = 'member_read_changed' THEN (p_payload #>> '{member,last_read_seq}')::bigint
        ELSE NULL
      END,
      'stream_id', CASE WHEN p_event = 'member_read_changed' THEN p_payload #>> '{member,stream_id}' END,
      'version', CASE WHEN p_event = 'member_read_changed' THEN (p_payload #>> '{member,version}')::integer END,
      'is_marked_unread', CASE WHEN p_event = 'member_read_changed' THEN (p_payload #>> '{member,is_marked_unread}')::boolean END,
      -- #5649 仅 delivery_changed 带值:哪台设备(gugu-agent:<uid> 即 agent)把这条(entity_id)标成了 delivered/read。
      'device_id', CASE WHEN p_event = 'delivery_changed' THEN p_payload #>> '{receipt,device_id}' ELSE NULL END,
      'status',    CASE WHEN p_event = 'delivery_changed' THEN p_payload #>> '{receipt,status}'    ELSE NULL END
    ));
    revision_tombstone := p_event LIKE '%deleted'
      OR p_event LIKE '%removed'
      OR p_payload ->> 'op' IN ('delete', 'deleted', 'removed');

    FOR target_user_id IN
        SELECT DISTINCT cm.user_id
          FROM chat.active_members cm
         WHERE cm.chat_id = p_chat_id
           AND (v_about.id IS NULL
                OR chat.message_visible_to(v_about.chat_id, v_about.created_at, v_about.is_whisper,
                                           v_about.sender_user_id, v_about.to_user_ids, cm.user_id))
         ORDER BY cm.user_id
    LOOP
        PERFORM chat.publish_user_revision(target_user_id, p_event, revision_key, revision_tombstone);
        -- Topic source-line notifications are a deliberately narrow legacy edge: the
        -- topic projection needs the source-line marker to refresh its anchor card.
        -- Keep this low-volume payload only for that shape; ordinary chat/message
        -- mutations use the durable revision wake above.
        IF p_event = 'chat_changed' AND p_payload ? 'topic_of_source_chat' THEN
            PERFORM chat.send_user_event(
                p_payload,
                p_event,
                'gugu:user:' || target_user_id || ':events',
                true
            );
        END IF;
    END LOOP;
END;
$function$
;

GRANT EXECUTE ON FUNCTION chat.broadcast_to_chat_member_user_events(text,text,jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
