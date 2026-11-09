-- One record per file version. A version (item_id, n) is one row of chat.workspace_item_versions wherever its bytes are:
-- a managed blob (blob_id), inline text, or a file kept on a device (host_device_id, host_project_id, relative_path, with
-- the sha256 and file name the device published). chat.file_device_revisions, which kept device versions in a second table
-- under the same key, is folded in and dropped. Every file version has its row from the moment it exists, the current one
-- included; before this a version got a row only once a newer one replaced it.
-- An image's pixel size belongs to its bytes: chat.file_contents keeps it by sha256, for a blob and a device copy alike, so a
-- forwarded, shared or whispered copy of the same bytes has it too. file_blobs.width/height move there and are dropped. The
-- server's own measurement (file_blob_register) overwrites one a publishing device reported (file_device_publish).
-- RPC result shapes are unchanged; file_resolve_as now also returns width/height for a version kept on a device.
-- Old clients keep calling file_device_publish without p_width/p_height, which default to NULL.
-- The installation DDL guard closes created or replaced functions, so every one is granted again below.
-- Rollback: ops/rollback-one-file-version-record.sql.
SET LOCAL lock_timeout = '5s';
LOCK TABLE chat.workspace_items, chat.workspace_item_versions, chat.file_device_revisions, chat.file_blobs,
    chat.file_temporary_transfers IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE chat.file_contents (
    sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    width integer NOT NULL CHECK (width > 0),
    height integer NOT NULL CHECK (height > 0)
);
ALTER TABLE chat.file_contents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.file_contents FROM PUBLIC, anon, authenticated, service_role;
INSERT INTO chat.file_contents(sha256, width, height)
SELECT sha256, width, height FROM chat.file_blobs WHERE sha256 IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL;

-- Where a device keeps the version. Set only for such a version.
ALTER TABLE chat.workspace_item_versions
    ADD COLUMN file_name text CHECK (file_name <> ''),
    ADD COLUMN sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    ADD COLUMN host_device_id text REFERENCES identity.gugu_devices(device_id) ON DELETE SET NULL,
    ADD COLUMN host_project_id text,
    ADD COLUMN relative_path text CHECK (length(relative_path) BETWEEN 1 AND 4096
        AND relative_path !~ '(^/|//|/$|:|\\|[[:cntrl:]]|(^|/)\.\.?(/|$))');
CREATE INDEX workspace_item_versions_host_device_idx ON chat.workspace_item_versions(host_device_id) WHERE host_device_id IS NOT NULL;

ALTER TABLE chat.workspace_item_versions DROP CONSTRAINT workspace_item_versions_one_body;
ALTER TABLE chat.workspace_item_versions DROP CONSTRAINT workspace_item_versions_item_id_device_version_fkey;

-- Backfill in batches of files. Device versions: a replaced one already has its row (blob and text empty); the current
-- one and one a move superseded have none. Managed files: the current version has a row only if a replacement wrote it.
CREATE TEMP TABLE unify_files ON COMMIT DROP AS
    SELECT w.id, row_number() OVER (ORDER BY w.id) AS k FROM chat.workspace_items w WHERE w.kind = 'file';
DO $backfill$
DECLARE lo bigint := 0; batch constant integer := 2000; total bigint := (SELECT count(*) FROM unify_files);
BEGIN
    WHILE lo < total LOOP
        UPDATE chat.workspace_item_versions v
           SET file_name = d.file_name, sha256 = d.sha256, host_device_id = d.host_device_id, host_project_id = d.host_project_id,
               relative_path = d.relative_path, content_type = d.content_type, size_bytes = d.size_bytes
          FROM chat.file_device_revisions d JOIN unify_files f ON f.id = d.item_id AND f.k > lo AND f.k <= lo + batch
         WHERE v.item_id = d.item_id AND v.n = d.version;
        INSERT INTO chat.workspace_item_versions(item_id, n, content_type, size_bytes, made_by, made_at,
            file_name, sha256, host_device_id, host_project_id, relative_path)
        SELECT d.item_id, d.version, d.content_type, d.size_bytes,
               CASE WHEN w.version = d.version THEN COALESCE(w.updated_by, w.created_by) ELSE w.created_by END,
               CASE WHEN w.version = d.version THEN w.updated_at ELSE w.created_at END,
               d.file_name, d.sha256, d.host_device_id, d.host_project_id, d.relative_path
          FROM chat.file_device_revisions d JOIN unify_files f ON f.id = d.item_id AND f.k > lo AND f.k <= lo + batch
          JOIN chat.workspace_items w ON w.id = d.item_id
        ON CONFLICT (item_id, n) DO NOTHING;
        INSERT INTO chat.workspace_item_versions(item_id, n, blob_id, content_type, size_bytes, made_by, made_at)
        SELECT w.id, w.version, w.blob_id, w.content_type, w.size_bytes, COALESCE(w.updated_by, w.created_by), w.updated_at
          FROM chat.workspace_items w JOIN unify_files f ON f.id = w.id AND f.k > lo AND f.k <= lo + batch
         WHERE w.blob_id IS NOT NULL
        ON CONFLICT (item_id, n) DO NOTHING;
        lo := lo + batch;
    END LOOP;
END $backfill$;
DO $check$
DECLARE missing bigint;
BEGIN
    SELECT count(*) INTO missing FROM chat.workspace_items w WHERE w.kind = 'file'
       AND (w.blob_id IS NOT NULL OR EXISTS(SELECT 1 FROM chat.file_device_revisions d WHERE d.item_id = w.id AND d.version = w.version))
       AND NOT EXISTS(SELECT 1 FROM chat.workspace_item_versions v WHERE v.item_id = w.id AND v.n = w.version);
    IF missing > 0 THEN RAISE EXCEPTION 'one_file_version_record: % files have no record of their current version', missing; END IF;
END $check$;

ALTER TABLE chat.workspace_item_versions DROP COLUMN device_version;
ALTER TABLE chat.workspace_item_versions ADD CONSTRAINT workspace_item_versions_one_body CHECK (CASE
    WHEN host_project_id IS NOT NULL THEN inline_text IS NULL AND blob_id IS NULL
        AND relative_path IS NOT NULL AND sha256 IS NOT NULL AND file_name IS NOT NULL
        AND size_bytes >= 0 AND content_type <> ''
    ELSE host_device_id IS NULL AND relative_path IS NULL AND sha256 IS NULL AND file_name IS NULL
        AND num_nonnulls(inline_text, blob_id) >= 1 END);

ALTER TABLE chat.file_temporary_transfers DROP CONSTRAINT file_temporary_transfers_item_id_version_fkey;
ALTER TABLE chat.file_temporary_transfers ADD CONSTRAINT file_temporary_transfers_item_id_version_fkey
    FOREIGN KEY (item_id, version) REFERENCES chat.workspace_item_versions(item_id, n) ON DELETE CASCADE;

DROP TRIGGER file_device_snapshot ON chat.workspace_item_versions;
DROP FUNCTION chat.file_device_snapshot();

-- Members read the version columns they always could; where a device keeps a version is read through the file functions.
REVOKE SELECT ON chat.workspace_item_versions FROM authenticated;
GRANT SELECT (item_id, n, inline_text, content_type, size_bytes, made_by, made_at, blob_id) ON chat.workspace_item_versions TO authenticated;

-- A file's version has its record as it becomes current. Writers that bring new bytes (a replacement, a device
-- publication) record the version themselves before they move the file to it. A move or rename also makes a new version
-- (workspace_move_as) and keeps the bytes where they were: the new version is recorded with the same blob, or kept by the
-- same device at the same path. This runs before file_device_version_integrity, which requires that record.
CREATE FUNCTION chat.file_current_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d chat.workspace_item_versions%ROWTYPE;
BEGIN
    IF TG_OP = 'UPDATE' AND EXISTS(SELECT 1 FROM chat.workspace_item_versions WHERE item_id = NEW.id AND n = NEW.version) THEN
        RETURN NEW;
    END IF;
    IF NEW.blob_id IS NOT NULL THEN
        INSERT INTO chat.workspace_item_versions(item_id, n, blob_id, content_type, size_bytes, made_by, made_at)
        VALUES (NEW.id, NEW.version, NEW.blob_id, NEW.content_type, NEW.size_bytes, COALESCE(NEW.updated_by, NEW.created_by), now())
        ON CONFLICT (item_id, n) DO NOTHING;
    ELSIF TG_OP = 'UPDATE' AND OLD.blob_id IS NULL AND NEW.chat_id = OLD.chat_id
          AND NEW.size_bytes IS NOT DISTINCT FROM OLD.size_bytes AND NEW.content_type IS NOT DISTINCT FROM OLD.content_type THEN
        SELECT * INTO d FROM chat.workspace_item_versions WHERE item_id = OLD.id AND n = OLD.version AND host_project_id IS NOT NULL;
        IF FOUND THEN
            INSERT INTO chat.workspace_item_versions(item_id, n, content_type, size_bytes, made_by, made_at,
                file_name, sha256, host_device_id, host_project_id, relative_path)
            VALUES (NEW.id, NEW.version, d.content_type, d.size_bytes, NEW.updated_by, now(),
                NEW.filename, d.sha256, d.host_device_id, d.host_project_id, d.relative_path);
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE NEW END;
END $$;
DROP TRIGGER file_device_carry_revision ON chat.workspace_items;
DROP FUNCTION chat.file_device_carry_revision();
-- Named to sort before file_device_version_integrity among the BEFORE UPDATE triggers.
CREATE TRIGGER file_current_version BEFORE UPDATE OF version ON chat.workspace_items
    FOR EACH ROW WHEN (NEW.kind = 'file' AND NEW.version <> OLD.version) EXECUTE FUNCTION chat.file_current_version();
CREATE TRIGGER file_current_version_created AFTER INSERT ON chat.workspace_items
    FOR EACH ROW WHEN (NEW.kind = 'file' AND NEW.blob_id IS NOT NULL) EXECUTE FUNCTION chat.file_current_version();

DROP FUNCTION chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb,text);
DROP FUNCTION file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid);

CREATE FUNCTION file_private.publish_revision(p_item uuid, p_chat text, p_device text, p_project text, p_path text, p_sha text, p_size bigint, p_filename text, p_type text, p_expected integer DEFAULT NULL::integer, p_parent uuid DEFAULT NULL::uuid, p_width integer DEFAULT NULL::integer, p_height integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE g text:=chat.workspace_require_room_member(p_chat,chat.workspace_actor_for(auth.uid()::text));
    project text:=p_project; w chat.workspace_items%ROWTYPE; n integer;
BEGIN
    PERFORM 1 FROM identity.gugu_devices WHERE device_id=p_device AND user_id=auth.uid() FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'A local revision is published by the device that keeps it' USING HINT='file_transfer_denied'; END IF;
    IF (p_width IS NULL)<>(p_height IS NULL) THEN
        RAISE EXCEPTION 'An image size has both a width and a height' USING HINT='file_transfer_invalid';
    END IF;
    -- Clients released before this one name no project: the device's own project bound to the chat.
    IF project IS NULL THEN
        SELECT dp.local_project_id INTO project FROM identity.device_projects dp
         WHERE dp.device_id=p_device AND dp.chat_id=g AND dp.user_id=auth.uid()
         ORDER BY dp.group_representative DESC,dp.created_at,dp.local_project_id LIMIT 1;
    END IF;
    IF project IS NULL OR project<>'device-store' AND NOT EXISTS(SELECT 1 FROM identity.device_projects dp
        WHERE dp.device_id=p_device AND dp.local_project_id=project AND dp.chat_id=g AND dp.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'This device keeps no project for this chat' USING HINT='file_transfer_denied';
    END IF;
    SELECT * INTO w FROM chat.workspace_items WHERE id=p_item FOR UPDATE;
    IF FOUND THEN
        IF w.chat_id<>g OR w.kind<>'file' OR w.version IS DISTINCT FROM p_expected THEN
            RAISE EXCEPTION 'File revision conflict' USING HINT='file_transfer_conflict';
        END IF;
        n:=w.version+1;
    ELSE
        IF p_expected IS NOT NULL THEN RAISE EXCEPTION 'File revision conflict' USING HINT='file_transfer_conflict'; END IF;
        n:=1;
        INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,size_bytes,created_by,parent_id)
        VALUES(p_item,g,'file',p_filename,p_type,p_size,auth.uid()::text,p_parent) RETURNING filename INTO p_filename;
    END IF;
    INSERT INTO chat.workspace_item_versions(item_id,n,content_type,size_bytes,made_by,made_at,file_name,sha256,host_device_id,host_project_id,relative_path)
    VALUES(p_item,n,p_type,p_size,auth.uid()::text,now(),chat.workspace_stored_name(p_filename),p_sha,p_device,project,p_path);
    IF p_width IS NOT NULL THEN
        INSERT INTO chat.file_contents(sha256,width,height) VALUES(p_sha,p_width,p_height) ON CONFLICT (sha256) DO NOTHING;
    END IF;
    IF w.id IS NOT NULL THEN
        UPDATE chat.workspace_items SET version=n,blob_id=NULL,size_bytes=p_size,filename=p_filename,content_type=p_type,updated_by=auth.uid()::text WHERE id=w.id;
    END IF;
    RETURN jsonb_build_object('item_id',p_item,'version',n,'sha256',p_sha,'size_bytes',p_size,'envelope',chat.workspace_version_envelope(p_item,n));
END $function$;

CREATE FUNCTION chat.file_device_publish(p_item uuid, p_chat text, p_device text, p_path text, p_sha text, p_size bigint, p_filename text, p_type text, p_expected integer DEFAULT NULL::integer, p_parent uuid DEFAULT NULL::uuid, p_message jsonb DEFAULT NULL::jsonb, p_project text DEFAULT NULL::text, p_width integer DEFAULT NULL::integer, p_height integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE revision jsonb; message jsonb; sender text;
BEGIN
    IF p_message IS NOT NULL THEN
        IF jsonb_typeof(p_message) IS DISTINCT FROM 'object' OR COALESCE((p_message->>'is_whisper')::boolean,false) THEN
            RAISE EXCEPTION 'A local project publication cannot be a whisper' USING HINT='file_transfer_denied';
        END IF;
        sender:=COALESCE(NULLIF(p_message->>'sender_user_id',''),auth.uid()::text);
        IF NOT chat.can_act_as(sender,p_chat) THEN
            RAISE EXCEPTION 'A project file can be sent only as yourself or your own agent in this chat' USING ERRCODE='42501',HINT='file_transfer_denied';
        END IF;
    END IF;
    revision:=file_private.publish_revision(p_item,p_chat,p_device,p_project,p_path,p_sha,p_size,p_filename,p_type,p_expected,p_parent,p_width,p_height);
    IF p_message IS NOT NULL THEN
        SELECT to_jsonb(sent) INTO message FROM chat.send_message_idempotent(
            p_message->>'message_id',p_chat,sender,ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_message->'to_user_ids','[]'::jsonb))),
            (revision->>'envelope')||chat.attachment_caption_suffix(p_message->>'caption'),
            'attachment',p_message->>'reply_to_message_id',p_message->>'thread_root_id',COALESCE((p_message->>'is_thread_root')::boolean,false),
            false,p_message->>'via_app',p_item,(revision->>'version')::integer
        ) AS sent;
        PERFORM file_private.link_project_message(p_item,message->>'id');
    END IF;
    RETURN (revision-'envelope')||CASE WHEN message IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('message',message) END;
END $function$;

CREATE OR REPLACE FUNCTION chat.file_device_version_integrity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    IF auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM chat.workspace_item_versions
           WHERE item_id=OLD.id AND n=OLD.version AND host_project_id IS NOT NULL)
       AND NOT (NEW.blob_id IS NOT NULL AND NEW.version=OLD.version+1 AND NEW.chat_id=OLD.chat_id AND NEW.kind='file')
       AND NOT EXISTS(SELECT 1 FROM chat.workspace_item_versions d WHERE d.item_id=NEW.id AND d.n=NEW.version
           AND d.host_project_id IS NOT NULL AND (d.file_name,d.content_type,d.size_bytes)=(NEW.filename,NEW.content_type,NEW.size_bytes)
           AND NEW.blob_id IS NULL AND NEW.chat_id=OLD.chat_id AND NEW.kind='file') THEN
        RAISE EXCEPTION 'A local version changes only with its revision' USING HINT='file_transfer_invalid';
    END IF;
    RETURN NEW;
END $function$;

-- One version record, then where its bytes are. A blob's facts (type, size, sha256) still come from the blob as before.
CREATE OR REPLACE FUNCTION chat.file_resolve_as(p_ref jsonb, p_as text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE actor text:=chat.workspace_actor_for(p_as); msg text; w chat.workspace_items%ROWTYPE;
    d chat.workspace_item_versions%ROWTYPE; size chat.file_contents%ROWTYPE; holder identity.gugu_devices%ROWTYPE;
    c record; want integer; hint text; ref jsonb:=p_ref;
BEGIN
    IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR NOT (
        (ref ? 'item_id' AND ref-'item_id'-'version'='{}' AND jsonb_typeof(ref->'item_id')='string'
            AND (NOT (ref ? 'version') OR (jsonb_typeof(ref->'version')='number' AND ref->>'version' ~ '^[1-9][0-9]{0,8}$')))
        OR (ref ? 'message_id' AND ref-'message_id'='{}' AND jsonb_typeof(ref->'message_id')='string')
        OR (ref ? 'attachment_id' AND ref-'attachment_id'='{}' AND jsonb_typeof(ref->'attachment_id')='string')) THEN
        RAISE EXCEPTION 'Invalid file reference' USING HINT='file_transfer_invalid';
    END IF;
    IF ref ? 'message_id' THEN
        msg:=ref->>'message_id';
        IF NOT chat.can_read_message(msg,actor) THEN RETURN jsonb_build_object('status','gone'); END IF;
        SELECT file_item_id,file_version INTO w.id,want FROM chat.messages WHERE id=msg AND retracted_at IS NULL;
        IF w.id IS NOT NULL THEN ref:=jsonb_build_object('item_id',w.id,'version',want); END IF;
    END IF;
    IF ref ? 'item_id' THEN
        -- Same membership and room checks as all workspace readers; hidden messages were checked above.
        BEGIN w:=chat.workspace_item_for(ref->>'item_id',actor,false);
        EXCEPTION WHEN raise_exception THEN
            GET STACKED DIAGNOSTICS hint=PG_EXCEPTION_HINT;
            IF hint='workspace_item_not_found' THEN RETURN jsonb_build_object('status','gone'); END IF;
            RAISE;
        END;
        want:=COALESCE((ref->>'version')::integer,w.version);
        SELECT * INTO d FROM chat.workspace_item_versions v WHERE v.item_id=w.id AND v.n=want AND v.host_project_id IS NOT NULL;
        IF FOUND THEN
            -- Gone with its device, or with its project's binding to this chat (a device store needs none).
            SELECT * INTO holder FROM identity.gugu_devices WHERE device_id=d.host_device_id;
            IF NOT FOUND OR d.host_project_id<>'device-store' AND NOT EXISTS(SELECT 1 FROM identity.device_projects dp
                WHERE dp.device_id=d.host_device_id AND dp.local_project_id=d.host_project_id AND dp.chat_id=w.chat_id) THEN
                RETURN jsonb_build_object('status','gone');
            END IF;
            SELECT * INTO size FROM chat.file_contents WHERE sha256=d.sha256;
            RETURN jsonb_build_object('status','ready','source','local','item_id',w.id,'version',want,'current_version',w.version,
                'chat_id',w.chat_id,'message_id',msg,'file_name',d.file_name,'content_type',d.content_type,
                'sha256',d.sha256,'size_bytes',d.size_bytes,'width',size.width,'height',size.height,
                'host_device_id',d.host_device_id,'host_project_id',d.host_project_id,
                'host_account_id',holder.user_id,'host_label',holder.label,'host_online',holder.status='online',
                'relative_path',d.relative_path,'temporary_transfer',(chat.file_storage_of(holder.user_id::text)->>'temporary_transfer')::boolean);
        END IF;
    END IF;
    IF ref ? 'attachment_id' THEN
        SELECT * INTO c FROM chat.session_attachment_urls_as(ARRAY[(ref->>'attachment_id')::uuid],actor) LIMIT 1;
    ELSE SELECT * INTO c FROM chat.file_urls_as(jsonb_build_array(ref),actor) LIMIT 1;
    END IF;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','gone'); END IF;
    DECLARE resolved jsonb;
    BEGIN
    resolved:=to_jsonb(c)||jsonb_build_object('source','managed-object','message_id',COALESCE(to_jsonb(c)->>'message_id',msg),
        'status',CASE WHEN EXISTS(SELECT 1 FROM chat.file_transfer_storage o JOIN chat.file_transfer_storage_refs r ON r.storage_id=o.id
            WHERE o.bucket_id=c.bucket_id AND o.object_name=c.object_name AND r.chat_id=chat.file_transfer_group(to_jsonb(c)->>'chat_id')
              AND r.expired_at IS NOT NULL) THEN 'expired' ELSE 'ready' END);
    IF resolved->>'status'='ready' AND EXISTS(SELECT 1 FROM chat.file_transfer_storage o
        WHERE o.bucket_id=c.bucket_id AND o.object_name=c.object_name AND o.state='gone') THEN
        RETURN jsonb_build_object('status','missing','code','object_not_found','sha256',c.sha256);
    END IF;
    RETURN resolved;
    END;
END $function$;

CREATE OR REPLACE FUNCTION chat.workspace_version_envelope(p_item_id uuid, p_n integer)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT chat.attachment_envelope(COALESCE(d.file_name,w.filename),COALESCE(d.size_bytes,b.size_bytes,w.size_bytes),
        COALESCE(d.content_type,b.content_type)) FROM chat.workspace_items w
        LEFT JOIN chat.file_blobs b ON b.id=chat.workspace_version_blob(p_item_id,p_n)
        LEFT JOIN chat.workspace_item_versions d ON d.item_id=w.id AND d.n=p_n AND d.host_project_id IS NOT NULL
        WHERE w.id=p_item_id AND (b.id IS NOT NULL OR d.item_id IS NOT NULL)
$function$;

-- Readers that found a device's version in chat.file_device_revisions find it in the version record; pixel sizes come
-- from chat.file_contents.
DO $upgrade$
DECLARE r record; definition text;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('chat.file_urls_as(jsonb,text)',
         $old$b.content_type, b.width, b.height$old$,
         $new$b.content_type, size.width, size.height$new$),
        ('chat.file_urls_as(jsonb,text)',
         $old$JOIN chat.file_blobs b ON b.id = chat.workspace_version_blob(w.id, COALESCE(a.ref_version, w.version))$old$,
         $new$JOIN chat.file_blobs b ON b.id = chat.workspace_version_blob(w.id, COALESCE(a.ref_version, w.version))
      LEFT JOIN chat.file_contents size ON size.sha256 = b.sha256$new$),
        ('chat.file_urls_as(jsonb,text)',
         $old$JOIN chat.file_blobs b ON b.id = m.file_blob_id$old$,
         $new$JOIN chat.file_blobs b ON b.id = m.file_blob_id
      LEFT JOIN chat.file_contents size ON size.sha256 = b.sha256$new$),
        ('chat.session_attachment_urls_as(uuid[],text)',
         $old$b.content_type,b.width,b.height$old$,
         $new$b.content_type,size.width,size.height$new$),
        ('chat.session_attachment_urls_as(uuid[],text)',
         $old$JOIN chat.file_blobs b ON b.id=a.blob_id$old$,
         $new$JOIN chat.file_blobs b ON b.id=a.blob_id LEFT JOIN chat.file_contents size ON size.sha256=b.sha256$new$),
        ('chat.file_blob_register(text,text,text,bigint,text,integer,integer)',
         $old$(bucket_id, object_name, sha256, size_bytes, content_type, width, height, created_by)$old$,
         $new$(bucket_id, object_name, sha256, size_bytes, content_type, created_by)$new$),
        ('chat.file_blob_register(text,text,text,bigint,text,integer,integer)',
         $old$'application/octet-stream'), p_width, p_height, p_uploader)$old$,
         $new$'application/octet-stream'), p_uploader)$new$),
        ('chat.file_blob_register(text,text,text,bigint,text,integer,integer)',
         $old$    INSERT INTO chat.file_blob_uploads (staging_key, uploader, blob_id)$old$,
         $new$    -- The server measured these bytes: its size replaces one a publishing device reported.
    IF p_width IS NOT NULL AND p_height IS NOT NULL THEN
        INSERT INTO chat.file_contents(sha256, width, height) VALUES (v_sha, p_width, p_height)
        ON CONFLICT (sha256) DO UPDATE SET width = EXCLUDED.width, height = EXCLUDED.height;
    END IF;
    INSERT INTO chat.file_blob_uploads (staging_key, uploader, blob_id)$new$),
        ('chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean)',
         $old$SELECT d.host_device_id FROM chat.file_device_revisions d
         WHERE d.item_id = w.id AND d.version = w.version LIMIT 1$old$,
         $new$SELECT d.host_device_id FROM chat.workspace_item_versions d
         WHERE d.item_id = w.id AND d.n = w.version AND d.host_project_id IS NOT NULL$new$),
        ('chat.file_temporary_pending(text)',
         $old$JOIN chat.file_device_revisions d ON d.item_id=t.item_id AND d.version=t.version$old$,
         $new$JOIN chat.workspace_item_versions d ON d.item_id=t.item_id AND d.n=t.version$new$),
        ('chat.file_storage_overview_as()',
         $old$FROM chat.file_device_revisions r JOIN chat.workspace_items w ON w.id=r.item_id AND w.version=r.version$old$,
         $new$FROM chat.workspace_item_versions r JOIN chat.workspace_items w ON w.id=r.item_id AND w.version=r.n$new$),
        ('file_private.link_project_message(uuid,text)',
         $old$JOIN chat.file_device_revisions r ON r.item_id=w.id AND r.version=m.file_version$old$,
         $new$JOIN chat.workspace_item_versions r ON r.item_id=w.id AND r.n=m.file_version$new$),
        ('chat.attachment_place_share(uuid,integer,text,text,text)',
         $old$SELECT 1 FROM chat.file_device_revisions d WHERE d.item_id = v_item.id AND d.version = v_version$old$,
         $new$SELECT 1 FROM chat.workspace_item_versions d WHERE d.item_id = v_item.id AND d.n = v_version AND d.host_project_id IS NOT NULL$new$),
        ('chat.set_workspace_item_updated_at()',
         $old$SELECT 1 FROM chat.file_device_revisions n JOIN chat.file_device_revisions o
               ON o.item_id=OLD.id AND o.version=OLD.version AND o.sha256=n.sha256
               WHERE n.item_id=NEW.id AND n.version=NEW.version$old$,
         $new$SELECT 1 FROM chat.workspace_item_versions n JOIN chat.workspace_item_versions o
               ON o.item_id=OLD.id AND o.n=OLD.version AND o.sha256=n.sha256
               WHERE n.item_id=NEW.id AND n.n=NEW.version$new$)
    ) AS patches(signature, before_text, after_text)
    UNION ALL
    SELECT s, $old$VALUES (v_item.id, v_item.version, v_item.blob_id, v_item.content_type, v_item.size_bytes, v_item.created_by, v_item.updated_at)$old$,
        $new$SELECT v_item.id, v_item.version, v_item.blob_id, v_item.content_type, v_item.size_bytes, v_item.created_by, v_item.updated_at
     WHERE NOT EXISTS(SELECT 1 FROM chat.workspace_item_versions x WHERE x.item_id = v_item.id AND x.n = v_item.version)$new$
      FROM unnest(ARRAY['chat.file_replace_as(text,text,text,integer)', 'chat.workspace_replace_file_as(text,text,text,bigint,text,integer)',
                        'chat.messages_file_ref()']) AS s
    LOOP
        SELECT pg_get_functiondef(r.signature::regprocedure) INTO definition;
        IF position(r.before_text IN definition)=0 THEN RAISE EXCEPTION 'Unexpected predecessor: %', r.signature; END IF;
        EXECUTE replace(definition, r.before_text, r.after_text);
    END LOOP;
END $upgrade$;

DROP TABLE chat.file_device_revisions;
ALTER TABLE chat.file_blobs DROP COLUMN width, DROP COLUMN height;

REVOKE ALL ON FUNCTION chat.file_current_version(), chat.file_device_version_integrity(),
    chat.set_workspace_item_updated_at(), chat.workspace_version_envelope(uuid,integer),
    chat.file_blob_register(text,text,text,bigint,text,integer,integer),
    file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid,integer,integer),
    chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb,text,integer,integer),
    chat.file_resolve_as(jsonb,text), chat.file_urls_as(jsonb,text), chat.session_attachment_urls_as(uuid[],text),
    chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean), chat.file_temporary_pending(text),
    chat.file_storage_overview_as(), file_private.link_project_message(uuid,text),
    chat.attachment_place_share(uuid,integer,text,text,text), chat.messages_file_ref(),
    chat.file_replace_as(text,text,text,integer), chat.workspace_replace_file_as(text,text,text,bigint,text,integer)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.file_device_version_integrity(),
    chat.workspace_version_envelope(uuid,integer), chat.file_blob_register(text,text,text,bigint,text,integer,integer),
    chat.session_attachment_urls_as(uuid[],text)
    TO service_role;
GRANT EXECUTE ON FUNCTION
    file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid,integer,integer),
    chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb,text,integer,integer),
    chat.file_resolve_as(jsonb,text), chat.file_urls_as(jsonb,text), chat.session_attachment_urls_as(uuid[],text),
    chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean), chat.file_temporary_pending(text),
    chat.file_storage_overview_as(), file_private.link_project_message(uuid,text),
    chat.attachment_place_share(uuid,integer,text,text,text),
    chat.file_replace_as(text,text,text,integer), chat.workspace_replace_file_as(text,text,text,bigint,text,integer)
    TO authenticated;
