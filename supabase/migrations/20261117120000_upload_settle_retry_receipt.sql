-- Finishing a declared upload is repeatable after a lost response, including under a new upload permit.
-- The declaration and its message keep their verified blob; every resumed upload gets its own matching receipt.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION chat.file_blob_settle(p_uploader text,p_pending_key text,p_upload_key text,p_sha256 text,p_size_bytes bigint,
    p_content_type text,p_width integer DEFAULT NULL,p_height integer DEFAULT NULL,p_document jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE receipt chat.file_blob_uploads%ROWTYPE; p chat.file_blobs%ROWTYPE; l chat.file_blobs%ROWTYPE; created boolean:=false;
    sha text:=lower(btrim(COALESCE(p_sha256,''))); v record; hint text;
BEGIN
    SELECT * INTO receipt FROM chat.file_blob_uploads WHERE staging_key=p_pending_key AND uploader=p_uploader FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'no declared upload %',p_pending_key USING HINT='attachment_upload_not_found'; END IF;
    SELECT * INTO p FROM chat.file_blobs WHERE id=receipt.blob_id FOR UPDATE;
    IF p.bucket_id<>'pending' THEN
        -- Settled before (a retried request): the same bytes answer the same blob.
        IF p.sha256 IS DISTINCT FROM sha OR p.size_bytes IS DISTINCT FROM p_size_bytes THEN RAISE EXCEPTION 'upload % settled with other content',p_pending_key USING HINT='file_transfer_conflict'; END IF;
        l:=p;
    ELSE
        IF sha IS DISTINCT FROM p.declared_sha256 OR p_size_bytes IS DISTINCT FROM p.size_bytes THEN
            UPDATE chat.file_blobs SET declared_failed_at=now() WHERE id=p.id;
            PERFORM chat.file_pending_changed(p.id);
            RETURN jsonb_build_object('status','failed','blob_id',p.id);
        END IF;
        INSERT INTO chat.file_blobs AS b(bucket_id,object_name,sha256,size_bytes,content_type,created_by)
        VALUES('oss',substr(sha,1,2)||'/'||sha,sha,p_size_bytes,COALESCE(NULLIF(btrim(COALESCE(p_content_type,'')),''),'application/octet-stream'),p_uploader)
        ON CONFLICT (sha256) DO NOTHING RETURNING b.* INTO l;
        created:=FOUND;
        IF NOT created THEN SELECT * INTO l FROM chat.file_blobs WHERE sha256=sha; END IF;
        PERFORM chat.file_blob_take(l.id);
        IF p_width IS NOT NULL AND p_height IS NOT NULL THEN
            INSERT INTO chat.file_contents(sha256,width,height) VALUES(sha,p_width,p_height)
            ON CONFLICT (sha256) DO UPDATE SET width=EXCLUDED.width,height=EXCLUDED.height;
        END IF;
        -- Every reference the declaration collected moves to the bytes; each move is tracked in the ledger as that reference's.
        PERFORM pg_catalog.set_config('chat.file_blob_settling',p.id::text,true);
        PERFORM chat.file_pending_changed(p.id);
        UPDATE chat.messages SET file_blob_id=l.id WHERE file_blob_id=p.id;
        UPDATE chat.workspace_items SET blob_id=l.id WHERE blob_id=p.id;
        FOR v IN UPDATE chat.workspace_item_versions SET blob_id=l.id WHERE blob_id=p.id RETURNING item_id,made_by LOOP
            PERFORM chat.file_transfer_track(l.id,(SELECT chat_id FROM chat.workspace_items WHERE id=v.item_id),v.made_by);
        END LOOP;
        UPDATE chat.file_blob_uploads SET blob_id=l.id,document=COALESCE(document,p_document) WHERE blob_id=p.id;
        PERFORM pg_catalog.set_config('chat.file_blob_settling','',true);
        DELETE FROM chat.file_blob_gc WHERE blob_id=p.id;
        DELETE FROM chat.file_blobs WHERE id=p.id;
        -- A folder file replaced while its first bytes were still coming has its newer version imported on its own; the stale
        -- import is skipped, never left to fail the settle (and every retry of it).
        BEGIN PERFORM chat.workspace_ingest_upload(p_pending_key);
        EXCEPTION WHEN raise_exception THEN
            GET STACKED DIAGNOSTICS hint=PG_EXCEPTION_HINT;
            IF hint IS DISTINCT FROM 'workspace_version_conflict' THEN RAISE; END IF;
        END;
    END IF;
    -- A lost response may resume under a new permit even when the declaration is already settled.
    -- Both cases must leave that permit's receipt for file_managed_upload_registered.
    IF p_upload_key<>p_pending_key THEN
        INSERT INTO chat.file_blob_uploads(staging_key,uploader,blob_id,document) VALUES(p_upload_key,p_uploader,l.id,p_document)
        ON CONFLICT (staging_key) DO NOTHING;
        IF NOT EXISTS(SELECT 1 FROM chat.file_blob_uploads WHERE staging_key=p_upload_key AND uploader=p_uploader AND blob_id=l.id) THEN
            RAISE EXCEPTION 'upload % is registered for other content',p_upload_key USING HINT='file_transfer_conflict';
        END IF;
    END IF;
    RETURN jsonb_build_object('status','ready','blob_id',l.id,'object_name',l.object_name,'created',created);
END $$;
ALTER FUNCTION chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb) TO service_role;

NOTIFY pgrst,'reload schema';
