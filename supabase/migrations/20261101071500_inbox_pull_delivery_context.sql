-- An agent's host prepared each delivered message with one more round trip per need after its pull: the rules of
-- each group or topic line (chat.chat_facts, and once more for a topic's source group) and the identities the
-- envelope names (identity.users). On a group or topic message that was two or three sequential calls between
-- reading the message and handing it to the agent, so the read receipt the sender waits for came that much later.
--
-- identity.pull_agent_inbox_v2 now returns both with the message: `group_rules` (the rules in force on the line,
-- '' when none, NULL off rooms) and `named_identities` (the recipients and the quoted sender, keyed by id).
-- Arguments, existing columns, rows and authorization are unchanged; the two columns are appended, so a host that
-- does not read them is unaffected. Adding result columns changes the return type, so the function is dropped and
-- created again in this transaction and its grant restored. Membership is read through chat.active_members, as the installed
-- definition already does since 20261031031000 rewrote it.

DROP FUNCTION identity.pull_agent_inbox_v2(text, text, bigint, integer, jsonb, bigint);

CREATE FUNCTION identity.pull_agent_inbox_v2(p_agent_user_id text, p_chat_id text DEFAULT NULL::text, p_after_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 80, p_scan_after jsonb DEFAULT NULL::jsonb, p_scan_max_ingest_seq bigint DEFAULT NULL::bigint) RETURNS TABLE(chat_id text, chat_kind text, chat_public_id integer, chat_name text, chat_creator_user_id text, listen_mode text, notification_level text, last_read_seq bigint, id text, seq bigint, sender_user_id text, sender_type text, sender_display_name text, sender_gugu_number integer, content text, content_type text, to_user_ids text[], is_whisper boolean, reply_to_message_id text, reply_to_sender_user_id text, reply_to_content text, thread_root_id text, is_thread_root boolean, created_at timestamp with time zone, scan_max_ingest_seq bigint, via_app text, file_item_id uuid, file_version integer, file_blob_id uuid, group_rules text, named_identities jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'chat', 'identity', 'public'
    AS $$
 DECLARE
     -- 这一次扫描的上界:首页取序列此刻的位置并随行返回,后续页原样传回。❌ 墙钟(#6327)。
     v_fence BIGINT;
 BEGIN
     -- 授权镜像 chat.can_act_as 的身份半边(fail-closed):调用者是该 agent 本人,或拥有该 agent。
     IF (SELECT auth.uid()) IS NULL THEN
         RAISE EXCEPTION 'not authenticated';
     END IF;
     IF NOT (
         p_agent_user_id = (SELECT auth.uid()::text)
         OR EXISTS (
             SELECT 1 FROM identity.users u
             WHERE u.id = p_agent_user_id
               AND u.type = 'agent'
               AND u.owner_user_id = (SELECT auth.uid()::text)
         )
     ) THEN
         RAISE EXCEPTION 'not authorized to pull unread for %', p_agent_user_id;
     END IF;

     v_fence := COALESCE(
         p_scan_max_ingest_seq,
         pg_sequence_last_value(pg_get_serial_sequence('chat.messages', 'ingest_seq')::regclass),
         0
     );

     IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id = p_agent_user_id AND u.session_archived_at IS NOT NULL) THEN RETURN; END IF;

     RETURN QUERY
     SELECT
         page.chat_id,
         page.kind,
         page.public_id,
         page.name,
         page.creator_user_id,
         page.listen_mode,
         page.notification_level,
         page.last_read_seq,
         page.id,
         page.seq,
         page.sender_user_id,
         su.type,
         su.display_name,
         su.gugu_number,
         page.content,
         page.content_type,
         page.to_user_ids,
         page.is_whisper,
         page.reply_to_message_id,
         rm.sender_user_id,
         rm.content,
         page.thread_root_id,
         page.is_thread_root,
         page.created_at,
         v_fence,
         page.via_app,
         -- ◇ 附件指针(agent 拿它去 attachments/urls 取字节)。
         page.file_item_id,
         page.file_version,
         page.file_blob_id,
         -- The rules in force on a group or topic line, as the agent's host read them through chat.chat_facts one
         -- call at a time: the line's own prompt, else (a topic) its source group's when the agent or the caller
         -- can see that group; '' when none. NULL for lines that are not rooms.
         CASE WHEN page.kind IN ('group', 'topic') THEN
             CASE
                 WHEN btrim(COALESCE(page.group_prompt, '')) <> '' THEN page.group_prompt
                 WHEN page.kind = 'topic' AND page.source_chat_id IS NOT NULL
                      AND (chat.is_chat_member(page.source_chat_id, p_agent_user_id)
                           OR chat.is_chat_member(page.source_chat_id, (SELECT auth.uid()::text)))
                      THEN COALESCE((SELECT CASE WHEN btrim(COALESCE(s.group_prompt, '')) <> '' THEN s.group_prompt END
                                       FROM chat.chats s WHERE s.id = page.source_chat_id), '')
                 ELSE ''
             END
         END,
         -- Everyone the envelope names besides the sender (whom it is for, whose message it quotes), as the host
         -- read them from identity.users one call later: {id: {type, display_name, gugu_number}}.
         COALESCE((
             SELECT jsonb_object_agg(u.id, jsonb_build_object('type', u.type, 'display_name', u.display_name, 'gugu_number', u.gugu_number))
               FROM identity.users u
              WHERE u.id = ANY (array_append(COALESCE(page.to_user_ids, '{}'::text[]), rm.sender_user_id))
                AND u.id IS DISTINCT FROM page.sender_user_id
         ), '{}'::jsonb)
     FROM (
         SELECT woken.*
         FROM (
             -- 候选:读游标之后、入群之后、本次扫描上界之内、这条消息叫醒了这个 agent。
             -- OFFSET 0 keeps this a separate plan step: the wake check (most selective) runs before the
             -- receipt and block checks below, which then only see messages that woke this agent.
             SELECT
                 m.chat_id, c.kind, c.public_id, c.name, c.creator_user_id, c.group_prompt, c.source_chat_id,
                 cm.listen_mode, cm.notification_level, cm.last_read_seq,
                 m.id, m.seq, m.sender_user_id, m.content, m.content_type, m.to_user_ids, m.is_whisper,
                 m.reply_to_message_id, m.thread_root_id, m.is_thread_root, m.created_at, m.via_app,
                 m.file_item_id, m.file_version, m.file_blob_id
             FROM chat.active_members cm
             JOIN chat.chats c    ON c.id = cm.chat_id
             JOIN chat.messages m ON m.chat_id = cm.chat_id
             WHERE cm.user_id = p_agent_user_id
               AND (p_chat_id IS NULL OR cm.chat_id = p_chat_id)
               AND c.status = 'active'
               AND m.deleted_at IS NULL
               -- A deregistered human/agent is not retroactively a system sender.
               AND (m.sender_user_id IS NOT NULL OR m.content_type = 'system')
               AND m.seq > GREATEST(cm.last_read_seq, COALESCE(p_after_seq, 0))
               -- #5258 入群门:只投递 agent 在场之后到达的消息。入群前的历史归它自己按需回看,
               -- ❌ 不当积压推。与 hide_history_before 那道门同形(`>=`,同一 now() 时钟)。
               AND m.ingest_seq > cm.joined_ingest_seq
               AND m.ingest_seq <= v_fence
               AND (p_scan_after IS NULL OR
                    (m.chat_id, m.seq) > (p_scan_after->>'chat_id', (p_scan_after->>'seq')::BIGINT))
               -- @@@6400 「叫醒谁」在消息写入那一刻定下(chat.message_agent_wakes),这里只读结果。
               -- ❌ 再拿此刻的 to_user_ids / 回复目标 / 档位重判:它们事后会变(删 agent、注销、切档)。
               AND EXISTS (
                   SELECT 1 FROM chat.message_agent_wakes w
                   WHERE w.message_id = m.id
                     AND w.agent_user_id = p_agent_user_id
               )
             OFFSET 0
         ) woken
         WHERE NOT EXISTS (SELECT 1 FROM chat.message_agent_delivery_blocks b WHERE b.message_id = woken.id AND b.agent_user_id = p_agent_user_id)
           -- 已消费排除:水位可停滞(gap gate),精确读行才是逐条消费事实
           AND NOT EXISTS (
               SELECT 1 FROM chat.message_deliveries d
               WHERE d.message_id = woken.id
                 AND d.device_id = 'gugu-agent:' || p_agent_user_id
                 AND d.status = 'read'
           )
         ORDER BY woken.chat_id, woken.seq
         LIMIT GREATEST(COALESCE(p_limit, 80), 1)
     ) page
     -- 回复**预览**(给这个收件人看的上下文),按它的可读性裁剪;路由目标另算,见谓词的最后一个参数。
     -- Joined after the page is chosen: only returned rows pay for chat.can_read_message.
     LEFT JOIN chat.messages rm
            ON rm.id = page.reply_to_message_id
           AND rm.deleted_at IS NULL
           AND NOT rm.is_whisper
           -- @@@5856 **这个 agent** 读不读得到被回复的那一条:一条它入群前的消息被别人回复 + @ 它,
           -- 正文不许原样落到它主人的机器上。⚠️ 传 p_agent_user_id:auth.uid() 是调用方(主人),不是收件人。
           AND chat.can_read_message(rm.id, p_agent_user_id)
     LEFT JOIN identity.users su ON su.id = page.sender_user_id
     ORDER BY page.chat_id, page.seq;
 END;
 $$;

-- The function-DDL guard closes authenticated execution even on replacement. Restore the existing grant.
REVOKE ALL ON FUNCTION identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint)
  TO authenticated, service_role;
