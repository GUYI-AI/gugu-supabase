-- Roll back 20261116160000_revision_heads_commit_flush: revision heads are locked again where events are published,
-- and chat.lock_chat_revision_recipients locks the line members' heads again. Revisions already written stay; nothing
-- staged is lost (the flush runs before it is dropped). chat.lock_lines stays: ops/close-removed-agent-dms-backfill.sql
-- and its rollback call it. Run it before any older operational rollback that edits these functions.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Whatever this transaction staged is written now, while the flush still exists.
SET CONSTRAINTS chat.pending_user_revisions_flush IMMEDIATE;
DROP TRIGGER pending_user_revisions_flush ON chat.pending_user_revisions;

DROP FUNCTION chat.publish_user_revision(text, text, jsonb, boolean);
DROP FUNCTION chat.append_user_revision(text, text, jsonb, boolean);
CREATE OR REPLACE FUNCTION chat.append_user_revision(p_user_id text, p_event text, p_resource_key jsonb, p_tombstone boolean DEFAULT false)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'public', 'pg_catalog'
AS $function$
DECLARE
    next_revision BIGINT;
BEGIN
    IF p_user_id IS NULL OR btrim(p_user_id) = '' THEN
        RAISE EXCEPTION 'revision user id is required';
    END IF;
    IF p_event IS NULL OR btrim(p_event) = '' THEN
        RAISE EXCEPTION 'revision event is required';
    END IF;
    IF p_event NOT IN (
      'agent_changed',
      'chat_changed',
      'chat_members_changed',
      'chat_meta_changed',
      'delivery_changed',
      'device_changed',
      'friend_requests_changed',
      'friendship_changed',
      'group_collab_changed',
      'group_invitations_changed',
      'gugu_decision_event',
      'member_read_changed',
      'member_stream_read_changed',
      'message_created',
      'message_deleted',
      'message_file_changed',
      'presence_changed',
      'reaction_changed',
      'workspace_changed'
    ) THEN
        RAISE EXCEPTION 'unsupported account revision event %', p_event;
    END IF;
    IF p_resource_key IS NULL OR jsonb_typeof(p_resource_key) <> 'object' THEN
        RAISE EXCEPTION 'revision resource key must be an object';
    END IF;

    IF NOT chat.is_user_event_recipient(p_user_id) THEN
        RETURN NULL;
    END IF;

    INSERT INTO chat.account_revision_heads (user_id, revision, updated_at)
    VALUES (p_user_id, 1, now())
    ON CONFLICT (user_id) DO UPDATE
       SET revision = chat.account_revision_heads.revision + 1,
           updated_at = now()
    RETURNING revision INTO next_revision;

    INSERT INTO chat.account_revisions (user_id, revision, event, resource_key, tombstone)
    VALUES (p_user_id, next_revision, p_event, p_resource_key, COALESCE(p_tombstone, false));
    RETURN next_revision;
END;
$function$;
CREATE OR REPLACE FUNCTION chat.publish_user_revision(p_user_id text, p_event text, p_resource_key jsonb, p_tombstone boolean DEFAULT false)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'realtime', 'public', 'pg_catalog'
AS $function$
DECLARE
    next_revision BIGINT;
BEGIN
    next_revision := chat.append_user_revision(p_user_id, p_event, p_resource_key, p_tombstone);
    IF next_revision IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM chat.send_user_event(
        jsonb_build_object('revision', next_revision),
        'im_revision_advanced',
        'gugu:user:' || p_user_id || ':events',
        true
    );
    RETURN next_revision;
END;
$function$;
REVOKE ALL ON FUNCTION chat.append_user_revision(text, text, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION chat.publish_user_revision(text, text, jsonb, boolean) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION chat.lock_revision_heads(p_user_ids text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    target_user_id TEXT;
BEGIN
    FOR target_user_id IN
        SELECT DISTINCT u FROM unnest(p_user_ids) AS u WHERE u IS NOT NULL ORDER BY u
    LOOP
        INSERT INTO chat.account_revision_heads (user_id) VALUES (target_user_id)
        ON CONFLICT (user_id) DO NOTHING;
        PERFORM 1 FROM chat.account_revision_heads h WHERE h.user_id = target_user_id FOR NO KEY UPDATE;
    END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION chat.lock_revision_heads(text[]) FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION chat.lock_chat_revision_recipients(p_chat_id text, p_affected_user_ids text[] DEFAULT '{}'::text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'pg_catalog'
AS $function$
DECLARE
    target_user_id TEXT;
BEGIN
    FOR target_user_id IN
        SELECT DISTINCT recipient.user_id
        FROM (
            SELECT cm.user_id
            FROM chat.active_members cm
            WHERE cm.chat_id = p_chat_id
               OR cm.chat_id = (
                   SELECT c.source_chat_id FROM chat.chats c
                   WHERE c.id = p_chat_id AND c.kind = 'topic'
               )
            UNION ALL
            SELECT unnest(COALESCE(p_affected_user_ids, '{}'::text[]))
        ) recipient
        WHERE recipient.user_id IS NOT NULL
        ORDER BY recipient.user_id
    LOOP
        -- Initializing a missing head neither advances its revision nor emits an
        -- event. Keep creation and locking in the same global order. NO KEY
        -- UPDATE matches publish_user_revision and permits revision-row FKs.
        INSERT INTO chat.account_revision_heads (user_id)
        VALUES (target_user_id)
        ON CONFLICT (user_id) DO NOTHING;
        PERFORM 1 FROM chat.account_revision_heads h
        WHERE h.user_id = target_user_id
        FOR NO KEY UPDATE;
    END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION identity.fan_agent_presence_to_viewers(p_agent_user_id text, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'identity', 'chat', 'realtime', 'public', 'pg_catalog'
AS $function$
DECLARE
    viewer_user_id TEXT;
    next_revision BIGINT;
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
        next_revision := chat.append_user_revision(
          viewer_user_id,
          'presence_changed',
          v_resource_key
        );
        IF next_revision IS NOT NULL AND chat.claim_presence_wake(viewer_user_id) THEN
            PERFORM chat.send_user_event(
                jsonb_build_object('revision', next_revision),
                'im_revision_advanced',
                'gugu:user:' || viewer_user_id || ':events',
                true
            );
        END IF;
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
    v_last_revision BIGINT;
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
        v_last_revision := chat.append_user_revision(v_uid, 'message_deleted',
            jsonb_build_object('chat_id', p_chat_id, 'entity_id', v_message_id), true);
    END LOOP;

    IF v_last_revision IS NOT NULL THEN
        PERFORM chat.send_user_event(
            jsonb_build_object('revision', v_last_revision), 'im_revision_advanced',
            'gugu:user:' || v_uid || ':events', true);
    END IF;
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
        SET CONSTRAINTS ALL IMMEDIATE;
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
    -- This trigger and the device revision trigger after it advance these heads; lock them all first, sorted.
    PERFORM chat.lock_revision_heads(ARRAY(
        SELECT NEW.user_id::text
        UNION
        SELECT viewer.user_id
          FROM identity.users agent
          CROSS JOIN LATERAL identity.agent_presence_viewer_ids(agent.id) AS viewer(user_id)
         WHERE agent.device_id = NEW.device_id AND agent.type = 'agent'));
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
    PERFORM chat.lock_revision_heads(ARRAY(SELECT m.user_id FROM chat.active_members m WHERE m.chat_id = ANY(dms)));
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
  viewer text;
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
  -- Admission runs after the message broadcast has acquired its revision heads.
  -- Take the same heads, globally ordered across all affected chats, before the
  -- state transition. No message path needs an identity lock for admission.
  FOR viewer IN
    SELECT DISTINCT v.id FROM (
      SELECT agent.id AS id UNION SELECT agent.owner_user_id
      UNION SELECT CASE WHEN f.user_a_id = agent.id THEN f.user_b_id ELSE f.user_a_id END
        FROM identity.active_friendships f WHERE agent.id IN (f.user_a_id, f.user_b_id)
      UNION SELECT peer.user_id FROM chat.live_identity_members mine
        JOIN chat.active_members peer ON peer.chat_id = mine.chat_id
        WHERE mine.user_id = agent.id
      UNION SELECT peer.user_id FROM chat.live_identity_members mine
        JOIN chat.chats c ON c.id = mine.chat_id AND c.kind = 'topic'
        JOIN chat.active_members peer ON peer.chat_id = c.source_chat_id
        WHERE mine.user_id = agent.id
    ) v WHERE v.id IS NOT NULL ORDER BY v.id
  LOOP
    INSERT INTO chat.account_revision_heads(user_id) VALUES(viewer) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM chat.account_revision_heads WHERE user_id = viewer FOR NO KEY UPDATE;
  END LOOP;
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

GRANT EXECUTE ON FUNCTION identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.clear_messages_for_me(text) TO authenticated;
GRANT EXECUTE ON FUNCTION identity.archive_user(text,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION identity.set_agent_session_archival(text,text,uuid,bigint,timestamp with time zone,jsonb) TO authenticated;

DROP FUNCTION chat.flush_user_revisions();
DROP FUNCTION chat.stage_user_revision(text, text, jsonb, boolean, text);
DROP TABLE chat.pending_user_revisions;

NOTIFY pgrst, 'reload schema';
COMMIT;
