-- Roll back 20261112011000_project_identity_readers: the two readers derive project-ness from device rows again;
-- publish_device_projects is its own implementation again and publish_device_projects_v2 goes. Run on that schema only.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION chat.file_transfer_expire(p_limit integer DEFAULT 500)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE s jsonb; idle boolean; threshold_bytes bigint; idle_seconds bigint; r record; n integer:=0;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid expiry batch size'; END IF;
    IF NOT pg_try_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0)) THEN RETURN 0; END IF;
    SELECT settings INTO s FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*';
    -- Absent deployment policy preserves idle files; it never invents a deletion policy.
    idle:=COALESCE(s ?& ARRAY['large_file_bytes','large_file_idle_seconds'],false);
    IF idle THEN
        threshold_bytes:=chat.file_transfer_parameter(s,'large_file_bytes');
        idle_seconds:=chat.file_transfer_parameter(s,'large_file_idle_seconds');
        IF idle_seconds NOT BETWEEN 1 AND 2147483647 THEN RAISE EXCEPTION 'Invalid large file idle interval'; END IF;
    END IF;
    FOR r IN SELECT ref.storage_id,ref.chat_id,o.blob_id
        FROM chat.file_transfer_storage_refs ref JOIN chat.file_transfer_storage o ON o.id=ref.storage_id
        WHERE ref.expired_at IS NULL AND o.state='ready' AND o.blob_id IS NOT NULL
          AND (ref.expires_at<=now()
            OR idle AND o.size_bytes>threshold_bytes
              AND COALESCE(ref.last_download_at,ref.retention_started_at)<=now()-make_interval(secs=>idle_seconds::integer)
              AND NOT EXISTS(SELECT 1 FROM identity.device_projects p WHERE p.chat_id=ref.chat_id))
          AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_reservations d WHERE d.kind='download'
              AND d.subject='object:'||o.id::text AND d.expires_at>now() AND d.state IN ('reserved','issued'))
        ORDER BY COALESCE(ref.last_download_at,ref.retention_started_at),ref.storage_id,ref.chat_id
        LIMIT p_limit FOR UPDATE OF ref SKIP LOCKED
    LOOP
        UPDATE chat.file_transfer_storage_refs SET expired_at=now() WHERE storage_id=r.storage_id AND chat_id=r.chat_id;
        -- The existing GC checks all remaining references and owns physical deletion/retry.
        PERFORM chat.file_blob_enqueue(r.blob_id);
        UPDATE chat.file_blob_gc SET next_attempt_at=now() WHERE blob_id=r.blob_id AND status<>'running';
        n:=n+1;
    END LOOP;
    RETURN n;
END $function$;

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
    IF u.blob_id IS NULL AND b.content_type LIKE 'image/%' AND EXISTS(SELECT 1 FROM identity.device_projects WHERE chat_id=u.chat_id)
       AND NOT (chat.file_storage_of(u.account_id)->>'proactive_upload')::boolean THEN
        UPDATE chat.file_transfer_storage_refs SET expires_at=now()+(chat.file_storage_of(u.account_id)->>'image_retention')::interval
          WHERE storage_id=(SELECT id FROM chat.file_transfer_storage WHERE blob_id=b.id) AND chat_id=u.chat_id;
    END IF;
    UPDATE chat.file_transfer_uploads SET blob_id=b.id WHERE staging_key=p_key;
    UPDATE chat.file_transfer_reservations SET actual_bytes=b.size_bytes WHERE id=u.reservation_id;
END $function$;

CREATE OR REPLACE FUNCTION identity.publish_device_projects(p_device_id text, p_projects jsonb, p_applied_removals jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_me uuid := auth.uid();
    v_changed boolean := false;
    v_rows integer;
    v_project jsonb;
    v_folder jsonb;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NULLIF(p_device_id, '') IS NULL THEN
        RAISE EXCEPTION 'Device is required';
    END IF;
    -- The row lock serializes two publishes from the same device. NO KEY keeps it from blocking the
    -- FOR KEY SHARE that inserts into tables referencing the device take.
    PERFORM 1 FROM identity.gugu_devices WHERE device_id = p_device_id AND user_id = v_me FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Device is not owned by current user';
    END IF;

    IF p_projects IS NULL OR jsonb_typeof(p_projects) <> 'array' THEN
        RAISE EXCEPTION 'Projects must be an array';
    END IF;
    IF jsonb_array_length(p_projects) > 1000 THEN
        RAISE EXCEPTION 'A device publishes at most 1000 projects';
    END IF;
    IF p_applied_removals IS NULL OR jsonb_typeof(p_applied_removals) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(p_applied_removals)) > 1000
       OR EXISTS (SELECT 1 FROM jsonb_each(p_applied_removals) e WHERE jsonb_typeof(e.value) <> 'string') THEN
        RAISE EXCEPTION 'Applied removals must be a project to command map';
    END IF;
    FOR v_project IN SELECT value FROM jsonb_array_elements(p_projects) LOOP
        IF jsonb_typeof(v_project) <> 'object'
           OR jsonb_typeof(v_project -> 'local_project_id') IS DISTINCT FROM 'string' OR v_project ->> 'local_project_id' = ''
           OR jsonb_typeof(v_project -> 'name') IS DISTINCT FROM 'string'
           OR jsonb_typeof(v_project -> 'root_path') IS DISTINCT FROM 'string' OR v_project ->> 'root_path' = ''
           OR (v_project ? 'chat_id' AND jsonb_typeof(v_project -> 'chat_id') NOT IN ('string', 'null'))
           OR (v_project ? 'group_representative' AND jsonb_typeof(v_project -> 'group_representative') <> 'boolean')
           OR jsonb_typeof(v_project -> 'folders') IS DISTINCT FROM 'array'
           OR jsonb_typeof(v_project -> 'created_at') IS DISTINCT FROM 'string' THEN
            RAISE EXCEPTION 'Invalid project %', left(v_project::text, 200);
        END IF;
        BEGIN
            PERFORM (v_project ->> 'created_at')::timestamp with time zone;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
            RAISE EXCEPTION 'Invalid project %', left(v_project::text, 200);
        END;
        IF jsonb_array_length(v_project -> 'folders') > 1000 THEN
            RAISE EXCEPTION 'A project publishes at most 1000 folders';
        END IF;
        FOR v_folder IN SELECT value FROM jsonb_array_elements(v_project -> 'folders') LOOP
            IF jsonb_typeof(v_folder) <> 'object'
               OR jsonb_typeof(v_folder -> 'workspace_id') IS DISTINCT FROM 'string' OR v_folder ->> 'workspace_id' = ''
               OR (v_folder ->> 'kind') IS DISTINCT FROM 'root' AND (v_folder ->> 'kind') IS DISTINCT FROM 'attached'
               OR jsonb_typeof(v_folder -> 'path') IS DISTINCT FROM 'string' OR v_folder ->> 'path' = ''
               OR (v_folder ? 'attached_at' AND jsonb_typeof(v_folder -> 'attached_at') NOT IN ('string', 'null')) THEN
                RAISE EXCEPTION 'Invalid folder %', left(v_folder::text, 200);
            END IF;
        END LOOP;
    END LOOP;
    IF (SELECT count(DISTINCT value ->> 'local_project_id') FROM jsonb_array_elements(p_projects))
       <> jsonb_array_length(p_projects) THEN
        RAISE EXCEPTION 'Each project is published once';
    END IF;

    UPDATE identity.device_projects d SET removal_requested_at = NULL, removal_command_id = NULL, updated_at = now()
    FROM identity.gugu_device_commands c
    WHERE d.device_id = p_device_id AND d.user_id = v_me AND d.removal_requested_at IS NOT NULL
      AND c.id = d.removal_command_id AND c.user_id = v_me AND c.status = 'done'
      AND c.type = 'project.set_removed' AND c.payload->>'removed' = 'true'
      AND p_applied_removals->>d.local_project_id = c.id::text
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_projects) p WHERE p.value->>'local_project_id' = d.local_project_id);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := v_rows > 0;

    DELETE FROM identity.device_projects d
     WHERE d.device_id = p_device_id
       AND d.removal_requested_at IS NULL AND d.removal_command_id IS NULL
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(p_projects) p WHERE p.value ->> 'local_project_id' = d.local_project_id
       );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := v_changed OR v_rows > 0;

    -- Folders are stored with exactly the four keys, so a row compares equal when nothing a reader sees changed.
    INSERT INTO identity.device_projects AS d
           (device_id, user_id, local_project_id, name, root_path, created_at, chat_id, group_representative, folders)
    SELECT p_device_id, v_me, p.value ->> 'local_project_id', p.value ->> 'name', p.value ->> 'root_path',
           (p.value ->> 'created_at')::timestamp with time zone,
           -- Someone else's group is not this account's to bind: the row is kept, without the group (20261109210000).
           -- ❌ refusing the whole publish: a client that already holds such a binding would never sync any project again.
           CASE WHEN chat.may_bind_project_group(p.value ->> 'chat_id', v_me::text) THEN p.value ->> 'chat_id' END,
           COALESCE((p.value -> 'group_representative')::boolean, false),
           (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'workspace_id', f.value ->> 'workspace_id',
                       'kind', f.value ->> 'kind',
                       'path', f.value ->> 'path',
                       'attached_at', f.value -> 'attached_at'
                   ) ORDER BY f.ordinality), '[]'::jsonb)
              FROM jsonb_array_elements(p.value -> 'folders') WITH ORDINALITY f)
      FROM jsonb_array_elements(p_projects) p
    ON CONFLICT (device_id, local_project_id) DO UPDATE
       SET name = EXCLUDED.name,
           root_path = EXCLUDED.root_path,
           created_at = EXCLUDED.created_at,
           chat_id = EXCLUDED.chat_id,
           group_representative = EXCLUDED.group_representative,
           folders = EXCLUDED.folders,
           updated_at = now()
     WHERE d.removal_requested_at IS NULL AND d.removal_command_id IS NULL
       AND (d.name, d.root_path, d.created_at, d.chat_id, d.group_representative, d.folders) IS DISTINCT FROM
           (EXCLUDED.name, EXCLUDED.root_path, EXCLUDED.created_at, EXCLUDED.chat_id, EXCLUDED.group_representative,
            EXCLUDED.folders);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := v_changed OR v_rows > 0;

    -- A project bound to a group is that group's project: record it (20261109210000). Only ids this account may bind
    -- (the same test that kept or dropped the row's group above).
    INSERT INTO chat.project_groups (chat_id)
    SELECT DISTINCT p.value ->> 'chat_id' FROM jsonb_array_elements(p_projects) p
     WHERE chat.may_bind_project_group(p.value ->> 'chat_id', v_me::text)
    ON CONFLICT (chat_id) DO NOTHING;

    IF v_changed THEN
        PERFORM chat.publish_user_revision(v_me::text, 'device_changed', jsonb_build_object('device_id', p_device_id, 'kind', 'projects'), false);
    END IF;
    RETURN v_changed;
END;
$function$;

GRANT EXECUTE ON FUNCTION chat.file_transfer_expire(integer) TO service_role;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_registered(text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION identity.publish_device_projects(text, jsonb, jsonb) TO authenticated, service_role;
DROP FUNCTION identity.publish_device_projects_v2(text, jsonb, jsonb);
COMMIT;
