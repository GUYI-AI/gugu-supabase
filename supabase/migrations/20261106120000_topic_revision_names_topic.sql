-- A topic's change on its source line names the topic, so a reader refreshes that one summary.
--
-- Every message publishes one chat_changed for its own chat (20261105160000). A topic's activity, creation, rename,
-- archival and membership are published on the source line as chat_changed too, and their revision key was the
-- source line's own: {chat_id: source}. A client could not tell "a topic of this line changed" from "this line got a
-- message", so it re-listed every topic of the open line on every message of that line.
--
-- Now those revisions carry entity_id = the topic's chat id. A plain chat_changed (the chat row itself) still has no
-- entity_id. list_topics_of_chat takes an optional p_topic_chat_id to read that one summary; omitted, it lists the
-- whole line as before.
--
-- Deleting a topic message changes the summary's count and activity but published nothing on the source line: readers
-- only caught up because any line message re-listed. It now publishes the same activity revision as sending one.
SET LOCAL lock_timeout = '5s';

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
        -- A topic's activity, creation, rename, archival or membership, published on its source line, names the topic.
        CASE WHEN p_payload ? 'topic_of_source_chat' THEN COALESCE(p_payload ->> 'chat_id', p_payload #>> '{chat,id}') END,
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

DROP FUNCTION chat.list_topics_of_chat(text, text);
CREATE FUNCTION chat.list_topics_of_chat(p_source_chat_id text, p_as_user_id text DEFAULT NULL::text, p_topic_chat_id text DEFAULT NULL::text) RETURNS TABLE(chat_id text, name text, source_message_id text, creator_user_id text, last_message_at timestamp with time zone, message_count bigint, participant_count bigint, is_participant boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_caller TEXT := (SELECT auth.uid()::text);
    v_actor TEXT;
    v_actor_owner TEXT;
    v_actor_is_agent BOOLEAN;
BEGIN
    v_actor := COALESCE(p_as_user_id, v_caller);
    SELECT u.type = 'agent', u.owner_user_id INTO v_actor_is_agent, v_actor_owner
      FROM identity.users u WHERE u.id = v_actor;
    IF v_actor IS DISTINCT FROM v_caller
       AND NOT (COALESCE(v_actor_is_agent, false) AND v_actor_owner = v_caller) THEN
        RAISE EXCEPTION 'Not allowed to act as %', v_actor;
    END IF;

    -- 与 create_topic 同形:actor 在来源线,**或** actor 是 agent 且主人在来源线。
    -- 两边不同形的后果是 agent 开得出话题却列不出来,而这个函数的用途正是
    -- 「开第二条之前先看看有没有」—— 它永远回「没有」,于是同一个问题被开成一串重复的线。
    IF NOT chat.is_chat_member(p_source_chat_id, v_actor)
       AND NOT (COALESCE(v_actor_is_agent, false)
                AND v_actor_owner IS NOT NULL
                AND chat.is_chat_member(p_source_chat_id, v_actor_owner)) THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        t.id,
        t.name,
        t.source_message_id,
        t.creator_user_id,
        t.last_message_at,
        -- 数的是 actor 读得到的条数:与 message_history_as 同一组条件(未删 + 可见下界 + 悄悄话规则);
        -- The one visibility rule; the floor is computed once per topic.
        (SELECT count(*) FROM chat.messages m
          WHERE m.chat_id = t.id AND m.deleted_at IS NULL
            AND chat.message_visible_at((SELECT chat.history_floor(t.id, v_actor)),
                  m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, v_actor)),
        (SELECT count(*) FROM chat.active_members cm WHERE cm.chat_id = t.id),
        chat.is_chat_member(t.id, v_actor)
    FROM chat.chats t
    WHERE t.kind = 'topic' AND t.status <> 'archived'
      AND t.source_chat_id = p_source_chat_id
      AND (p_topic_chat_id IS NULL OR t.id = p_topic_chat_id)
    ORDER BY t.last_message_at DESC NULLS LAST, t.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION chat.list_topics_of_chat(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_topics_of_chat(TEXT, TEXT, TEXT) TO authenticated, service_role;

CREATE TRIGGER messages_publish_topic_deletion AFTER UPDATE OF deleted_at ON chat.messages
    FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
    EXECUTE FUNCTION chat.publish_topic_activity_to_source_line();

NOTIFY pgrst, 'reload schema';
