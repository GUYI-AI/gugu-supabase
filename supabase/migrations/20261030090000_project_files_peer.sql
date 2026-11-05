-- A project chat has no host. Each file version is kept by the device that sent it, and its revision row records that
-- device (file_device_revisions.host_device_id: the version's holder). A reader fetches a version from its holder; any
-- member's device may write a next version, which that device then holds. Whether a sent file stays on its device or is
-- uploaded is the sender's own setting (identity.user_settings file_storage), never another account's.
--
-- Removed: the chat's single host (chat.file_project_policies and its first-read election), the host-only publish and
-- link checks, the "Remote project files are read-only" half of the workspace trigger, the "not uploaded proactively"
-- fence, and the next-version / first-file handoff to a host (chat.file_version_handoffs and its functions).
-- Existing revisions already name the device that holds their bytes, so no row is rewritten.
-- file_project_policy_for / file_project_policy_as stay, without a table, for clients released before this one.

-- 1. Settings belong to an account. -----------------------------------------------------------------------------------
CREATE FUNCTION chat.file_storage_of(p_account text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT '{"proactive_upload":false,"temporary_transfer":true,"retention":"7d","image_retention":"7d","temporary_retention":"7d"}'::jsonb
        ||COALESCE((SELECT s.config->'file_storage' FROM identity.user_settings s WHERE s.scope='user' AND s.user_id=p_account),'{}'::jsonb)
$$;

-- How long a copy marked temporary stays: its uploader's setting, in every chat.
CREATE OR REPLACE FUNCTION chat.file_temporary_interval(p_chat text,p_account text) RETURNS interval
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT (chat.file_storage_of(p_account)->>'temporary_retention')::interval
$$;

-- 2. Handoffs to a host are gone. Deleting the rows first lets file_version_handoff_collect hand every staged copy to the
--    blob collector; their upload reservations lapse at their own expiry.
DELETE FROM chat.file_version_handoffs;
DROP FUNCTION chat.file_version_handoff_publish(uuid,text,text,bigint),
    chat.file_version_handoff_request(uuid,uuid,integer,text,text,bigint,text,bigint,bigint,jsonb,text,text),
    chat.file_version_handoff_request(uuid,uuid,integer,text,text,bigint,text,bigint,bigint,jsonb,text),
    chat.file_version_handoff_upload(uuid,text),chat.file_version_handoff_commit(uuid,text,text,bigint,text),
    chat.file_version_handoff_pending(text),chat.file_version_handoff_fetch(uuid,text),
    chat.file_version_handoff_status(uuid,boolean),chat.file_version_handoff_status_of(chat.file_version_handoffs),
    chat.file_version_handoff_expire(integer),chat.file_version_handoff_host(text);
DROP TABLE chat.file_version_handoffs;
DROP FUNCTION chat.file_version_handoff_collect();

-- 3. One publisher of local revisions: the caller's own device, under one of its projects bound to this chat, or its
--    device store (files sent from a device with no project bound to the chat). New file or next version alike.
DROP FUNCTION chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb);
DROP FUNCTION file_private.publish_revision(uuid,text,text,text,text,bigint,text,text,integer,uuid);
DROP FUNCTION file_private.publish_revision_by(uuid,text,text,text,text,bigint,text,text,integer,uuid,text);

CREATE FUNCTION file_private.publish_revision(p_item uuid,p_chat text,p_device text,p_project text,p_path text,p_sha text,
    p_size bigint,p_filename text,p_type text,p_expected integer DEFAULT NULL,p_parent uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
END $$;

-- A published version's message is linked by the account whose device keeps that version.
CREATE OR REPLACE FUNCTION file_private.link_project_message(p_item uuid,p_message text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
END $$;

CREATE FUNCTION chat.file_device_publish(p_item uuid,p_chat text,p_device text,p_path text,p_sha text,p_size bigint,
    p_filename text,p_type text,p_expected integer DEFAULT NULL,p_parent uuid DEFAULT NULL,p_message jsonb DEFAULT NULL,
    p_project text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
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
END $$;

-- 4. Folder entries of local files follow the ordinary folder rules (rename, move, delete). A local version changes only
--    with its revision row (publish, or the rename carry trigger), or by a blob next version.
DROP TRIGGER file_device_read_only ON chat.workspace_items;
DROP FUNCTION chat.file_device_read_only();
CREATE FUNCTION chat.file_device_version_integrity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM chat.file_device_revisions WHERE item_id=OLD.id AND version=OLD.version)
       AND NOT (NEW.blob_id IS NOT NULL AND NEW.version=OLD.version+1 AND NEW.chat_id=OLD.chat_id AND NEW.kind='file')
       AND NOT EXISTS(SELECT 1 FROM chat.file_device_revisions d WHERE d.item_id=NEW.id AND d.version=NEW.version
           AND (d.file_name,d.content_type,d.size_bytes)=(NEW.filename,NEW.content_type,NEW.size_bytes)
           AND NEW.blob_id IS NULL AND NEW.chat_id=OLD.chat_id AND NEW.kind='file') THEN
        RAISE EXCEPTION 'A local version changes only with its revision' USING HINT='file_transfer_invalid';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER file_device_version_integrity BEFORE UPDATE ON chat.workspace_items
    FOR EACH ROW EXECUTE FUNCTION chat.file_device_version_integrity();

-- 5. Reading: a version resolves to its holder, named with its label and online state (readers of other accounts cannot
--    read the device rows). Gone when that device was removed or its project no longer bound to the chat, as before.
--    Any version can be fetched, not just the current one;
--    the holder verifies the bytes against the revision's sha256 before sending them.
CREATE OR REPLACE FUNCTION chat.file_resolve_as(p_ref jsonb,p_as text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
    RETURN to_jsonb(c)||jsonb_build_object('source','managed-object','message_id',COALESCE(to_jsonb(c)->>'message_id',msg),
        'status',CASE WHEN EXISTS(SELECT 1 FROM chat.file_transfer_storage o JOIN chat.file_transfer_storage_refs r ON r.storage_id=o.id
            WHERE o.bucket_id=c.bucket_id AND o.object_name=c.object_name AND r.chat_id=chat.file_transfer_group(to_jsonb(c)->>'chat_id')
              AND r.expired_at IS NOT NULL) THEN 'expired' ELSE 'ready' END);
END $$;

CREATE OR REPLACE FUNCTION chat.file_temporary_current(p_transfer chat.file_temporary_transfers) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
    SELECT COALESCE(r->>'status'='ready' AND r->>'source'='local' AND r->>'item_id'=(p_transfer).item_id::text
        AND (r->>'version')::integer=(p_transfer).version
        AND r->>'host_device_id'=(p_transfer).host_device_id AND (r->>'temporary_transfer')::boolean,false)
    FROM (SELECT chat.file_resolve_for((p_transfer).source_ref,(p_transfer).reader_actor,(p_transfer).reader_account) AS r) source
$$;

-- A temporary copy is asked of the version's holder and kept as long as the holder's account says.
CREATE OR REPLACE FUNCTION chat.file_temporary_request(p_ref jsonb,p_as text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); r jsonb; t chat.file_temporary_transfers%ROWTYPE; kept text; cfg jsonb;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    r:=chat.file_resolve_as(p_ref,actor);
    IF r->>'status'<>'ready' OR r->>'source'<>'local' THEN RETURN r; END IF;
    IF (r->>'temporary_transfer')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Temporary transfer is disabled for this file' USING HINT='file_transfer_denied';
    END IF;
    SELECT * INTO t FROM chat.file_temporary_transfers WHERE id=p_id;
    IF FOUND THEN
        IF (t.reader_account,t.reader_actor,t.item_id,t.version,t.source_ref)
           IS DISTINCT FROM (auth.uid()::text,actor,(r->>'item_id')::uuid,(r->>'version')::integer,p_ref) THEN
            RAISE EXCEPTION 'Transfer identity is immutable' USING HINT='file_transfer_conflict';
        END IF;
    ELSE
        kept:=chat.file_storage_of(r->>'host_account_id')->>'retention'; cfg:=chat.file_transfer_settings();
        IF kept<>'read-once' THEN
            SELECT generation.* INTO t FROM chat.file_temporary_transfers generation WHERE item_id=(r->>'item_id')::uuid AND version=(r->>'version')::integer
                AND retention<>'read-once' AND (state='ready' AND serve_until>now() AND created_at>now()-interval '30 days'
                    OR state='requested' AND created_at>now()-make_interval(secs=>chat.file_transfer_parameter(cfg,'upload_permit_seconds')::integer)
                    OR state='uploading' AND EXISTS(SELECT 1 FROM chat.file_transfer_reservations v WHERE v.id=generation.id AND v.state='issued' AND v.expires_at>now()))
                AND chat.file_temporary_current(generation)
                ORDER BY created_at DESC LIMIT 1;
        END IF;
        IF t.id IS NULL THEN
            IF (SELECT count(*) FROM chat.file_temporary_transfers WHERE reader_account=auth.uid()::text
                AND created_at>now()-make_interval(secs=>chat.file_transfer_parameter(cfg,'sign_window_seconds')::integer))
                >=chat.file_transfer_parameter(cfg,'sign_account_count') THEN
                RAISE EXCEPTION 'Too many temporary transfer requests' USING HINT='file_transfer_rate_limited';
            END IF;
            INSERT INTO chat.file_temporary_transfers(id,item_id,version,chat_id,host_device_id,reader_account,reader_actor,source_ref,retention,object_name)
            VALUES(p_id,(r->>'item_id')::uuid,(r->>'version')::integer,r->>'chat_id',r->>'host_device_id',auth.uid()::text,actor,p_ref,kept,
                'temporary/'||(r->>'chat_id')||'/'||(r->>'item_id')||'/'||(r->>'version')||'/'||(r->>'sha256')||'/'||p_id::text) RETURNING * INTO t;
            PERFORM realtime.send(jsonb_build_object('request_id',t.id),'files.transfer','gugu:'||t.host_device_id||':rpc',true);
        END IF;
    END IF;
    RETURN r||jsonb_build_object('transfer_id',t.id,'transfer_status',t.state);
END $$;

-- 6. Patch the long upload and download bodies in place: delete the project fence, key image expiry on the uploader,
--    and serve a ready temporary copy of any version.
DO $peer$
DECLARE definition text; a integer; z integer;
BEGIN
    SELECT pg_get_functiondef('chat.file_managed_upload_prepare(text,text,bigint,text)'::regprocedure) INTO definition;
    a:=position('IF g IS NOT NULL AND EXISTS(SELECT 1 FROM identity.device_projects WHERE chat_id=g)' IN definition);
    z:=a+position('END IF;' IN substr(definition,a))+length('END IF;')-1;
    IF a=0 OR position('Project files are not uploaded proactively' IN substr(definition,a,z-a))=0 THEN
        RAISE EXCEPTION 'Unexpected managed upload fence predecessor';
    END IF;
    EXECUTE substr(definition,1,a-1)||substr(definition,z);

    SELECT pg_get_functiondef('chat.file_managed_upload_registered(text,text,jsonb)'::regprocedure) INTO definition;
    a:=position('IF EXISTS(SELECT 1 FROM identity.device_projects WHERE chat_id=u.chat_id)' IN definition);
    z:=a+position('END IF;' IN substr(definition,a))+length('END IF;')-1;
    IF a=0 OR position('Project files are not uploaded proactively' IN substr(definition,a,z-a))=0
       OR position('chat.file_storage_policy(u.chat_id)' IN substr(definition,z))=0 THEN
        RAISE EXCEPTION 'Unexpected upload registration fence predecessor';
    END IF;
    EXECUTE replace(substr(definition,1,a-1)||substr(definition,z),'chat.file_storage_policy(u.chat_id)','chat.file_storage_of(u.account_id)');

    SELECT pg_get_functiondef('chat.file_transfer_download_as(jsonb,text,uuid)'::regprocedure) INTO definition;
    IF position($old$AND (r->>'temporary_transfer')::boolean AND version=(r->>'current_version')::integer$old$ IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected temporary download predecessor';
    END IF;
    EXECUTE replace(definition,$old$AND (r->>'temporary_transfer')::boolean AND version=(r->>'current_version')::integer$old$,
        $new$AND (r->>'temporary_transfer')::boolean$new$);

    SELECT pg_get_functiondef('chat.attachment_place_share(uuid,integer,text,text,text)'::regprocedure) INTO definition;
    IF position('is kept on its host computer: it can be sent only in its own chat' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected attachment_share predecessor';
    END IF;
    EXECUTE replace(definition,'is kept on its host computer: it can be sent only in its own chat',
        'is kept on the computer that sent it: it can be sent only in its own chat');
END $peer$;
REVOKE ALL ON FUNCTION chat.attachment_place_share(uuid,integer,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION chat.attachment_place_share(uuid,integer,text,text,text) TO authenticated;

-- 7. The dashboard: per machine, the files it keeps (current versions) and the temporary copies made from them.
CREATE OR REPLACE FUNCTION chat.file_storage_overview_as() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
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
END $$;

-- 8. A chat has no file policy. The two RPCs keep their shapes for clients released before this one: there is no chat
--    host to read, and "binding" a device's own project returns that device and project with the caller's own setting,
--    so such a client publishes from its own machine. Drop both once those clients are gone.
CREATE OR REPLACE FUNCTION chat.file_project_policy_for(p_chat text,p_as text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
    PERFORM chat.workspace_require_room_member(p_chat,chat.workspace_actor_for(p_as));
    RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION chat.file_project_policy_as(p_chat text,p_device text,p_project text,p_upload boolean,p_temporary boolean,p_retention text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g text:=chat.workspace_require_room_member(p_chat,auth.uid()::text);
BEGIN
    IF NOT EXISTS(SELECT 1 FROM identity.device_projects dp JOIN identity.gugu_devices d ON d.device_id=dp.device_id
        WHERE dp.device_id=p_device AND dp.local_project_id=p_project AND dp.chat_id=g AND dp.user_id=auth.uid() AND d.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'This device keeps no project for this chat' USING HINT='file_transfer_denied';
    END IF;
    RETURN jsonb_build_object('chat_id',g,'host_device_id',p_device,'host_project_id',p_project)||chat.file_storage_of(auth.uid()::text);
END $$;

DROP FUNCTION chat.file_storage_policy(text);
DROP TABLE chat.file_project_policies;

-- The installation DDL guard closes every created or replaced function; restore only the intended surface.
REVOKE ALL ON FUNCTION chat.file_storage_of(text),chat.file_temporary_interval(text,text),
    file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid),file_private.link_project_message(uuid,text),
    chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb,text),chat.file_device_version_integrity(),
    chat.file_resolve_as(jsonb,text),chat.file_temporary_current(chat.file_temporary_transfers),chat.file_temporary_request(jsonb,text,uuid),
    chat.file_managed_upload_prepare(text,text,bigint,text),chat.file_managed_upload_registered(text,text,jsonb),
    chat.file_transfer_download_as(jsonb,text,uuid),chat.file_storage_overview_as(),
    chat.file_project_policy_for(text,text),chat.file_project_policy_as(text,text,text,boolean,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid),
    file_private.link_project_message(uuid,text),chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb,text),
    chat.file_resolve_as(jsonb,text),chat.file_temporary_request(jsonb,text,uuid),chat.file_managed_upload_prepare(text,text,bigint,text),
    chat.file_transfer_download_as(jsonb,text,uuid),chat.file_storage_overview_as(),
    chat.file_project_policy_for(text,text),chat.file_project_policy_as(text,text,text,boolean,boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_registered(text,text,jsonb),chat.file_device_version_integrity() TO service_role;

NOTIFY pgrst,'reload schema';
