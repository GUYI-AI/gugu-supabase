-- Rollback of 20261112170000_message_send_groups (gugu#2581). Run as the database owner, in one transaction.
-- Functions go back to their previous shape. chat.messages keeps send_group_id/send_group_size and chat.messages_view
-- keeps returning them (a view column cannot be removed in place); with nothing writing them they stay NULL.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER messages_join_send_group ON chat.messages;
DROP FUNCTION chat.messages_join_send_group();

DROP FUNCTION chat.attachment_commit(text, text, text, text, text, text[], text, text, boolean, boolean, text, text, uuid, integer, uuid, integer);
CREATE FUNCTION chat.attachment_commit(p_staging_key text, p_message_id text, p_chat_id text, p_sender_user_id text, p_file_name text, p_to_user_ids text[] DEFAULT '{}'::text[], p_reply_to_message_id text DEFAULT NULL::text, p_thread_root_id text DEFAULT NULL::text, p_is_thread_root boolean DEFAULT false, p_is_whisper boolean DEFAULT false, p_via_app text DEFAULT NULL::text, p_caption text DEFAULT NULL::text, p_item_id uuid DEFAULT NULL::uuid, p_expected_version integer DEFAULT NULL::integer) RETURNS SETOF chat.messages_view
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
    v_placed RECORD;
BEGIN
    IF p_item_id IS NOT NULL THEN
        IF COALESCE(p_is_whisper, false) THEN
            RAISE EXCEPTION USING HINT = 'file_place_invalid',
                MESSAGE = 'a whisper carries its own bytes, outside the folder: it cannot be a folder file''s next version';
        END IF;
        SELECT * INTO v_placed FROM chat.attachment_place_version(p_staging_key, p_item_id, p_expected_version, p_chat_id, p_sender_user_id, p_message_id);
    ELSE
        SELECT * INTO v_placed FROM chat.attachment_place(p_staging_key, p_chat_id, p_sender_user_id, p_file_name, p_message_id, COALESCE(p_is_whisper, false));
    END IF;
    RETURN QUERY
    SELECT * FROM chat.send_message_idempotent(
        p_message_id, p_chat_id, p_sender_user_id, COALESCE(p_to_user_ids, '{}'), v_placed.envelope || chat.attachment_caption_suffix(p_caption), 'attachment',
        p_reply_to_message_id, p_thread_root_id, COALESCE(p_is_thread_root, false), COALESCE(p_is_whisper, false), p_via_app,
        v_placed.item_id, v_placed.item_version, NULL, v_placed.file_blob_id);
END;
$$;
REVOKE ALL ON FUNCTION chat.attachment_commit(text, text, text, text, text, text[], text, text, boolean, boolean, text, text, uuid, integer) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION chat.attachment_commit(text, text, text, text, text, text[], text, text, boolean, boolean, text, text, uuid, integer) TO authenticated;

-- attachment_forward: back to 20261110053000's signature and body.
DROP FUNCTION chat.attachment_forward(text,text,text,text,text[],text,boolean,boolean,uuid,integer);
CREATE OR REPLACE FUNCTION chat.attachment_forward(p_source_message_id text, p_message_id text, p_chat_id text, p_sender_user_id text, p_to_user_ids text[] DEFAULT '{}'::text[], p_thread_root_id text DEFAULT NULL::text, p_is_thread_root boolean DEFAULT false, p_is_whisper boolean DEFAULT false)
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
    RETURN QUERY
    SELECT * FROM chat.send_message_idempotent(
        p_message_id, p_chat_id, p_sender_user_id, COALESCE(p_to_user_ids, '{}'), v_placed.envelope || v_caption, 'attachment',
        NULL, p_thread_root_id, COALESCE(p_is_thread_root, false), COALESCE(p_is_whisper, false), NULL,
        v_placed.item_id, v_placed.item_version, p_source_message_id, v_placed.file_blob_id);
END;
$function$;
REVOKE ALL ON FUNCTION chat.attachment_forward(text,text,text,text,text[],text,boolean,boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.attachment_forward(text,text,text,text,text[],text,boolean,boolean) TO authenticated;

-- Replace text back in the functions the release patched, keeping each function's grants.
CREATE FUNCTION pg_temp.unpatch(signature text, pairs text[], recreate boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    definition text; acl aclitem[]; permission record; i int;
BEGIN
    SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl, acldefault('f', p.proowner)) INTO definition, acl
      FROM pg_proc p WHERE p.oid = signature::regprocedure;
    FOR i IN 1 .. array_length(pairs, 1) / 2 LOOP
        IF position(pairs[2 * i - 1] IN definition) = 0 THEN RAISE EXCEPTION 'nothing to undo in %: %', signature, pairs[2 * i - 1]; END IF;
        definition := replace(definition, pairs[2 * i - 1], pairs[2 * i]);
    END LOOP;
    IF recreate THEN EXECUTE 'DROP FUNCTION ' || signature; END IF;
    EXECUTE definition;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', signature);
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
        FROM aclexplode(acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', signature,
            CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
            CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
END $$;

SELECT pg_temp.unpatch('chat.list_unread_locators_for_chats(text[])', ARRAY[
    'COUNT(DISTINCT COALESCE(message.send_group_id::text, message.id))::BIGINT AS unread_count', 'COUNT(message.id)::BIGINT AS unread_count',
    'COUNT(DISTINCT COALESCE(message.send_group_id::text, message.id)) FILTER', 'COUNT(message.id) FILTER'], false);
SELECT pg_temp.unpatch('chat.sync_snapshot()', ARRAY['p.retracted_at, p.send_group_size', 'p.retracted_at'], false);
SELECT pg_temp.unpatch('identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint)', ARRAY[
    ', send_group_id uuid, send_group_size smallint)', ')',
    'm.deleted_for_user_ids, m.send_group_id, m.send_group_size', 'm.deleted_for_user_ids',
    'wi.id, page.send_group_id, page.send_group_size', 'wi.id'], true);
SELECT pg_temp.unpatch('chat.list_chat_previews(text[])', ARRAY[
    ', retracted_at timestamp with time zone, send_group_size smallint)', ', retracted_at timestamp with time zone)',
    E'latest.retracted_at,\n           latest.send_group_size', 'latest.retracted_at',
    E'v.retracted_at,\n               v.send_group_size', 'v.retracted_at'], true);

NOTIFY pgrst, 'reload schema';
COMMIT;
