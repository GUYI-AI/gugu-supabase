-- Group authority belongs to the source group; participation settings belong to each topic.
-- Membership reads use chat.active_members (live identities); writes target chat.chat_members.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION chat.group_is_manager(p_chat_id TEXT, p_actor TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
        SELECT 1 FROM chat.chats c JOIN chat.active_members m ON m.chat_id = c.id
        WHERE c.id = p_chat_id AND c.kind = 'group' AND c.status <> 'archived'
          AND m.user_id = p_actor AND m.role IN ('owner', 'admin')
    );
$$;
REVOKE ALL ON FUNCTION chat.group_is_manager(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- The only management-scope resolver. Topic-local roles never enter this result.
-- Creator authority is retained only for topics inside a private conversation.
CREATE FUNCTION chat.management_authority(p_chat_id TEXT, p_actor TEXT)
RETURNS TABLE(source_chat_id TEXT, source_kind TEXT, my_role TEXT, can_manage BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT s.id, s.kind, CASE WHEN s.kind = 'group' THEN m.role ELSE 'member' END,
        CASE WHEN s.kind = 'group' THEN chat.group_is_manager(s.id, p_actor)
             ELSE c.kind = 'topic' AND s.kind IN ('dm', 'ai') AND s.status <> 'archived'
               AND m.user_id IS NOT NULL AND actor.type = 'human'
               AND (creator.id = p_actor OR (creator.type = 'agent' AND creator.owner_user_id = p_actor))
        END
      FROM chat.chats c
      JOIN chat.chats s ON s.id = CASE WHEN c.kind = 'topic' THEN c.source_chat_id ELSE c.id END
      LEFT JOIN chat.active_members m ON m.chat_id = s.id AND m.user_id = p_actor
      LEFT JOIN identity.users creator ON creator.id = c.creator_user_id
      LEFT JOIN identity.users actor ON actor.id = p_actor
     WHERE c.id = p_chat_id;
$$;
REVOKE ALL ON FUNCTION chat.management_authority(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION chat.can_manage_group_members(p_chat_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT COALESCE((SELECT can_manage FROM chat.management_authority(p_chat_id, auth.uid()::text)), false);
$$;
REVOKE ALL ON FUNCTION chat.can_manage_group_members(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.can_manage_group_members(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION chat.workspace_is_chat_admin(p_chat_id TEXT, p_actor TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT source_kind = 'group' AND can_manage FROM chat.management_authority(p_chat_id, p_actor);
$$;
REVOKE ALL ON FUNCTION chat.workspace_is_chat_admin(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION chat.require_group_manager(p_chat_id TEXT, p_as_user_id TEXT)
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id);
BEGIN
    IF NOT EXISTS (SELECT 1 FROM chat.management_authority(p_chat_id, v_actor) a
        JOIN chat.chats c ON c.id = p_chat_id WHERE a.can_manage AND c.status <> 'archived') THEN
        RAISE EXCEPTION 'group_manager_required' USING ERRCODE = '42501';
    END IF;
    RETURN v_actor;
END;
$$;
REVOKE ALL ON FUNCTION chat.require_group_manager(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION chat.group_info_as(p_chat_id TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id); v_group chat.chats%ROWTYPE; v_authority RECORD;
BEGIN
    SELECT * INTO v_group FROM chat.chats WHERE id = p_chat_id AND kind IN ('group', 'topic');
    IF NOT FOUND OR NOT (
        chat.is_chat_member(p_chat_id, v_actor) OR chat.is_chat_member(p_chat_id, auth.uid()::text)
        OR (v_group.kind = 'topic' AND (chat.is_chat_member(v_group.source_chat_id, v_actor)
            OR chat.is_chat_member(v_group.source_chat_id, auth.uid()::text)))
    ) THEN RAISE EXCEPTION 'group_not_visible' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v_authority FROM chat.management_authority(p_chat_id, v_actor);
    RETURN jsonb_build_object(
        'id', v_group.id, 'public_id', v_group.public_id, 'creator_user_id', v_group.creator_user_id,
        'name', v_group.name, 'status', v_group.status, 'group_prompt', v_group.group_prompt,
        'default_agent_type', v_group.default_agent_type, 'join_token', v_group.join_token,
        'description', v_group.description, 'max_members', v_group.max_members,
        'allow_member_invite', v_group.allow_member_invite, 'invite_link_enabled', v_group.invite_link_enabled,
        'agent_join_approval', v_group.agent_join_approval, 'join_mode', v_group.join_mode,
        'hide_history', v_group.hide_history, 'avatar_url', v_group.avatar_url,
        'is_discoverable', v_group.is_discoverable, 'agent_flood_threshold', v_group.agent_flood_threshold,
        'agent_flood_threshold_effective', chat.agent_flood_threshold_for(p_chat_id),
        'my_role', v_authority.my_role, 'can_manage', COALESCE(v_authority.can_manage, false),
        'can_archive_topic', v_group.kind = 'topic' AND COALESCE(v_authority.can_manage, false),
        'can_dissolve', v_group.kind = 'group' AND COALESCE(v_authority.my_role = 'owner', false)
    );
END;
$$;
REVOKE ALL ON FUNCTION chat.group_info_as(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.group_info_as(TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION chat.set_group_member_role_as(p_chat_id TEXT, p_member_user_id TEXT, p_role TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT; v_role TEXT;
BEGIN
    PERFORM 1 FROM chat.chats WHERE id = p_chat_id AND kind = 'group' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'group_roles_require_source_group' USING ERRCODE = '42501'; END IF;
    v_actor := chat.require_group_manager(p_chat_id, p_as_user_id);
    IF p_role IS NULL OR p_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION 'invalid_group_role'; END IF;
    SELECT role INTO v_role FROM chat.active_members WHERE chat_id = p_chat_id AND user_id = p_member_user_id FOR UPDATE;
    IF v_role IS NULL THEN RAISE EXCEPTION 'group_member_not_found'; END IF;
    IF v_role = 'owner' THEN RAISE EXCEPTION 'group_owner_role_protected'; END IF;
    IF v_role <> p_role THEN
        UPDATE chat.chat_members SET role = p_role WHERE chat_id = p_chat_id AND user_id = p_member_user_id;
        UPDATE chat.group_agent_states SET last_action = 'gugu:i18n:messaging:chatService.groupAction.roleUpdated', updated_at = now()
        WHERE chat_id = p_chat_id AND agent_user_id = p_member_user_id;
        PERFORM chat.announce_group_management(p_chat_id, v_actor, p_member_user_id, p_role);
    END IF;
    RETURN jsonb_build_object('chat_id', p_chat_id, 'user_id', p_member_user_id, 'role', p_role);
END;
$$;
REVOKE ALL ON FUNCTION chat.set_group_member_role_as(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.set_group_member_role_as(TEXT, TEXT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION chat.list_member_ids(p_chat_id text, p_as_user_id text DEFAULT NULL::text) RETURNS TABLE(user_id text, role text, listen_mode text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_caller TEXT := (SELECT auth.uid()::text);
    v_actor TEXT;
    v_is_agent BOOLEAN;
    v_owner TEXT;
BEGIN
    v_actor := COALESCE(NULLIF(trim(p_as_user_id), ''), v_caller);
    SELECT u.type = 'agent', u.owner_user_id INTO v_is_agent, v_owner
      FROM identity.users u WHERE u.id = v_actor;
    IF v_actor IS DISTINCT FROM v_caller AND NOT (COALESCE(v_is_agent, false) AND v_owner = v_caller) THEN
        RAISE EXCEPTION 'Not allowed to act as %', v_actor;
    END IF;
    -- 与 chat.chat_facts 同一个可见域:actor 在,或调用者(主人)在,或这是一条话题而两人之一在来源线。
    IF NOT EXISTS (
        SELECT 1 FROM chat.chats c
         WHERE c.id = p_chat_id
           AND (
               chat.is_chat_member(c.id, v_actor)
               OR chat.is_chat_member(c.id, v_caller)
               OR (c.kind = 'topic' AND c.source_chat_id IS NOT NULL
                   AND (chat.is_chat_member(c.source_chat_id, v_actor)
                        OR chat.is_chat_member(c.source_chat_id, v_caller)))
           )
    ) THEN
        RETURN;
    END IF;
    RETURN QUERY SELECT cm.user_id, COALESCE(a.my_role, 'member'), cm.listen_mode
                   FROM chat.active_members cm
                   LEFT JOIN LATERAL chat.management_authority(p_chat_id, cm.user_id) a ON true
                  WHERE cm.chat_id = p_chat_id;
END;
$$;
REVOKE ALL ON FUNCTION chat.list_member_ids(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_member_ids(TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION chat.archive_topic_as(p_chat_id TEXT, p_as_user_id TEXT, p_confirm_name TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_actor TEXT := chat.require_group_actor(p_as_user_id);
    v_topic chat.chats%ROWTYPE;
    v_authority RECORD;
    v_actor_type TEXT;
BEGIN
    SELECT * INTO v_authority FROM chat.management_authority(p_chat_id, v_actor);
    -- Use the same source-before-topic lock order as source departure.
    PERFORM 1 FROM chat.chats s WHERE s.id = v_authority.source_chat_id FOR SHARE;
    PERFORM 1 FROM chat.active_members m
     WHERE m.chat_id = v_authority.source_chat_id AND m.user_id = v_actor FOR SHARE;
    SELECT * INTO v_topic FROM chat.chats WHERE id = p_chat_id AND kind = 'topic' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Topic not found' USING ERRCODE = '22023'; END IF;
    SELECT * INTO v_authority FROM chat.management_authority(p_chat_id, v_actor);
    SELECT type INTO v_actor_type FROM identity.users WHERE id = v_actor;
    IF NOT COALESCE(v_authority.can_manage, false) THEN
        RAISE EXCEPTION 'Source conversation management required' USING ERRCODE = '42501';
    END IF;
    IF v_actor_type = 'agent' AND (p_confirm_name IS NULL
        OR convert_to(p_confirm_name, 'UTF8') IS DISTINCT FROM convert_to(v_topic.name, 'UTF8')) THEN
        RAISE EXCEPTION 'Topic name confirmation must exactly match the current topic name, including case and whitespace'
            USING ERRCODE = '22023';
    END IF;
    UPDATE chat.chats SET status = 'archived' WHERE id = p_chat_id AND status <> 'archived';
    RETURN jsonb_build_object('chat_id', p_chat_id, 'status', 'archived');
END;
$$;
REVOKE ALL ON FUNCTION chat.archive_topic_as(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.archive_topic_as(TEXT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION chat.create_topic(p_source_chat_id text, p_source_message_id text, p_name text DEFAULT NULL::text, p_member_user_ids text[] DEFAULT NULL::text[], p_as_user_id text DEFAULT NULL::text) RETURNS TABLE(chat_id text, public_id integer, name text, source_chat_id text, source_message_id text, creator_user_id text)
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
    v_chat_id TEXT := gen_random_uuid()::text;
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

REVOKE ALL ON FUNCTION chat.create_topic(TEXT, TEXT, TEXT, TEXT[], TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.create_topic(TEXT, TEXT, TEXT, TEXT[], TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION chat.enroll_topic_agent_owner()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_topic chat.chats%ROWTYPE;
    v_owner TEXT;
BEGIN
    SELECT * INTO v_topic FROM chat.chats WHERE id = NEW.chat_id AND kind = 'topic';
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT owner_user_id INTO v_owner FROM identity.users WHERE id = NEW.user_id AND type = 'agent';
    IF NOT FOUND THEN RETURN NULL; END IF;

    -- Lock the existing source seat: a concurrent source departure cannot
    -- invalidate the owner's eligibility before this admission commits.
    PERFORM 1 FROM chat.active_members m JOIN identity.users u ON u.id = m.user_id AND u.type = 'human'
     WHERE m.chat_id = v_topic.source_chat_id AND m.user_id = v_owner FOR KEY SHARE OF m;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'The Agent''s human owner cannot join this topic because they are not a member of its source conversation'
            USING ERRCODE = '42501';
    END IF;
    -- Existing seats keep their role, history boundary, read state and settings.
    -- The normal membership triggers supply visibility/inbox/revision behavior.
    INSERT INTO chat.chat_members(chat_id,user_id,role,joined_ingest_seq)
    VALUES (NEW.chat_id,v_owner,'member',NEW.joined_ingest_seq)
    ON CONFLICT (chat_id,user_id) DO NOTHING;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION chat.enroll_topic_agent_owner() FROM PUBLIC, anon, authenticated;
-- Decisions follow the same management resolver: a topic's local seat role is not authority.
CREATE OR REPLACE FUNCTION chat.gugu_decision_events_vote_scope_chk() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'chat', 'identity', 'public', 'pg_catalog'
    AS $$
DECLARE
    caller_user_id TEXT;
    is_admin_or_owner BOOLEAN;
BEGIN
    IF identity.is_trusted_decision_erasure_update(OLD, NEW) THEN
        NEW.updated_at := now();
        RETURN NEW;
    END IF;

    caller_user_id := (SELECT auth.uid()::text);
    IF caller_user_id IS NULL THEN
        RAISE EXCEPTION 'no auth.uid() — cannot identify caller';
    END IF;

    is_admin_or_owner := chat.can_manage_group_members(NEW.chat_id);

    IF OLD.status = 'pending' AND NEW.status = 'cancelled' THEN
        IF NOT is_admin_or_owner THEN
            RAISE EXCEPTION 'only owner/admin can cancel decision';
        END IF;
        NEW.updated_at := now();
        RETURN NEW;
    END IF;

    IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'cannot modify decision in status=%', OLD.status;
    END IF;

    IF NOT chat._keys_diff_owned_by(NEW.user_task_decisions, OLD.user_task_decisions, caller_user_id)
       OR NOT chat._keys_diff_owned_by(NEW.user_resource_states, OLD.user_resource_states, caller_user_id)
       OR NOT chat._keys_diff_owned_by(NEW.user_rationales, OLD.user_rationales, caller_user_id) THEN
        RAISE EXCEPTION 'supervisors can only modify their own vote keys';
    END IF;

    IF NEW.chat_id IS DISTINCT FROM OLD.chat_id
       OR NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
        RAISE EXCEPTION 'chat_id/event_type/created_by_user_id are immutable';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION chat.gugu_decision_events_vote_scope_chk() FROM PUBLIC;
ALTER POLICY gugu_decision_events_manager_update ON chat.gugu_decision_events
    USING (chat.can_manage_group_members(chat_id)) WITH CHECK (chat.can_manage_group_members(chat_id));
ALTER POLICY gugu_decision_events_owner_write ON chat.gugu_decision_events
    WITH CHECK (chat.can_manage_group_members(chat_id));

-- Retire the former topic hierarchy without changing participation or preferences.
UPDATE chat.chat_members m SET role = 'member'
  FROM chat.chats c WHERE c.id = m.chat_id AND c.kind = 'topic' AND m.role <> 'member';

NOTIFY pgrst, 'reload schema';
