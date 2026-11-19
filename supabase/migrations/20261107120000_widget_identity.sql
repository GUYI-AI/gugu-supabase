-- Widget specifications have one identity independent of their display slots.
-- The installer owns the transaction and its migration ledger.
SET LOCAL lock_timeout = '5s';

CREATE TABLE chat.widgets (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    chat_id text NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
    message_id text NOT NULL UNIQUE REFERENCES chat.messages(id) ON DELETE CASCADE,
    app text NOT NULL CHECK (length(app) > 0),
    view text NOT NULL CHECK (length(view) > 0),
    text text NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
    data jsonb CHECK (data IS NULL OR jsonb_typeof(data) = 'object'),
    created_by text REFERENCES identity.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX widgets_chat_id_idx ON chat.widgets(chat_id);
CREATE INDEX widgets_created_by_idx ON chat.widgets(created_by) WHERE created_by IS NOT NULL;
ALTER TABLE chat.widgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.widgets FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON chat.widgets TO authenticated;
CREATE POLICY widgets_select ON chat.widgets FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM chat.messages m
        WHERE m.id = widgets.message_id AND m.retracted_at IS NULL
          AND NOT (m.deleted_for_user_ids ? (SELECT auth.uid()::text)))
);

-- One-use authorization, private to the definer. Never trust a caller-set GUC,
-- including through another definer that may invoke the canonical writer.
CREATE TABLE chat.widget_id_grants (message_id text PRIMARY KEY, wid text NOT NULL);
ALTER TABLE chat.widget_id_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.widget_id_grants FROM PUBLIC, anon, authenticated, service_role;

-- A widget body's specification, or null when it is not a valid v2 widget.
-- Existing NOT VALID constraints do not establish the shape of historical rows.
-- Keep the original JSON byte checks: jsonb::text would change whitespace.
CREATE FUNCTION chat.widget_spec(content text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE spec jsonb;
BEGIN
    IF content IS NULL OR octet_length(content) > 6144 OR NOT pg_input_is_valid(content, 'jsonb') THEN RETURN NULL; END IF;
    spec := content::jsonb;
    IF jsonb_typeof(spec) IS DISTINCT FROM 'object'
       OR jsonb_typeof(spec->'v') IS DISTINCT FROM 'number' THEN RETURN NULL; END IF;
    IF NOT pg_input_is_valid(spec->>'v', 'double precision') THEN RETURN NULL; END IF;
    IF (spec->>'v')::double precision <> 2
       OR jsonb_typeof(spec->'text') IS DISTINCT FROM 'string'
       OR length(spec->>'text') NOT BETWEEN 1 AND 200
       OR jsonb_typeof(spec->'app') IS DISTINCT FROM 'string' OR length(spec->>'app') = 0
       OR jsonb_typeof(spec->'view') IS DISTINCT FROM 'string' OR length(spec->>'view') = 0
       OR spec ?| ARRAY['id', 'title'] THEN RETURN NULL; END IF;
    IF spec ? 'data' AND (jsonb_typeof(spec->'data') IS DISTINCT FROM 'object'
        OR octet_length((content::json->'data')::text) > 4096) THEN RETURN NULL; END IF;
    RETURN spec;
END;
$$;
REVOKE ALL ON FUNCTION chat.widget_spec(text) FROM PUBLIC, anon, authenticated, service_role;

-- The insert trigger's writer. Messages sent before this release are
-- registered by the separate backfill release, under their message ids.
CREATE FUNCTION chat.register_widget_message(message chat.messages) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE spec jsonb := chat.widget_spec(message.content);
BEGIN
    IF message.content_type <> 'widget' OR spec IS NULL THEN RETURN; END IF;
    IF spec ? 'wid' AND (jsonb_typeof(spec->'wid') IS DISTINCT FROM 'string'
        OR length(spec->>'wid') = 0) THEN RETURN; END IF;
    INSERT INTO chat.widgets(id, chat_id, message_id, app, view, text, data, created_by, created_at)
    VALUES (COALESCE(spec->>'wid', message.id), message.chat_id, message.id,
        spec->>'app', spec->>'view', spec->>'text', spec->'data', message.sender_user_id, message.created_at)
    ON CONFLICT (message_id) DO NOTHING;
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Widget could not be sent' USING ERRCODE = '23505';
END;
$$;
REVOKE ALL ON FUNCTION chat.register_widget_message(chat.messages) FROM PUBLIC, anon, authenticated, service_role;

-- Run as invoker: a private grant AND the definer's effective role are required.
CREATE FUNCTION chat.guard_widget_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE spec jsonb; writer name;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF (OLD.content_type = 'widget' AND (NEW.content IS DISTINCT FROM OLD.content
            OR NEW.content_type IS DISTINCT FROM OLD.content_type))
           OR (NEW.content_type = 'widget' AND OLD.content_type IS DISTINCT FROM NEW.content_type) THEN
            RAISE EXCEPTION 'Widget message content and type are immutable' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.content_type <> 'widget' OR NEW.content IS NULL
       OR octet_length(NEW.content) > 6144 THEN RETURN NEW; END IF;
    IF NOT pg_input_is_valid(NEW.content, 'jsonb') THEN RETURN NEW; END IF;
    spec := NEW.content::jsonb;
    IF jsonb_typeof(spec) IS DISTINCT FROM 'object' OR NOT (spec ? 'wid') THEN RETURN NEW; END IF;
    SELECT pg_get_userbyid(proowner) INTO writer FROM pg_proc
      WHERE oid = 'chat.send_widget(text,text,text,text,text,text,json,text,text,integer)'::regprocedure;
    IF current_user IS DISTINCT FROM writer OR jsonb_typeof(spec->'wid') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'Widget identity must be assigned by send_widget' USING ERRCODE = '42501';
    END IF;
    DELETE FROM chat.widget_id_grants g WHERE g.message_id = NEW.id AND g.wid = spec->>'wid';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Widget identity must be assigned by send_widget' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.guard_widget_identity() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION chat.register_inserted_widget() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM chat.register_widget_message(NEW);
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.register_inserted_widget() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION chat.send_widget(
    p_message_id text, p_chat_id text, p_sender_user_id text,
    p_text text, p_app text, p_view text, p_data json DEFAULT NULL,
    p_reply_to_message_id text DEFAULT NULL, p_thread_root_id text DEFAULT NULL,
    p_height integer DEFAULT NULL
) RETURNS TABLE(message_id text, widget_id text, seq bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    wid text; content json; sent record;
    id_lock bigint; client_lock bigint;
BEGIN
    IF NULLIF(p_message_id, '') IS NULL OR NULLIF(p_chat_id, '') IS NULL THEN
        RAISE EXCEPTION 'message id and chat id are required';
    END IF;
    IF chat.can_act_as(p_sender_user_id, p_chat_id) IS NOT TRUE THEN
        RAISE EXCEPTION 'Widgets can be sent only as yourself or your own member agent' USING ERRCODE = '42501';
    END IF;
    IF p_height IS NOT NULL AND p_height NOT BETWEEN 64 AND 520 THEN
        RAISE EXCEPTION 'height must be an integer from 64 to 520' USING ERRCODE = '23514';
    END IF;
    -- Match the canonical writer's namespaces and order, including concurrent
    -- legacy sends. The nested writer takes these same transaction locks again.
    id_lock := pg_catalog.hashtextextended('chat.messages.id:' || p_message_id, 0);
    client_lock := pg_catalog.hashtextextended('chat.messages.client:' || p_chat_id || ':' || p_message_id, 0);
    PERFORM pg_catalog.pg_advisory_xact_lock(LEAST(id_lock, client_lock));
    IF id_lock <> client_lock THEN PERFORM pg_catalog.pg_advisory_xact_lock(GREATEST(id_lock, client_lock)); END IF;
    SELECT w.id INTO wid FROM chat.widgets w WHERE w.message_id = p_message_id;
    wid := COALESCE(wid, gen_random_uuid()::text);
    content := json_build_object('v', 2, 'text', p_text, 'app', p_app, 'view', p_view);
    IF p_data IS NOT NULL THEN
        -- json, rather than jsonb, retains the caller's original data bytes.
        content := json_build_object('v', 2, 'text', p_text, 'app', p_app, 'view', p_view, 'data', p_data);
    END IF;
    -- Preserve data's JSON source when adding the system-assigned identity.
    content := (left(content::text, -1)
        || CASE WHEN p_height IS NULL THEN '' ELSE ',"height":' || p_height::text END
        || ',"wid":' || to_json(wid)::text || '}')::json;
    INSERT INTO chat.widget_id_grants(message_id, wid) VALUES(p_message_id, wid);
    SELECT * INTO STRICT sent FROM chat.send_message_idempotent(
        p_message_id, p_chat_id, p_sender_user_id, NULL, content::text, 'widget',
        p_reply_to_message_id, p_thread_root_id, false, false);
    -- The guard consumes an insert's grant; a replay makes no insert.
    DELETE FROM chat.widget_id_grants g WHERE g.message_id = p_message_id;
    RETURN QUERY SELECT sent.id::text, w.id, sent.seq::bigint
        FROM chat.widgets w WHERE w.message_id = sent.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Authoritative widget row missing for %', p_message_id; END IF;
END;
$$;
REVOKE ALL ON FUNCTION chat.send_widget(text,text,text,text,text,text,json,text,text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.send_widget(text,text,text,text,text,text,json,text,text,integer) TO authenticated;

-- Only widget rows reach the guard: messages is the hottest write path.
CREATE TRIGGER widget_identity_guard_insert BEFORE INSERT ON chat.messages
    FOR EACH ROW WHEN (NEW.content_type = 'widget') EXECUTE FUNCTION chat.guard_widget_identity();
CREATE TRIGGER widget_identity_guard_update BEFORE UPDATE OF content, content_type ON chat.messages
    FOR EACH ROW WHEN (OLD.content_type = 'widget' OR NEW.content_type = 'widget') EXECUTE FUNCTION chat.guard_widget_identity();
CREATE TRIGGER widget_identity_register AFTER INSERT ON chat.messages
    FOR EACH ROW WHEN (NEW.content_type = 'widget') EXECUTE FUNCTION chat.register_inserted_widget();

COMMENT ON TABLE chat.widgets IS 'Immutable widget specifications, identified independently of their display slots; original-message visibility remains authoritative.';

-- Append registry identities after the existing actor-scoped message selection.
-- Preserve the deployed history and inbox authorization, paging, fences, rules and grants.
DROP FUNCTION chat.message_history_as(text, text, text, bigint, integer);
CREATE FUNCTION chat.message_history_as(p_chat_id text, p_as_user_id text DEFAULT NULL::text, p_thread_root_id text DEFAULT NULL::text, p_before_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 20) RETURNS TABLE(id text, seq bigint, sender_user_id text, sender_name text, to_user_ids text[], content text, content_type text, reply_to_message_id text, thread_root_id text, created_at timestamp with time zone, file_item_id uuid, file_version integer, is_whisper boolean, widget_id text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_actor TEXT := COALESCE(NULLIF(trim(COALESCE(p_as_user_id, '')), ''), (SELECT auth.uid()::text));
BEGIN
    IF v_actor IS NULL OR NOT chat.is_acting_as(v_actor) THEN
        RAISE EXCEPTION 'Not allowed to act as %', v_actor;
    END IF;
    RETURN QUERY
    SELECT m.id, m.seq::BIGINT, m.sender_user_id, COALESCE(u.display_name, '未知用户'), m.to_user_ids, m.content,
           m.content_type, m.reply_to_message_id, m.thread_root_id, m.created_at, m.file_item_id, m.file_version, m.is_whisper, wi.id
      FROM chat.messages m
      LEFT JOIN identity.users u ON u.id = m.sender_user_id
      LEFT JOIN chat.widgets wi ON wi.message_id = m.id AND m.content_type = 'widget'
           AND m.retracted_at IS NULL AND NOT (m.deleted_for_user_ids ? v_actor)
     WHERE m.chat_id = p_chat_id
       AND m.deleted_at IS NULL
       AND m.thread_root_id IS NOT DISTINCT FROM NULLIF(p_thread_root_id, '')
       AND (p_before_seq IS NULL OR m.seq < p_before_seq)
       AND chat.message_visible_at((SELECT chat.history_floor(p_chat_id, v_actor)),
             m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, v_actor)
     ORDER BY m.seq DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
END;
$$;
REVOKE ALL ON FUNCTION chat.message_history_as(text, text, text, bigint, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.message_history_as(text, text, text, bigint, integer) TO authenticated, service_role;

DROP FUNCTION identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint);
CREATE FUNCTION identity.pull_agent_inbox_v2(p_agent_user_id text, p_chat_id text DEFAULT NULL::text, p_after_seq bigint DEFAULT NULL::bigint, p_limit integer DEFAULT 80, p_scan_after jsonb DEFAULT NULL::jsonb, p_scan_max_ingest_seq bigint DEFAULT NULL::bigint) RETURNS TABLE(chat_id text, chat_kind text, chat_public_id integer, chat_name text, chat_creator_user_id text, listen_mode text, notification_level text, last_read_seq bigint, id text, seq bigint, sender_user_id text, sender_type text, sender_display_name text, sender_gugu_number integer, content text, content_type text, to_user_ids text[], is_whisper boolean, reply_to_message_id text, reply_to_sender_user_id text, reply_to_content text, thread_root_id text, is_thread_root boolean, created_at timestamp with time zone, scan_max_ingest_seq bigint, via_app text, file_item_id uuid, file_version integer, file_blob_id uuid, group_rules text, named_identities jsonb, widget_id text)
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
                 WHEN chat.group_prompt_present(page.group_prompt) THEN page.group_prompt
                 WHEN page.kind = 'topic' AND page.source_chat_id IS NOT NULL
                      AND (chat.is_chat_member(page.source_chat_id, p_agent_user_id)
                           OR chat.is_chat_member(page.source_chat_id, (SELECT auth.uid()::text)))
                      THEN COALESCE((SELECT CASE WHEN chat.group_prompt_present(s.group_prompt) THEN s.group_prompt END
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
         ), '{}'::jsonb),
         wi.id
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
                 m.file_item_id, m.file_version, m.file_blob_id, m.retracted_at, m.deleted_for_user_ids
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
     LEFT JOIN chat.widgets wi ON wi.message_id = page.id AND page.content_type = 'widget'
           AND page.retracted_at IS NULL AND NOT (page.deleted_for_user_ids ? p_agent_user_id)
     ORDER BY page.chat_id, page.seq;
 END;
 $$;

-- The function-DDL guard closes authenticated execution even on replacement. Restore the existing grant.
REVOKE ALL ON FUNCTION identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
