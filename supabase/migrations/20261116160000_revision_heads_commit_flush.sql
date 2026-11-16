-- Revision heads are locked once, at commit, in user-id order; who-is-a-member is serialized per line.
--
-- Before: chat.account_revision_heads (one row per human) was locked the moment anything published to that user and
-- held to commit. Those row locks did two jobs. They numbered revisions, and, because a fan-out locked the heads of a
-- chat's members before reading the members, they also kept membership changes and fan-outs of one chat apart. One
-- row per user ties together every chat the user is in, so two transactions in different chats could take the same
-- heads (an owner's, an agent's) in opposite orders and deadlock: provision_taskpage_agent published to the owner while
-- creating an agent and then locked the project group's members, while add_group_agent locked {member, agent, owner}
-- sorted. The losing add_group_agent left a new agent outside its birth group.
--
-- After: the two jobs get separate locks.
--   * Numbering: publishing only stages the event (chat.pending_user_revisions). chat.flush_user_revisions, a deferred
--     constraint trigger, runs at commit and is the only writer of heads: one pass, sorted by user id.
--   * Membership vs fan-out: an exclusive transaction advisory lock per line (a chat with its topics), taken by
--     chat.lock_chat_revision_recipients at exactly the points that used to lock the line members' heads. Two
--     transactions now wait on each other there only if they touch the same line; before, they waited whenever the
--     lines shared any member. So no wait exists that did not exist before, and the cross-chat ones are gone.
--
-- Lock contract (each row: locks in the order taken; what it guarantees)
-- | operation                         | locks, in order                                              | guarantees
-- |-----------------------------------|--------------------------------------------------------------|----------------------------------------------
-- | message insert                    | chat row (assign_message_seq) -> line (broadcast_message_created) | contiguous seq per chat; recipients = members
-- |                                   |   -> admission reads the agents' state                        |   when the line lock is held
-- | line fan-out (reaction, receipt,  | line, then read chat.active_members                          | a concurrent joiner either reads the change
-- |   deletion, meta, topic activity, |                                                              |   after joining or receives its revision
-- |   roster, membership)             |                                                              |
-- | membership change (add_group_agent| chat row FOR UPDATE where the RPC takes it (add_group_agent, | concurrent fan-outs on the line finish before
-- |   provision, decide_group_join,   |   provision_taskpage_agent, decide_group_join; flood rule)   |   it or see the new members
-- |   create_topic, topic join, leave)|   -> line (roster/membership triggers)                       |
-- | session archival                  | member_liveness -> lines of all the agent's chats (sorted)   | an in-flight message admits before archival or
-- |                                   |   -> users row                                               |   sees the archived agent
-- | archive_user (remove identity)    | DM chat rows (sorted) -> lines of all its chats (sorted)     | fan-outs see the removal or finish before it
-- |                                   |   -> users row                                               |
-- | device presence                   | none of its own (the old sorted heads pre-lock only ordered  | -
-- |                                   |   the two publishes of one device update; staging does that) |
-- | heads flush (every transaction    | at commit, after all body work: heads of staged users, sorted| per-user revisions contiguous, in commit order,
-- |   that published)                 |                                                              |   committed with the state they describe
--
-- Rules for new code: publish through chat.publish_user_revision / chat.append_user_revision (never touch heads);
-- read a line's members only after chat.lock_chat_revision_recipients / chat.lock_lines; never
-- `SET CONSTRAINTS ALL IMMEDIATE` (it would run the flush mid-transaction; name the constraints).

CREATE UNLOGGED TABLE chat.pending_user_revisions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
    user_id TEXT NOT NULL,
    event TEXT NOT NULL,
    resource_key JSONB NOT NULL,
    tombstone BOOLEAN NOT NULL,
    wake TEXT NOT NULL CHECK (wake IN ('none', 'always', 'presence'))
);
CREATE INDEX pending_user_revisions_transaction ON chat.pending_user_revisions (transaction_id, id);
ALTER TABLE chat.pending_user_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE chat.pending_user_revisions FROM PUBLIC, anon, authenticated, service_role;

-- wake: 'always' sends im_revision_advanced at commit; 'presence' only when chat.claim_presence_wake grants it;
-- 'none' never (append_user_revision: a record without a wake).
CREATE FUNCTION chat.stage_user_revision(p_user_id text, p_event text, p_resource_key jsonb, p_tombstone boolean, p_wake text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'chat', 'public', 'pg_catalog' AS $$
BEGIN
    IF p_user_id IS NULL OR btrim(p_user_id) = '' THEN
        RAISE EXCEPTION 'revision user id is required';
    END IF;
    IF p_event IS NULL OR btrim(p_event) = '' THEN
        RAISE EXCEPTION 'revision event is required';
    END IF;
    IF p_event NOT IN (
      'agent_changed', 'chat_changed', 'chat_members_changed', 'chat_meta_changed', 'delivery_changed',
      'device_changed', 'friend_requests_changed', 'friendship_changed', 'group_collab_changed',
      'group_invitations_changed', 'gugu_decision_event', 'member_read_changed', 'member_stream_read_changed',
      'message_created', 'message_deleted', 'message_file_changed', 'presence_changed', 'reaction_changed',
      'workspace_changed'
    ) THEN
        RAISE EXCEPTION 'unsupported account revision event %', p_event;
    END IF;
    IF p_resource_key IS NULL OR jsonb_typeof(p_resource_key) <> 'object' THEN
        RAISE EXCEPTION 'revision resource key must be an object';
    END IF;
    IF NOT chat.is_user_event_recipient(p_user_id) THEN
        RETURN;
    END IF;
    INSERT INTO chat.pending_user_revisions (user_id, event, resource_key, tombstone, wake)
    VALUES (p_user_id, p_event, p_resource_key, COALESCE(p_tombstone, false), p_wake);
END;
$$;
REVOKE ALL ON FUNCTION chat.stage_user_revision(text, text, jsonb, boolean, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION chat.flush_user_revisions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'chat', 'public', 'pg_catalog' AS $$
DECLARE
    staged chat.pending_user_revisions%ROWTYPE;
    target_user_id TEXT;
    next_revision BIGINT;
    wake_head BIGINT;
    wake_kind TEXT;
BEGIN
    -- One event per staged row; the first one to fire flushes the whole transaction, the rest find their row gone.
    IF NOT EXISTS (SELECT 1 FROM chat.pending_user_revisions p WHERE p.id = NEW.id) THEN
        RETURN NULL;
    END IF;
    -- The one pass over heads, in user-id order. A user erased later in this transaction is no recipient now.
    FOR target_user_id IN
        SELECT DISTINCT p.user_id FROM chat.pending_user_revisions p
         WHERE p.transaction_id = pg_current_xact_id() AND chat.is_user_event_recipient(p.user_id)
         ORDER BY p.user_id
    LOOP
        INSERT INTO chat.account_revision_heads (user_id) VALUES (target_user_id) ON CONFLICT (user_id) DO NOTHING;
        PERFORM 1 FROM chat.account_revision_heads h WHERE h.user_id = target_user_id FOR NO KEY UPDATE;
    END LOOP;
    FOR target_user_id IN
        SELECT DISTINCT p.user_id FROM chat.pending_user_revisions p
         WHERE p.transaction_id = pg_current_xact_id() AND chat.is_user_event_recipient(p.user_id)
         ORDER BY p.user_id
    LOOP
        wake_kind := 'none';
        FOR staged IN
            SELECT * FROM chat.pending_user_revisions p
             WHERE p.transaction_id = pg_current_xact_id() AND p.user_id = target_user_id
             ORDER BY p.id
        LOOP
            UPDATE chat.account_revision_heads h SET revision = h.revision + 1, updated_at = now()
             WHERE h.user_id = target_user_id
            RETURNING h.revision INTO next_revision;
            INSERT INTO chat.account_revisions (user_id, revision, event, resource_key, tombstone)
            VALUES (target_user_id, next_revision, staged.event, staged.resource_key, staged.tombstone);
            wake_kind := CASE
                WHEN wake_kind = 'always' OR staged.wake = 'always' THEN 'always'
                WHEN staged.wake = 'presence' THEN 'presence'
                ELSE wake_kind END;
        END LOOP;
        wake_head := next_revision;
        IF wake_kind = 'always' OR (wake_kind = 'presence' AND chat.claim_presence_wake(target_user_id)) THEN
            PERFORM chat.send_user_event(
                jsonb_build_object('revision', wake_head),
                'im_revision_advanced',
                'gugu:user:' || target_user_id || ':events',
                true
            );
        END IF;
    END LOOP;
    DELETE FROM chat.pending_user_revisions p WHERE p.transaction_id = pg_current_xact_id();
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION chat.flush_user_revisions() FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER pending_user_revisions_flush
    AFTER INSERT ON chat.pending_user_revisions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION chat.flush_user_revisions();

-- The number is assigned at commit; nothing read it (every caller PERFORMs), so these return nothing now.
DROP FUNCTION chat.publish_user_revision(text, text, jsonb, boolean);
CREATE FUNCTION chat.publish_user_revision(p_user_id text, p_event text, p_resource_key jsonb, p_tombstone boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'chat', 'public', 'pg_catalog' AS $$
BEGIN
    PERFORM chat.stage_user_revision(p_user_id, p_event, p_resource_key, p_tombstone, 'always');
END;
$$;
REVOKE ALL ON FUNCTION chat.publish_user_revision(text, text, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION chat.append_user_revision(text, text, jsonb, boolean);
CREATE FUNCTION chat.append_user_revision(p_user_id text, p_event text, p_resource_key jsonb, p_tombstone boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'chat', 'public', 'pg_catalog' AS $$
BEGIN
    PERFORM chat.stage_user_revision(p_user_id, p_event, p_resource_key, p_tombstone, 'none');
END;
$$;
REVOKE ALL ON FUNCTION chat.append_user_revision(text, text, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- A line is a chat together with its topics (a topic's line is its source chat). Membership of a line and the
-- fan-out that reads it are serialized by one exclusive transaction-level advisory lock per line, taken at the
-- points where the heads of the line's members used to be locked. Lines are locked in id order within a call.
CREATE FUNCTION chat.lock_lines(p_chat_ids text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'chat', 'pg_catalog' AS $$
DECLARE line_id TEXT;
BEGIN
    FOR line_id IN
        SELECT DISTINCT COALESCE((SELECT c.source_chat_id FROM chat.chats c WHERE c.id = requested.id AND c.kind = 'topic'), requested.id)
          FROM unnest(p_chat_ids) AS requested(id)
         WHERE requested.id IS NOT NULL
         ORDER BY 1
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended('chat:line:' || line_id, 0));
    END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION chat.lock_lines(text[]) FROM PUBLIC, anon, authenticated, service_role;

-- Every fan-out over a chat's members, and every membership change (through the roster triggers), calls this
-- before it reads the members.
CREATE OR REPLACE FUNCTION chat.lock_chat_revision_recipients(p_chat_id text, p_affected_user_ids text[] DEFAULT '{}'::text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'chat', 'pg_catalog' AS $$
BEGIN
    PERFORM chat.lock_lines(ARRAY[p_chat_id]);
END;
$$;

CREATE OR REPLACE FUNCTION identity.fan_agent_presence_to_viewers(p_agent_user_id text, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'identity', 'chat', 'realtime', 'public', 'pg_catalog'
AS $function$
DECLARE
    viewer_user_id TEXT;
    v_resource_key JSONB;
BEGIN
    IF p_payload IS NULL THEN
        RAISE EXCEPTION 'Agent presence payload is required';
    END IF;

    v_resource_key := jsonb_build_object('agent_user_id', p_agent_user_id, 'presence', p_payload -> 'presence');

    FOR viewer_user_id IN
        SELECT DISTINCT candidate.user_id
          FROM (
            SELECT unnest(t.presence_viewer_user_ids) AS user_id
              FROM identity.agent_lifecycle_tombstones t
             WHERE t.agent_user_id = p_agent_user_id
            UNION
            SELECT u.owner_user_id
              FROM identity.users u
             WHERE u.id = p_agent_user_id
               AND u.type = 'agent'
               AND u.owner_user_id IS NOT NULL
            UNION
            SELECT CASE WHEN f.user_a_id = p_agent_user_id THEN f.user_b_id ELSE f.user_a_id END
              FROM identity.active_friendships f
             WHERE f.user_a_id = p_agent_user_id OR f.user_b_id = p_agent_user_id
            UNION
            SELECT cm_self.user_id
              FROM chat.active_members cm_agent
              JOIN chat.active_members cm_self ON cm_self.chat_id = cm_agent.chat_id
             WHERE cm_agent.user_id = p_agent_user_id
               AND cm_self.user_id <> p_agent_user_id
          ) candidate
          JOIN identity.users viewer ON viewer.id = candidate.user_id
                                    AND viewer.type = 'human'
         WHERE candidate.user_id IS NOT NULL
         ORDER BY candidate.user_id
    LOOP
        PERFORM chat.stage_user_revision(viewer_user_id, 'presence_changed', v_resource_key, false, 'presence');
    END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION chat.clear_messages_for_me(p_chat_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'public'
AS $function$
DECLARE
    v_uid TEXT := (SELECT auth.uid()::text);
    v_through_seq BIGINT;
    v_message_id TEXT;
BEGIN
    IF NOT chat.is_member(p_chat_id) THEN
        RAISE EXCEPTION 'not a member of chat: %', p_chat_id;
    END IF;

    SELECT COALESCE(MAX(m.seq), 0) INTO v_through_seq
    FROM chat.messages m WHERE m.chat_id = p_chat_id;

    FOR v_message_id IN
        WITH cleared AS (
            UPDATE chat.messages
            SET deleted_for_user_ids = deleted_for_user_ids || jsonb_build_array(v_uid),
                updated_at = now()
            WHERE chat_id = p_chat_id
              AND seq <= v_through_seq
              AND deleted_at IS NULL
              AND NOT deleted_for_user_ids @> jsonb_build_array(v_uid)
            RETURNING id, seq
        )
        SELECT id FROM cleared ORDER BY seq
    LOOP
        PERFORM chat.stage_user_revision(v_uid, 'message_deleted',
            jsonb_build_object('chat_id', p_chat_id, 'entity_id', v_message_id), true, 'always');
    END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION identity.erase_account_references(p_ids text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE erased_actor text := 'erased:' || gen_random_uuid()::text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.account_lifecycle_context c
        WHERE c.transaction_id=pg_current_xact_id() AND c.operation='privacy_erasure'
          AND c.delete_user_ids=p_ids) THEN
        RAISE EXCEPTION 'Account reference erasure requires the auth deletion transaction' USING ERRCODE='42501';
    END IF;
    UPDATE chat.file_transfer_uploads SET
        actor_id=CASE WHEN actor_id=ANY(p_ids) THEN erased_actor ELSE actor_id END,
        account_id=CASE WHEN account_id=ANY(p_ids) THEN erased_actor ELSE account_id END
    WHERE actor_id=ANY(p_ids) OR account_id=ANY(p_ids);
    UPDATE chat.file_transfer_reservations SET account_id=erased_actor WHERE account_id=ANY(p_ids);
    UPDATE chat.file_transfer_storage_refs SET account_id=erased_actor WHERE account_id=ANY(p_ids);
    DELETE FROM chat.file_transfer_limits WHERE scope='account' AND scope_id=ANY(p_ids);
    UPDATE chat.file_transfer_storage SET owner_account=NULL WHERE owner_account=ANY(p_ids);
    UPDATE chat.file_temporary_transfers SET
        reader_actor=CASE WHEN reader_actor=ANY(p_ids) THEN erased_actor ELSE reader_actor END,
        reader_account=CASE WHEN reader_account=ANY(p_ids) THEN erased_actor ELSE reader_account END
    WHERE reader_actor=ANY(p_ids) OR reader_account=ANY(p_ids);
    UPDATE chat.workspace_items SET updated_by=NULL WHERE updated_by=ANY(p_ids);
    -- A delivery to no surviving recipient no longer grants access to a file.
    DELETE FROM chat.session_attachments WHERE recipient_user_ids <@ p_ids;
    UPDATE chat.session_attachments SET recipient_user_ids=ARRAY(
        SELECT id FROM unnest(recipient_user_ids) id WHERE NOT id=ANY(p_ids))
    WHERE recipient_user_ids && p_ids;
    DELETE FROM chat.presence_wake_throttles WHERE viewer_user_id=ANY(p_ids);
    DELETE FROM chat.message_agent_delivery_blocks WHERE agent_user_id=ANY(p_ids);
    DELETE FROM identity.gugu_device_removals WHERE user_id::text=ANY(p_ids);
    -- Adoption-only historical tables are absent from a fresh installation.
    IF to_regclass('chat_private.removed_agent_dm_close_backup') IS NOT NULL THEN
        EXECUTE 'DELETE FROM chat_private.removed_agent_dm_close_backup WHERE agent_user_id=ANY($1)' USING p_ids;
    END IF;
    IF to_regclass('file_private.backfill_20261106_local_file_updated_at') IS NOT NULL THEN
        EXECUTE 'DELETE FROM file_private.backfill_20261106_local_file_updated_at WHERE updated_by=ANY($1)' USING p_ids;
    END IF;
    -- Last: cascades and shared-content updates can publish revisions themselves.
    DELETE FROM chat.account_revisions WHERE user_id=ANY(p_ids);
    DELETE FROM chat.account_revision_heads WHERE user_id=ANY(p_ids);
    DELETE FROM chat.pending_user_revisions WHERE user_id=ANY(p_ids);
END;
$function$;

CREATE OR REPLACE FUNCTION identity.provision_taskpage_agent(p_agent_id uuid, p_display_name text, p_name_mode text, p_agent_type text, p_device_id text, p_local_path text, p_group_chat_id text, p_new_group_id text, p_group_name text, p_name_serial_base text)
 RETURNS TABLE(agent_id uuid, display_name text, group_chat_id text, group_created boolean, prior_group_state text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'identity', 'chat', 'public', 'pg_catalog'
AS $function$
DECLARE
    v_owner      TEXT := (SELECT auth.uid()::text);
    v_name       TEXT := btrim(coalesce(p_display_name, ''));
    v_parts      TEXT[];
    v_base       TEXT;
    v_serial     INTEGER;
    v_name_clash BOOLEAN;
    v_minted     RECORD;
    v_prior      TEXT := 'none';
    v_group      TEXT := '';
    v_created    BOOLEAN := false;
    v_status     TEXT;
    v_target     TEXT;
    v_kind       TEXT;
    v_denial     TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id=p_agent_id::text AND u.removed_at IS NOT NULL) THEN RAISE EXCEPTION 'identity_removed: restoring requires a new identity' USING ERRCODE = '55000'; END IF;
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'provision_taskpage_agent requires authenticated session';
    END IF;
    IF v_name = '' THEN
        RAISE EXCEPTION 'p_display_name is required';
    END IF;
    IF p_name_mode NOT IN ('serial', 'explicit') THEN
        RAISE EXCEPTION 'p_name_mode must be serial or explicit, got %', p_name_mode;
    END IF;

    -- 幂等:这个 id 已经铸过就直接沿用。客户端拿着本机预生成的 id 先把会话起起来,这一发在后台跑 ——
    -- 网络抖一下重发、或两条腿各发了一次,都会带着同一个 id 到这里。❌ 第二发失败:那等于让一次重试
    -- 把已经在用的身份判死。名字与群按已存在的事实回答,不重算,❌ 也不再占一个新号。
    IF EXISTS (
        SELECT 1 FROM identity.users u
        WHERE u.id = p_agent_id::text AND u.type = 'agent' AND u.owner_user_id = v_owner
    ) THEN
        SELECT u.id::uuid AS id, u.display_name INTO v_minted
        FROM identity.users u WHERE u.id = p_agent_id::text;
        v_name := v_minted.display_name;
        -- The host knows this is a linked task. Only attest an existing, exact harness placeholder;
        -- a high-water counter cannot recover a renamed agent's individual historical number.
        v_parts := regexp_match(v_name, '^(.*\S)\s+(\d{1,9})$');
        IF p_name_mode = 'serial' AND NULLIF(btrim(p_name_serial_base), '') = v_parts[1] THEN
            UPDATE identity.users SET name_serial = v_parts[2]::integer
            WHERE id = v_minted.id::text AND name_serial IS NULL;
        END IF;
    ELSE
        -- A supplied harness base opts into task-name metadata. Without it, preserve the old
        -- nine-argument explicit-name collision contract, using this same allocator and lock.
        v_parts := regexp_match(v_name, '^(.*\S)\s+(\d{1,9})$');
        v_base := COALESCE(NULLIF(btrim(p_name_serial_base), ''), v_parts[1], v_name);
        PERFORM pg_advisory_xact_lock(hashtextextended(v_owner || '/' || v_base, 6396));
        -- Every new task identity uses the same counter. Keep legacy collision naming.
        SELECT EXISTS (
            SELECT 1 FROM identity.users u
            WHERE u.type = 'agent' AND u.owner_user_id = v_owner AND u.display_name = v_name
        ) INTO v_name_clash;
        v_serial := CASE WHEN p_name_mode = 'explicit' AND (NULLIF(btrim(p_name_serial_base), '') IS NOT NULL OR NOT v_name_clash)
            THEN 1 ELSE COALESCE(v_parts[2]::INTEGER, CASE WHEN p_name_mode = 'serial' THEN 1 ELSE 2 END) END;
        IF p_name_mode = 'explicit' AND NULLIF(btrim(p_name_serial_base), '') IS NULL
            AND NOT v_name_clash AND v_parts[2]::integer > 0 THEN
            -- An old host already issued this numbered name offline. Attest that number;
            -- the existing users trigger records it without consuming another counter value.
            v_serial := v_parts[2]::integer;
        ELSE
            -- 原子占号:起号 = GREATEST(这个前缀用过的最大号 + 1, 候选号)。
            INSERT INTO identity.agent_name_serials AS s (owner_user_id, base, high_water)
            VALUES (v_owner, v_base, v_serial)
            ON CONFLICT (owner_user_id, base) DO UPDATE
                SET high_water = GREATEST(s.high_water + 1, EXCLUDED.high_water), updated_at = now()
            RETURNING s.high_water INTO v_serial;
        END IF;
        IF p_name_mode = 'serial' OR (NULLIF(btrim(p_name_serial_base), '') IS NULL AND v_name_clash) THEN
            -- Only the new explicit task API permits duplicate chosen names.
            WHILE EXISTS (
                SELECT 1 FROM identity.users u
                WHERE u.type = 'agent' AND u.owner_user_id = v_owner AND u.display_name = v_base || ' ' || v_serial
            ) LOOP
                v_serial := v_serial + 1;
            END LOOP;
            v_name := v_base || ' ' || v_serial;
        END IF;

        -- 开户:走同一个 create_owned_agent(设备归属校验、agent_create_device_id、users 回填都在它里面)。
        -- 写出来的名字由 users 上的触发器记进 agent_name_serials。
        SELECT * INTO v_minted FROM identity.create_owned_agent(
            v_name, NULL, p_agent_type, p_device_id, p_local_path, NULL, true, NULL, p_agent_id
        );
        UPDATE identity.users SET name_serial = v_serial WHERE id = v_minted.id::text;
    END IF;

    -- 项目 = 群。
    IF p_group_name IS NOT NULL THEN
      BEGIN
        IF p_group_chat_id IS NULL OR p_group_chat_id = '' THEN
            RAISE EXCEPTION 'p_group_chat_id is required when p_group_name is given';
        END IF;
        SELECT c.status, c.kind INTO v_status, v_kind FROM chat.chats c WHERE c.id = p_group_chat_id;
        IF NOT FOUND THEN
            v_prior := 'missing';
            v_target := p_group_chat_id;
        ELSIF v_kind <> 'group' OR NOT chat.is_chat_member(p_group_chat_id, v_owner) THEN
            -- 安全:映射里递上来的 id 不是调用者自己所在的群(别人的群 / 私聊 / 话题)⇒ ❌ 不往里塞 agent。
            -- 与「映射指着一个归档群」同处置:另建一个项目群,客户端按返回的 group_chat_id 改指映射。
            v_prior := 'foreign';
            IF p_new_group_id IS NULL OR p_new_group_id = '' THEN
                RAISE EXCEPTION 'p_new_group_id is required when the mapped project group is not the caller''s group';
            END IF;
            v_target := p_new_group_id;
        ELSIF v_status = 'archived' THEN
            v_prior := 'archived';
            IF p_new_group_id IS NULL OR p_new_group_id = '' THEN
                RAISE EXCEPTION 'p_new_group_id is required when the mapped project group is archived';
            END IF;
            v_target := p_new_group_id;
        ELSE
            v_prior := 'active';
            v_target := p_group_chat_id;
        END IF;

        IF v_prior = 'active' THEN
            -- 与客户端直插(RLS)同一道「能否加此人」:上限、agent 审批、成员邀请开关。
            -- 串行化同一群的并发加人(与 add_group_agent 同一把群行锁),再判上限。
            PERFORM 1 FROM chat.chats WHERE id = v_target FOR UPDATE;
            v_denial := chat.group_add_denial(v_target, v_minted.id::text, v_owner);
            IF v_denial = 'agent_join_requires_manager' THEN
                -- 群开了「Agent 加入需审批」而调用者不是管理员:进审批队列,这次不入群(会话照常起)。
                PERFORM chat.queue_agent_join_request(v_target, v_minted.id::text, v_owner, NULL);
                v_prior := 'pending_approval';
            ELSIF v_denial IS NOT NULL THEN
                RAISE EXCEPTION 'provision_taskpage_agent: cannot add agent to project group %: %', v_target, v_denial;
            ELSE
                PERFORM chat.insert_group_member(v_target, v_minted.id::text, 'active', false);
            END IF;
        ELSE
            BEGIN
                PERFORM chat.create_gugu_group(v_target, p_group_name, v_owner, '[]'::jsonb, NULL, NULL);
                PERFORM chat.insert_group_member(v_target, v_minted.id::text, 'active', false);
                v_created := true;
            EXCEPTION WHEN unique_violation THEN
                -- 背靠背的另一条会话刚用同一个预生成 id 把群建出来了 ⇒ 改加座位。
                -- 串行化同一群的并发加人(与 add_group_agent 同一把群行锁),再判上限。
            PERFORM 1 FROM chat.chats WHERE id = v_target FOR UPDATE;
            v_denial := chat.group_add_denial(v_target, v_minted.id::text, v_owner);
                IF v_denial IS NOT NULL THEN
                    RAISE EXCEPTION 'provision_taskpage_agent: cannot add agent to project group %: %', v_target, v_denial;
                END IF;
                PERFORM chat.insert_group_member(v_target, v_minted.id::text, 'active', false);
                v_prior := 'active';
            END;
        END IF;
        v_group := CASE WHEN v_prior = 'pending_approval' THEN '' ELSE v_target END;
        -- Only the chat invariants: ALL would also fire chat.flush_user_revisions here, taking revision heads mid-transaction.
        SET CONSTRAINTS chat.chats_membership_invariants_trg, chat.chats_status_invariants_trg IMMEDIATE;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'provision_taskpage_agent: project group enrollment failed for agent % in group % [%]: %', v_minted.id, v_target, SQLSTATE, SQLERRM;
        v_group := '';
        v_created := false;
        v_prior := 'join_failed:' || COALESCE(v_denial, SQLSTATE);
      END;
    END IF;

    RETURN QUERY SELECT v_minted.id, v_name, v_group, v_created, v_prior;
END;
$function$;

CREATE OR REPLACE FUNCTION identity.broadcast_agent_presence_from_device()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'identity', 'realtime', 'public', 'pg_catalog'
AS $function$
DECLARE
    v_agent RECORD;
    v_payload JSONB;
BEGIN
    FOR v_agent IN
        SELECT id
        FROM identity.users
        WHERE device_id = NEW.device_id
          AND type = 'agent'
    LOOP
        v_payload := identity.build_agent_presence_payload(v_agent.id);
        IF v_payload IS NULL THEN
            CONTINUE;
        END IF;
        PERFORM identity.fan_agent_presence_to_viewers(v_agent.id, v_payload);
    END LOOP;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION identity.archive_user(p_user_id text, p_remove_social_identity boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE target identity.users%ROWTYPE; caller text := auth.uid()::text; dms text[];
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_remove_social_identity IS NULL THEN
    RAISE EXCEPTION 'remove_social_identity must be a boolean' USING ERRCODE = '22023';
  END IF;
  IF p_remove_social_identity AND EXISTS (SELECT 1 FROM identity.users u WHERE u.id = p_user_id
    AND u.type = 'agent' AND u.owner_user_id = caller AND u.removed_at IS NULL) THEN
    SELECT array_agg(c.id ORDER BY c.id) INTO dms FROM chat.chats c
      WHERE c.kind = 'dm' AND EXISTS (SELECT 1 FROM chat.active_members a WHERE a.chat_id = c.id AND a.user_id = p_user_id);
    PERFORM 1 FROM chat.chats c WHERE c.id = ANY(dms) ORDER BY c.id FOR UPDATE;
    -- Removing the identity changes who is an active member of every line it is in.
    PERFORM chat.lock_lines(ARRAY(SELECT a.chat_id FROM chat.active_members a WHERE a.user_id = p_user_id));
  END IF;
  SELECT * INTO target FROM identity.users u
    WHERE u.id = p_user_id AND (u.id = caller OR (u.type = 'agent' AND u.owner_user_id = caller))
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Identity is not owned by current user' USING ERRCODE = '42501'; END IF;
  IF target.removed_at IS NOT NULL AND NOT p_remove_social_identity THEN
    RAISE EXCEPTION 'identity_removed: restoring requires a new identity' USING ERRCODE = '55000';
  END IF;
  IF target.removed_at IS NULL AND NOT identity.user_is_live(caller) THEN
    RAISE EXCEPTION 'Identity is not active' USING ERRCODE = '42501';
  END IF;
  IF p_remove_social_identity AND target.removed_at IS NULL THEN
    IF target.type = 'agent' THEN
      UPDATE chat.chat_members m SET conversation_deleted_at = clock_timestamp()
        FROM chat.active_members peer
        WHERE peer.chat_id = ANY(dms) AND peer.user_id <> target.id AND peer.conversation_deleted_at IS NULL
          AND m.chat_id = peer.chat_id AND m.user_id = peer.user_id;
    END IF;
    UPDATE identity.users SET removed_at = clock_timestamp() WHERE id = target.id
      RETURNING * INTO target;
  END IF;
  -- false leaves social state alone; the host keeps its existing revisioned
  -- set_agent_session_archival/offline-interval path. No membership DML here.
  RETURN jsonb_build_object('user_id', target.id, 'removed_at', target.removed_at,
    'remove_social_identity', p_remove_social_identity);
END;
$function$;

CREATE OR REPLACE FUNCTION identity.set_agent_session_archival(p_agent_user_id text, p_device_id text, p_operation_id uuid, p_revision bigint, p_archived_at timestamp with time zone, p_intervals jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  agent identity.users%ROWTYPE;
  item jsonb;
  interval_id uuid;
  starts timestamptz;
  ends timestamptz;
  prior identity.agent_session_archive_intervals%ROWTYPE;
  operation_hash text;
BEGIN
  IF NOT identity.user_is_live(p_agent_user_id) THEN RAISE EXCEPTION 'identity_removed: restoring requires a new identity' USING ERRCODE = '55000'; END IF;
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_operation_id IS NULL OR p_revision IS NULL OR p_revision <= 0
    OR jsonb_typeof(p_intervals) IS DISTINCT FROM 'array' OR jsonb_array_length(p_intervals) > 256 THEN
    RAISE EXCEPTION 'Invalid session archival operation' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO agent FROM identity.users
    WHERE id = p_agent_user_id AND type = 'agent' AND owner_user_id = auth.uid()::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agent is not owned by current user' USING ERRCODE = '42501'; END IF;
  IF agent.device_id IS DISTINCT FROM p_device_id OR NOT EXISTS (
    SELECT 1 FROM identity.gugu_devices d WHERE d.device_id = p_device_id AND d.user_id = auth.uid()
  ) THEN RAISE EXCEPTION 'Agent archival device does not match its owner' USING ERRCODE = '42501'; END IF;

  PERFORM 1 FROM identity.member_liveness WHERE user_id = p_agent_user_id FOR NO KEY UPDATE;
  -- Admission runs inside the message's line lock (broadcast_message_created takes it before
  -- messages_c_record_agent_admission). Take the lines of every chat this agent is in, sorted, before the state
  -- transition, so an in-flight message either admits before archival or sees the archived agent.
  PERFORM chat.lock_lines(ARRAY(SELECT mine.chat_id FROM chat.live_identity_members mine WHERE mine.user_id = agent.id));
  SELECT * INTO agent FROM identity.users
    WHERE id = p_agent_user_id AND type = 'agent' AND owner_user_id = auth.uid()::text FOR NO KEY UPDATE;
  IF NOT FOUND OR agent.device_id IS DISTINCT FROM p_device_id THEN
    RAISE EXCEPTION 'Agent archival ownership changed' USING ERRCODE = '42501';
  END IF;
  operation_hash := md5(jsonb_build_object('device_id', p_device_id, 'revision', p_revision,
    'archived_at', extract(epoch FROM p_archived_at), 'intervals', p_intervals)::text);
  IF agent.session_lifecycle_operation_id = p_operation_id THEN
    IF agent.session_lifecycle_operation_hash IS DISTINCT FROM operation_hash THEN
      RAISE EXCEPTION 'Session archival operation payload changed' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('agent_user_id', agent.id, 'archived_at', agent.session_archived_at,
      'revision', agent.session_lifecycle_revision, 'operation_id', p_operation_id);
  END IF;
  IF p_revision <= agent.session_lifecycle_revision THEN
    RAISE EXCEPTION 'Stale session archival revision' USING ERRCODE = 'PT409';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_intervals) LOOP
    interval_id := (item->>'id')::uuid;
    starts := (item->>'archived_at')::timestamptz;
    ends := (item->>'restored_at')::timestamptz;
    IF interval_id IS NULL OR starts IS NULL OR (ends IS NOT NULL AND ends < starts) THEN
      RAISE EXCEPTION 'Invalid session archive interval' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO prior FROM identity.agent_session_archive_intervals
      WHERE agent_user_id = agent.id AND id = interval_id;
    IF FOUND AND (prior.archived_at <> starts OR (prior.restored_at IS NOT NULL AND prior.restored_at IS DISTINCT FROM ends)) THEN
      RAISE EXCEPTION 'A settled session archive interval cannot change' USING ERRCODE = '22023';
    END IF;
    INSERT INTO identity.agent_session_archive_intervals(agent_user_id, id, archived_at, restored_at)
      VALUES(agent.id, interval_id, starts, ends)
      ON CONFLICT(agent_user_id, id) DO UPDATE SET restored_at = EXCLUDED.restored_at;
  END LOOP;

  -- Every open interval must agree with the current state. Otherwise a restore
  -- could leave an unbounded interval that incorrectly refuses future messages.
  IF (SELECT count(*) FROM identity.agent_session_archive_intervals
      WHERE agent_user_id = agent.id AND restored_at IS NULL) <>
      (CASE WHEN p_archived_at IS NULL THEN 0 ELSE 1 END)
    OR (p_archived_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM identity.agent_session_archive_intervals
      WHERE agent_user_id = agent.id AND restored_at IS NULL AND archived_at = p_archived_at
    )) THEN
    RAISE EXCEPTION 'Session archive intervals do not match current state' USING ERRCODE = '22023';
  END IF;

  UPDATE identity.users SET session_archived_at = p_archived_at,
    session_lifecycle_revision = p_revision, session_lifecycle_operation_id = p_operation_id,
    session_lifecycle_operation_hash = operation_hash,
    updated_at = clock_timestamp() WHERE id = agent.id;

  -- Backfill only this recipient's unconsumed admissions from an offline interval.
  -- Message history, wake routing facts, membership and read cursors are unchanged.
  INSERT INTO chat.message_agent_delivery_blocks(message_id, agent_user_id)
    SELECT w.message_id, agent.id FROM chat.message_agent_wakes w
    JOIN chat.messages m ON m.id = w.message_id
    WHERE w.agent_user_id = agent.id AND EXISTS (
      SELECT 1 FROM identity.agent_session_archive_intervals i
      WHERE i.agent_user_id = agent.id AND m.created_at >= i.archived_at
        AND (i.restored_at IS NULL OR m.created_at < i.restored_at)
    ) AND NOT EXISTS (
      SELECT 1 FROM chat.message_deliveries d WHERE d.message_id = m.id
        AND d.device_id = 'gugu-agent:' || agent.id AND d.status = 'read'
    ) ON CONFLICT DO NOTHING;
  PERFORM identity.fan_agent_presence_to_viewers(agent.id, identity.build_agent_presence_payload(agent.id));
  RETURN jsonb_build_object('agent_user_id', agent.id, 'archived_at', p_archived_at,
    'revision', p_revision, 'operation_id', p_operation_id);
END;
$function$;

DROP FUNCTION chat.lock_revision_heads(text[]);

-- CREATE OR REPLACE above re-installs these; keep their callers' grants.
GRANT EXECUTE ON FUNCTION identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.clear_messages_for_me(text) TO authenticated;
GRANT EXECUTE ON FUNCTION identity.archive_user(text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION identity.set_agent_session_archival(text,text,uuid,bigint,timestamp with time zone,jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
