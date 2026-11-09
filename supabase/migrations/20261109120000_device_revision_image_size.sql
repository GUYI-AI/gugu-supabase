-- A project image's pixel size is part of its local revision, as it is of a managed blob (file_blobs.width/height).
-- Readers lay out an image by its file record before any byte arrives; a local revision had no size, so a project
-- chat's image was drawn at a placeholder size and changed size when its pixels came. The device that publishes a
-- version reads the size from the file's header and sends it; the size is NULL when it cannot (not an image, or a
-- format whose header it does not read) and for versions published before this release.
-- Old clients keep calling file_device_publish without the two new parameters, which default to NULL.
-- Every function keeps its ACL: the installation DDL guard closes created or replaced functions, so each is restated.

ALTER TABLE chat.file_device_revisions ADD COLUMN width integer CHECK(width>0), ADD COLUMN height integer CHECK(height>0);

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
    INSERT INTO chat.file_device_revisions(item_id,version,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type,width,height)
    VALUES(p_item,n,p_device,project,p_path,p_sha,p_size,chat.workspace_stored_name(p_filename),p_type,p_width,p_height);
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
    INSERT INTO chat.file_device_revisions(item_id,version,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type,width,height)
    VALUES(NEW.id,NEW.version,d.host_device_id,d.host_project_id,d.relative_path,d.sha256,d.size_bytes,NEW.filename,d.content_type,d.width,d.height);
    RETURN NEW;
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
                'sha256',d.sha256,'size_bytes',d.size_bytes,'width',d.width,'height',d.height,'host_device_id',d.host_device_id,'host_project_id',d.host_project_id,
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


REVOKE ALL ON FUNCTION file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid,integer,integer),chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb,text,integer,integer),chat.file_resolve_as(jsonb,text),
    chat.file_device_carry_revision() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid,integer,integer),chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb,text,integer,integer),chat.file_resolve_as(jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.file_device_carry_revision() TO service_role;

NOTIFY pgrst,'reload schema';
