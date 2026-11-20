-- A cite's words ride with its pills (gugu cite-one-form).
--
-- A Cite in the composer is a file pill; the words it picked are kept by the pill, not written into the message text.
-- They are saved with the message, in its own row, so they are read exactly where the message is, and the agent inbox
-- hands them to the agent beside the text. Clients never draw them.
--   * chat.messages.cites: [{ "link": <the pill's link>, "text": <the words> }, ...], NULL for a message without.
--   * chat.send_message_with_overlays takes p_cites; the row it inserts carries them.
--   * identity.pull_agent_inbox_v2 returns cites as its last column; existing columns keep their names, types and order.
-- Released clients pass no p_cites, so nothing changes for them.
--
-- Locks: adding one nullable column without a default rewrites nothing.
SET LOCAL lock_timeout = '5s';

ALTER TABLE chat.messages ADD COLUMN cites jsonb;
COMMENT ON COLUMN chat.messages.cites IS
    'The words each file pill of the text cites, [{ link, text }], as the sender''s composer kept them; NULL without.';

-- ── the inserted row takes its cites ─────────────────────────────────────────────────────
-- chat.send_message_with_overlays names the one message it is about to insert and its cites (transaction-local
-- settings, as chat.messages_join_send_group reads its send); rows inserted by triggers on the way have other ids.
CREATE FUNCTION chat.messages_take_cites() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
    IF pg_catalog.current_setting('chat.cites_message', true) IS DISTINCT FROM NEW.id THEN
        RETURN NEW;
    END IF;
    NEW.cites := pg_catalog.current_setting('chat.cites', true)::jsonb;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.messages_take_cites() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER messages_take_cites BEFORE INSERT ON chat.messages
    FOR EACH ROW EXECUTE FUNCTION chat.messages_take_cites();

-- ── send: p_cites ────────────────────────────────────────────────────────────────────────
DROP FUNCTION chat.send_message_with_overlays(text,text,text,text[],text,text,text,text,boolean,boolean,text,uuid,integer,text,uuid);
CREATE FUNCTION chat.send_message_with_overlays(
    p_message_id text, p_chat_id text, p_sender_user_id text, p_to_user_ids text[],
    p_content text, p_content_type text, p_reply_to_message_id text, p_thread_root_id text,
    p_is_thread_root boolean, p_is_whisper boolean,
    p_via_app text DEFAULT NULL, p_file_item_id uuid DEFAULT NULL,
    p_file_version integer DEFAULT NULL, p_forwarded_from_message_id text DEFAULT NULL,
    p_file_blob_id uuid DEFAULT NULL, p_cites jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = chat, public, pg_catalog
AS $$
DECLARE
    message chat.messages_view%ROWTYPE;
BEGIN
    IF p_cites IS NOT NULL THEN
        PERFORM pg_catalog.set_config('chat.cites_message', p_message_id, true);
        PERFORM pg_catalog.set_config('chat.cites', p_cites::text, true);
    END IF;
    SELECT * INTO STRICT message FROM chat.send_message_idempotent(
        p_message_id, p_chat_id, p_sender_user_id, p_to_user_ids, p_content, p_content_type,
        p_reply_to_message_id, p_thread_root_id, p_is_thread_root, p_is_whisper,
        p_via_app, p_file_item_id, p_file_version, p_forwarded_from_message_id, p_file_blob_id);
    -- Admission triggers have finished. On replay, include the current rows.
    -- These SELECTs run under the same caller RLS as window revalidation.
    RETURN jsonb_build_object(
        'message', to_jsonb(message),
        'reactions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'message_id', r.message_id, 'user_id', r.user_id, 'emoji', r.emoji))
            FROM chat.message_reactions r WHERE r.message_id = message.id), '[]'::jsonb),
        'deliveries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'message_id', d.message_id, 'status', d.status, 'device_id', d.device_id))
            FROM chat.message_deliveries d WHERE d.message_id = message.id), '[]'::jsonb),
        'delivery_blocks', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'message_id', b.message_id, 'agent_user_id', b.agent_user_id, 'reason', b.reason))
            FROM chat.message_agent_delivery_blocks b WHERE b.message_id = message.id), '[]'::jsonb)
    );
END;
$$;

REVOKE ALL ON FUNCTION chat.send_message_with_overlays(text,text,text,text[],text,text,text,text,boolean,boolean,text,uuid,integer,text,uuid,jsonb)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.send_message_with_overlays(text,text,text,text[],text,text,text,text,boolean,boolean,text,uuid,integer,text,uuid,jsonb)
    TO authenticated;

-- ── agent inbox: cites at the end ────────────────────────────────────────────────────────
DO $inbox$
DECLARE
    signature constant text := 'identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint)';
    definition text; result text; acl aclitem[]; owner_oid oid; fn_comment text; patched text; permission record;
    inner_old constant text := 'm.send_group_id, m.send_group_size';
    outer_old constant text := 'page.send_group_id, page.send_group_size';
BEGIN
    SELECT pg_get_functiondef(p.oid), pg_get_function_result(p.oid), COALESCE(p.proacl, acldefault('f', p.proowner)),
           p.proowner, obj_description(p.oid, 'pg_proc')
      INTO definition, result, acl, owner_oid, fn_comment
      FROM pg_proc p WHERE p.oid = signature::regprocedure;
    IF result NOT LIKE '%, send_group_size smallint)'
       OR (length(definition) - length(replace(definition, inner_old, ''))) / length(inner_old) <> 1
       OR (length(definition) - length(replace(definition, outer_old, ''))) / length(outer_old) <> 1 THEN
        RAISE EXCEPTION 'Unexpected agent inbox predecessor';
    END IF;
    patched := replace(definition, 'RETURNS ' || result, 'RETURNS ' || left(result, length(result) - 1) || ', cites jsonb)');
    patched := replace(patched, inner_old, inner_old || ', m.cites');
    patched := replace(patched, outer_old, outer_old || ', page.cites');
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

NOTIFY pgrst, 'reload schema';
