-- Roll back 20261109150000_one_file_version_record: device versions return to chat.file_device_revisions, image sizes
-- to chat.file_blobs, and every changed function to its previous definition. Version rows the release added (current
-- versions, versions a move superseded) stay: they are true versions in the old shape too. Image sizes that only a
-- device reported (no blob has those bytes) are lost. Run on the release's own schema only.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE chat.workspace_items, chat.workspace_item_versions, chat.file_blobs, chat.file_temporary_transfers IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER file_current_version ON chat.workspace_items;
DROP TRIGGER file_current_version_created ON chat.workspace_items;
DROP FUNCTION chat.file_current_version();

-- The release retired the old table; its rows stopped at the release. It still holds the old index and key names.
DROP TABLE IF EXISTS chat.file_device_revisions_retired;
CREATE TABLE chat.file_device_revisions (
    item_id uuid NOT NULL REFERENCES chat.workspace_items(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version > 0),
    host_device_id text REFERENCES identity.gugu_devices(device_id) ON DELETE SET NULL,
    host_project_id text NOT NULL,
    relative_path text NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 4096
        AND relative_path !~ '(^/|//|/$|:|\\|[[:cntrl:]]|(^|/)\.\.?(/|$))'),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    file_name text NOT NULL CHECK (file_name <> ''),
    content_type text NOT NULL CHECK (content_type <> ''),
    PRIMARY KEY (item_id, version)
);
ALTER TABLE chat.file_device_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.file_device_revisions FROM PUBLIC, anon, authenticated;
GRANT ALL ON chat.file_device_revisions TO service_role;
INSERT INTO chat.file_device_revisions(item_id,version,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type)
SELECT item_id,n,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type
  FROM chat.workspace_item_versions WHERE host_project_id IS NOT NULL;

ALTER TABLE chat.file_blobs ADD COLUMN width integer CHECK (width > 0), ADD COLUMN height integer CHECK (height > 0);
UPDATE chat.file_blobs b SET width = c.width, height = c.height FROM chat.file_contents c WHERE c.sha256 = b.sha256;

ALTER TABLE chat.file_temporary_transfers DROP CONSTRAINT file_temporary_transfers_item_id_version_fkey;
ALTER TABLE chat.file_temporary_transfers ADD CONSTRAINT file_temporary_transfers_item_id_version_fkey
    FOREIGN KEY (item_id, version) REFERENCES chat.file_device_revisions(item_id, version) ON DELETE CASCADE;

ALTER TABLE chat.workspace_item_versions DROP CONSTRAINT workspace_item_versions_one_body;
ALTER TABLE chat.workspace_item_versions ADD COLUMN device_version integer;
UPDATE chat.workspace_item_versions SET device_version = n WHERE host_project_id IS NOT NULL;
ALTER TABLE chat.workspace_item_versions ADD CONSTRAINT workspace_item_versions_item_id_device_version_fkey
    FOREIGN KEY (item_id, device_version) REFERENCES chat.file_device_revisions(item_id, version) ON DELETE CASCADE;
DROP INDEX chat.workspace_item_versions_host_device_idx;
ALTER TABLE chat.workspace_item_versions DROP COLUMN file_name, DROP COLUMN sha256, DROP COLUMN host_device_id,
    DROP COLUMN host_project_id, DROP COLUMN relative_path;
ALTER TABLE chat.workspace_item_versions ADD CONSTRAINT workspace_item_versions_one_body CHECK (
    device_version IS NULL AND num_nonnulls(inline_text, blob_id) >= 1
    OR device_version IS NOT NULL AND device_version = n AND inline_text IS NULL AND blob_id IS NULL);
REVOKE SELECT ON chat.workspace_item_versions FROM authenticated;
GRANT SELECT ON chat.workspace_item_versions TO authenticated;

DROP FUNCTION chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb,text,integer,integer);
DROP FUNCTION file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid,integer,integer);

-- Previous definitions, as the parent schema had them in effect.
CREATE OR REPLACE FUNCTION file_private.publish_revision(p_item uuid, p_chat text, p_device text, p_project text, p_path text, p_sha text, p_size bigint, p_filename text, p_type text, p_expected integer DEFAULT NULL::integer, p_parent uuid DEFAULT NULL::uuid)
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
        INSERT INTO chat.workspace_item_versions(item_id,n,blob_id,content_type,size_bytes,made_by,made_at)
        VALUES(w.id,w.version,w.blob_id,w.content_type,w.size_bytes,w.created_by,w.updated_at) ON CONFLICT DO NOTHING;
        n:=w.version+1;
    ELSE
        IF p_expected IS NOT NULL THEN RAISE EXCEPTION 'File revision conflict' USING HINT='file_transfer_conflict'; END IF;
        n:=1;
        INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,size_bytes,created_by,parent_id)
        VALUES(p_item,g,'file',p_filename,p_type,p_size,auth.uid()::text,p_parent) RETURNING filename INTO p_filename;
    END IF;
    INSERT INTO chat.file_device_revisions(item_id,version,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type)
    VALUES(p_item,n,p_device,project,p_path,p_sha,p_size,chat.workspace_stored_name(p_filename),p_type);
    IF w.id IS NOT NULL THEN
        UPDATE chat.workspace_items SET version=n,blob_id=NULL,size_bytes=p_size,filename=p_filename,content_type=p_type,updated_by=auth.uid()::text WHERE id=w.id;
    END IF;
    RETURN jsonb_build_object('item_id',p_item,'version',n,'sha256',p_sha,'size_bytes',p_size,'envelope',chat.workspace_version_envelope(p_item,n));
END $function$;

CREATE OR REPLACE FUNCTION chat.file_device_publish(p_item uuid, p_chat text, p_device text, p_path text, p_sha text, p_size bigint, p_filename text, p_type text, p_expected integer DEFAULT NULL::integer, p_parent uuid DEFAULT NULL::uuid, p_message jsonb DEFAULT NULL::jsonb, p_project text DEFAULT NULL::text)
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
    revision:=file_private.publish_revision(p_item,p_chat,p_device,p_project,p_path,p_sha,p_size,p_filename,p_type,p_expected,p_parent);
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

CREATE OR REPLACE FUNCTION chat.file_resolve_as(p_ref jsonb, p_as text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE actor text:=chat.workspace_actor_for(p_as); msg text; w chat.workspace_items%ROWTYPE;
    d chat.file_device_revisions%ROWTYPE; holder identity.gugu_devices%ROWTYPE; c record; n integer; hint text; ref jsonb:=p_ref;
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
        SELECT file_item_id,file_version INTO w.id,n FROM chat.messages WHERE id=msg AND retracted_at IS NULL;
        IF w.id IS NOT NULL THEN ref:=jsonb_build_object('item_id',w.id,'version',n); END IF;
    END IF;
    IF ref ? 'item_id' THEN
        -- Same membership and room checks as all workspace readers; hidden messages were checked above.
        BEGIN w:=chat.workspace_item_for(ref->>'item_id',actor,false);
        EXCEPTION WHEN raise_exception THEN
            GET STACKED DIAGNOSTICS hint=PG_EXCEPTION_HINT;
            IF hint='workspace_item_not_found' THEN RETURN jsonb_build_object('status','gone'); END IF;
            RAISE;
        END;
        n:=COALESCE((ref->>'version')::integer,w.version);
        SELECT * INTO d FROM chat.file_device_revisions WHERE item_id=w.id AND version=n;
        IF FOUND THEN
            -- Gone with its device, or with its project's binding to this chat (a device store needs none).
            SELECT * INTO holder FROM identity.gugu_devices WHERE device_id=d.host_device_id;
            IF NOT FOUND OR d.host_project_id<>'device-store' AND NOT EXISTS(SELECT 1 FROM identity.device_projects dp
                WHERE dp.device_id=d.host_device_id AND dp.local_project_id=d.host_project_id AND dp.chat_id=w.chat_id) THEN
                RETURN jsonb_build_object('status','gone');
            END IF;
            RETURN jsonb_build_object('status','ready','source','local','item_id',w.id,'version',n,'current_version',w.version,
                'chat_id',w.chat_id,'message_id',msg,'file_name',d.file_name,'content_type',d.content_type,
                'sha256',d.sha256,'size_bytes',d.size_bytes,'host_device_id',d.host_device_id,'host_project_id',d.host_project_id,
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

CREATE OR REPLACE FUNCTION chat.file_urls_as(p_refs jsonb, p_as_user_id text)
 RETURNS TABLE(item_id uuid, version integer, message_id text, current_version integer, chat_id text, file_name text, bucket_id text, object_name text, sha256 text, size_bytes bigint, content_type text, width integer, height integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_messages TEXT[];
BEGIN
    IF jsonb_typeof(p_refs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_refs) > 200 THEN
        RAISE EXCEPTION 'file_urls_as: refs is an array of at most 200 {item_id, version} or {message_id}';
    END IF;
    SELECT array_agg(DISTINCT r.value ->> 'message_id') INTO v_messages
      FROM jsonb_array_elements(p_refs) AS r(value)
     WHERE r.value ->> 'message_id' IS NOT NULL
       AND chat.can_read_message(r.value ->> 'message_id', v_actor);
    RETURN QUERY
    WITH asked AS (
        SELECT CASE WHEN r.value ->> 'item_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN (r.value ->> 'item_id')::uuid END AS ref_item,
               CASE WHEN r.value ->> 'version' ~ '^[0-9]{1,9}$' THEN (r.value ->> 'version')::INTEGER END AS ref_version
          FROM jsonb_array_elements(p_refs) AS r(value)
    ), picked AS MATERIALIZED (
        -- Only the primary key can serve this filter, so the lookup stays bounded by the refs.
        SELECT m.id, m.chat_id, m.content, m.content_type, m.file_item_id, m.file_blob_id,
               m.storage_bucket_id, m.storage_object_name
          FROM chat.messages m
         WHERE m.id = ANY(v_messages) AND m.retracted_at IS NULL
    )
    SELECT DISTINCT w.id, COALESCE(a.ref_version, w.version), NULL::TEXT, w.version, w.chat_id, w.filename, b.bucket_id,
           b.object_name, b.sha256, b.size_bytes, b.content_type, b.width, b.height
      FROM asked a
      JOIN chat.workspace_items w ON w.id = a.ref_item
      JOIN chat.chats c ON c.id = w.chat_id AND c.kind IN ('group', 'topic', 'dm', 'ai')
      JOIN chat.file_blobs b ON b.id = chat.workspace_version_blob(w.id, COALESCE(a.ref_version, w.version))
     WHERE chat.is_chat_member(w.chat_id, v_actor)
    UNION
    SELECT NULL::UUID, NULL::INTEGER, m.id, NULL::INTEGER, m.chat_id,
           chat.attachment_envelope_name(m.content, b.size_bytes, b.content_type), b.bucket_id,
           b.object_name, b.sha256, b.size_bytes, b.content_type, b.width, b.height
      FROM picked m
      JOIN chat.file_blobs b ON b.id = m.file_blob_id
    -- Legacy cards: the bytes are the chat-media object named by the storage columns; size and type come from it.
    UNION
    SELECT NULL::UUID, NULL::INTEGER, m.id, NULL::INTEGER, m.chat_id, chat.legacy_attachment_name(m.content),
           m.storage_bucket_id, m.storage_object_name, NULL::TEXT, NULLIF(o.metadata ->> 'size', '')::BIGINT,
           COALESCE(NULLIF(o.metadata ->> 'mimetype', ''), 'application/octet-stream'), NULL::INTEGER, NULL::INTEGER
      FROM picked m
      JOIN storage.objects o ON o.bucket_id = m.storage_bucket_id AND o.name = m.storage_object_name
     WHERE m.content_type = 'attachment' AND m.file_item_id IS NULL AND m.file_blob_id IS NULL
       AND m.storage_bucket_id = 'chat-media';
END;
$function$;

CREATE OR REPLACE FUNCTION chat.session_attachment_urls_as(p_ids uuid[], p_as_user_id text)
 RETURNS TABLE(attachment_id uuid, file_name text, bucket_id text, object_name text, sha256 text, size_bytes bigint, content_type text, width integer, height integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_actor text := chat.workspace_actor_for(p_as_user_id);
BEGIN
    IF COALESCE(cardinality(p_ids),0) NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'expected 1 to 32 attachment ids'; END IF;
    RETURN QUERY SELECT a.id,a.file_name,b.bucket_id,b.object_name,b.sha256,b.size_bytes,b.content_type,b.width,b.height
      FROM chat.session_attachments a JOIN chat.file_blobs b ON b.id=a.blob_id
     WHERE a.id=ANY(p_ids) AND a.owner_user_id=auth.uid()::text AND a.revoked_at IS NULL AND b.state='live'
       AND (v_actor=a.owner_user_id OR v_actor=a.sender_user_id OR v_actor=ANY(a.recipient_user_ids));
END;
$function$;

CREATE OR REPLACE FUNCTION chat.file_blob_register(p_uploader text, p_staging_key text, p_sha256 text, p_size_bytes bigint, p_content_type text, p_width integer DEFAULT NULL::integer, p_height integer DEFAULT NULL::integer)
 RETURNS TABLE(blob_id uuid, object_name text, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_sha TEXT := lower(btrim(COALESCE(p_sha256, '')));
    v_blob chat.file_blobs%ROWTYPE;
    v_created BOOLEAN := false;
    v_upload chat.file_blob_uploads%ROWTYPE;
BEGIN
    IF v_sha !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'file_blob_register: sha256 must be 64 hex digits';
    END IF;
    IF p_size_bytes IS NULL OR p_size_bytes < 1 THEN
        RAISE EXCEPTION USING HINT = 'file_too_large', MESSAGE = format('file_blob_register: size must be at least 1 byte, got %s', p_size_bytes);
    END IF;
    SELECT * INTO v_upload FROM chat.file_blob_uploads u WHERE u.staging_key = p_staging_key;
    IF FOUND THEN
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = v_upload.blob_id;
        IF v_upload.uploader IS DISTINCT FROM p_uploader OR v_blob.sha256 IS DISTINCT FROM v_sha THEN
            RAISE EXCEPTION 'file_blob_register: % is already registered for other content', p_staging_key;
        END IF;
        RETURN QUERY SELECT v_blob.id, v_blob.object_name, false;
        RETURN;
    END IF;

    INSERT INTO chat.file_blobs AS b (bucket_id, object_name, sha256, size_bytes, content_type, width, height, created_by)
    VALUES ('oss', substr(v_sha, 1, 2) || '/' || v_sha, v_sha, p_size_bytes,
            COALESCE(NULLIF(btrim(COALESCE(p_content_type, '')), ''), 'application/octet-stream'), p_width, p_height, p_uploader)
    ON CONFLICT (sha256) DO NOTHING
    RETURNING b.* INTO v_blob;
    v_created := FOUND;
    IF NOT v_created THEN
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.sha256 = v_sha;
        IF v_blob.size_bytes IS DISTINCT FROM p_size_bytes THEN
            RAISE EXCEPTION 'file_blob_register: sha256 % is stored with % bytes, not %', v_sha, v_blob.size_bytes, p_size_bytes;
        END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM chat.file_transfer_storage o WHERE o.blob_id=v_blob.id AND o.state='gone') THEN
        -- Copy precedes registration; keep the old identity and verify the post-GC copy.
        v_created:=true;
    ELSE
        PERFORM chat.file_blob_take(v_blob.id);
    END IF;

    INSERT INTO chat.file_blob_uploads (staging_key, uploader, blob_id) VALUES (p_staging_key, p_uploader, v_blob.id);
    RETURN QUERY SELECT v_blob.id, v_blob.object_name, v_created;
END;
$function$;

CREATE OR REPLACE FUNCTION chat.workspace_version_envelope(p_item_id uuid, p_n integer)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT chat.attachment_envelope(COALESCE(d.file_name,w.filename),COALESCE(d.size_bytes,b.size_bytes,w.size_bytes),
        COALESCE(d.content_type,b.content_type)) FROM chat.workspace_items w
        LEFT JOIN chat.file_blobs b ON b.id=chat.workspace_version_blob(p_item_id,p_n)
        LEFT JOIN chat.file_device_revisions d ON d.item_id=w.id AND d.version=p_n
        WHERE w.id=p_item_id AND (b.id IS NOT NULL OR d.item_id IS NOT NULL)
$function$;

CREATE OR REPLACE FUNCTION chat.workspace_list_as(p_chat_id text, p_as_user_id text, p_offset integer DEFAULT 0, p_limit integer DEFAULT NULL::integer, p_name text DEFAULT NULL::text, p_kind text DEFAULT NULL::text, p_folder text DEFAULT NULL::text, p_exact boolean DEFAULT false)
 RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, total bigint, parent_id uuid, system_role text, path text, updated_by text, metadata jsonb, expires_at timestamp with time zone, is_mine boolean, storage_class text, copy_expired_at timestamp with time zone, copy_account_id text, host_device_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_name TEXT := NULLIF(btrim(COALESCE(p_name, '')), '');
    v_exact BOOLEAN := COALESCE(p_exact, false);
    v_key TEXT := lower(chat.workspace_stored_name(p_name));
    v_offset INTEGER := COALESCE(p_offset, 0);
    v_all BOOLEAN := p_folder IS NULL;
    v_parent UUID; v_transfer_group TEXT; v_transfer_account TEXT;
    v_base TEXT; v_depth INTEGER := 0;
BEGIN
    IF v_offset < 0 OR p_limit < 0 THEN
        RAISE EXCEPTION 'workspace_list: offset and limit must not be negative';
    END IF;
    IF p_kind IS NOT NULL AND p_kind NOT IN ('document', 'file', 'folder') THEN
        RAISE EXCEPTION 'workspace_list: kind must be document, file or folder, got %', p_kind;
    END IF;
    p_chat_id := chat.workspace_require_room_member(p_chat_id, v_actor);
    IF NOT v_all THEN
        v_parent := chat.workspace_folder_for(p_chat_id, p_folder, v_actor, false);
    END IF;
    -- The folder's own path and depth. A folder 64 deep or more lists nothing, as the walk from the top stops there.
    IF v_parent IS NOT NULL THEN
        WITH RECURSIVE up AS (
            SELECT a.parent_id, a.filename::TEXT AS name, 1 AS depth FROM chat.workspace_items a WHERE a.id = v_parent
            UNION ALL
            SELECT a.parent_id, a.filename, u.depth + 1 FROM chat.workspace_items a JOIN up u ON a.id = u.parent_id WHERE u.depth < 64
        )
        SELECT string_agg(u.name, '/' ORDER BY u.depth DESC), max(u.depth) INTO v_base, v_depth FROM up u;
    END IF;
    v_transfer_group := chat.file_transfer_group(p_chat_id);
    v_transfer_account := chat.file_transfer_account(v_actor);
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT r.id AS item_id, concat_ws('/', v_base, r.filename) AS item_path, v_depth + 1 AS depth
          FROM chat.workspace_items r
         WHERE r.chat_id = p_chat_id AND v_depth < 64
           AND (r.parent_id = v_parent OR (v_parent IS NULL AND r.parent_id IS NULL))
        UNION ALL
        SELECT c.id, t.item_path || '/' || c.filename, t.depth + 1
          FROM chat.workspace_items c
          JOIN tree t ON c.parent_id = t.item_id
         WHERE v_all AND t.depth < 64
    ), page AS (
        SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, w.blob_id, w.source_message_ids,
               w.created_by, w.version, w.created_at, w.updated_at, count(*) OVER () AS total, w.parent_id, w.system_role,
               t.item_path, w.updated_by, w.metadata
          FROM chat.workspace_items w
          JOIN tree t ON t.item_id = w.id
         WHERE w.chat_id = p_chat_id
           AND (p_kind IS NULL OR w.kind = p_kind)
           AND (v_name IS NULL
                OR (v_exact AND w.name_key = v_key)
                OR (NOT v_exact AND w.filename ILIKE '%' || replace(replace(replace(v_name, '\', '\\'), '%', '\%'), '_', '\_') || '%'))
         ORDER BY w.created_at DESC, w.id DESC
        OFFSET v_offset
         LIMIT p_limit
    )
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at,
           w.total, w.parent_id, w.system_role, w.item_path, w.updated_by, w.metadata, copy.expires_at, copy.account_id = v_transfer_account,
           CASE WHEN ref.found AND ref.expired_at IS NULL THEN CASE WHEN ref.content_type LIKE 'image/%' THEN 'image'
               WHEN ref.expires_at IS NOT NULL THEN 'temporary' ELSE 'kept' END END,
           ref.expired_at, ref.account_id, dev.host_device_id
      FROM page w
      LEFT JOIN LATERAL (SELECT r.expires_at, r.account_id FROM chat.file_transfer_storage o
          JOIN chat.file_transfer_storage_refs r ON r.storage_id = o.id
         WHERE o.blob_id = w.blob_id AND r.chat_id = v_transfer_group AND r.expired_at IS NULL ORDER BY o.id LIMIT 1) copy ON true
      -- The live copy if there is one, else the latest reclaimed one.
      LEFT JOIN LATERAL (SELECT true AS found, r.expires_at, r.expired_at, r.account_id, b.content_type FROM chat.file_transfer_storage o
          JOIN chat.file_transfer_storage_refs r ON r.storage_id = o.id JOIN chat.file_blobs b ON b.id = o.blob_id
         WHERE o.blob_id = w.blob_id AND r.chat_id = v_transfer_group
         ORDER BY r.expired_at IS NOT NULL, r.expired_at DESC, o.id LIMIT 1) ref ON true
      LEFT JOIN LATERAL (SELECT d.host_device_id FROM chat.file_device_revisions d
         WHERE d.item_id = w.id AND d.version = w.version LIMIT 1) dev ON true
     ORDER BY w.created_at DESC, w.id DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION chat.file_temporary_pending(p_device text)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM identity.gugu_devices WHERE device_id=p_device AND user_id=auth.uid()) THEN
        RAISE EXCEPTION 'Device is not owned by the caller' USING HINT='file_transfer_denied';
    END IF;
    RETURN QUERY SELECT to_jsonb(t)-'data_key'||jsonb_build_object('relative_path',d.relative_path,'sha256',d.sha256,'size_bytes',d.size_bytes)
        FROM chat.file_temporary_transfers t JOIN chat.file_device_revisions d ON d.item_id=t.item_id AND d.version=t.version
        WHERE t.host_device_id=p_device AND t.state IN ('requested','uploading') ORDER BY t.created_at LIMIT 200;
END $function$;

CREATE OR REPLACE FUNCTION chat.file_storage_overview_as()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE me text:=auth.uid()::text; result jsonb;
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING HINT='file_transfer_denied'; END IF;
    WITH mine AS (
        SELECT ref.storage_id,ref.chat_id,ref.expires_at,o.size_bytes,o.blob_id,
            CASE WHEN b.content_type LIKE 'image/%' THEN 'image' WHEN ref.expires_at IS NOT NULL THEN 'temporary' ELSE 'kept' END AS class
        FROM chat.file_transfer_storage_refs ref JOIN chat.file_transfer_storage o ON o.id=ref.storage_id JOIN chat.file_blobs b ON b.id=o.blob_id
        WHERE ref.account_id=me AND ref.expired_at IS NULL AND o.state='ready'
    ), devices AS (SELECT device_id,label FROM identity.gugu_devices WHERE user_id::text=me)
    SELECT jsonb_build_object(
        'total_bytes',COALESCE((SELECT sum(size_bytes) FROM (SELECT DISTINCT ON (storage_id) storage_id,size_bytes FROM mine) d),0),
        'count',(SELECT count(*) FROM mine),
        'expiring_7d_bytes',COALESCE((SELECT sum(size_bytes) FROM mine WHERE expires_at<=now()+interval '7 days'),0),
        -- The idle-expiry policy chat.file_transfer_expire applies (larger than large_file_bytes, unopened for
        -- large_file_idle_seconds, project chats exempt); null when the deployment sets no such policy.
        'expiry',(SELECT CASE WHEN l.settings ?& ARRAY['large_file_bytes','large_file_idle_seconds'] THEN jsonb_build_object(
            'large_file_bytes',chat.file_transfer_parameter(l.settings,'large_file_bytes'),
            'idle_seconds',chat.file_transfer_parameter(l.settings,'large_file_idle_seconds')) END
            FROM chat.file_transfer_limits l WHERE l.scope='global' AND l.scope_id='*'),
        'classes',(SELECT jsonb_object_agg(c.class,jsonb_build_object('bytes',COALESCE(s.bytes,0),'count',COALESCE(s.n,0)))
            FROM (VALUES('image'),('temporary'),('kept')) c(class)
            LEFT JOIN (SELECT class,sum(size_bytes) bytes,count(*) n FROM mine GROUP BY class) s ON s.class=c.class),
        'groups',COALESCE((SELECT jsonb_agg(g ORDER BY (g->>'bytes')::bigint DESC) FROM (
            SELECT jsonb_build_object('chat_id',m.chat_id,'name',c.name,'project',EXISTS(SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id=m.chat_id),
                'bytes',sum(m.size_bytes),'count',count(*)) g
            FROM mine m JOIN chat.chats c ON c.id=m.chat_id GROUP BY m.chat_id,c.name) gs),'[]'::jsonb),
        'expiring',COALESCE((SELECT jsonb_agg(e ORDER BY e->>'expires_at') FROM (
            SELECT jsonb_build_object('chat_id',m.chat_id,'expires_at',m.expires_at,'bytes',m.size_bytes,'class',m.class,
                'item_id',w.id,'file_name',w.filename) e
            FROM mine m LEFT JOIN LATERAL (SELECT i.id,i.filename FROM chat.workspace_items i WHERE i.chat_id=m.chat_id AND i.blob_id=m.blob_id LIMIT 1) w ON true
            WHERE m.expires_at IS NOT NULL ORDER BY m.expires_at LIMIT 20) es),'[]'::jsonb),
        'machines',COALESCE((SELECT jsonb_agg(jsonb_build_object('device_id',d.device_id,'label',d.label,'files',s.files,'bytes',s.bytes,
                'temporary_copy_bytes',s.copies))
            FROM devices d JOIN LATERAL (
                SELECT count(*) files,COALESCE(sum(r.size_bytes),0) bytes,
                    COALESCE((SELECT sum(t.ciphertext_bytes) FROM chat.file_temporary_transfers t
                        WHERE t.host_device_id=d.device_id AND t.state IN ('uploading','ready')),0) copies
                FROM chat.file_device_revisions r JOIN chat.workspace_items w ON w.id=r.item_id AND w.version=r.version
                WHERE r.host_device_id=d.device_id) s ON true),'[]'::jsonb)
    ) INTO result;
    RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION file_private.link_project_message(p_item uuid, p_message text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM chat.workspace_items w
        JOIN chat.messages m ON m.id=p_message AND m.file_item_id=w.id AND NOT m.is_whisper
        JOIN chat.chats c ON c.id=m.chat_id AND COALESCE(c.source_chat_id,c.id)=w.chat_id
        JOIN chat.file_device_revisions r ON r.item_id=w.id AND r.version=m.file_version
        JOIN identity.gugu_devices d ON d.device_id=r.host_device_id
        WHERE w.id=p_item AND d.user_id=auth.uid() AND chat.is_chat_member(w.chat_id,auth.uid()::text)) THEN
        RAISE EXCEPTION 'Only the device that keeps this version can link its message' USING HINT='file_transfer_denied';
    END IF;
    UPDATE chat.workspace_items SET source_message_ids=array_append(source_message_ids,p_message)
        WHERE id=p_item AND NOT p_message=ANY(source_message_ids);
END $function$;

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
$function$;

CREATE OR REPLACE FUNCTION chat.set_workspace_item_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    IF (NEW.inline_text IS DISTINCT FROM OLD.inline_text AND NOT
          (OLD.kind='file' AND NEW.kind='document' AND NEW.blob_id IS NOT NULL))
       OR NEW.blob_id IS DISTINCT FROM OLD.blob_id
       OR (NEW.kind='file' AND NEW.blob_id IS NULL AND NEW.version IS DISTINCT FROM OLD.version
           AND NOT EXISTS(SELECT 1 FROM chat.file_device_revisions n JOIN chat.file_device_revisions o
               ON o.item_id=OLD.id AND o.version=OLD.version AND o.sha256=n.sha256
               WHERE n.item_id=NEW.id AND n.version=NEW.version)) THEN
        NEW.updated_at:=now();
    ELSE
        NEW.updated_at:=OLD.updated_at;
        NEW.updated_by:=OLD.updated_by;
    END IF;
    RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION chat.file_device_version_integrity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    IF auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM chat.file_device_revisions WHERE item_id=OLD.id AND version=OLD.version)
       AND NOT (NEW.blob_id IS NOT NULL AND NEW.version=OLD.version+1 AND NEW.chat_id=OLD.chat_id AND NEW.kind='file')
       AND NOT EXISTS(SELECT 1 FROM chat.file_device_revisions d WHERE d.item_id=NEW.id AND d.version=NEW.version
           AND (d.file_name,d.content_type,d.size_bytes)=(NEW.filename,NEW.content_type,NEW.size_bytes)
           AND NEW.blob_id IS NULL AND NEW.chat_id=OLD.chat_id AND NEW.kind='file') THEN
        RAISE EXCEPTION 'A local version changes only with its revision' USING HINT='file_transfer_invalid';
    END IF;
    RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION chat.file_device_carry_revision()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE d chat.file_device_revisions%ROWTYPE;
BEGIN
    IF NEW.kind<>'file' OR NEW.chat_id<>OLD.chat_id OR NEW.version<>OLD.version+1
       OR OLD.blob_id IS NOT NULL OR NEW.blob_id IS NOT NULL
       OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.content_type IS DISTINCT FROM OLD.content_type
       -- A publication writes its own row for the new version before it updates the file.
       OR EXISTS(SELECT 1 FROM chat.file_device_revisions WHERE item_id=NEW.id AND version=NEW.version) THEN
        RETURN NEW;
    END IF;
    SELECT * INTO d FROM chat.file_device_revisions WHERE item_id=OLD.id AND version=OLD.version;
    IF NOT FOUND THEN RETURN NEW; END IF;
    INSERT INTO chat.file_device_revisions(item_id,version,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type)
    VALUES(NEW.id,NEW.version,d.host_device_id,d.host_project_id,d.relative_path,d.sha256,d.size_bytes,NEW.filename,d.content_type);
    RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION chat.file_device_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    IF NEW.blob_id IS NULL AND NEW.inline_text IS NULL THEN
        SELECT version INTO NEW.device_version FROM chat.file_device_revisions WHERE item_id=NEW.item_id AND version=NEW.n;
    END IF;
    RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION chat.file_replace_as(p_staging_key text, p_item_id text, p_as_user_id text, p_expected_version integer DEFAULT NULL::integer)
 RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, pruned_pointers text[], parent_id uuid, system_role text, path text, updated_by text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_keep CONSTANT INTEGER := 50;
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_item chat.workspace_items%ROWTYPE;
    v_upload chat.file_blob_uploads%ROWTYPE;
    v_blob chat.file_blobs%ROWTYPE;
    v_next INTEGER;
    v_pruned TEXT[] := '{}';
BEGIN
    v_item := chat.workspace_item_for(p_item_id, v_actor, true);
    v_upload := chat.file_upload_take(p_staging_key);
    IF v_upload.item_id IS NOT NULL THEN
        -- 重试:上次已经把这个文件换成了这份字节(换到别的条目上的上传不能再用)。
        IF v_upload.item_id IS DISTINCT FROM v_item.id THEN
            RAISE EXCEPTION USING HINT = 'attachment_upload_used',
                MESSAGE = format('upload %s was already placed elsewhere', p_staging_key);
        END IF;
    ELSE
        IF v_item.kind='document' AND (v_upload.document->'prepared'->>'item' IS DISTINCT FROM v_item.id::text
           OR v_upload.document->'prepared'->>'actor' IS DISTINCT FROM v_actor
           OR (v_upload.document->'prepared'->>'expected')::integer IS DISTINCT FROM p_expected_version
           OR (v_upload.document->'prepared'->>'epoch')::integer IS DISTINCT FROM v_item.epoch
           OR (v_upload.document->'prepared'->>'expires')::timestamptz<=clock_timestamp()) THEN
            RAISE EXCEPTION 'Document replacement is not prepared or has expired' USING HINT='workspace_version_conflict';
        END IF;
        IF v_item.kind NOT IN ('file','document') THEN
            RAISE EXCEPTION USING HINT = 'file_place_invalid',
                MESSAGE = format('file_replace_as: %s is a live text file; change it through the file service', p_item_id);
        END IF;
        IF p_expected_version IS NOT NULL AND p_expected_version <> v_item.version THEN
            RAISE EXCEPTION USING HINT = 'workspace_version_conflict', DETAIL = v_item.version::TEXT,
                MESSAGE = format('workspace item %s version conflict: expected %s, got %s', p_item_id, p_expected_version, v_item.version);
        END IF;
        IF v_item.kind='file' AND v_upload.blob_id = v_item.blob_id THEN
            RAISE EXCEPTION USING HINT = 'file_place_invalid', MESSAGE = 'file_replace_as: that is the content the file already has';
        END IF;
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = v_upload.blob_id;
        v_next := CASE WHEN v_item.kind='document' AND v_upload.blob_id=chat.workspace_version_blob(v_item.id,v_item.version) THEN v_item.version
            ELSE GREATEST(v_item.version,(SELECT COALESCE(max(n),0) FROM chat.workspace_item_versions WHERE item_id=v_item.id))+1 END;
        -- 被替换的这一版:第一次换版本时它还不在历史里(建文件时不写历史),补上。
        INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by, made_at)
        VALUES (v_item.id, v_item.version, v_item.blob_id, v_item.content_type, v_item.size_bytes, v_item.created_by, v_item.updated_at)
        ON CONFLICT ON CONSTRAINT workspace_item_versions_pkey DO NOTHING;
        INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by)
        VALUES (v_item.id, v_next, v_blob.id, v_blob.content_type, v_blob.size_bytes, v_actor) ON CONFLICT(item_id,n) DO NOTHING;
        IF v_item.kind='document' THEN
            UPDATE chat.workspace_item_versions SET inline_text=v_upload.document->>'text' WHERE item_id=v_item.id AND n=v_next;
            UPDATE chat.workspace_items w SET ystate=decode(v_upload.document->'prepared'->>'state','hex'),inline_text=v_upload.document->'prepared'->>'text',epoch=w.epoch+1 WHERE w.id=v_item.id;
        END IF;
        UPDATE chat.workspace_items w SET blob_id=v_blob.id,version=v_next,updated_by=v_actor,
            content_type=CASE WHEN v_item.kind='document' THEN v_upload.document->>'content_type' ELSE v_blob.content_type END,
            size_bytes=CASE WHEN v_item.kind='document' THEN octet_length(v_upload.document->'prepared'->>'text') ELSE v_blob.size_bytes END WHERE w.id=v_item.id;
        UPDATE chat.file_blob_uploads u SET item_id=v_item.id,item_version=v_next,
            document=CASE WHEN v_item.kind='document' THEN jsonb_set(u.document,'{prepared}',(u.document->'prepared')-'state'-'text') ELSE u.document END WHERE u.staging_key=p_staging_key;
        WITH gone AS (
            DELETE FROM chat.workspace_item_versions v
             WHERE v.item_id = v_item.id
               AND v.n NOT IN (SELECT k.n FROM chat.workspace_item_versions k WHERE k.item_id = v_item.id ORDER BY k.n DESC LIMIT v_keep)
               -- 聊天记录钉着的那一版不裁:它是「当时发的那一版」,得一直读得到。
               AND NOT EXISTS (SELECT 1 FROM chat.messages m WHERE m.file_item_id = v.item_id AND m.file_version = v.n)
            RETURNING v.blob_id
        )
        SELECT COALESCE(array_agg(chat.file_blob_pointer(g.blob_id)) FILTER (WHERE chat.file_blob_pointer(g.blob_id) IS NOT NULL), '{}') INTO v_pruned FROM gone g;
    END IF;
    RETURN QUERY
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at, v_pruned,
           w.parent_id, w.system_role, chat.workspace_path_of(w.id), w.updated_by
      FROM chat.workspace_items w
     WHERE w.id = v_item.id;
END;
$function$;

CREATE OR REPLACE FUNCTION chat.workspace_replace_file_as(p_item_id text, p_as_user_id text, p_pointer text, p_size_bytes bigint, p_content_type text DEFAULT NULL::text, p_expected_version integer DEFAULT NULL::integer)
 RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, pruned_pointers text[], parent_id uuid, system_role text, path text, updated_by text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_keep CONSTANT INTEGER := 50;
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_item chat.workspace_items%ROWTYPE;
    v_type TEXT;
    v_next INTEGER;
    v_pruned TEXT[];
    v_blob UUID;
BEGIN
    v_item := chat.workspace_item_for(p_item_id, v_actor, true);
    IF v_item.kind <> 'file' THEN
        RAISE EXCEPTION 'workspace_replace_file: % is a live text file; change it through the file service', p_item_id;
    END IF;
    IF p_pointer IS NULL OR chat.workspace_require_room_member(split_part(p_pointer, '/', 1), v_actor) IS DISTINCT FROM v_item.chat_id THEN
        RAISE EXCEPTION 'workspace_replace_file: pointer must live under %/', v_item.chat_id;
    END IF;
    IF p_pointer = chat.file_blob_pointer(v_item.blob_id) THEN
        RAISE EXCEPTION 'workspace_replace_file: that is the content the file already has';
    END IF;
    IF p_size_bytes IS NULL OR p_size_bytes < 0 THEN
        RAISE EXCEPTION 'workspace_replace_file: size_bytes is required';
    END IF;
    IF p_expected_version IS NOT NULL AND p_expected_version <> v_item.version THEN
        RAISE EXCEPTION 'workspace item % version conflict: expected %, got %', p_item_id, p_expected_version, v_item.version
            USING HINT = 'workspace_version_conflict', DETAIL = v_item.version::TEXT;
    END IF;
    v_type := COALESCE(NULLIF(btrim(COALESCE(p_content_type, '')), ''), v_item.content_type);
    v_next := v_item.version + 1;

    INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by, made_at)
    VALUES (v_item.id, v_item.version, v_item.blob_id, v_item.content_type, v_item.size_bytes, v_item.created_by, v_item.updated_at)
    ON CONFLICT ON CONSTRAINT workspace_item_versions_pkey DO NOTHING;
    v_blob := chat.file_blob_for_pointer(p_pointer, p_size_bytes, v_type, v_actor);
    INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by)
    VALUES (v_item.id, v_next, v_blob, v_type, p_size_bytes, v_actor);

    UPDATE chat.workspace_items w
       SET blob_id = v_blob, size_bytes = p_size_bytes, content_type = v_type, version = v_next, updated_by = v_actor
     WHERE w.id = v_item.id;

    WITH gone AS (
        DELETE FROM chat.workspace_item_versions v
         WHERE v.item_id = v_item.id
           AND v.n NOT IN (SELECT k.n FROM chat.workspace_item_versions k WHERE k.item_id = v_item.id ORDER BY k.n DESC LIMIT v_keep)
           AND NOT EXISTS (SELECT 1 FROM chat.messages m WHERE m.file_item_id = v.item_id AND m.file_version = v.n)
        RETURNING v.blob_id
    )
    SELECT COALESCE(array_agg(chat.file_blob_pointer(g.blob_id)) FILTER (WHERE chat.file_blob_pointer(g.blob_id) IS NOT NULL), '{}') INTO v_pruned FROM gone g;

    RETURN QUERY
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at, v_pruned,
           w.parent_id, w.system_role, chat.workspace_path_of(w.id), w.updated_by
      FROM chat.workspace_items w
     WHERE w.id = v_item.id;
END;
$function$;

CREATE OR REPLACE FUNCTION chat.messages_file_ref()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_item chat.workspace_items%ROWTYPE;
    v_blob chat.file_blobs%ROWTYPE;
    v_source chat.messages%ROWTYPE;
    v_envelope TEXT;
    v_resource TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- 发出去以后不能改指向;删文件时外键把 file_item_id 清空(墓碑)是唯一的变化。
        IF NEW.file_version IS DISTINCT FROM OLD.file_version
           OR (NEW.file_item_id IS DISTINCT FROM OLD.file_item_id AND NEW.file_item_id IS NOT NULL)
           -- ◇ 悄悄话附件指着的那份字节也不能改。
           OR NEW.file_blob_id IS DISTINCT FROM OLD.file_blob_id THEN
            RAISE EXCEPTION USING HINT = 'message_file_fixed', MESSAGE = 'an attachment keeps the file version it was sent with';
        END IF;
        -- 正文和类型也不能改(墓碑也一样):authenticated 本来就能改自己消息的正文(编辑),而老客户端照正文画名字、大小和 [URL],
        -- 新客户端照条目读字节 —— 改了正文,同一条消息两边看到两样东西。撤回只写 retracted_at,不经过这里。
        IF (OLD.file_item_id IS NOT NULL OR OLD.file_version IS NOT NULL OR OLD.file_blob_id IS NOT NULL)
           AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.content_type IS DISTINCT FROM OLD.content_type) THEN
            RAISE EXCEPTION USING HINT = 'message_file_fixed', MESSAGE = 'an attachment''s text is fixed once it is sent';
        END IF;
        RETURN NEW;
    END IF;
    -- ◇ 悄悄话附件:消息直接指字节。形状(悄悄话、没有条目)由 CHECK messages_file_blob_shape 管。
    IF NEW.file_blob_id IS NOT NULL THEN
        -- 先锁住、核它没在回收(同条目那一路的 file_blob_take)。
        PERFORM chat.file_blob_take(NEW.file_blob_id);
        -- 字节从哪来:这条消息自己消费的那次上传,或者发送者读得到、指着同一份字节的源消息。
        IF NOT EXISTS (SELECT 1 FROM chat.file_blob_uploads u WHERE u.message_id = NEW.id AND u.blob_id = NEW.file_blob_id) THEN
            IF NEW.forwarded_from_message_id IS NOT NULL
               AND chat.can_read_message(NEW.forwarded_from_message_id, NEW.sender_user_id) THEN
                SELECT * INTO v_source FROM chat.messages s WHERE s.id = NEW.forwarded_from_message_id AND s.retracted_at IS NULL;
            END IF;
            IF v_source.id IS NULL
               OR COALESCE(v_source.file_blob_id, chat.workspace_version_blob(v_source.file_item_id, v_source.file_version))
                  IS DISTINCT FROM NEW.file_blob_id THEN
                RAISE EXCEPTION USING HINT = 'message_file_not_here',
                    MESSAGE = 'a whisper attachment carries bytes uploaded for it, or forwards the bytes of an unretracted message its sender can read';
            END IF;
        END IF;
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = NEW.file_blob_id;
        IF NEW.content_type IS DISTINCT FROM 'attachment'
           OR chat.attachment_envelope_name(chat.attachment_text_envelope(NEW.content), v_blob.size_bytes, v_blob.content_type) IS NULL THEN
            RAISE EXCEPTION USING HINT = 'message_file_envelope',
                MESSAGE = format('an attachment''s text is its file''s envelope: %s',
                                 chat.attachment_envelope('<name>', v_blob.size_bytes, v_blob.content_type));
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.file_item_id IS NULL THEN
        IF NEW.file_version IS NOT NULL THEN
            RAISE EXCEPTION USING HINT = 'message_file_not_here', MESSAGE = 'an attachment''s version needs its file';
        END IF;
        RETURN NEW;
    END IF;
    -- FOR SHARE:换版本那边(workspace_replace_file_as)先对条目拿 FOR UPDATE、修剪历史;这里排在它后面,拿到锁时它已提交,
    -- 下一句用新快照,看得到修剪以后的历史 —— 钉的那一版已经裁掉就拒。只靠外键的 KEY SHARE 不排队:两边都成功,
    -- 消息钉着一版历史里已经没有的字节,回收随后把它删掉(复核 L11 两个连接实测)。反过来这边先到,修剪等这边提交、看得见钉住。
    v_resource := chat.workspace_require_room_member(NEW.chat_id, NEW.sender_user_id);
    SELECT * INTO v_item FROM chat.workspace_items w WHERE w.id = NEW.file_item_id FOR SHARE;
    IF NOT FOUND OR v_item.chat_id IS DISTINCT FROM v_resource OR v_item.kind = 'folder' THEN
        RAISE EXCEPTION USING HINT = 'message_file_not_here',
            MESSAGE = 'an attachment points at a file in its source chat''s folder';
    END IF;
    NEW.file_version := COALESCE(NEW.file_version, v_item.version);
    v_envelope := chat.workspace_version_envelope(v_item.id, NEW.file_version);
    IF v_envelope IS NULL THEN
        RAISE EXCEPTION USING HINT = 'message_file_not_here',
            MESSAGE = format('version %s of that file has no bytes to send', NEW.file_version);
    END IF;
    IF NEW.content_type IS DISTINCT FROM 'attachment' OR chat.attachment_text_envelope(NEW.content) IS DISTINCT FROM v_envelope THEN
        RAISE EXCEPTION USING HINT = 'message_file_envelope',
            MESSAGE = format('an attachment''s text is its file''s envelope: %s', v_envelope);
    END IF;
    -- ◇ 钉住条目现在那一版:写进历史(还没有的话)。改名、移动只升版本、不写历史,不记的话那一版的字节就只挂在条目上,
    -- 下一次改名以后 chat.workspace_version_blob 找不到它。写法同 workspace_replace_file_as 补旧版本那一句。
    IF NEW.file_version = v_item.version THEN
        INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by, made_at)
        VALUES (v_item.id, v_item.version, v_item.blob_id, v_item.content_type, v_item.size_bytes, v_item.created_by, v_item.updated_at)
        ON CONFLICT ON CONSTRAINT workspace_item_versions_pkey DO NOTHING;
    END IF;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER file_device_carry_revision BEFORE UPDATE ON chat.workspace_items FOR EACH ROW EXECUTE FUNCTION chat.file_device_carry_revision();
CREATE TRIGGER file_device_snapshot BEFORE INSERT ON chat.workspace_item_versions FOR EACH ROW EXECUTE FUNCTION chat.file_device_snapshot();
DROP TABLE chat.file_contents;

REVOKE ALL ON FUNCTION chat.attachment_place_share(uuid,integer,text,text,text),
    chat.file_blob_register(text,text,text,bigint,text,integer,integer),
    chat.file_device_carry_revision(),
    chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb,text),
    chat.file_device_snapshot(),
    chat.file_device_version_integrity(),
    chat.file_replace_as(text,text,text,integer),
    chat.file_resolve_as(jsonb,text),
    chat.file_storage_overview_as(),
    chat.file_temporary_pending(text),
    chat.file_urls_as(jsonb,text),
    chat.messages_file_ref(),
    chat.session_attachment_urls_as(uuid[],text),
    chat.set_workspace_item_updated_at(),
    chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean),
    chat.workspace_replace_file_as(text,text,text,bigint,text,integer),
    chat.workspace_version_envelope(uuid,integer),
    file_private.link_project_message(uuid,text),
    file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid),
    chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb,text),
    chat.file_resolve_as(jsonb,text),
    chat.file_urls_as(jsonb,text),
    chat.session_attachment_urls_as(uuid[],text),
    chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean),
    chat.file_temporary_pending(text),
    chat.file_storage_overview_as(),
    file_private.link_project_message(uuid,text),
    chat.attachment_place_share(uuid,integer,text,text,text),
    chat.file_replace_as(text,text,text,integer),
    chat.workspace_replace_file_as(text,text,text,bigint,text,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.session_attachment_urls_as(uuid[],text),
    chat.file_blob_register(text,text,text,bigint,text,integer,integer),
    chat.workspace_version_envelope(uuid,integer),
    chat.file_device_version_integrity(),
    chat.file_device_carry_revision(),
    chat.file_device_snapshot() TO service_role;
COMMIT;
