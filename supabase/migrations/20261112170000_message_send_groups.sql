-- Files sent at once are one message (gugu#2581).
--
-- Each file still commits as its own row, so upload, failure and resend stay per file. The rows of one send share
-- send_group_id; send_group_size is how many files that send holds, so a reader knows when it has all of them. Clients
-- draw a group as one message, and an agent's host hands a complete group over as one turn.
--   * chat.attachment_commit and chat.attachment_forward take p_send_group_id + p_send_group_size; the row they insert
--     carries both (files forwarded together stay one message where they land).
--   * chat.messages_view, chat.list_chat_previews (and the previews in chat.sync_snapshot) and
--     identity.pull_agent_inbox_v2 return the two columns; existing columns keep their names, types and order.
--   * Unread counts count a group once (chat.list_unread_locators_for_chats, which chat.list_unread_locators reads).
-- Rows without a group read exactly as before. Released clients do not send a group, so nothing changes for them.
--
-- Locks: adding two nullable columns without a default rewrites nothing; the CHECK is NOT VALID (no existing row has
-- either column). Rollback: ops/rollback-message-send-groups.sql.
SET LOCAL lock_timeout = '5s';

ALTER TABLE chat.messages
    ADD COLUMN send_group_id uuid,
    ADD COLUMN send_group_size smallint;
ALTER TABLE chat.messages ADD CONSTRAINT messages_send_group_shape CHECK (
    (send_group_id IS NULL) = (send_group_size IS NULL) AND (send_group_size IS NULL OR send_group_size BETWEEN 2 AND 10)
) NOT VALID;
COMMENT ON COLUMN chat.messages.send_group_id IS
    'The send this row belongs to when several files were sent at once (gugu#2581); NULL for a message sent on its own.';
COMMENT ON COLUMN chat.messages.send_group_size IS
    'How many files the send of send_group_id holds (2 to 10).';

-- ── the inserted row joins its send ──────────────────────────────────────────────────────
-- chat.attachment_commit names the one message it is about to insert and its send (transaction-local settings, as
-- identity.agent_create_device_id does); rows inserted by triggers on the way (another line's activity, a system row)
-- have other ids and are left alone.
CREATE FUNCTION chat.messages_join_send_group() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
    v_message text := pg_catalog.current_setting('chat.send_group_message', true);
    v_group text := pg_catalog.current_setting('chat.send_group', true);
BEGIN
    IF v_message IS NULL OR v_message = '' OR v_message IS DISTINCT FROM NEW.id THEN
        RETURN NEW;
    END IF;
    NEW.send_group_id := pg_catalog.split_part(v_group, ':', 1)::uuid;
    NEW.send_group_size := pg_catalog.split_part(v_group, ':', 2)::smallint;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.messages_join_send_group() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER messages_join_send_group BEFORE INSERT ON chat.messages
    FOR EACH ROW EXECUTE FUNCTION chat.messages_join_send_group();

-- ── commit: the file's row joins its send ────────────────────────────────────────────────
DROP FUNCTION chat.attachment_commit(text, text, text, text, text, text[], text, text, boolean, boolean, text, text, uuid, integer);
CREATE FUNCTION chat.attachment_commit(p_staging_key text, p_message_id text, p_chat_id text, p_sender_user_id text, p_file_name text, p_to_user_ids text[] DEFAULT '{}'::text[], p_reply_to_message_id text DEFAULT NULL::text, p_thread_root_id text DEFAULT NULL::text, p_is_thread_root boolean DEFAULT false, p_is_whisper boolean DEFAULT false, p_via_app text DEFAULT NULL::text, p_caption text DEFAULT NULL::text, p_item_id uuid DEFAULT NULL::uuid, p_expected_version integer DEFAULT NULL::integer, p_send_group_id uuid DEFAULT NULL::uuid, p_send_group_size integer DEFAULT NULL::integer) RETURNS SETOF chat.messages_view
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
    v_placed RECORD;
BEGIN
    IF (p_send_group_id IS NULL) <> (p_send_group_size IS NULL) OR p_send_group_size NOT BETWEEN 2 AND 10 THEN
        RAISE EXCEPTION USING HINT = 'send_group_invalid',
            MESSAGE = 'a send of several files names its group and how many files it holds (2 to 10), or neither';
    END IF;
    IF p_item_id IS NOT NULL THEN
        IF COALESCE(p_is_whisper, false) THEN
            RAISE EXCEPTION USING HINT = 'file_place_invalid',
                MESSAGE = 'a whisper carries its own bytes, outside the folder: it cannot be a folder file''s next version';
        END IF;
        SELECT * INTO v_placed FROM chat.attachment_place_version(p_staging_key, p_item_id, p_expected_version, p_chat_id, p_sender_user_id, p_message_id);
    ELSE
        SELECT * INTO v_placed FROM chat.attachment_place(p_staging_key, p_chat_id, p_sender_user_id, p_file_name, p_message_id, COALESCE(p_is_whisper, false));
    END IF;
    IF p_send_group_id IS NOT NULL THEN
        PERFORM pg_catalog.set_config('chat.send_group_message', p_message_id, true);
        PERFORM pg_catalog.set_config('chat.send_group', p_send_group_id::text || ':' || p_send_group_size::text, true);
    END IF;
    RETURN QUERY
    SELECT * FROM chat.send_message_idempotent(
        p_message_id, p_chat_id, p_sender_user_id, COALESCE(p_to_user_ids, '{}'), v_placed.envelope || chat.attachment_caption_suffix(p_caption), 'attachment',
        p_reply_to_message_id, p_thread_root_id, COALESCE(p_is_thread_root, false), COALESCE(p_is_whisper, false), p_via_app,
        v_placed.item_id, v_placed.item_version, NULL, v_placed.file_blob_id);
    IF p_send_group_id IS NOT NULL THEN
        PERFORM pg_catalog.set_config('chat.send_group_message', '', true);
        PERFORM pg_catalog.set_config('chat.send_group', '', true);
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION chat.attachment_commit(text, text, text, text, text, text[], text, text, boolean, boolean, text, text, uuid, integer, uuid, integer) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION chat.attachment_commit(text, text, text, text, text, text[], text, text, boolean, boolean, text, text, uuid, integer, uuid, integer) TO authenticated;

-- ── forward: the copies of a send forwarded together are one send where they land ─────────
-- 20261110053000's definition, plus p_send_group_id / p_send_group_size (the new row joins that send, as in commit).
DROP FUNCTION chat.attachment_forward(text,text,text,text,text[],text,boolean,boolean);
CREATE FUNCTION chat.attachment_forward(p_source_message_id text, p_message_id text, p_chat_id text, p_sender_user_id text, p_to_user_ids text[] DEFAULT '{}'::text[], p_thread_root_id text DEFAULT NULL::text, p_is_thread_root boolean DEFAULT false, p_is_whisper boolean DEFAULT false, p_send_group_id uuid DEFAULT NULL::uuid, p_send_group_size integer DEFAULT NULL::integer)
 RETURNS SETOF chat.messages_view
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    v_existing chat.messages%ROWTYPE;
    v_placed RECORD;
    v_source_text TEXT;
    v_caption TEXT;
BEGIN
    IF (p_send_group_id IS NULL) <> (p_send_group_size IS NULL) OR p_send_group_size NOT BETWEEN 2 AND 10 THEN
        RAISE EXCEPTION USING HINT = 'send_group_invalid',
            MESSAGE = 'a send of several files names its group and how many files it holds (2 to 10), or neither';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chat.attachment_forward:' || p_message_id, 0));
    SELECT * INTO v_existing FROM chat.messages m WHERE m.id = p_message_id;
    IF FOUND THEN
        RETURN QUERY SELECT * FROM chat.send_message_idempotent(
            p_message_id, p_chat_id, p_sender_user_id, COALESCE(p_to_user_ids, '{}'), v_existing.content, 'attachment',
            NULL, p_thread_root_id, COALESCE(p_is_thread_root, false), COALESCE(p_is_whisper, false), NULL,
            v_existing.file_item_id, v_existing.file_version, p_source_message_id, v_existing.file_blob_id);
        RETURN;
    END IF;
    -- 先以调用者的身份读原消息(消息表的 RLS:看不到的历史、没发给你的悄悄话都读不到),与客户端 forwardCanonicalMessage
    -- 同一条判据(gugu apps/desktop/src/lib/chatCanonicalStorage.ts):读的是登录的那个人,以自己的 agent 转也一样。
    -- 撤回的由 definer 那一半拒。
    SELECT m.content INTO v_source_text FROM chat.messages m WHERE m.id = p_source_message_id AND m.deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING HINT = 'attachment_source_not_found',
            MESSAGE = format('message %s is not one you can read', p_source_message_id);
    END IF;
    SELECT * INTO v_placed FROM chat.attachment_place_forward(p_source_message_id, p_chat_id, p_sender_user_id, p_message_id, COALESCE(p_is_whisper, false));
    v_caption := chat.attachment_caption_of(v_source_text);
    IF p_send_group_id IS NOT NULL THEN
        PERFORM pg_catalog.set_config('chat.send_group_message', p_message_id, true);
        PERFORM pg_catalog.set_config('chat.send_group', p_send_group_id::text || ':' || p_send_group_size::text, true);
    END IF;
    RETURN QUERY
    SELECT * FROM chat.send_message_idempotent(
        p_message_id, p_chat_id, p_sender_user_id, COALESCE(p_to_user_ids, '{}'), v_placed.envelope || v_caption, 'attachment',
        NULL, p_thread_root_id, COALESCE(p_is_thread_root, false), COALESCE(p_is_whisper, false), NULL,
        v_placed.item_id, v_placed.item_version, p_source_message_id, v_placed.file_blob_id);
    IF p_send_group_id IS NOT NULL THEN
        PERFORM pg_catalog.set_config('chat.send_group_message', '', true);
        PERFORM pg_catalog.set_config('chat.send_group', '', true);
    END IF;
END;
$function$;
REVOKE ALL ON FUNCTION chat.attachment_forward(text,text,text,text,text[],text,boolean,boolean,uuid,integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.attachment_forward(text,text,text,text,text[],text,boolean,boolean,uuid,integer) TO authenticated;

-- ── messages_view: the two columns at the end ────────────────────────────────────────────
-- 20261104103000's definition, every published column in place; the outer list is spelled out so the new columns
-- follow file_metadata.
CREATE OR REPLACE VIEW chat.messages_view WITH (security_invoker=true) AS
SELECT m.id, m.chat_id, m.sender_user_id, m.to_user_ids, m.sender_name, m.sender_avatar, m.seq, m.content, m.content_type,
    m.reply_to_message_id, m.reply_to_sender_user_id, m.reply_to_sender_name, m.reply_to_content, m.deleted_at,
    m.deleted_for_user_ids, m.retracted_at, m.created_at, m.forwarded_from_message_id, m.thread_root_id, m.edited_at,
    m.is_whisper, m.is_thread_root, m.client_message_id, m.is_imported_history_root, m.via_app, m.file_item_id,
    m.file_version, m.sent_by_agent, m.agent_sender, m.file_blob_id,
    CASE WHEN m.content_type = 'attachment'
        AND (m.file_version IS NOT NULL OR m.file_blob_id IS NOT NULL)
        AND (SELECT auth.uid()) IS NOT NULL
    THEN chat.file_resolve_as(jsonb_build_object('message_id', m.id), (SELECT auth.uid())::text)
        - ARRAY['bucket_id','object_name']
    END AS file_metadata,
    m.send_group_id,
    m.send_group_size
FROM (
SELECT m.id,
    m.chat_id,
    m.sender_user_id,
    m.to_user_ids,
    COALESCE(su.display_name, '未知用户'::text) AS sender_name,
    su.avatar AS sender_avatar,
    m.seq,
    m.content,
    m.content_type,
    m.reply_to_message_id,
    ( SELECT rp.reply_to_sender_user_id
        FROM chat.message_reply_preview_for(m.reply_to_message_id, ( SELECT (auth.uid())::text AS uid)) rp) AS reply_to_sender_user_id,
    ( SELECT rp.reply_to_sender_name
        FROM chat.message_reply_preview_for(m.reply_to_message_id, ( SELECT (auth.uid())::text AS uid)) rp) AS reply_to_sender_name,
    ( SELECT rp.reply_to_content
        FROM chat.message_reply_preview_for(m.reply_to_message_id, ( SELECT (auth.uid())::text AS uid)) rp) AS reply_to_content,
    m.deleted_at,
    m.deleted_for_user_ids,
    m.retracted_at,
    m.created_at,
    m.forwarded_from_message_id,
    m.thread_root_id,
    m.edited_at,
    m.is_whisper,
    m.is_thread_root,
    m.client_message_id,
    COALESCE((m.client_message_id ~ '^session-import-root:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text), false) AS is_imported_history_root,
    m.via_app,
    m.file_item_id,
    m.file_version,
    m.sent_by_agent,
        CASE
            WHEN (m.sender_user_id = ( SELECT (auth.uid())::text AS uid)) THEN ( SELECT jsonb_build_object('id', a.agent_user_id, 'name', a.agent_name) AS jsonb_build_object
               FROM chat.message_agent_sends a
              WHERE ((a.message_id = m.id) AND (a.owner_user_id = ( SELECT (auth.uid())::text AS uid))))
            ELSE NULL::jsonb
        END AS agent_sender,
    m.file_blob_id,
    m.send_group_id,
    m.send_group_size
   FROM (chat.messages m
     LEFT JOIN identity.users su ON ((su.id = m.sender_user_id)))) m;

-- ── unread: a send of several files counts once ──────────────────────────────────────────
-- chat.list_unread_locators_for_chats (chat.list_unread_locators and chat.sync_snapshot read it) counts the messages
-- after the read cursor as COUNT(message.id) over chat.messages; count each send once instead. Everything else stays
-- as 20261107134000 wrote it. The function-DDL guard closes execution on replacement: restore the existing grants.
DO $unread$
DECLARE
    signature constant text := 'chat.list_unread_locators_for_chats(text[])';
    definition text; acl aclitem[]; permission record;
    unread_old constant text := 'COUNT(message.id)::BIGINT AS unread_count';
    unread_new constant text := 'COUNT(DISTINCT COALESCE(message.send_group_id::text, message.id))::BIGINT AS unread_count';
    addressed_old constant text := 'COUNT(message.id) FILTER (WHERE addressed.is_addressed)::BIGINT AS addressed_count';
    addressed_new constant text := 'COUNT(DISTINCT COALESCE(message.send_group_id::text, message.id)) FILTER (WHERE addressed.is_addressed)::BIGINT AS addressed_count';
BEGIN
    SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl, acldefault('f', p.proowner)) INTO definition, acl
      FROM pg_proc p WHERE p.oid = signature::regprocedure;
    IF (length(definition) - length(replace(definition, unread_old, ''))) / length(unread_old) <> 1
       OR (length(definition) - length(replace(definition, addressed_old, ''))) / length(addressed_old) <> 1 THEN
        RAISE EXCEPTION 'Unexpected unread predecessor';
    END IF;
    EXECUTE replace(replace(definition, unread_old, unread_new), addressed_old, addressed_new);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', signature);
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
        FROM aclexplode(acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', signature,
            CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
            CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
END $unread$;

-- ── agent inbox: the two columns at the end ──────────────────────────────────────────────
DO $inbox$
DECLARE
    signature constant text := 'identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint)';
    definition text; result text; acl aclitem[]; owner_oid oid; fn_comment text; patched text; permission record;
    inner_old constant text := 'm.file_item_id, m.file_version, m.file_blob_id, m.retracted_at, m.deleted_for_user_ids';
BEGIN
    SELECT pg_get_functiondef(p.oid), pg_get_function_result(p.oid), COALESCE(p.proacl, acldefault('f', p.proowner)),
           p.proowner, obj_description(p.oid, 'pg_proc')
      INTO definition, result, acl, owner_oid, fn_comment
      FROM pg_proc p WHERE p.oid = signature::regprocedure;
    IF result NOT LIKE '%, widget_id text)'
       OR (length(definition) - length(replace(definition, inner_old, ''))) / length(inner_old) <> 1
       OR definition !~ '\mwi\.id\s+FROM \(' THEN
        RAISE EXCEPTION 'Unexpected agent inbox predecessor';
    END IF;
    patched := replace(definition, 'RETURNS ' || result,
        'RETURNS ' || left(result, length(result) - 1) || ', send_group_id uuid, send_group_size smallint)');
    patched := replace(patched, inner_old, inner_old || ', m.send_group_id, m.send_group_size');
    patched := regexp_replace(patched, '\mwi\.id(\s+)FROM \(', 'wi.id, page.send_group_id, page.send_group_size\1FROM (');
    EXECUTE 'DROP FUNCTION ' || signature;
    EXECUTE patched;
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', signature, pg_get_userbyid(owner_oid));
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', signature);
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
        FROM aclexplode(acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', signature,
            CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
            CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
    IF fn_comment IS NOT NULL THEN
        EXECUTE format('COMMENT ON FUNCTION %s IS %L', signature, fn_comment);
    END IF;
END $inbox$;

-- ── chat list previews: the send's size, so a client can say how many files the latest message holds ──────────────
DROP FUNCTION chat.list_chat_previews(text[]);
CREATE FUNCTION chat.list_chat_previews(p_chat_ids text[])
 RETURNS TABLE(id text, chat_id text, created_at timestamp with time zone, preview text, seq bigint, content_type text, sender_user_id text, client_message_id text, preview_source text, retracted_at timestamp with time zone, send_group_size smallint)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
    v_viewer TEXT := (SELECT auth.uid()::text);
BEGIN
    IF v_viewer IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
    IF p_chat_ids IS NULL THEN RAISE EXCEPTION 'chat ids are required'; END IF;
    -- Each chat's latest message the viewer can see: messages_view (security invoker, so the messages RLS: membership,
    -- hidden history, deleted), not a whisper, not waiting for its agent, not deleted for the viewer. A recalled message
    -- stays the latest but says nothing of what it said: the '[Recalled]' placeholder, no link source; retracted_at marks it.
    RETURN QUERY
    SELECT latest.id, latest.chat_id, latest.created_at,
           CASE WHEN latest.retracted_at IS NULL THEN chat.message_preview(latest.content, latest.content_type)
                ELSE '[Recalled]' END, latest.seq,
           latest.content_type, latest.sender_user_id, latest.client_message_id,
           CASE WHEN latest.content_type = 'text' AND latest.retracted_at IS NULL
               AND lower(coalesce(latest.content, '')) LIKE ANY (ARRAY['%gugu-chat://%', '%gugu-widget://%'])
           THEN latest.content END,
           latest.retracted_at,
           latest.send_group_size
    FROM (
        SELECT DISTINCT requested_chat.id
        FROM unnest(p_chat_ids) requested_chat(id)
        LEFT JOIN chat.active_members member
          ON member.chat_id = requested_chat.id AND member.user_id = v_viewer
        WHERE requested_chat.id IS NOT NULL
          AND member.conversation_deleted_at IS NULL
    ) requested
    CROSS JOIN LATERAL (
        -- Named columns only: the view's reply and file columns are computed only for readers that ask for them.
        SELECT v.id, v.chat_id, v.created_at, v.seq, v.content, v.content_type, v.sender_user_id, v.client_message_id, v.retracted_at,
               v.send_group_size
        FROM chat.messages_view v
        WHERE v.chat_id = requested.id AND NOT v.is_whisper
          AND NOT (v.deleted_for_user_ids ? v_viewer)
          AND NOT chat.is_pending_delivery(v.id, v.content_type, v.sender_user_id, v.client_message_id)
        ORDER BY v.seq DESC
        LIMIT 1
    ) latest;
END;
$function$;
REVOKE ALL ON FUNCTION chat.list_chat_previews(text[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.list_chat_previews(text[]) TO authenticated;

-- The cold-start snapshot's previews read the same function; carry the new column there too, grants restored.
DO $snapshot$
DECLARE
    signature constant text := 'chat.sync_snapshot()';
    definition text; acl aclitem[]; permission record;
    previews_old constant text := 'p.client_message_id, p.preview_source, p.retracted_at';
BEGIN
    SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl, acldefault('f', p.proowner)) INTO definition, acl
      FROM pg_proc p WHERE p.oid = signature::regprocedure;
    IF (length(definition) - length(replace(definition, previews_old, ''))) / length(previews_old) <> 1 THEN
        RAISE EXCEPTION 'Unexpected sync snapshot predecessor';
    END IF;
    EXECUTE replace(definition, previews_old, previews_old || ', p.send_group_size');
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', signature);
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
        FROM aclexplode(acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', signature,
            CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
            CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
END $snapshot$;

NOTIFY pgrst, 'reload schema';
