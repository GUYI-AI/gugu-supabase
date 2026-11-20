-- Direct upload to the final key (D1, server half).
--
-- 1. Managed blobs are owned by their uploader: bucket 'oss', object 'u/<account>/<sha256>'. The sha is the uploader's
--    claim, scoped to the uploader, and nothing global is ever found by a client-supplied sha. Legacy '<aa>/<sha256>'
--    objects stay readable and are never attached to again.
-- 2. Registration finds and creates a blob by its place (bucket, object), not by a sha256 that is unique across all
--    buckets. A temporary relay blob records the sha of whatever bytes its host uploaded, so a host could otherwise
--    upload a target file's plaintext as its "ciphertext" and capture every later upload of that file.
-- 3. Content dimensions move from the sha-keyed chat.file_contents onto the blob and version rows that name the bytes.
SET LOCAL lock_timeout = '5s';

-- Replacing a function body must not change who may call it: remember its EXECUTE grantees, re-grant them after.
CREATE TEMP TABLE replaced_grants ON COMMIT DROP AS
SELECT p.oid::regprocedure AS fn, pg_get_userbyid(a.grantee) AS grantee
  FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
 WHERE a.privilege_type='EXECUTE' AND a.grantee<>0 AND a.grantee<>p.proowner
   AND p.oid IN ('chat.file_blob_register(text,text,text,bigint,text,integer,integer)'::regprocedure,
       'chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb)'::regprocedure,
       'file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid,integer,integer)'::regprocedure,
       'chat.file_resolve_availability_base(jsonb,text)'::regprocedure,'chat.file_urls_as_pending_base(jsonb,text)'::regprocedure,
       'chat.session_attachment_urls_as(uuid[],text)'::regprocedure,'chat.file_managed_upload_scope(text,text,text,text)'::regprocedure);

DO $place$
DECLARE definition text;
    reg_conflict text := 'ON CONFLICT (sha256) DO NOTHING
    RETURNING b.* INTO v_blob;';
    reg_lookup text := 'SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.sha256 = v_sha;';
    settle_conflict text := 'ON CONFLICT (sha256) DO NOTHING RETURNING b.* INTO l;';
    settle_lookup text := 'IF NOT created THEN SELECT * INTO l FROM chat.file_blobs WHERE sha256=sha; END IF;';
BEGIN
    SELECT pg_get_functiondef('chat.file_blob_register(text,text,text,bigint,text,integer,integer)'::regprocedure) INTO definition;
    IF strpos(definition,reg_conflict)=0 OR strpos(definition,reg_lookup)=0 THEN
        RAISE EXCEPTION 'Unexpected file_blob_register definition; refusing a partial upgrade';
    END IF;
    IF strpos(definition,'VALUES (''oss'', substr(v_sha, 1, 2) || ''/'' || v_sha,')=0 THEN
        RAISE EXCEPTION 'Unexpected file_blob_register name; refusing a partial upgrade';
    END IF;
    definition:=replace(definition,'VALUES (''oss'', substr(v_sha, 1, 2) || ''/'' || v_sha,','VALUES (''oss'', ''u/'' || p_uploader || ''/'' || v_sha,');
    definition:=replace(definition,reg_conflict,'ON CONFLICT ON CONSTRAINT file_blobs_place_key DO NOTHING
    RETURNING b.* INTO v_blob;');
    EXECUTE replace(definition,reg_lookup,
        'SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.bucket_id = ''oss'' AND b.object_name = ''u/'' || p_uploader || ''/'' || v_sha;');

    SELECT pg_get_functiondef('chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb)'::regprocedure) INTO definition;
    IF strpos(definition,settle_conflict)=0 OR strpos(definition,settle_lookup)=0 THEN
        RAISE EXCEPTION 'Unexpected file_blob_settle definition; refusing a partial upgrade';
    END IF;
    IF strpos(definition,'VALUES(''oss'',substr(sha,1,2)||''/''||sha,')=0 THEN
        RAISE EXCEPTION 'Unexpected file_blob_settle name; refusing a partial upgrade';
    END IF;
    definition:=replace(definition,'VALUES(''oss'',substr(sha,1,2)||''/''||sha,','VALUES(''oss'',''u/''||p_uploader||''/''||sha,');
    definition:=replace(definition,settle_conflict,'ON CONFLICT ON CONSTRAINT file_blobs_place_key DO NOTHING RETURNING b.* INTO l;');
    EXECUTE replace(definition,settle_lookup,
        'IF NOT created THEN SELECT * INTO l FROM chat.file_blobs WHERE bucket_id=''oss'' AND object_name=''u/''||p_uploader||''/''||sha; END IF;');
END $place$;

-- Both registrations now conflict on the place key; nothing else uses the global key.
ALTER TABLE chat.file_blobs DROP CONSTRAINT file_blobs_sha256_key;
-- Lookups by content hash (integrity checks, document import) keep an index.
CREATE INDEX file_blobs_sha256_idx ON chat.file_blobs(sha256) WHERE sha256 IS NOT NULL;
-- A managed object is named by its sha: legacy '<aa>/<sha>' or owned 'u/<account>/<sha>'. New managed rows are owned only;
-- NOT VALID leaves existing legacy rows as they are.
ALTER TABLE chat.file_blobs DROP CONSTRAINT file_blobs_oss_shape;
ALTER TABLE chat.file_blobs ADD CONSTRAINT file_blobs_oss_shape CHECK (bucket_id<>'oss' OR sha256 IS NOT NULL AND size_bytes IS NOT NULL
    AND (object_name = substr(sha256,1,2)||'/'||sha256
         OR split_part(object_name,'/',1)='u' AND split_part(object_name,'/',2)<>'' AND object_name='u/'||split_part(object_name,'/',2)||'/'||sha256));
ALTER TABLE chat.file_blobs ADD CONSTRAINT file_blobs_oss_owned CHECK (bucket_id<>'oss' OR object_name LIKE 'u/%') NOT VALID;


-- Content dimensions live on the row that names the bytes, not in a table keyed by a sha anyone can claim.
-- chat.file_contents was keyed by sha256 across every bucket and owner, so a device or host reporting dimensions for a
-- sha changed the preview size of every file with that sha. A managed blob now carries the dimensions the server
-- measured; a device-kept version carries the ones its device reported. Readers read the row they already hold.
ALTER TABLE chat.file_blobs ADD COLUMN width integer, ADD COLUMN height integer,
    ADD CONSTRAINT file_blobs_dimensions CHECK ((width IS NULL) = (height IS NULL) AND (width IS NULL OR width > 0 AND height > 0));
ALTER TABLE chat.workspace_item_versions ADD COLUMN width integer, ADD COLUMN height integer,
    ADD CONSTRAINT workspace_item_versions_dimensions CHECK ((width IS NULL) = (height IS NULL) AND (width IS NULL OR width > 0 AND height > 0));
GRANT SELECT (width, height) ON chat.workspace_item_versions TO authenticated;

DO $contents$
DECLARE blobs bigint; versions bigint; contents bigint;
BEGIN
    SELECT count(*) INTO contents FROM chat.file_contents;
    UPDATE chat.file_blobs b SET width=c.width,height=c.height FROM chat.file_contents c
     WHERE c.sha256=b.sha256 AND b.bucket_id NOT IN ('temporary','pending');
    GET DIAGNOSTICS blobs = ROW_COUNT;
    UPDATE chat.workspace_item_versions v SET width=c.width,height=c.height FROM chat.file_contents c
     WHERE c.sha256=v.sha256 AND v.blob_id IS NULL AND v.host_project_id IS NOT NULL;
    GET DIAGNOSTICS versions = ROW_COUNT;
    RAISE NOTICE 'file_contents: % rows copied onto % blobs and % device-kept versions', contents, blobs, versions;
END $contents$;

CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_from text, p_to text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE definition text := pg_get_functiondef(p_fn);
BEGIN
    IF strpos(definition, p_from) = 0 THEN RAISE EXCEPTION 'Unexpected % definition; refusing a partial upgrade', p_fn; END IF;
    RETURN replace(definition, p_from, p_to);
END $$;

DO $writers$
DECLARE definition text;
BEGIN
    -- Registration measured the bytes: their dimensions belong to this blob.
    definition := pg_temp.patch('chat.file_blob_register(text,text,text,bigint,text,integer,integer)',
        'INSERT INTO chat.file_contents(sha256, width, height) VALUES (v_sha, p_width, p_height)
        ON CONFLICT (sha256) DO UPDATE SET width = EXCLUDED.width, height = EXCLUDED.height;',
        'UPDATE chat.file_blobs SET width = p_width, height = p_height WHERE id = v_blob.id;');
    EXECUTE definition;
    definition := pg_temp.patch('chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb)',
        'INSERT INTO chat.file_contents(sha256,width,height) VALUES(sha,p_width,p_height)
            ON CONFLICT (sha256) DO UPDATE SET width=EXCLUDED.width,height=EXCLUDED.height;',
        'UPDATE chat.file_blobs SET width=p_width,height=p_height WHERE id=l.id;');
    EXECUTE definition;
    -- A device-kept version records the dimensions its device reported, on that version only.
    definition := pg_temp.patch('file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid,integer,integer)',
        'host_device_id,host_project_id,relative_path)
    VALUES(p_item,n,p_type,p_size,auth.uid()::text,now(),chat.workspace_stored_name(p_filename),p_sha,p_device,project,p_path);
    IF p_width IS NOT NULL THEN
        INSERT INTO chat.file_contents(sha256,width,height) VALUES(p_sha,p_width,p_height) ON CONFLICT (sha256) DO NOTHING;
    END IF;',
        'host_device_id,host_project_id,relative_path,width,height)
    VALUES(p_item,n,p_type,p_size,auth.uid()::text,now(),chat.workspace_stored_name(p_filename),p_sha,p_device,project,p_path,
        CASE WHEN p_width IS NOT NULL AND p_height IS NOT NULL THEN p_width END,
        CASE WHEN p_width IS NOT NULL AND p_height IS NOT NULL THEN p_height END);');
    EXECUTE definition;
END $writers$;
DO $readers$
DECLARE definition text;
BEGIN
    definition := pg_temp.patch('chat.file_resolve_availability_base(jsonb,text)',
        'size chat.file_contents%ROWTYPE;', '');
    definition := replace(definition, 'SELECT * INTO size FROM chat.file_contents WHERE sha256=d.sha256;', '');
    IF strpos(definition, '''width'',size.width,''height'',size.height') = 0 THEN
        RAISE EXCEPTION 'Unexpected file_resolve_availability_base definition; refusing a partial upgrade';
    END IF;
    EXECUTE replace(definition, '''width'',size.width,''height'',size.height', '''width'',d.width,''height'',d.height');

    definition := pg_temp.patch('chat.file_urls_as_pending_base(jsonb,text)',
        'LEFT JOIN chat.file_contents size ON size.sha256 = b.sha256', '');
    EXECUTE replace(definition, 'size.width, size.height', 'b.width, b.height');

    definition := pg_temp.patch('chat.session_attachment_urls_as(uuid[],text)',
        ' LEFT JOIN chat.file_contents size ON size.sha256=b.sha256', '');
    EXECUTE replace(definition, 'size.width,size.height', 'b.width,b.height');
END $readers$;
DROP TABLE chat.file_contents;


-- Direct upload: the client sends the bytes straight to their owned final object 'u/<account>/<sha256>'.
-- A permit's logical key is 'direct/<account>/<reservation id>' (the existing per-permit key column), and its object is
-- object_key. One reservation per permit, 1x the declared size (no staging copy), released like any upload hold.
ALTER TABLE chat.file_transfer_uploads ADD COLUMN object_key text,
    ADD CONSTRAINT file_transfer_uploads_direct_shape CHECK (object_key IS NULL AND staging_key NOT LIKE 'direct/%'
        OR object_key ~ ('^u/' || account_id || '/[0-9a-f]{64}$') AND staging_key = 'direct/' || account_id || '/' || reservation_id::text);
ALTER TABLE chat.file_blob_uploads DROP CONSTRAINT file_blob_uploads_staging_key_check;
ALTER TABLE chat.file_blob_uploads ADD CONSTRAINT file_blob_uploads_staging_key_check
    CHECK (staging_key ~ '^(staging|direct)/[^/]+/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
DO $replay$
BEGIN
    EXECUTE pg_temp.patch('chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb)',
        'AND u.staging_key=''staging/''||p_uploader||''/''||r.id::text',
        'AND u.staging_key IN (''staging/''||p_uploader||''/''||r.id::text,''direct/''||p_uploader||''/''||r.id::text)');
END $replay$;


-- Issue: the same bytes already stored by this account need no upload (a receipt only: no reservation, no permit);
-- an open permit for the same object answers upload_in_progress; otherwise a 1x reservation and a permit for the
-- final object. Serialized by the quota lock, so two permits never write one object.
CREATE FUNCTION chat.file_managed_upload_direct_as(p_id uuid,p_chat text,p_as text,p_bytes bigint,p_content_type text,p_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); u text:=auth.uid()::text; g text; prepared jsonb;
    v chat.file_transfer_reservations%ROWTYPE; key text:='direct/'||u||'/'||p_id::text; object text;
    prior chat.file_transfer_uploads%ROWTYPE; stored uuid; busy timestamptz;
BEGIN
    IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'A direct upload names its bytes by sha256' USING HINT='file_transfer_invalid';
    END IF;
    object:='u/'||u||'/'||p_sha256;
    prepared:=chat.file_managed_upload_prepare(p_chat,p_as,p_bytes,p_content_type);
    g:=prepared->>'chat_id';
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    -- A repeated request answers what it answered the first time.
    IF EXISTS(SELECT 1 FROM chat.file_blob_uploads WHERE staging_key=key AND uploader=u)
       AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_uploads WHERE staging_key=key) THEN
        RETURN jsonb_build_object('status','stored','staging_key',key);
    END IF;
    SELECT * INTO prior FROM chat.file_transfer_uploads WHERE staging_key=key;
    IF NOT FOUND THEN
        SELECT b.id INTO stored FROM chat.file_blobs b WHERE b.bucket_id='oss' AND b.object_name=object AND b.state='live';
        IF FOUND THEN
            INSERT INTO chat.file_blob_uploads(staging_key,uploader,blob_id) VALUES(key,u,stored);
            RETURN jsonb_build_object('status','stored','staging_key',key);
        END IF;
        SELECT r.release_at INTO busy FROM chat.file_transfer_uploads o JOIN chat.file_transfer_reservations r ON r.id=o.reservation_id
         WHERE o.object_key=object AND o.blob_id IS NULL AND NOT o.staging_deleted ORDER BY r.release_at DESC NULLS FIRST LIMIT 1;
        IF FOUND THEN
            RAISE EXCEPTION 'These bytes are being uploaded by another request' USING HINT='file_transfer_upload_in_progress',
                DETAIL=COALESCE(busy,now())::text;
        END IF;
    ELSIF prior.object_key IS DISTINCT FROM object OR prior.actor_id<>actor OR prior.chat_id IS DISTINCT FROM g OR prior.max_bytes<>p_bytes THEN
        RAISE EXCEPTION 'Upload scope is immutable' USING HINT='file_transfer_conflict';
    END IF;
    v:=chat.file_transfer_reserve(p_id,'upload',u,g,p_bytes,key);
    IF v.expires_at<=now() OR v.state='settled' THEN RAISE EXCEPTION 'Upload permit expired' USING HINT='file_transfer_expired'; END IF;
    INSERT INTO chat.file_transfer_uploads(staging_key,reservation_id,account_id,chat_id,actor_id,max_bytes,object_key)
    VALUES(key,p_id,u,g,actor,p_bytes,object) ON CONFLICT DO NOTHING;
    UPDATE chat.file_transfer_reservations SET state='issued' WHERE id=p_id;
    RETURN jsonb_build_object('status','upload','staging_key',key,'object_key',object,'max_bytes',p_bytes,
        'expires_at',v.expires_at,'signed_at',v.created_at);
END $$;
ALTER FUNCTION chat.file_managed_upload_direct_as(uuid,text,text,bigint,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_managed_upload_direct_as(uuid,text,text,bigint,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_direct_as(uuid,text,text,bigint,text,text) TO authenticated;

-- A stored key has no ledger scope: commit, place and finish admit it for their own target chat and actor, the same
-- check as issuing (the bytes are the account's own, so referencing them is a forward).
DO $scope$
BEGIN
    EXECUTE pg_temp.patch('chat.file_managed_upload_scope(text,text,text,text)',
        '    SELECT * INTO u FROM chat.file_transfer_uploads WHERE staging_key=p_key AND account_id=auth.uid()::text;
    IF NOT FOUND OR u.actor_id<>actor THEN',
        '    SELECT * INTO u FROM chat.file_transfer_uploads WHERE staging_key=p_key AND account_id=auth.uid()::text;
    IF NOT FOUND AND p_key LIKE ''direct/%'' AND EXISTS(SELECT 1 FROM chat.file_blob_uploads r
        WHERE r.staging_key=p_key AND r.uploader=auth.uid()::text AND r.blob_id IS NOT NULL) THEN
        IF p_item IS NOT NULL THEN w:=chat.workspace_item_for(p_item,actor,false); p_chat:=w.chat_id; END IF;
        IF p_chat IS NOT NULL THEN g:=chat.workspace_require_room_member(p_chat,actor); END IF;
        RETURN;
    END IF;
    IF NOT FOUND OR u.actor_id<>actor THEN');
END $scope$;

-- Registration on the staging path (older clients) creates the same owned object a direct permit writes. While another
-- direct permit for that object is unresolved (its upload may land, or GC may be deleting its object), creating the blob
-- here would race that permit, so it answers the same retryable upload_in_progress as issuing does.
DO $race$
DECLARE guard text := '
    IF NOT EXISTS(SELECT 1 FROM chat.file_blobs x WHERE x.bucket_id = ''oss'' AND x.object_name = ''u/'' || p_uploader || ''/'' || %1$s)
       AND EXISTS(SELECT 1 FROM chat.file_transfer_uploads o WHERE o.object_key = ''u/'' || p_uploader || ''/'' || %1$s
           AND o.blob_id IS NULL AND NOT o.staging_deleted AND o.staging_key <> %2$s) THEN
        RAISE EXCEPTION ''These bytes are being uploaded by another request'' USING HINT = ''file_transfer_upload_in_progress'',
            DETAIL = (SELECT COALESCE(max(r.release_at), now())::text FROM chat.file_transfer_uploads o
                JOIN chat.file_transfer_reservations r ON r.id = o.reservation_id
                WHERE o.object_key = ''u/'' || p_uploader || ''/'' || %1$s AND o.blob_id IS NULL AND NOT o.staging_deleted);
    END IF;
';
BEGIN
    EXECUTE pg_temp.patch('chat.file_blob_register(text,text,text,bigint,text,integer,integer)',
        '    INSERT INTO chat.file_blobs AS b (bucket_id, object_name, sha256, size_bytes, content_type, created_by)',
        format(guard, 'v_sha', 'p_staging_key') || '    INSERT INTO chat.file_blobs AS b (bucket_id, object_name, sha256, size_bytes, content_type, created_by)');
    EXECUTE pg_temp.patch('chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb)',
        '        INSERT INTO chat.file_blobs AS b(bucket_id,object_name,sha256,size_bytes,content_type,created_by)',
        format(guard, 'sha', 'p_upload_key') || '        INSERT INTO chat.file_blobs AS b(bucket_id,object_name,sha256,size_bytes,content_type,created_by)');
END $race$;

-- Failure cleanup: an abandoned direct upload (never registered, past its release time) can leave bytes at its owned
-- object. The attachments GC claims such permits under the quota lock, deletes the object only when no live blob owns
-- it, and records the outcome; until then a new permit for the object answers upload_in_progress.
CREATE FUNCTION chat.file_direct_upload_cleanup_claim(p_limit integer)
RETURNS TABLE(staging_key text,object_key text,upload_id text,object_owned boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid direct cleanup batch'; END IF;
    IF NOT pg_try_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0)) THEN RETURN; END IF;
    RETURN QUERY
    SELECT o.staging_key,o.object_key,o.upload_id,
           EXISTS(SELECT 1 FROM chat.file_blobs b WHERE b.bucket_id='oss' AND b.object_name=o.object_key)
      FROM chat.file_transfer_uploads o JOIN chat.file_transfer_reservations r ON r.id=o.reservation_id
     WHERE o.object_key IS NOT NULL AND o.blob_id IS NULL AND NOT o.staging_deleted
       AND r.release_at<=now() AND r.state IN ('reserved','issued')
     ORDER BY r.release_at,o.staging_key LIMIT p_limit;
END $$;
CREATE FUNCTION chat.file_direct_upload_cleanup_done(p_key text,p_object_deleted boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    UPDATE chat.file_transfer_uploads SET staging_deleted=true,
        close_evidence=COALESCE(close_evidence,CASE WHEN p_object_deleted THEN 'abandoned:object-deleted' ELSE 'abandoned:object-owned' END)
     WHERE staging_key=p_key AND object_key IS NOT NULL AND blob_id IS NULL AND NOT staging_deleted;
    IF NOT FOUND THEN RAISE EXCEPTION 'Direct upload cleanup is not pending for %',p_key; END IF;
END $$;
ALTER FUNCTION chat.file_direct_upload_cleanup_claim(integer) OWNER TO postgres;
ALTER FUNCTION chat.file_direct_upload_cleanup_done(text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_direct_upload_cleanup_claim(integer),chat.file_direct_upload_cleanup_done(text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_direct_upload_cleanup_claim(integer),chat.file_direct_upload_cleanup_done(text,boolean) TO service_role;

-- A multipart upload lives on its object: the staging key itself, or a direct permit's owned object.
DROP FUNCTION chat.file_managed_upload_parts_claim(integer);
CREATE FUNCTION chat.file_managed_upload_parts_claim(p_limit integer) RETURNS TABLE(staging_key text,account_id text,upload_id text,object_key text)
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
    UPDATE chat.file_transfer_uploads u SET abandon_tried_at=now()
    FROM (SELECT c.staging_key FROM chat.file_transfer_uploads c
            JOIN chat.file_transfer_reservations r ON r.id=c.reservation_id
            WHERE c.upload_id IS NOT NULL AND r.expires_at<=now()
            ORDER BY c.abandon_tried_at NULLS FIRST,r.expires_at LIMIT greatest(p_limit,0)) picked
    WHERE u.staging_key=picked.staging_key
    RETURNING u.staging_key,u.account_id,u.upload_id,COALESCE(u.object_key,u.staging_key);
$$;
ALTER FUNCTION chat.file_managed_upload_parts_claim(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_managed_upload_parts_claim(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_parts_claim(integer) TO service_role;

DO $regrant$
DECLARE r record;
BEGIN
    FOR r IN SELECT fn, grantee FROM replaced_grants LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', r.fn, r.grantee);
    END LOOP;
END $regrant$;

NOTIFY pgrst,'reload schema';
