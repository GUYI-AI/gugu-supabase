-- A project chat's image stays uploaded and expires as before; the machine that sent it also keeps the bytes, as a local
-- revision of the same version. While the cloud copy lives it serves the file. Once it has expired the file is read from
-- that machine, exactly like any other project file. The copy's references alone decide when its bytes are collected:
-- a local revision adds none.
CREATE INDEX IF NOT EXISTS file_device_revisions_host ON chat.file_device_revisions(host_device_id);

CREATE FUNCTION file_private.cloud_copy_live(p_blob uuid,p_chat text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT EXISTS(SELECT 1 FROM chat.file_transfer_storage o JOIN chat.file_transfer_storage_refs r ON r.storage_id=o.id
        WHERE o.blob_id=p_blob AND o.state='ready' AND r.chat_id=chat.file_transfer_group(p_chat) AND r.expired_at IS NULL)
$$;

-- What this device should keep: images its account sent, or an agent on this device sent, whose cloud copy is due to
-- expire and which no machine keeps yet. A retracted image is not kept. Starts from this account's own copies.
CREATE FUNCTION file_private.device_adoptable(p_device text,p_item uuid DEFAULT NULL)
RETURNS TABLE(item_id uuid,version integer,chat_id text,file_name text,content_type text,sha256 text,size_bytes bigint,expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT w.id,w.version,w.chat_id,w.filename,b.content_type,b.sha256,b.size_bytes,r.expires_at
    FROM identity.gugu_devices me
    JOIN chat.file_transfer_storage_refs r ON r.account_id=auth.uid()::text AND r.expired_at IS NULL AND r.expires_at IS NOT NULL
    JOIN chat.file_transfer_storage o ON o.id=r.storage_id AND o.state='ready'
    JOIN chat.file_blobs b ON b.id=o.blob_id AND b.content_type LIKE 'image/%' AND b.sha256 IS NOT NULL
    JOIN chat.workspace_items w ON w.blob_id=o.blob_id AND w.kind='file' AND chat.file_transfer_group(w.chat_id)=r.chat_id
    JOIN LATERAL (SELECT COALESCE((SELECT m.sender_user_id FROM chat.messages m
        WHERE m.file_item_id=w.id AND m.file_version=w.version ORDER BY m.created_at LIMIT 1),w.created_by) AS id) sender ON true
    JOIN identity.users u ON u.id=sender.id
    WHERE me.device_id=p_device AND me.user_id=auth.uid() AND (p_item IS NULL OR w.id=p_item)
      AND (u.id=auth.uid()::text OR u.type='agent' AND u.owner_user_id=auth.uid()::text AND u.device_id=p_device)
      AND chat.is_chat_member(w.chat_id,auth.uid()::text)
      AND EXISTS(SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id=w.chat_id)
      AND NOT EXISTS(SELECT 1 FROM chat.messages m WHERE m.file_item_id=w.id AND m.file_version=w.version AND m.retracted_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM chat.file_device_revisions d WHERE d.item_id=w.id AND d.version=w.version)
$$;

-- p_skip: what this drain has already tried, so an image that keeps failing does not stand in front of the rest.
CREATE FUNCTION chat.file_device_adopt_pending(p_device text,p_limit integer DEFAULT 50,p_skip uuid[] DEFAULT '{}')
RETURNS TABLE(item_id uuid,version integer,chat_id text,file_name text,content_type text,sha256 text,size_bytes bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT a.item_id,a.version,a.chat_id,a.file_name,a.content_type,a.sha256,a.size_bytes
    FROM file_private.device_adoptable(p_device) a WHERE NOT a.item_id=ANY(p_skip) ORDER BY a.expires_at,a.item_id LIMIT LEAST(GREATEST(p_limit,1),200)
$$;

-- False: nothing to do any more (another machine kept it first, it expired, or it is not this device's to keep).
CREATE FUNCTION chat.file_device_adopt(p_item uuid,p_device text,p_project text,p_path text,p_sha text,p_size bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a record;
BEGIN
    -- The table refuses a path that leaves its root; what is kept this way lives only where keeping puts it.
    IF p_path NOT LIKE '.gugu/attachments/%' THEN RAISE EXCEPTION 'A kept image lives under .gugu/attachments' USING HINT='file_transfer_invalid'; END IF;
    SELECT * INTO a FROM file_private.device_adoptable(p_device,p_item) LIMIT 1;
    IF NOT FOUND THEN RETURN false; END IF;
    IF a.sha256<>p_sha OR a.size_bytes<>p_size THEN
        RAISE EXCEPTION 'The kept bytes are not this image' USING HINT='file_transfer_invalid';
    END IF;
    IF p_project<>'device-store' AND NOT EXISTS(SELECT 1 FROM identity.device_projects dp
        WHERE dp.device_id=p_device AND dp.local_project_id=p_project AND dp.chat_id=a.chat_id AND dp.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'This device keeps no project for this chat' USING HINT='file_transfer_denied';
    END IF;
    INSERT INTO chat.file_device_revisions(item_id,version,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type)
    VALUES(p_item,a.version,p_device,p_project,p_path,p_sha,p_size,chat.workspace_stored_name(a.file_name),a.content_type)
    ON CONFLICT DO NOTHING;
    RETURN FOUND;
END $$;

-- A sent image reaches the machines that keep it through the signal they already drain file work on: its sender's own
-- desktops, or the machine its agent runs on. Only ever as this trigger: nobody may call it or attach it elsewhere, which would name another sender.
CREATE FUNCTION file_private.ask_to_adopt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE device text;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM chat.workspace_items w JOIN chat.file_blobs b ON b.id=w.blob_id
        WHERE w.id=NEW.file_item_id AND b.content_type LIKE 'image/%' AND EXISTS(SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id=w.chat_id)) THEN RETURN NULL; END IF;
    FOR device IN SELECT g.device_id FROM identity.users u JOIN identity.gugu_devices g
            ON u.type='agent' AND g.device_id=u.device_id OR u.type<>'agent' AND g.user_id::text=u.id AND g.platform NOT IN ('android','ios','web')
        WHERE u.id=NEW.sender_user_id AND g.status='online'
    LOOP
        PERFORM realtime.send('{}'::jsonb,'files.transfer','gugu:'||device||':rpc',true);
    END LOOP;
    RETURN NULL;
END $$;
CREATE TRIGGER messages_ask_to_adopt AFTER INSERT ON chat.messages FOR EACH ROW
WHEN (NEW.file_item_id IS NOT NULL) EXECUTE FUNCTION file_private.ask_to_adopt();

-- A reader waiting on an offline machine subscribes to this topic only while it says so; a machine that keeps files
-- says it is back once per return. Nothing else listens, and no account's revision stream moves.
CREATE FUNCTION chat.file_holder_visible(p_device text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT EXISTS(SELECT 1 FROM chat.file_device_revisions d JOIN chat.workspace_items w ON w.id=d.item_id
        JOIN chat.active_members m ON m.chat_id=w.chat_id WHERE d.host_device_id=p_device AND m.user_id=auth.uid()::text)
$$;
CREATE POLICY gugu_file_holder_select ON realtime.messages FOR SELECT TO authenticated
USING (split_part(topic,':',1)='gugu' AND split_part(topic,':',2)='holder' AND chat.file_holder_visible(split_part(topic,':',3)));

CREATE FUNCTION identity.gugu_devices_announce_holder() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM chat.file_device_revisions d WHERE d.host_device_id=NEW.device_id) THEN
        PERFORM realtime.send('{}'::jsonb,'holder_online','gugu:holder:'||NEW.device_id,true);
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER gugu_devices_announce_holder AFTER UPDATE OF status ON identity.gugu_devices FOR EACH ROW
WHEN (NEW.status='online' AND OLD.status IS DISTINCT FROM 'online') EXECUTE FUNCTION identity.gugu_devices_announce_holder();

DO $patch$
DECLARE r record; definition text;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('chat.file_resolve_as(jsonb,text)',
         $old$        IF FOUND THEN
            -- Gone with its device$old$,
         $new$        IF FOUND AND NOT file_private.cloud_copy_live(chat.workspace_version_blob(w.id,n),w.chat_id) THEN
            -- Gone with its device$new$),
        ('chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean)',
         $old$ref.expired_at, ref.account_id, dev.host_device_id$old$,
         $new$ref.expired_at, ref.account_id, CASE WHEN ref.found AND ref.expired_at IS NULL THEN NULL ELSE dev.host_device_id END$new$),
        -- A rename or move makes a new version of the same bytes: it stays kept, with or without a cloud copy.
        ('chat.file_device_carry_revision()',
         $old$OR OLD.blob_id IS NOT NULL OR NEW.blob_id IS NOT NULL$old$,
         $new$OR OLD.blob_id IS DISTINCT FROM NEW.blob_id$new$),
        ('chat.file_device_version_integrity()',
         $old$IF auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM chat.file_device_revisions WHERE item_id=OLD.id AND version=OLD.version)$old$,
         $new$IF auth.uid() IS NOT NULL AND OLD.blob_id IS NULL AND EXISTS(SELECT 1 FROM chat.file_device_revisions WHERE item_id=OLD.id AND version=OLD.version)$new$)
    ) AS patches(signature,before_text,after_text)
    LOOP
        SELECT pg_get_functiondef(r.signature::regprocedure) INTO definition;
        IF position(r.before_text IN definition)=0 THEN RAISE EXCEPTION 'Unexpected predecessor: %',r.signature; END IF;
        EXECUTE replace(definition,r.before_text,r.after_text);
    END LOOP;
END $patch$;

-- Functions default to PUBLIC execute: state who may call each one. The internal ones run only from a SECURITY DEFINER
-- function or as a trigger, and neither needs the caller to hold EXECUTE. Attaching one to a table of one's own does.
REVOKE ALL ON FUNCTION file_private.cloud_copy_live(uuid,text),file_private.device_adoptable(text,uuid),file_private.ask_to_adopt(),
    identity.gugu_devices_announce_holder() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION chat.file_device_adopt_pending(text,integer,uuid[]),chat.file_device_adopt(uuid,text,text,text,text,bigint),
    chat.file_holder_visible(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION chat.file_device_adopt_pending(text,integer,uuid[]),chat.file_device_adopt(uuid,text,text,text,text,bigint),
    chat.file_holder_visible(text),chat.file_resolve_as(jsonb,text),chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean) TO authenticated;
NOTIFY pgrst,'reload schema';
