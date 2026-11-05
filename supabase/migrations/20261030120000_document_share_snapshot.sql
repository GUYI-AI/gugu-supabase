-- Sending a text document by reference refused every document edited in the editor, in words that contradict
-- themselves: "x has no version 2 any more (it is at version 2)". attachment_share pins a version's bytes, and a
-- document's versions are text only (chat.files_record_version records rounds without bytes).
--   · chat.attachment_document_snapshot: the document's text as it is now, as a version with bytes. The latest version
--     when it already says this text with bytes; otherwise the next version (a version's bytes never change,
--     workspace_bytes_pinned), numbered and kept as the file service numbers and keeps them — the file service's next
--     round of the same text is then not recorded again. With no bytes for that text yet, it asks for them
--     (HINT attachment_forward_needs_bytes): the attachments edge function (POST share) stages the text, registers it
--     (content-addressed by sha256) and asks again with that upload. The bytes must be exactly that text.
--   · attachment_place_share: a document version without bytes says where it is sent from, instead of "gone".
CREATE FUNCTION chat.attachment_document_snapshot(p_item_id uuid, p_as_user_id text, p_text text, p_staging_key text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_keep CONSTANT INTEGER := 50;
    v_item chat.workspace_items%ROWTYPE;
    v_last chat.workspace_item_versions%ROWTYPE;
    v_blob chat.file_blobs%ROWTYPE;
BEGIN
    IF (SELECT auth.uid()) IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT chat.is_acting_as(p_as_user_id) THEN
        RAISE EXCEPTION 'Not allowed to act as %', COALESCE(p_as_user_id, '<null>');
    END IF;
    IF p_text IS NULL THEN
        RAISE EXCEPTION USING HINT = 'file_place_invalid', MESSAGE = 'attachment_document_snapshot: the text is required';
    END IF;
    -- Locked as files_record_version locks it: a round recorded meanwhile queues behind this one, numbers do not collide.
    v_item := chat.workspace_item_for(p_item_id::TEXT, p_as_user_id, true);
    IF v_item.kind <> 'document' THEN
        RAISE EXCEPTION USING HINT = 'file_place_invalid',
            MESSAGE = format('%s is not a text document: its versions already have bytes', v_item.filename);
    END IF;
    SELECT * INTO v_last FROM chat.workspace_item_versions v WHERE v.item_id = v_item.id ORDER BY v.n DESC LIMIT 1;
    IF FOUND AND v_last.blob_id IS NOT NULL AND v_last.inline_text IS NOT DISTINCT FROM p_text THEN
        RETURN v_last.n;
    END IF;
    IF p_staging_key IS NULL THEN
        RAISE EXCEPTION USING HINT = 'attachment_forward_needs_bytes',
            MESSAGE = format('%s is a text document: its text is sent as bytes through attachments/share', v_item.filename);
    END IF;
    SELECT b.* INTO v_blob FROM chat.file_blob_uploads u JOIN chat.file_blobs b ON b.id = u.blob_id
     WHERE u.staging_key = p_staging_key AND u.uploader = (SELECT auth.uid())::TEXT;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING HINT = 'attachment_upload_not_found', MESSAGE = 'that upload is not one of yours';
    END IF;
    IF v_blob.sha256 IS DISTINCT FROM encode(sha256(convert_to(p_text, 'UTF8')), 'hex') THEN
        RAISE EXCEPTION USING HINT = 'file_place_invalid', MESSAGE = 'the uploaded bytes are not this text';
    END IF;
    INSERT INTO chat.workspace_item_versions (item_id, n, inline_text, blob_id, content_type, size_bytes, made_by)
    VALUES (v_item.id, COALESCE(v_last.n, 0) + 1, p_text, v_blob.id, v_item.content_type, octet_length(p_text), v_item.updated_by);
    DELETE FROM chat.workspace_item_versions v
     WHERE v.item_id = v_item.id
       AND v.n NOT IN (SELECT k.n FROM chat.workspace_item_versions k WHERE k.item_id = v_item.id ORDER BY k.n DESC LIMIT v_keep)
       AND NOT EXISTS (SELECT 1 FROM chat.messages m WHERE m.file_item_id = v.item_id AND m.file_version = v.n);
    RETURN COALESCE(v_last.n, 0) + 1;
END;
$$;
REVOKE ALL ON FUNCTION chat.attachment_document_snapshot(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.attachment_document_snapshot(uuid, text, text, text) TO authenticated;

DO $document_share$
DECLARE definition text; r record;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('chat.attachment_place_share(uuid,integer,text,text,text)',
         $old$    IF v_blob IS NULL AND NOT EXISTS(SELECT 1 FROM chat.file_device_revisions d WHERE d.item_id = v_item.id AND d.version = v_version) THEN
        RAISE EXCEPTION USING HINT = 'attachment_source_gone',
$old$,
         $new$    IF v_blob IS NULL AND NOT EXISTS(SELECT 1 FROM chat.file_device_revisions d WHERE d.item_id = v_item.id AND d.version = v_version) THEN
        -- A text document's version is text: attachments/share pins its text as it is now (attachment_document_snapshot).
        IF v_item.kind = 'document' THEN
            RAISE EXCEPTION USING HINT = 'attachment_forward_needs_bytes',
                MESSAGE = format('%s is a text document: send it through attachments/share', v_item.filename);
        END IF;
        RAISE EXCEPTION USING HINT = 'attachment_source_gone',
$new$)
    ) AS patches(signature, old_body, new_body) LOOP
        SELECT pg_get_functiondef(r.signature::regprocedure) INTO definition;
        IF position(r.old_body IN definition) = 0 OR
           length(definition) - length(replace(definition, r.old_body, '')) <> length(r.old_body) THEN
            RAISE EXCEPTION 'Unexpected document-share predecessor: %', r.signature;
        END IF;
        EXECUTE replace(definition, r.old_body, r.new_body);
    END LOOP;
END $document_share$;
-- Redefining it this way leaves it without its grant, as the earlier patches of it found: give it back.
REVOKE ALL ON FUNCTION chat.attachment_place_share(uuid, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.attachment_place_share(uuid, integer, text, text, text) TO authenticated;
NOTIFY pgrst, 'reload schema';
