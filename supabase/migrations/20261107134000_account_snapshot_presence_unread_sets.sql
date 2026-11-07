-- Reuse bounded presence batches and one owned-agent set in account snapshots.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION identity.get_agent_presence_batch(p_agent_user_ids text[]) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'identity', 'public', 'pg_catalog'
    AS $$
DECLARE
    -- 上限存在的理由不是性能，是让「问得太多」变成一个能被看见的错误而不是一份残缺的答案。
    v_max CONSTANT INT := 200;
    v_ids TEXT[];
    v_count INT;
    v_results JSONB := '{}'::jsonb;
BEGIN
    IF p_agent_user_ids IS NULL THEN
        RAISE EXCEPTION 'get_agent_presence_batch: p_agent_user_ids must not be NULL';
    END IF;

    -- 先去重再判上限：调用方重复传同一个 id 不该把它推过闸，也不该让同一个 id 被查两遍。
    SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::TEXT[])
      INTO v_ids
      FROM unnest(p_agent_user_ids) AS x
     WHERE x IS NOT NULL AND x <> '';

    v_count := COALESCE(array_length(v_ids, 1), 0);
    IF v_count > v_max THEN
        -- fail loud：❌ 不静默截断。截断会返回一份看起来完整的答案，而调用方无从知道
        -- 哪些 id 从来没被问过 —— 那比报错难查得多。
        RAISE EXCEPTION
            'get_agent_presence_batch: % distinct ids exceeds the cap of %; split the request',
            v_count, v_max;
    END IF;

    -- Authorization is the same owner / live friendship / live shared-seat /
    -- tombstone predicate as can_view_agent_runtime_state, evaluated as sets.
    WITH requested AS MATERIALIZED (SELECT unnest(v_ids) AS id),
    owned AS MATERIALIZED (
      SELECT q.id FROM requested q JOIN identity.users u ON u.id=q.id
      WHERE u.type='agent' AND u.owner_user_id=(SELECT auth.uid()::text)
    ), remaining AS MATERIALIZED (
      SELECT q.id FROM requested q WHERE NOT EXISTS (SELECT 1 FROM owned o WHERE o.id=q.id)
    ), viewer_chats AS MATERIALIZED (
      SELECT m.chat_id FROM chat.active_members m WHERE m.user_id = (SELECT auth.uid()::text)
        AND EXISTS (SELECT 1 FROM remaining)
    ), related AS MATERIALIZED (
      SELECT q.id FROM remaining q JOIN identity.active_friendships f
        ON (f.user_a_id=(SELECT auth.uid()::text) AND f.user_b_id=q.id)
        OR (f.user_b_id=(SELECT auth.uid()::text) AND f.user_a_id=q.id)
      UNION
      SELECT q.id FROM remaining q JOIN chat.active_members m ON m.user_id=q.id
        JOIN viewer_chats c ON c.chat_id=m.chat_id
    ), authorized AS MATERIALIZED (
      SELECT id FROM owned
      UNION
      SELECT r.id FROM related r JOIN identity.users u ON u.id=r.id WHERE u.type='agent'
      UNION
      SELECT q.id FROM requested q JOIN identity.agent_lifecycle_tombstones t ON t.agent_user_id=q.id
      WHERE t.presence_viewer_user_ids @> ARRAY[(SELECT auth.uid()::text)]
    ), live_payloads AS MATERIALIZED (
      SELECT u.id, jsonb_build_object(
        'presence', jsonb_build_object(
            'agent_user_id',        u.id,
            'account_status',       'active',
            'runtime_status',       COALESCE(r.runtime_status, 'offline'),
            'desired_status',       COALESCE(u.desired_status, 'online'),
            'activity_status',      COALESCE(r.activity_status, 'idle'),
            -- #6448 宿主写下的读数;NULL = 这一行没有读数(读方退回 activity_status)。
            'agent_status',         r.agent_status,
            'agent_status_detail',  r.agent_status_detail,
            'active_chat_id',       r.active_chat_id,
            'runtime_kind',         r.runtime_kind,
            'runtime_label',        r.runtime_label,
            'agent_type',           ap.agent_type,
            'recent_tool_type',     r.recent_tool_type,
            'recent_actions',       COALESCE(r.recent_actions, ARRAY[]::TEXT[]),
            'last_action_at',       r.last_action_at,
            'window_title',         r.window_title,
            'pid',                  r.pid,
            'runtime_last_seen_at', r.last_seen_at,
            'device_id',            u.device_id,
            'device_status',        d.status,
            'device_last_seen_at',  d.last_seen_at,
            'host_runtime_capability', (d.capabilities->>'host_runtime_capability')::int,
            'consecutive_deliver_failures', COALESCE(r.consecutive_deliver_failures, 0),
            'updated_at',           GREATEST(
                                        COALESCE(r.updated_at, to_timestamp(0)),
                                        COALESCE(d.updated_at, to_timestamp(0))
                                    )
        )
    ) AS payload
      FROM authorized q JOIN identity.users u ON u.id=q.id AND u.type='agent' AND u.removed_at IS NULL
      LEFT JOIN identity.agent_runtime_states r ON r.agent_user_id=u.id
      LEFT JOIN identity.gugu_devices d ON d.device_id=u.device_id
      LEFT JOIN identity.agent_profiles ap ON ap.id::text=u.id
    ), removed_payloads AS (
      SELECT q.id, jsonb_build_object(
        'presence', jsonb_build_object(
            'agent_user_id',        t.agent_user_id,
            'account_status',       'removed',
            'runtime_status',       'offline',
            'desired_status',       'offline',
            'activity_status',      'idle',
            'agent_status',         NULL,
            'agent_status_detail',  NULL,
            'active_chat_id',       NULL,
            'runtime_kind',         NULL,
            'runtime_label',        NULL,
            'agent_type',           NULL,
            'recent_tool_type',     NULL,
            'recent_actions',       ARRAY[]::TEXT[],
            'last_action_at',       NULL,
            'window_title',         NULL,
            'pid',                  NULL,
            'runtime_last_seen_at', NULL,
            'device_id',            NULL,
            'device_status',        NULL,
            'device_last_seen_at',  NULL,
            'host_runtime_capability', NULL,
            'consecutive_deliver_failures', 0,
            'updated_at',           t.removed_at
        )
    ) AS payload
      FROM authorized q
      LEFT JOIN identity.users u ON u.id=q.id AND u.type='agent' AND u.removed_at IS NOT NULL
      LEFT JOIN identity.agent_lifecycle_tombstones old ON old.agent_user_id=q.id
      CROSS JOIN LATERAL (SELECT q.id AS agent_user_id, COALESCE(old.removed_at,u.removed_at) AS removed_at) t
      WHERE NOT EXISTS (SELECT 1 FROM live_payloads l WHERE l.id=q.id)
        AND (old.agent_user_id IS NOT NULL OR u.id IS NOT NULL)
    ), payloads AS (
      SELECT * FROM live_payloads UNION ALL SELECT * FROM removed_payloads
    )
    SELECT COALESCE(jsonb_object_agg(q.id, CASE
      WHEN a.id IS NULL THEN jsonb_build_object('status','unauthorized')
      WHEN p.payload IS NULL THEN jsonb_build_object('status','not_found')
      ELSE jsonb_build_object('status','presence','presence',p.payload->'presence') END), '{}'::jsonb)
    INTO v_results
    FROM requested q LEFT JOIN authorized a ON a.id=q.id LEFT JOIN payloads p ON p.id=q.id;

    -- 包一层 results 而不是裸对象：将来要加批次级元信息（例如服务端时钟）时不必改客户端解析形状。
    RETURN jsonb_build_object('results', v_results);
END;
$$;

REVOKE ALL ON FUNCTION identity.get_agent_presence_batch(text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION identity.get_agent_presence_batch(text[]) TO authenticated;

CREATE OR REPLACE FUNCTION chat.list_unread_locators_for_chats(p_chat_ids text[])
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
  WITH owned_agents AS MATERIALIZED (
    SELECT u.id FROM identity.users u WHERE u.type='agent' AND u.owner_user_id=v_user
  ), streams AS (
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
    LEFT JOIN owned_agents owned_sender ON owned_sender.id=message.sender_user_id
    LEFT JOIN LATERAL (SELECT v_user = ANY (message.to_user_ids) OR '*' = ANY (message.to_user_ids) OR (message.reply_to_message_id IS NOT NULL AND chat.message_reply_routing_target(message.reply_to_message_id) = v_user AND owned_sender.id IS NULL) AS is_addressed) addressed ON message.id IS NOT NULL
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

REVOKE ALL ON FUNCTION chat.list_unread_locators_for_chats(text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.list_unread_locators_for_chats(text[]) TO authenticated;

-- Preserve every other snapshot projection, its invoker rights and exact installed grants.
DO $snapshot$
DECLARE target regprocedure := 'chat.sync_snapshot()'::regprocedure;
  definition text; prior_acl aclitem[]; permission record;
  old_projection constant text := $before$'presence', COALESCE((SELECT jsonb_object_agg(u.id, identity.get_agent_presence(u.id))
            FROM identities u WHERE u.type = 'agent' AND identity.can_view_agent_runtime_state(u.id)), '{}'::jsonb)$before$;
  new_projection constant text := $after$'presence', COALESCE((
          SELECT jsonb_object_agg(entry.key, CASE WHEN entry.value->>'status'='not_found' THEN NULL::jsonb
            ELSE jsonb_build_object('presence',entry.value->'presence') END)
          FROM (
            SELECT identity.get_agent_presence_batch(array_agg(requested.id ORDER BY requested.id)) AS payload
            FROM (SELECT u.id, (row_number() OVER (ORDER BY u.id)-1)/200 AS batch
              FROM identities u WHERE u.type='agent') requested GROUP BY requested.batch
          ) batches CROSS JOIN LATERAL jsonb_each(batches.payload->'results') entry
          WHERE entry.value->>'status' IN ('presence','not_found')
        ), '{}'::jsonb)$after$;
BEGIN
  SELECT pg_get_functiondef(p.oid),COALESCE(p.proacl,acldefault('f',p.proowner))
    INTO definition,prior_acl FROM pg_proc p WHERE p.oid=target;
  IF (length(definition)-length(replace(definition,old_projection,''))) <> length(old_projection) THEN
    RAISE EXCEPTION 'Unexpected account snapshot presence projection';
  END IF;
  EXECUTE replace(definition,old_projection,new_projection);
  FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable FROM aclexplode(prior_acl)
    WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',target,
      CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
      CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $snapshot$;
