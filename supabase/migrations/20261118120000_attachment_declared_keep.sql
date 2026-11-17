-- The sender's retention choice belongs to the declaration, before the message or its bytes arrive.
-- Registration applies it atomically with the storage reference, including a resumed upload's receipt.
SET LOCAL lock_timeout = '5s';

ALTER TABLE chat.file_blob_uploads ADD COLUMN keep text CHECK (keep IN ('temporary','permanent'));
DROP FUNCTION chat.attachment_declare(text,text,bigint,text,integer,integer);

CREATE FUNCTION chat.attachment_declare(p_staging_key text,p_sha256 text,p_size_bytes bigint,p_content_type text,
    p_width integer DEFAULT NULL,p_height integer DEFAULT NULL,p_keep text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE me text:=auth.uid()::text; up chat.file_transfer_uploads%ROWTYPE; r chat.file_transfer_reservations%ROWTYPE;
    receipt chat.file_blob_uploads%ROWTYPE; b chat.file_blobs%ROWTYPE; sha text:=lower(btrim(COALESCE(p_sha256,'')));
BEGIN
    IF p_keep IS NOT NULL AND p_keep NOT IN ('temporary','permanent') THEN
        RAISE EXCEPTION 'keep is temporary or permanent' USING HINT='file_transfer_invalid';
    END IF;
    IF sha !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'sha256 must be 64 hex digits' USING HINT='file_transfer_invalid'; END IF;
    SELECT * INTO up FROM chat.file_transfer_uploads WHERE staging_key=p_staging_key AND account_id=me FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'no upload % of yours',p_staging_key USING HINT='attachment_upload_not_found'; END IF;
    SELECT * INTO receipt FROM chat.file_blob_uploads WHERE staging_key=p_staging_key;
    IF FOUND THEN
        SELECT * INTO b FROM chat.file_blobs WHERE id=receipt.blob_id;
        IF COALESCE(b.declared_sha256,b.sha256) IS DISTINCT FROM sha OR b.size_bytes IS DISTINCT FROM p_size_bytes
           OR receipt.keep IS DISTINCT FROM p_keep THEN
            RAISE EXCEPTION 'upload % is declared for other content',p_staging_key USING HINT='file_transfer_conflict';
        END IF;
        RETURN b.id;
    END IF;
    SELECT * INTO r FROM chat.file_transfer_reservations WHERE id=up.reservation_id;
    IF r.expires_at<=now() THEN RAISE EXCEPTION 'Upload permit expired' USING HINT='file_transfer_expired'; END IF;
    IF p_size_bytes IS NULL OR p_size_bytes<1 OR p_size_bytes>up.max_bytes THEN
        RAISE EXCEPTION 'declared size is outside the upload reservation' USING HINT='file_transfer_too_large';
    END IF;
    INSERT INTO chat.file_blobs(bucket_id,object_name,size_bytes,content_type,created_by,declared_sha256,declared_width,declared_height)
    VALUES('pending',p_staging_key,p_size_bytes,COALESCE(NULLIF(btrim(COALESCE(p_content_type,'')),''),'application/octet-stream'),me,sha,
        CASE WHEN p_width>0 AND p_height>0 THEN p_width END,CASE WHEN p_width>0 AND p_height>0 THEN p_height END)
    RETURNING * INTO b;
    -- The receipt outlives the upload permit: the sender's device may resume days later under a new staging key.
    INSERT INTO chat.file_blob_uploads(staging_key,uploader,blob_id,expires_at,keep) VALUES(p_staging_key,me,b.id,now()+interval '7 days',p_keep);
    RETURN b.id;
END $$;
ALTER FUNCTION chat.attachment_declare(text,text,bigint,text,integer,integer,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.attachment_declare(text,text,bigint,text,integer,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION chat.attachment_declare(text,text,bigint,text,integer,integer,text) TO authenticated;

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
        INSERT INTO chat.file_blob_uploads(staging_key,uploader,blob_id,document,keep) VALUES(p_upload_key,p_uploader,l.id,p_document,receipt.keep)
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

CREATE OR REPLACE FUNCTION chat.file_managed_upload_registered(p_key text, p_user text, p_document jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE u chat.file_transfer_uploads%ROWTYPE; b chat.file_blobs%ROWTYPE; receipt chat.file_blob_uploads%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    SELECT * INTO u FROM chat.file_transfer_uploads WHERE staging_key=p_key AND account_id=p_user FOR UPDATE;
    SELECT * INTO receipt FROM chat.file_blob_uploads WHERE staging_key=p_key AND uploader=p_user;
    SELECT * INTO b FROM chat.file_blobs WHERE id=receipt.blob_id;
    IF u.staging_key IS NULL OR b.id IS NULL OR b.size_bytes>u.max_bytes OR u.blob_id IS NOT NULL AND u.blob_id<>b.id THEN
        RAISE EXCEPTION 'Upload registration is not within its reservation' USING HINT='file_transfer_conflict';
    END IF;

    PERFORM chat.file_transfer_track(b.id,u.chat_id,p_user);
    IF u.blob_id IS NULL THEN
        UPDATE chat.file_transfer_storage SET state='ready' WHERE bucket_id=b.bucket_id AND object_name=b.object_name;
    END IF;
    IF receipt.item_id IS NOT NULL AND receipt.document-'prepared' IS DISTINCT FROM p_document THEN
        RAISE EXCEPTION 'Committed upload classification cannot change' USING HINT='file_transfer_conflict';
    END IF;
    UPDATE chat.file_blob_uploads SET document=CASE WHEN receipt.document-'prepared' IS NOT DISTINCT FROM p_document THEN receipt.document ELSE p_document END WHERE staging_key=p_key;
    IF u.blob_id IS NULL THEN
        UPDATE chat.file_transfer_storage_refs SET expired_at=NULL,last_download_at=NULL,retention_started_at=now()
          WHERE storage_id=(SELECT id FROM chat.file_transfer_storage WHERE blob_id=b.id)
            AND chat_id=u.chat_id AND expired_at IS NOT NULL;
    END IF;
    -- Fixed when the image is stored; sending it again, also after it expired, starts a new interval.
    IF u.blob_id IS NULL AND b.content_type LIKE 'image/%' AND chat.is_project_group(u.chat_id)
       AND NOT (chat.file_storage_of(u.account_id)->>'proactive_upload')::boolean THEN
        UPDATE chat.file_transfer_storage_refs SET expires_at=now()+(chat.file_storage_of(u.account_id)->>'image_retention')::interval
          WHERE storage_id=(SELECT id FROM chat.file_transfer_storage WHERE blob_id=b.id) AND chat_id=u.chat_id;
    END IF;
    -- A declared keep overrides the chat's default, in the transaction that registers this upload.
    IF u.blob_id IS NULL AND receipt.keep IS NOT NULL THEN
        UPDATE chat.file_transfer_storage_refs
           SET expires_at=CASE receipt.keep WHEN 'permanent' THEN NULL
               ELSE now()+chat.file_temporary_interval(chat.file_transfer_group(u.chat_id),p_user) END
         WHERE storage_id=(SELECT id FROM chat.file_transfer_storage WHERE blob_id=b.id)
           AND chat_id=chat.file_transfer_group(u.chat_id) AND account_id=chat.file_transfer_account(p_user);
    END IF;
    UPDATE chat.file_transfer_uploads SET blob_id=b.id WHERE staging_key=p_key;
    UPDATE chat.file_transfer_reservations SET actual_bytes=b.size_bytes WHERE id=u.reservation_id;
END $function$;

NOTIFY pgrst,'reload schema';
