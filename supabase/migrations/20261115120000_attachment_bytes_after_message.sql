-- A message is its text and its attachment's index; the bytes follow it (owner 11-15: 「消息不就是文件索引+文字内容吗」).
-- Before this the sender uploaded the whole file and only then committed the message, so a slow upload held the message,
-- its delivery and its read receipts. Now the sender declares the file it is about to upload (sha256, size, type) and
-- commits at once: the attachment's blob is a *pending* row (bucket 'pending', object_name = the staging key, no sha256
-- yet, declared_sha256 = what the sender promised). Item, version, whisper message and envelope reference it like any blob.
-- When the bytes are up, the attachments function hashes them and settles the row (chat.file_blob_settle): the verified
-- bytes become (or join) the live blob of that sha256, every reference moves to it and the pending row is deleted. Bytes
-- that do not match the declaration mark the row failed. The declaration never lends the sender anyone else's bytes:
-- a pending row is only ever replaced by bytes the function hashed itself.
--
-- Readers see the attachment's own state, never the message's: file_resolve_as answers it with 'upload' 'pending' (with
-- the declared size, type and an image's width and height, so its place is drawn at its size) or 'failed'; a pending row
-- older than a day without its bytes reads as failed (the sender's device did not come back); the sender may still settle
-- it until its upload receipt expires (seven days). Signing refuses it (file_transfer_download_as answers the same state;
-- file_urls_as leaves it out).
-- A pending row is not in the storage ledger: its quota is taken when it settles, as the live blob's.
-- Settling tells the chat's members (message_file_changed), so a reader shows the bytes as soon as they are there.
--
-- Old clients: they commit as before (upload first) and keep working. A pending or failed attachment reads, in the shape
-- they know, as an object not found (status 'missing', code 'object_not_found'), which they show as unavailable until
-- they read it again after it settled; the attachment's own state is in 'upload' ('pending' | 'failed') for new clients.
-- The two CHECKs are added NOT VALID here and validated by the two releases after this one, without holding the table.
-- Rollback: ops/rollback-attachment-bytes-after-message.sql.
SET LOCAL lock_timeout = '5s';

DO $constraints$
DECLARE previous_lock_timeout text := current_setting('lock_timeout');
BEGIN
    PERFORM set_config('lock_timeout', '1s', true);
    ALTER TABLE chat.file_blobs ADD COLUMN declared_sha256 text, ADD COLUMN declared_width integer,
        ADD COLUMN declared_height integer, ADD COLUMN declared_failed_at timestamptz;
    -- Every bucket in use stays; 'pending' is added.
    ALTER TABLE chat.file_blobs DROP CONSTRAINT file_blobs_bucket_id_check;
    ALTER TABLE chat.file_blobs ADD CONSTRAINT file_blobs_bucket_id_check
        CHECK (bucket_id IN ('oss','temporary','workspace','avatars','chat-media','attachments','feedback-screenshots','pending')) NOT VALID;
    -- A pending row is the declaration and nothing else; only a pending row carries one and only it can fail.
    ALTER TABLE chat.file_blobs ADD CONSTRAINT file_blobs_pending_shape CHECK (
        (bucket_id = 'pending') = (declared_sha256 IS NOT NULL)
        AND (declared_sha256 IS NULL OR declared_sha256 ~ '^[0-9a-f]{64}$')
        AND (bucket_id <> 'pending' OR sha256 IS NULL AND size_bytes IS NOT NULL)
        AND (declared_width IS NULL) = (declared_height IS NULL)
        AND (declared_width IS NULL OR bucket_id = 'pending' AND declared_width > 0 AND declared_height > 0)
        AND (declared_failed_at IS NULL OR bucket_id = 'pending')) NOT VALID;
    PERFORM set_config('lock_timeout', previous_lock_timeout, true);
END $constraints$;

/** How long readers wait for a pending attachment's bytes before they read it as failed. */
CREATE FUNCTION chat.file_pending_deadline() RETURNS interval LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT interval '1 day' $$;

-- The storage ledger tracks bytes that exist. A pending row joins it when it settles (as the live blob).
CREATE OR REPLACE FUNCTION chat.file_transfer_track(p_blob uuid,p_chat text,p_actor text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o uuid; b chat.file_blobs%ROWTYPE; g text := chat.file_transfer_group(p_chat);
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    SELECT * INTO b FROM chat.file_blobs WHERE id=p_blob;
    IF NOT FOUND THEN RAISE EXCEPTION 'File blob is missing'; END IF;
    IF b.bucket_id='pending' THEN RETURN NULL; END IF;
    INSERT INTO chat.file_transfer_storage AS s(blob_id,bucket_id,object_name,size_bytes,owner_account,created_at)
    VALUES(b.id,b.bucket_id,b.object_name,b.size_bytes,chat.file_transfer_account(b.created_by),b.created_at)
    ON CONFLICT(bucket_id,object_name) DO UPDATE SET blob_id=EXCLUDED.blob_id,owner_account=COALESCE(s.owner_account,EXCLUDED.owner_account)
    RETURNING id INTO o;
    IF g IS NOT NULL THEN
    INSERT INTO chat.file_transfer_storage_refs(storage_id,chat_id,account_id,created_at)
    VALUES(o,g,COALESCE(chat.file_transfer_account(p_actor),p_actor,b.created_by,'legacy:unknown'),b.created_at)
    ON CONFLICT DO NOTHING;
    END IF;
    RETURN o;
END $$;
ALTER FUNCTION chat.file_transfer_track(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_transfer_track(uuid,text,text) FROM PUBLIC,anon,authenticated;

-- A whisper keeps the bytes it was sent with; settling replaces the declaration with those very bytes, nothing else.
DO $ref$
DECLARE definition text:=pg_get_functiondef('chat.messages_file_ref()'::regprocedure);
    fixed text:='OR NEW.file_blob_id IS DISTINCT FROM OLD.file_blob_id THEN';
BEGIN
    IF position(fixed IN definition)=0 THEN RAISE EXCEPTION 'Unexpected messages_file_ref predecessor'; END IF;
    EXECUTE replace(definition,fixed,
        'OR NEW.file_blob_id IS DISTINCT FROM OLD.file_blob_id AND OLD.file_blob_id::text IS DISTINCT FROM NULLIF(current_setting(''chat.file_blob_settling'',true),'''') THEN');
END $ref$;

-- Settling moves a version's and an item's bytes from the declaration to the same bytes, verified: not a new version.
DO $pinned$
DECLARE definition text:=pg_get_functiondef('chat.workspace_bytes_pinned()'::regprocedure);
BEGIN
    IF position('BEGIN' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected workspace_bytes_pinned predecessor'; END IF;
    EXECUTE regexp_replace(definition,'BEGIN',
        'BEGIN
    IF OLD.blob_id::text IS NOT DISTINCT FROM NULLIF(current_setting(''chat.file_blob_settling'',true),'''') THEN RETURN NEW; END IF;');
END $pinned$;

-- Readers hear that a message's file changed (settled or failed) as an account revision, the way they hear of its deletion.
-- Released clients skip a revision event they do not know.
DO $revision$
DECLARE definition text:=pg_get_functiondef('chat.append_user_revision(text,text,jsonb,boolean)'::regprocedure);
BEGIN
    IF position('''message_deleted'',' IN definition)=0 THEN RAISE EXCEPTION 'Unexpected append_user_revision predecessor'; END IF;
    EXECUTE replace(definition,'''message_deleted'',','''message_deleted'',
      ''message_file_changed'',');
END $revision$;

/**
 * The sender's declaration of the bytes it is about to upload under its staging key: the pending blob a commit places
 * at once. Repeating it answers the same row; a different declaration for the same key is refused.
 */
CREATE FUNCTION chat.attachment_declare(p_staging_key text,p_sha256 text,p_size_bytes bigint,p_content_type text,
    p_width integer DEFAULT NULL,p_height integer DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE me text:=auth.uid()::text; up chat.file_transfer_uploads%ROWTYPE; r chat.file_transfer_reservations%ROWTYPE;
    receipt chat.file_blob_uploads%ROWTYPE; b chat.file_blobs%ROWTYPE; sha text:=lower(btrim(COALESCE(p_sha256,'')));
BEGIN
    IF sha !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'sha256 must be 64 hex digits' USING HINT='file_transfer_invalid'; END IF;
    SELECT * INTO up FROM chat.file_transfer_uploads WHERE staging_key=p_staging_key AND account_id=me FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'no upload % of yours',p_staging_key USING HINT='attachment_upload_not_found'; END IF;
    SELECT * INTO receipt FROM chat.file_blob_uploads WHERE staging_key=p_staging_key;
    IF FOUND THEN
        SELECT * INTO b FROM chat.file_blobs WHERE id=receipt.blob_id;
        IF COALESCE(b.declared_sha256,b.sha256) IS DISTINCT FROM sha OR b.size_bytes IS DISTINCT FROM p_size_bytes THEN
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
    INSERT INTO chat.file_blob_uploads(staging_key,uploader,blob_id,expires_at) VALUES(p_staging_key,me,b.id,now()+interval '7 days');
    RETURN b.id;
END $$;
ALTER FUNCTION chat.attachment_declare(text,text,bigint,text,integer,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.attachment_declare(text,text,bigint,text,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION chat.attachment_declare(text,text,bigint,text,integer,integer) TO authenticated;

/**
 * The caller's declarations whose bytes have not arrived (and were not refused): a restarted sender that still holds
 * them uploads and finishes each, under a new upload. Past the reading deadline is included; receivers read those
 * failed until the bytes arrive.
 */
CREATE FUNCTION chat.attachment_pending_mine() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object('staging_key',u.staging_key,'message_id',m.id,'chat_id',m.chat_id,
        'as',m.sender_user_id,'sha256',b.declared_sha256,'size_bytes',b.size_bytes,'content_type',b.content_type)
        ORDER BY b.created_at),'[]'::jsonb)
      FROM chat.file_blob_uploads u
      JOIN chat.file_blobs b ON b.id=u.blob_id AND b.bucket_id='pending' AND b.declared_failed_at IS NULL
      CROSS JOIN LATERAL (
          SELECT ms.id,ms.chat_id,ms.sender_user_id FROM chat.messages ms WHERE ms.file_blob_id=b.id AND ms.deleted_at IS NULL AND ms.retracted_at IS NULL
          UNION ALL
          SELECT ms.id,ms.chat_id,ms.sender_user_id FROM chat.workspace_item_versions w
            JOIN chat.messages ms ON ms.file_item_id=w.item_id AND ms.file_version=w.n
           WHERE w.blob_id=b.id AND ms.deleted_at IS NULL AND ms.retracted_at IS NULL
          LIMIT 1) m
     WHERE u.uploader=auth.uid()::text AND u.expires_at>now()
$$;
ALTER FUNCTION chat.attachment_pending_mine() OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.attachment_pending_mine() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION chat.attachment_pending_mine() TO authenticated;

/**
 * Tells the readers of every message carrying this declaration (a whisper's own blob, or a room file's version) that its
 * file changed, so they read it again: nobody polls for the bytes. Called before the references move.
 */
CREATE FUNCTION chat.file_pending_changed(p_blob uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE m record;
BEGIN
    FOR m IN SELECT ms.id,ms.chat_id FROM chat.messages ms WHERE ms.file_blob_id=p_blob
        UNION SELECT ms.id,ms.chat_id FROM chat.workspace_item_versions w
          JOIN chat.messages ms ON ms.file_item_id=w.item_id AND ms.file_version=w.n WHERE w.blob_id=p_blob LOOP
        PERFORM chat.broadcast_to_chat_member_user_events(m.chat_id,'message_file_changed',
            jsonb_build_object('message',jsonb_build_object('id',m.id,'chat_id',m.chat_id)));
    END LOOP;
END $$;
ALTER FUNCTION chat.file_pending_changed(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_pending_changed(uuid) FROM PUBLIC,anon,authenticated,service_role;

/**
 * The declared attachment's bytes are up under `p_upload_key` (the pending key itself, or a later upload of the same file)
 * and the function hashed them. Matching the declaration: they are registered like any upload, every reference moves to
 * that blob and the pending row goes. Not matching: the row is failed. Answers {status, blob_id, object_name, created}.
 */
CREATE FUNCTION chat.file_blob_settle(p_uploader text,p_pending_key text,p_upload_key text,p_sha256 text,p_size_bytes bigint,
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
        IF p.sha256 IS DISTINCT FROM sha THEN RAISE EXCEPTION 'upload % settled with other content',p_pending_key USING HINT='file_transfer_conflict'; END IF;
        RETURN jsonb_build_object('status','ready','blob_id',p.id,'object_name',p.object_name,'created',false);
    END IF;
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
    IF p_upload_key<>p_pending_key THEN
        INSERT INTO chat.file_blob_uploads(staging_key,uploader,blob_id,document) VALUES(p_upload_key,p_uploader,l.id,p_document)
        ON CONFLICT (staging_key) DO NOTHING;
    END IF;
    DELETE FROM chat.file_blob_gc WHERE blob_id=p.id;
    DELETE FROM chat.file_blobs WHERE id=p.id;
    -- A folder file replaced while its first bytes were still coming has its newer version imported on its own; the stale
    -- import is skipped, never left to fail the settle (and every retry of it).
    BEGIN PERFORM chat.workspace_ingest_upload(p_pending_key);
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS hint=PG_EXCEPTION_HINT;
        IF hint IS DISTINCT FROM 'workspace_version_conflict' THEN RAISE; END IF;
    END;
    RETURN jsonb_build_object('status','ready','blob_id',l.id,'object_name',l.object_name,'created',created);
END $$;
ALTER FUNCTION chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb) TO service_role;

/**
 * A pending blob's state as readers see it, null when the blob is not pending. Its status is the one released clients
 * already show as unavailable (an object not found); its own state is 'upload'.
 */
CREATE FUNCTION chat.file_pending_state(p_bucket text,p_object text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT jsonb_build_object('status','missing','code','object_not_found','sha256',NULL,
        'upload',CASE WHEN b.declared_failed_at IS NOT NULL OR b.created_at<now()-chat.file_pending_deadline() THEN 'failed' ELSE 'pending' END,
        'size_bytes',b.size_bytes,'content_type',b.content_type,'width',b.declared_width,'height',b.declared_height,'pending_since',b.created_at)
      FROM chat.file_blobs b WHERE p_bucket='pending' AND b.bucket_id='pending' AND b.object_name=p_object
$$;
REVOKE ALL ON FUNCTION chat.file_pending_state(text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Readers: the predecessors stay as *_pending_base and answer everything that is not pending.
DO $wrap$
DECLARE f record; definition text;
BEGIN
    FOR f IN SELECT * FROM (VALUES ('chat.file_resolve_as(jsonb,text)','chat.file_resolve_as('),
        ('chat.file_transfer_download_as(jsonb,text,uuid)','chat.file_transfer_download_as('),
        ('chat.file_urls_as(jsonb,text)','chat.file_urls_as(')) t(sig,head) LOOP
        definition:=pg_get_functiondef(f.sig::regprocedure);
        IF position('CREATE OR REPLACE FUNCTION '||f.head IN definition)<>1 THEN RAISE EXCEPTION 'Unexpected predecessor of %',f.sig; END IF;
        EXECUTE replace(definition,'CREATE OR REPLACE FUNCTION '||f.head,'CREATE FUNCTION '||replace(f.head,'(','_pending_base('));
    END LOOP;
END $wrap$;
ALTER FUNCTION chat.file_resolve_as_pending_base(jsonb,text) OWNER TO postgres;
ALTER FUNCTION chat.file_transfer_download_as_pending_base(jsonb,text,uuid) OWNER TO postgres;
ALTER FUNCTION chat.file_urls_as_pending_base(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_resolve_as_pending_base(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION chat.file_transfer_download_as_pending_base(jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION chat.file_urls_as_pending_base(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION chat.file_resolve_as(p_ref jsonb,p_as text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); item chat.workspace_items%ROWTYPE; m chat.messages%ROWTYPE;
    blob uuid; version integer; b chat.file_blobs%ROWTYPE; pending jsonb; result jsonb;
BEGIN
    -- The predecessor checks the reference first (its shape, the reader's access) and answers every file that exists.
    -- A declared file has no object yet, so it answers 'gone'; only then is the declaration looked up.
    result:=chat.file_resolve_as_pending_base(p_ref,p_as);
    IF result->>'status' IS DISTINCT FROM 'gone' THEN RETURN result; END IF;
    -- The same doors the resolver reads through: a message its reader can read, an item of a room its reader is in.
    IF p_ref ? 'message_id' THEN
        IF chat.can_read_message(p_ref->>'message_id',actor) THEN
            SELECT * INTO m FROM chat.messages WHERE id=p_ref->>'message_id' AND retracted_at IS NULL;
            version:=m.file_version;
            blob:=COALESCE(m.file_blob_id,chat.workspace_version_blob(m.file_item_id,m.file_version));
            IF m.file_item_id IS NOT NULL THEN SELECT * INTO item FROM chat.workspace_items WHERE id=m.file_item_id; END IF;
        END IF;
    ELSIF p_ref ? 'item_id' THEN
        BEGIN item:=chat.workspace_item_for(p_ref->>'item_id',actor,false);
        EXCEPTION WHEN raise_exception THEN item.id:=NULL; END;
        IF item.id IS NOT NULL THEN
            version:=COALESCE((p_ref->>'version')::integer,item.version);
            blob:=chat.workspace_version_blob(item.id,version);
        END IF;
    END IF;
    SELECT * INTO b FROM chat.file_blobs WHERE id=blob AND bucket_id='pending';
    IF NOT FOUND THEN RETURN result; END IF;
    pending:=chat.file_pending_state(b.bucket_id,b.object_name);
    -- No object to name: the file is its declaration until the bytes arrive.
    RETURN pending||jsonb_build_object('source','managed-object','item_id',item.id,'version',CASE WHEN item.id IS NOT NULL THEN version END,
        'chat_id',COALESCE(item.chat_id,m.chat_id),'file_name',item.filename,'message_id',m.id);
END $$;
ALTER FUNCTION chat.file_resolve_as(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_resolve_as(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.file_resolve_as(jsonb,text) TO authenticated;

CREATE OR REPLACE FUNCTION chat.file_transfer_download_as(p_ref jsonb,p_as text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE resolved jsonb:=chat.file_resolve_as(p_ref,p_as);
BEGIN
    IF resolved ? 'upload' THEN RETURN resolved; END IF;
    RETURN chat.file_transfer_download_as_pending_base(p_ref,p_as,p_id);
END $$;
ALTER FUNCTION chat.file_transfer_download_as(jsonb,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_transfer_download_as(jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.file_transfer_download_as(jsonb,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION chat.file_urls_as(p_refs jsonb,p_as_user_id text)
RETURNS TABLE(item_id uuid,version integer,message_id text,current_version integer,chat_id text,file_name text,bucket_id text,
    object_name text,sha256 text,size_bytes bigint,content_type text,width integer,height integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT * FROM chat.file_urls_as_pending_base(p_refs,p_as_user_id) u WHERE u.bucket_id<>'pending'
$$;
ALTER FUNCTION chat.file_urls_as(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_urls_as(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.file_urls_as(jsonb,text) TO authenticated;

NOTIFY pgrst,'reload schema';
