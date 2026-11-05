-- A file message takes its chat row before it publishes anything.
--
-- A message insert locks the chats row (assign_message_seq allocates the seq with an UPDATE) and then the members'
-- account heads (every revision goes through lock_chat_revision_recipients). Sending a file did the opposite:
-- placing it (attachment_place / _version / _share / _forward) inserts workspace_items, whose trigger publishes
-- workspace_changed to the members (heads), and only then send_message_idempotent inserts the message (chats row).
-- A file message and a plain message in one group could each hold what the other needed. Seen on the shared backend
-- 2026-11-05 16:28:54 UTC: a plain INSERT, holding the chats row, waited in assign_message_seq ->
-- publish_chat_row_revision -> lock_chat_revision_recipients on a head that attachment_commit held (40P01).
--
-- Same rule as 20261029213200_device_revision_lock_order: take the row locks the message insert will need before any
-- trigger touches a head. Every "place a file, then send it" path (attachment_commit, attachment_share,
-- attachment_forward, send_friend_file_as_owner) starts in one of the four place functions, right after the sender
-- check, so that is where the chat row is taken (the seq allocation's lock mode). A topic file locks the topic row,
-- which is what its message insert locks first anyway.
--
-- Not done: making every chat fan-out take the chat row first (in lock_chat_revision_recipients). A publish fired by a
-- row UPDATE has already locked that row (a read mark's chat_members row) before it would reach the chat row; under
-- mixed group/topic sends and read marks that version deadlocked within seconds in testing, where today's order did not.
--
-- The four functions below are their current definitions (foundation, 20261025080000_attachment_share,
-- 20261027033000_text_document_ingestion) with one statement added after the sender check.

CREATE OR REPLACE FUNCTION chat.attachment_place(p_staging_key text, p_chat_id text, p_sender_user_id text, p_file_name text, p_message_id text, p_is_whisper boolean DEFAULT false)
 RETURNS TABLE(item_id uuid, item_version integer, envelope text, file_blob_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_upload chat.file_blob_uploads%ROWTYPE;
    v_item chat.workspace_items%ROWTYPE;
    v_blob chat.file_blobs%ROWTYPE;
    v_envelope TEXT;
BEGIN
    PERFORM chat.attachment_sender_check(p_chat_id, p_sender_user_id);
    -- The chat row before any head: placing publishes to the members, and the message locks this row next.
    PERFORM 1 FROM chat.chats c WHERE c.id = p_chat_id FOR NO KEY UPDATE;
    IF NULLIF(p_message_id, '') IS NULL THEN
        RAISE EXCEPTION 'attachment_commit: a message id is required';
    END IF;
    SELECT * INTO v_upload FROM chat.file_blob_uploads u WHERE u.staging_key = p_staging_key FOR UPDATE;
    IF NOT FOUND OR v_upload.uploader IS DISTINCT FROM (SELECT auth.uid()::text) OR v_upload.expires_at <= now() THEN
        RAISE EXCEPTION USING HINT = 'attachment_upload_not_found',
            MESSAGE = format('no upload %s of yours is waiting to be sent', p_staging_key);
    END IF;
    IF v_upload.message_id IS NOT NULL THEN
        IF v_upload.message_id IS DISTINCT FROM p_message_id THEN
            RAISE EXCEPTION USING HINT = 'attachment_upload_used',
                MESSAGE = format('upload %s was already sent as message %s', p_staging_key, v_upload.message_id);
        END IF;
        -- 同一条消息重试:同一个条目、同一版、同一段正文(发消息那一步按它们重放)。
        RETURN QUERY SELECT v_upload.item_id, v_upload.item_version, v_upload.envelope,
                            CASE WHEN v_upload.item_id IS NULL THEN v_upload.blob_id END;
        RETURN;
    END IF;
    -- ◇ 悄悄话:不进群文件夹(那里全员看得见),消息直接指这份字节。名字照文件夹里的规矩规范化(不含换行)。
    IF COALESCE(p_is_whisper, false) THEN
        PERFORM chat.file_blob_take(v_upload.blob_id);
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = v_upload.blob_id;
        v_envelope := chat.attachment_envelope(chat.workspace_stored_name(p_file_name), v_blob.size_bytes, v_blob.content_type);
        UPDATE chat.file_blob_uploads u SET message_id = p_message_id, envelope = v_envelope WHERE u.staging_key = p_staging_key;
        RETURN QUERY SELECT NULL::UUID, NULL::INTEGER, v_envelope, v_upload.blob_id;
        RETURN;
    END IF;
    v_item := chat.attachment_item_for(p_chat_id, v_upload.blob_id, p_file_name, p_sender_user_id, p_message_id);
    v_envelope := chat.workspace_version_envelope(v_item.id, v_item.version);
    UPDATE chat.file_blob_uploads u
       SET message_id = p_message_id, item_id = v_item.id, item_version = v_item.version, envelope = v_envelope
     WHERE u.staging_key = p_staging_key;
    PERFORM chat.workspace_ingest_upload(p_staging_key);
    RETURN QUERY SELECT v_item.id, v_item.version, v_envelope, NULL::UUID;
END;
$function$
;

CREATE OR REPLACE FUNCTION chat.attachment_place_version(p_staging_key text, p_item_id uuid, p_expected_version integer, p_chat_id text, p_sender_user_id text, p_message_id text)
 RETURNS TABLE(item_id uuid, item_version integer, envelope text, file_blob_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_upload chat.file_blob_uploads%ROWTYPE;
    v_item chat.workspace_items%ROWTYPE;
    v_version INTEGER;
    v_envelope TEXT;
BEGIN
    PERFORM chat.attachment_sender_check(p_chat_id, p_sender_user_id);
    -- The chat row before any head: placing publishes to the members, and the message locks this row next.
    PERFORM 1 FROM chat.chats c WHERE c.id = p_chat_id FOR NO KEY UPDATE;
    IF NULLIF(p_message_id, '') IS NULL THEN
        RAISE EXCEPTION 'attachment_commit: a message id is required';
    END IF;
    IF p_expected_version IS NULL THEN
        RAISE EXCEPTION USING HINT = 'file_place_invalid',
            MESSAGE = 'a next version names the version it starts from (expected_version)';
    END IF;
    SELECT * INTO v_upload FROM chat.file_blob_uploads u WHERE u.staging_key = p_staging_key FOR UPDATE;
    IF NOT FOUND OR v_upload.uploader IS DISTINCT FROM (SELECT auth.uid()::text) OR v_upload.expires_at <= now() THEN
        RAISE EXCEPTION USING HINT = 'attachment_upload_not_found',
            MESSAGE = format('no upload %s of yours is waiting to be sent', p_staging_key);
    END IF;
    IF v_upload.message_id IS NOT NULL THEN
        IF v_upload.message_id IS DISTINCT FROM p_message_id OR v_upload.item_id IS DISTINCT FROM p_item_id THEN
            RAISE EXCEPTION USING HINT = 'attachment_upload_used',
                MESSAGE = format('upload %s was already sent as message %s', p_staging_key, v_upload.message_id);
        END IF;
        -- 同一条消息重试:同一个条目、同一版、同一段正文。
        RETURN QUERY SELECT v_upload.item_id, v_upload.item_version, v_upload.envelope, NULL::UUID;
        RETURN;
    END IF;
    v_item := chat.workspace_item_for(p_item_id::TEXT, p_sender_user_id, true);
    IF v_item.chat_id IS DISTINCT FROM chat.workspace_require_room_member(p_chat_id, p_sender_user_id) THEN
        RAISE EXCEPTION USING HINT = 'message_file_not_here',
            MESSAGE = format('%s is in another chat''s folder: a next version is sent in the chat whose folder holds it', v_item.filename);
    END IF;
    IF v_item.kind = 'file' AND p_expected_version = v_item.version AND v_upload.blob_id = v_item.blob_id THEN
        -- 和起点那一版一样的字节:不出新版,钉住那一版。
        v_version := v_item.version;
    ELSE
        -- 是不是文件、起点是不是现在这一版、换版本与修剪:都是 file_replace_as 的规矩,只在这一处。
        SELECT r.version INTO v_version FROM chat.file_replace_as(p_staging_key, p_item_id::TEXT, p_sender_user_id, p_expected_version) r;
    END IF;
    v_envelope := chat.workspace_version_envelope(v_item.id, v_version);
    UPDATE chat.file_blob_uploads u
       SET message_id = p_message_id, item_id = v_item.id, item_version = v_version, envelope = v_envelope
     WHERE u.staging_key = p_staging_key;
    RETURN QUERY SELECT v_item.id, v_version, v_envelope, NULL::UUID;
END;
$function$
;

CREATE OR REPLACE FUNCTION chat.attachment_place_share(p_item_id uuid, p_version integer, p_chat_id text, p_sender_user_id text, p_message_id text)
 RETURNS TABLE(item_id uuid, item_version integer, envelope text, file_blob_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_item chat.workspace_items%ROWTYPE;
    v_version INTEGER;
    v_blob UUID;
    v_resource TEXT;
    v_placed chat.workspace_items%ROWTYPE;
BEGIN
    PERFORM chat.attachment_sender_check(p_chat_id, p_sender_user_id);
    -- The chat row before any head: placing publishes to the members, and the message locks this row next.
    PERFORM 1 FROM chat.chats c WHERE c.id = p_chat_id FOR NO KEY UPDATE;
    IF NULLIF(p_message_id, '') IS NULL THEN
        RAISE EXCEPTION 'attachment_share: a message id is required';
    END IF;
    v_item := chat.workspace_item_for(p_item_id::TEXT, p_sender_user_id, false);
    IF v_item.kind = 'folder' THEN
        RAISE EXCEPTION USING HINT = 'file_place_invalid',
            MESSAGE = format('%s is not a stored file (a text file people edit together, or a folder): send its link instead', v_item.filename);
    END IF;
    v_version := COALESCE(p_version, v_item.version);
    v_blob := chat.workspace_version_blob(v_item.id, v_version);
    -- A project file kept on its host has a local revision for the version instead of a blob: it is there.
    IF v_blob IS NULL AND NOT EXISTS(SELECT 1 FROM chat.file_device_revisions d WHERE d.item_id = v_item.id AND d.version = v_version) THEN
        -- A text document's version is text: attachments/share pins its text as it is now (attachment_document_snapshot).
        IF v_item.kind = 'document' THEN
            RAISE EXCEPTION USING HINT = 'attachment_forward_needs_bytes',
                MESSAGE = format('%s is a text document: send it through attachments/share', v_item.filename);
        END IF;
        RAISE EXCEPTION USING HINT = 'attachment_source_gone',
            MESSAGE = CASE WHEN v_version > v_item.version
                THEN format('%s has no version %s yet (it is at version %s)', v_item.filename, v_version, v_item.version)
                ELSE format('%s has no version %s any more (it is at version %s)', v_item.filename, v_version, v_item.version) END;
    END IF;
    IF chat.file_transfer_reference_expired(v_blob,v_item.chat_id) THEN
        RAISE EXCEPTION 'File has expired; upload a new copy' USING HINT='file_transfer_expired';
    END IF;
    v_resource := chat.workspace_require_room_member(p_chat_id, p_sender_user_id);
    IF v_item.chat_id = v_resource THEN
        RETURN QUERY SELECT v_item.id, v_version, chat.workspace_version_envelope(v_item.id, v_version), NULL::UUID;
        RETURN;
    END IF;
    IF v_blob IS NULL THEN
        RAISE EXCEPTION USING HINT = 'file_transfer_read_only',
            MESSAGE = format('%s is kept on the computer that sent it: it can be sent only in its own chat', v_item.filename);
    END IF;
    v_placed := chat.attachment_item_for(p_chat_id, v_blob, v_item.filename, p_sender_user_id, p_message_id);
    PERFORM chat.workspace_import_document(v_placed.id,v_placed.version,v_blob,jsonb_build_object('text',v.inline_text,'content_type',v.content_type))
      FROM chat.workspace_item_versions v WHERE v.item_id=v_item.id AND v.n=v_version AND v_item.kind='document' AND v.inline_text IS NOT NULL AND v.blob_id IS NOT NULL;
    RETURN QUERY SELECT v_placed.id, v_placed.version, chat.workspace_version_envelope(v_placed.id, v_placed.version), NULL::UUID;
END;
$function$
;

CREATE OR REPLACE FUNCTION chat.attachment_place_forward(p_source_message_id text, p_chat_id text, p_sender_user_id text, p_message_id text, p_is_whisper boolean DEFAULT false)
 RETURNS TABLE(item_id uuid, item_version integer, envelope text, file_blob_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_source chat.messages%ROWTYPE;
    v_blob chat.file_blobs%ROWTYPE;
    v_blob_id UUID;
    v_name TEXT;
    v_item chat.workspace_items%ROWTYPE;
    v_source_item chat.workspace_items%ROWTYPE;
BEGIN
    PERFORM chat.attachment_sender_check(p_chat_id, p_sender_user_id);
    -- The chat row before any head: placing publishes to the members, and the message locks this row next.
    PERFORM 1 FROM chat.chats c WHERE c.id = p_chat_id FOR NO KEY UPDATE;
    SELECT * INTO v_source FROM chat.messages m WHERE m.id = p_source_message_id AND m.deleted_at IS NULL;
    IF NOT FOUND OR NOT chat.can_read_message(p_source_message_id, p_sender_user_id) THEN
        RAISE EXCEPTION USING HINT = 'attachment_source_not_found',
            MESSAGE = format('message %s is not one you can read', p_source_message_id);
    END IF;
    IF v_source.retracted_at IS NOT NULL THEN
        RAISE EXCEPTION USING HINT = 'attachment_source_retracted', MESSAGE = format('message %s was retracted', p_source_message_id);
    END IF;
    -- ◇ 字节:悄悄话附件直接指着的,或者条目钉住的那一版;名字:信封里的,或者条目现在的。
    IF v_source.file_blob_id IS NOT NULL THEN
        v_blob_id := v_source.file_blob_id;
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = v_blob_id;
        v_name := chat.attachment_envelope_name(v_source.content, v_blob.size_bytes, v_blob.content_type);
    ELSIF v_source.file_item_id IS NOT NULL THEN
        v_blob_id := chat.workspace_version_blob(v_source.file_item_id, v_source.file_version);
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = v_blob_id;
        SELECT * INTO v_source_item FROM chat.workspace_items w WHERE w.id = v_source.file_item_id;
        v_name := v_source_item.filename;
    ELSE
        RAISE EXCEPTION USING HINT = 'attachment_source_gone',
            MESSAGE = 'that message has no file to forward (it was deleted from its folder, or it is not an attachment)';
    END IF;
    IF v_blob_id IS NULL THEN
        RAISE EXCEPTION USING HINT = 'attachment_source_gone', MESSAGE = 'that version of the file has no bytes left';
    END IF;
    IF chat.file_transfer_reference_expired(v_blob_id,v_source.chat_id) THEN
        RAISE EXCEPTION 'File has expired; upload a new copy' USING HINT='file_transfer_expired';
    END IF;
    -- ◇ 转成悄悄话:指同一份字节,不进目标的文件夹。
    IF COALESCE(p_is_whisper, false) THEN
        PERFORM chat.file_blob_take(v_blob_id);
        RETURN QUERY SELECT NULL::UUID, NULL::INTEGER, chat.attachment_envelope(v_name, v_blob.size_bytes, v_blob.content_type), v_blob_id;
        RETURN;
    END IF;
    -- ◇ 转进放着这个文件的会话(它自己、它的话题):钉住同一个文件的同一版,不在「附件」里另建。
    IF v_source_item.id IS NOT NULL
       AND v_source_item.chat_id = chat.workspace_require_room_member(p_chat_id, p_sender_user_id) THEN
        RETURN QUERY SELECT v_source_item.id, v_source.file_version, chat.workspace_version_envelope(v_source_item.id, v_source.file_version), NULL::UUID;
        RETURN;
    END IF;
    v_item := chat.attachment_item_for(p_chat_id, v_blob_id, v_name, p_sender_user_id, p_message_id);
    PERFORM chat.workspace_import_document(v_item.id,v_item.version,v_blob_id,jsonb_build_object('text',v.inline_text,'content_type',v.content_type))
      FROM chat.workspace_item_versions v WHERE v.item_id=v_source_item.id AND v.n=v_source.file_version AND v_source_item.kind='document' AND v.inline_text IS NOT NULL AND v.blob_id IS NOT NULL;
    RETURN QUERY SELECT v_item.id, v_item.version, chat.workspace_version_envelope(v_item.id, v_item.version), NULL::UUID;
END;
$function$
;

REVOKE ALL ON FUNCTION chat.attachment_place(text,text,text,text,text,boolean),
    chat.attachment_place_version(text,uuid,integer,text,text,text),
    chat.attachment_place_share(uuid,integer,text,text,text),
    chat.attachment_place_forward(text,text,text,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.attachment_place(text,text,text,text,text,boolean),
    chat.attachment_place_version(text,uuid,integer,text,text,text),
    chat.attachment_place_share(uuid,integer,text,text,text),
    chat.attachment_place_forward(text,text,text,text,boolean) TO authenticated;
