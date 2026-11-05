-- A durable chat outbox supplies the topic id. Older callers may omit it.
-- Keep one signature so PostgREST and positional SQL calls resolve unambiguously.
DROP FUNCTION chat.create_topic(TEXT, TEXT, TEXT, TEXT[], TEXT);

CREATE OR REPLACE FUNCTION chat.create_topic(p_source_chat_id text, p_source_message_id text, p_name text DEFAULT NULL::text, p_member_user_ids text[] DEFAULT NULL::text[], p_as_user_id text DEFAULT NULL::text, p_topic_id text DEFAULT NULL::text) RETURNS TABLE(chat_id text, public_id integer, name text, source_chat_id text, source_message_id text, creator_user_id text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'chat', 'identity', 'public', 'pg_catalog'
    AS $$
#variable_conflict use_column
DECLARE
    v_me TEXT := auth.uid()::text;
    v_actor TEXT;
    v_actor_is_agent BOOLEAN;
    v_actor_owner TEXT;
    v_owner_in_source BOOLEAN;
    v_actor_name TEXT;
    v_source_kind TEXT;
    v_source_hide_history BOOLEAN;
    v_source_content TEXT;
    v_source_is_whisper BOOLEAN;
    v_source_retracted TIMESTAMPTZ;
    v_source_content_type TEXT;
    v_name TEXT;
    v_chat_id TEXT := COALESCE(NULLIF(p_topic_id, ''), gen_random_uuid()::text);
    v_existing chat.chats%ROWTYPE;
    v_members TEXT[];
    v_denial TEXT;
    v_candidate TEXT;
    v_join JSONB;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    v_actor := COALESCE(NULLIF(trim(COALESCE(p_as_user_id, '')), ''), v_me);
    SELECT u.type = 'agent', u.owner_user_id, u.display_name
      INTO v_actor_is_agent, v_actor_owner, v_actor_name
      FROM identity.users u WHERE u.id = v_actor;
    IF v_actor <> v_me AND NOT (COALESCE(v_actor_is_agent, false) AND v_actor_owner = v_me) THEN
        RAISE EXCEPTION 'Cannot open a topic as %', v_actor;
    END IF;

    SELECT c.kind, c.hide_history INTO v_source_kind, v_source_hide_history
      FROM chat.chats c WHERE c.id = p_source_chat_id;
    IF v_source_kind IS NULL THEN
        RAISE EXCEPTION 'Source chat % not found', p_source_chat_id;
    END IF;
    IF v_source_kind = 'topic' THEN
        RAISE EXCEPTION 'A topic cannot grow out of another topic';
    END IF;

    v_owner_in_source := COALESCE(v_actor_is_agent, false)
        AND v_actor_owner IS NOT NULL
        AND chat.is_chat_member(p_source_chat_id, v_actor_owner);

    IF NOT chat.is_chat_member(p_source_chat_id, v_actor) AND NOT v_owner_in_source THEN
        RAISE EXCEPTION 'Not a member of the source chat';
    END IF;

    -- Serialize equivalent requests before any enrollment or notice is emitted.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chat.create_topic:' || v_chat_id, 0));
    SELECT c.* INTO v_existing FROM chat.chats c WHERE c.id = v_chat_id;
    IF FOUND THEN
        IF v_existing.kind IS DISTINCT FROM 'topic'
           OR v_existing.source_chat_id IS DISTINCT FROM p_source_chat_id
           OR v_existing.source_message_id IS DISTINCT FROM p_source_message_id
           OR v_existing.creator_user_id IS DISTINCT FROM v_actor THEN
            RAISE EXCEPTION 'topic id already used for another creation' USING ERRCODE = '23505';
        END IF;
        RETURN QUERY
        SELECT c.id, c.public_id, c.name, c.source_chat_id, c.source_message_id, c.creator_user_id
          FROM chat.chats c WHERE c.id = v_chat_id;
        RETURN;
    END IF;

    -- Creating a topic with an agent enrolls it through ordinary source
    -- admission; a pending approval cannot produce a topic-only participant.
    IF v_owner_in_source AND NOT chat.is_chat_member(p_source_chat_id, v_actor) THEN
        v_join := chat.add_group_agent(p_source_chat_id, v_actor, NULL, v_actor);
        IF v_join->>'status' NOT IN ('joined','already_member') THEN
            RAISE EXCEPTION 'agent_join_requires_manager: join the source before opening this topic';
        END IF;
    END IF;
    FOREACH v_candidate IN ARRAY COALESCE(p_member_user_ids, ARRAY[]::TEXT[]) LOOP
        IF NOT chat.is_chat_member(p_source_chat_id, v_candidate)
           AND EXISTS (SELECT 1 FROM identity.users u WHERE u.id = v_candidate AND u.type = 'agent') THEN
            v_join := chat.add_group_agent(p_source_chat_id, v_candidate, NULL, v_actor);
            IF v_join->>'status' NOT IN ('joined','already_member') THEN
                RAISE EXCEPTION 'agent_join_requires_manager: join the source before opening this topic';
            END IF;
        END IF;
    END LOOP;

    SELECT m.content, m.is_whisper, m.retracted_at, m.content_type
      INTO v_source_content, v_source_is_whisper, v_source_retracted, v_source_content_type
    FROM chat.messages m
    WHERE m.id = p_source_message_id
      AND m.chat_id = p_source_chat_id
      AND m.deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Source message % is not a live message of chat %',
            p_source_message_id, p_source_chat_id;
    END IF;

    -- 悄悄话开不出话题:话题对来源线全员可见,而它的名字截自来源消息 ⇒ 开一条就是公开那句话。
    IF COALESCE(v_source_is_whisper, false) THEN
        RAISE EXCEPTION 'A whisper cannot be the source of a topic';
    END IF;

    -- 撤回的消息同理:那句话已经被收回,❌ 不许借话题名把它重新贴到所有人眼前。
    IF v_source_retracted IS NOT NULL THEN
        RAISE EXCEPTION 'A retracted message cannot be the source of a topic';
    END IF;

    IF NOT chat.can_read_message(p_source_message_id, v_actor)
       AND NOT (v_owner_in_source AND chat.can_read_message(p_source_message_id, v_actor_owner)) THEN
        RAISE EXCEPTION 'Source message % is not readable by %', p_source_message_id, v_actor;
    END IF;

    v_name := NULLIF(trim(COALESCE(p_name, '')), '');
    -- 只有正文类消息值得截名:系统消息会开出一条叫「某某 开了话题:…」的话题,附件会开出
    -- 「[附件] 季度报表.xlsx (2.1 MB)」—— 都不像人起的名字。其余类型退回「话题」,用户自己改。
    IF v_name IS NULL AND COALESCE(v_source_content_type, 'text') = 'text' THEN
        v_name := chat.topic_name_from_message(v_source_content);
    END IF;
    v_name := COALESCE(v_name, '话题');

    -- @@@5856 hide_history 跟着来源线走。不带它 ⇒ 话题默认 false ⇒ 入列触发器给成员置的时间界是 NULL,
    -- 于是「被时间界挡住的人在话题里说一句话(说话即参与)就解锁全部历史」。
    -- 可见继承来源,那道界也得继承。来源线里本来没有界的人不受影响 —— 他们走 can_see_topic_message。
    INSERT INTO chat.chats (id, kind, name, creator_user_id, source_chat_id, source_message_id, hide_history)
    VALUES (v_chat_id, 'topic', v_name, v_actor, p_source_chat_id, p_source_message_id,
            COALESCE(v_source_hide_history, false));

    -- ⚠️ 这道 is_chat_member 与下面 row3 的 `NOT v_owner_in_source OR …` 互补:主人不在来源线时
    -- row3 不过滤,但这里已经先把他踢掉了。动任一处都要看另一处。
    SELECT COALESCE(array_agg(DISTINCT candidate.user_id), ARRAY[]::TEXT[])
    INTO v_members
    FROM unnest(COALESCE(p_member_user_ids, ARRAY[]::TEXT[])) AS candidate(user_id)
    WHERE NULLIF(candidate.user_id, '') IS NOT NULL
      AND candidate.user_id <> v_actor
      AND chat.is_chat_member(p_source_chat_id, candidate.user_id);

    INSERT INTO chat.chat_members (chat_id, user_id, role)
    SELECT v_chat_id, v_actor, 'member'
    UNION ALL
    SELECT v_chat_id, v_actor_owner, 'member'
     WHERE v_owner_in_source AND v_actor_owner <> v_actor
    UNION ALL
    SELECT v_chat_id, member_id, 'member' FROM unnest(v_members) AS member_id
     WHERE NOT v_owner_in_source OR member_id <> v_actor_owner
    ON CONFLICT (chat_id, user_id) DO NOTHING;

    INSERT INTO chat.group_agent_states (
        chat_id, agent_user_id, functional_role, capability_roles, last_action, updated_at
    )
    SELECT v_chat_id, u.id, 'member', ARRAY['member']::TEXT[], '已加入话题', now()
    FROM identity.users u
    WHERE u.type = 'agent'
      AND (u.id = v_actor OR u.id = ANY(v_members));

    IF COALESCE(v_actor_is_agent, false) THEN
        INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, client_message_id)
        VALUES (
            gen_random_uuid()::text,
            p_source_chat_id,
            v_actor,
            COALESCE(v_actor_name, 'Agent') || ' 开了话题:' || v_name,
            'system',
            'topic-opened:' || v_chat_id
        )
        ON CONFLICT (chat_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING;
    END IF;

    RETURN QUERY
    SELECT c.id, c.public_id, c.name, c.source_chat_id, c.source_message_id, c.creator_user_id
    FROM chat.chats c WHERE c.id = v_chat_id;
END;
$$;

REVOKE ALL ON FUNCTION chat.create_topic(TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.create_topic(TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION chat.create_topic(text, text, text, text[], text, text) IS 'Open a topic from an existing message, including source provenance and ordinary creator admission. A supplied topic id makes retries idempotent.';

-- Forwarded text uses the canonical idempotent writer. Validate a new source
-- there, where deletion, retraction and message visibility are authoritative.
DO $migration$
DECLARE
    signature text := 'chat.send_message_idempotent(text,text,text,text[],text,text,text,text,boolean,boolean,text,uuid,integer,text,uuid)';
    definition text;
    original_acl aclitem[];
    permission record;
    needle text := '        -- F16 An App''s message sent in a person''s name:';
BEGIN
    definition := pg_get_functiondef(signature::regprocedure);
    SELECT COALESCE(proacl, acldefault('f', proowner)) INTO original_acl
      FROM pg_proc WHERE oid = signature::regprocedure;
    IF strpos(definition, needle) = 0 THEN RAISE EXCEPTION 'send_message_idempotent source guard anchor missing'; END IF;
    EXECUTE replace(definition, needle, $guard$
        IF p_forwarded_from_message_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM chat.messages source
            WHERE source.id = p_forwarded_from_message_id
              AND source.deleted_at IS NULL AND source.retracted_at IS NULL
        ) THEN
            RAISE EXCEPTION 'Original message is missing, retracted, or not readable';
        END IF;
        -- F16 An App's message sent in a person's name:$guard$);
    -- The foundation's DDL trigger closes CREATE OR REPLACE functions too.
    -- Restore only the predecessor's execution grants after changing its body.
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
      FROM aclexplode(original_acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', signature,
          CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
          CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
END;
$migration$;

-- Replaying an attachment forward must not place a second file or take another
-- blob reference before the writer discovers that this message already exists.
DO $migration$
DECLARE
    signature text := 'chat.attachment_forward(text,text,text,text,text[],text,boolean,boolean,text)';
    definition text;
    original_acl aclitem[];
    permission record;
BEGIN
    definition := pg_get_functiondef(signature::regprocedure);
    SELECT COALESCE(proacl, acldefault('f', proowner)) INTO original_acl
      FROM pg_proc WHERE oid = signature::regprocedure;
    IF strpos(definition, '    v_placed RECORD;') = 0 OR strpos(definition, E'BEGIN\n') = 0 THEN
        RAISE EXCEPTION 'attachment_forward replay anchor missing';
    END IF;
    definition := replace(definition, '    v_placed RECORD;', E'    v_existing chat.messages%ROWTYPE;\n    v_placed RECORD;');
    EXECUTE replace(definition, E'BEGIN\n', $replay$BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chat.attachment_forward:' || p_message_id, 0));
    SELECT * INTO v_existing FROM chat.messages m WHERE m.id = p_message_id;
    IF FOUND THEN
        RETURN QUERY SELECT * FROM chat.send_message_idempotent(
            p_message_id, p_chat_id, p_sender_user_id, COALESCE(p_to_user_ids, '{}'), v_existing.content, 'attachment',
            NULL, p_thread_root_id, COALESCE(p_is_thread_root, false), COALESCE(p_is_whisper, false), NULL,
            v_existing.file_item_id, v_existing.file_version, p_source_message_id, v_existing.file_blob_id);
        RETURN;
    END IF;
$replay$);
    -- The foundation's DDL trigger closes CREATE OR REPLACE functions too.
    -- Restore only the predecessor's execution grants after changing its body.
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
      FROM aclexplode(original_acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', signature,
          CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
          CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
END;
$migration$;
