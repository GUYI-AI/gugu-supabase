-- An image's preview is a small copy its sender uploads with it, and an image is otherwise a file like any other.
--
-- 1. chat.file_previews: the preview an account offers for bytes it holds (its own sha256 claim), a managed blob uploaded
--    with no chat (so no storage reference, no usage row, no expiry of its own). A version takes the preview of its bytes
--    when it is written (chat.file_version_preview_take): the bytes' holder is the account of a device-kept version's
--    device, or the uploader of a managed blob. Moves, renames and forwards write versions of the same bytes, so they keep it.
-- 2. The preview blob is held while a version names it (chat.file_blob_held_until), whatever happens to the original's
--    cloud copy, and is queued for collection when the last such version goes. Until a version takes it, its upload
--    receipt holds it; an offer whose blob is collected goes with it.
-- 3. Readers: file_resolve_as answers `preview` {sha256, size_bytes, content_type} through the same door as the file;
--    file_preview_download_as signs the preview the way a managed file is signed.
-- 4. An image no longer has rules of its own: the image_retention expiry of a managed upload in a project group and the
--    'image' storage class are gone (an old client still reads an empty 'image' class and may name it). Large-file idle
--    expiry also covers project groups: it removes a cloud copy, never the file, and a file kept only on a device has none.
-- The CHECK on user_settings.file_storage still accepts image_retention: released clients write it; nothing reads it.
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE replaced_grants ON COMMIT DROP AS
SELECT p.oid::regprocedure AS fn, pg_get_userbyid(a.grantee) AS grantee
  FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
 WHERE a.privilege_type='EXECUTE' AND a.grantee<>0 AND a.grantee<>p.proowner
   AND p.oid IN ('chat.file_managed_upload_registered(text,text,jsonb)'::regprocedure,
       'chat.file_transfer_expire(integer)'::regprocedure,'chat.file_storage_overview_as()'::regprocedure,
       'file_private.storage_mark_audit_base(jsonb,text,text)'::regprocedure,'chat.file_blob_held_until(uuid)'::regprocedure,
       'chat.workspace_list_as_availability_base(text,text,integer,integer,text,text,text,boolean)'::regprocedure);

CREATE OR REPLACE FUNCTION pg_temp.patch(p_fn regprocedure, p_from text, p_to text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE definition text := pg_get_functiondef(p_fn);
BEGIN
    IF strpos(definition, p_from) = 0 THEN RAISE EXCEPTION 'Unexpected % definition; refusing a partial upgrade', p_fn; END IF;
    RETURN replace(definition, p_from, p_to);
END $$;

-- ── 1. Previews ──
CREATE TABLE chat.file_previews (
    account_id text NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    blob_id uuid NOT NULL REFERENCES chat.file_blobs(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, sha256)
);
CREATE INDEX file_previews_blob_idx ON chat.file_previews(blob_id);
ALTER TABLE chat.file_previews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.file_previews FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE chat.workspace_item_versions ADD COLUMN preview_blob_id uuid REFERENCES chat.file_blobs(id);
CREATE INDEX workspace_item_versions_preview_idx ON chat.workspace_item_versions(preview_blob_id) WHERE preview_blob_id IS NOT NULL;

-- The bytes' holder and claim: a managed blob's uploader (a declared one's claim before its bytes arrive), or the account
-- of the device that keeps the version.
CREATE FUNCTION chat.file_version_preview_take() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NEW.preview_blob_id IS NOT NULL THEN RETURN NEW; END IF;
    IF NEW.blob_id IS NOT NULL THEN
        SELECT p.blob_id INTO NEW.preview_blob_id FROM chat.file_blobs b
          JOIN chat.file_previews p ON p.account_id=b.created_by AND p.sha256=COALESCE(b.sha256,b.declared_sha256)
         WHERE b.id=NEW.blob_id;
    ELSIF NEW.sha256 IS NOT NULL AND NEW.host_device_id IS NOT NULL THEN
        SELECT p.blob_id INTO NEW.preview_blob_id FROM identity.gugu_devices d
          JOIN chat.file_previews p ON p.account_id=d.user_id::text AND p.sha256=NEW.sha256
         WHERE d.device_id=NEW.host_device_id;
    END IF;
    RETURN NEW;
END $$;
ALTER FUNCTION chat.file_version_preview_take() OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_version_preview_take() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER workspace_item_versions_preview_take BEFORE INSERT OR UPDATE OF blob_id, sha256, host_device_id
    ON chat.workspace_item_versions FOR EACH ROW EXECUTE FUNCTION chat.file_version_preview_take();

CREATE FUNCTION chat.file_preview_lost_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF OLD.preview_blob_id IS NOT NULL AND (TG_OP='DELETE' OR NEW.preview_blob_id IS DISTINCT FROM OLD.preview_blob_id) THEN
        PERFORM chat.file_blob_enqueue(OLD.preview_blob_id);
    END IF;
    RETURN NULL;
END $$;
ALTER FUNCTION chat.file_preview_lost_reference() OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_preview_lost_reference() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER workspace_item_versions_preview_lost AFTER DELETE OR UPDATE OF preview_blob_id
    ON chat.workspace_item_versions FOR EACH ROW EXECUTE FUNCTION chat.file_preview_lost_reference();

-- ── 2. A preview blob is held while a version names it ──
DO $held$
BEGIN
    EXECUTE pg_temp.patch('chat.file_blob_held_until(uuid)',
        '    SELECT CASE WHEN
        EXISTS(SELECT 1 FROM chat.file_temporary_transfers t',
        '    SELECT CASE WHEN
        EXISTS(SELECT 1 FROM chat.workspace_item_versions pv WHERE pv.preview_blob_id=p_blob_id)
        OR EXISTS(SELECT 1 FROM chat.file_temporary_transfers t');
END $held$;

-- The uploader offers a preview for bytes it holds. Called by the attachments function after it registered the preview's
-- own upload (no chat): the receipt names the preview blob. A later offer for the same bytes replaces it for later versions.
CREATE FUNCTION chat.file_preview_offer(p_uploader text, p_key text, p_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE kept uuid;
BEGIN
    SELECT blob_id INTO kept FROM chat.file_blob_uploads WHERE staging_key=p_key AND uploader=p_uploader;
    IF NOT FOUND THEN RAISE EXCEPTION 'The preview upload is not registered' USING HINT='file_transfer_conflict'; END IF;
    INSERT INTO chat.file_previews(account_id,sha256,blob_id) VALUES(p_uploader,p_sha256,kept)
    ON CONFLICT (account_id,sha256) DO UPDATE SET blob_id=EXCLUDED.blob_id;
    -- Versions of these bytes written before the offer (a send that lost the race with its own preview) take it now.
    UPDATE chat.workspace_item_versions v SET preview_blob_id=kept
      FROM chat.file_blobs o WHERE v.preview_blob_id IS NULL AND v.blob_id=o.id AND o.created_by=p_uploader
       AND COALESCE(o.sha256,o.declared_sha256)=p_sha256;
    UPDATE chat.workspace_item_versions v SET preview_blob_id=kept
      FROM identity.gugu_devices d WHERE v.preview_blob_id IS NULL AND v.blob_id IS NULL AND v.sha256=p_sha256
       AND d.device_id=v.host_device_id AND d.user_id::text=p_uploader;
    RETURN jsonb_build_object('status','ready','blob_id',kept);
END $$;
ALTER FUNCTION chat.file_preview_offer(text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_preview_offer(text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.file_preview_offer(text,text,text) TO service_role;
CREATE INDEX workspace_item_versions_sha_idx ON chat.workspace_item_versions(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX file_blobs_holder_sha_idx ON chat.file_blobs(created_by, COALESCE(sha256, declared_sha256));

-- ── 3. Readers ──
-- The preview of the version a reference names, through the same doors as the file: an item of a room its reader is in,
-- a message its reader can read. A preview outlives the original's cloud copy and its device: it is answered whatever
-- the file's own status.
CREATE FUNCTION chat.file_preview_for(p_ref jsonb, p_actor text) RETURNS chat.file_blobs
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE item uuid; want integer; w chat.workspace_items%ROWTYPE; b chat.file_blobs%ROWTYPE;
BEGIN
    IF p_ref ? 'message_id' THEN
        IF NOT chat.can_read_message(p_ref->>'message_id',p_actor) THEN RETURN NULL; END IF;
        SELECT file_item_id,file_version INTO item,want FROM chat.messages WHERE id=p_ref->>'message_id' AND retracted_at IS NULL;
    ELSIF p_ref ? 'item_id' THEN
        BEGIN w:=chat.workspace_item_for(p_ref->>'item_id',p_actor,false);
        EXCEPTION WHEN raise_exception THEN RETURN NULL; END;
        item:=w.id; want:=COALESCE((p_ref->>'version')::integer,w.version);
    END IF;
    IF item IS NULL THEN RETURN NULL; END IF;
    SELECT f.* INTO b FROM chat.workspace_item_versions v JOIN chat.file_blobs f ON f.id=v.preview_blob_id
     WHERE v.item_id=item AND v.n=want;
    RETURN CASE WHEN FOUND THEN b END;
END $$;
ALTER FUNCTION chat.file_preview_for(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_preview_for(jsonb,text) FROM PUBLIC, anon, authenticated, service_role;

DO $resolve$
BEGIN
    EXECUTE replace(pg_get_functiondef('chat.file_resolve_as(jsonb,text)'::regprocedure),
        'CREATE OR REPLACE FUNCTION chat.file_resolve_as(', 'CREATE FUNCTION chat.file_resolve_preview_base(');
END $resolve$;
ALTER FUNCTION chat.file_resolve_preview_base(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_resolve_preview_base(jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION chat.file_resolve_as(p_ref jsonb, p_as text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb:=chat.file_resolve_preview_base(p_ref,p_as); b chat.file_blobs;
BEGIN
    b:=chat.file_preview_for(p_ref,chat.workspace_actor_for(p_as));
    IF b.id IS NULL THEN RETURN result; END IF;
    RETURN result||jsonb_build_object('preview',
        jsonb_build_object('sha256',b.sha256,'size_bytes',b.size_bytes,'content_type',b.content_type));
END $$;
ALTER FUNCTION chat.file_resolve_as(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_resolve_as(jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.file_resolve_as(jsonb,text) TO authenticated;

-- A preview download: the same reservation, quota and GC fence as a managed file's, on the preview's own object. It
-- touches no storage reference: the preview has none, and reading it is not activity on the original.
CREATE FUNCTION chat.file_preview_download_as(p_ref jsonb, p_as text, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); b chat.file_blobs; o chat.file_transfer_storage%ROWTYPE;
    v chat.file_transfer_reservations%ROWTYPE; g text; chat_id text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-download:'||p_id::text,0));
    b:=chat.file_preview_for(p_ref,actor);
    IF b.id IS NULL THEN RETURN jsonb_build_object('status','gone'); END IF;
    chat_id:=CASE WHEN p_ref ? 'message_id' THEN (SELECT m.chat_id FROM chat.messages m WHERE m.id=p_ref->>'message_id')
        ELSE (SELECT w.chat_id FROM chat.workspace_items w WHERE w.id=(p_ref->>'item_id')::uuid) END;
    g:=chat.file_transfer_group(chat_id);
    PERFORM chat.file_blob_take(b.id);
    PERFORM chat.file_transfer_track(b.id,NULL,actor);
    SELECT * INTO o FROM chat.file_transfer_storage WHERE bucket_id=b.bucket_id AND object_name=b.object_name FOR SHARE;
    v:=chat.file_transfer_reserve(p_id,'download',auth.uid()::text,g,greatest(1,b.size_bytes),'object:'||o.id::text);
    IF v.expires_at<=now() OR v.state='settled' THEN
        RAISE EXCEPTION 'Download authorization expired; use a new request identifier' USING HINT='file_transfer_expired';
    END IF;
    UPDATE chat.file_transfer_reservations SET state='issued' WHERE id=v.id;
    RETURN jsonb_build_object('status','ready','bucket_id',b.bucket_id,'object_name',b.object_name,'sha256',b.sha256,
        'size_bytes',b.size_bytes,'content_type',b.content_type,'storage_id',o.id,'download_id',v.id,
        'signed_at',v.created_at,'expires_at',v.expires_at);
END $$;
ALTER FUNCTION chat.file_preview_download_as(jsonb,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_preview_download_as(jsonb,text,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.file_preview_download_as(jsonb,text,uuid) TO authenticated;

-- ── 4. No image rules ──
DO $plain$
DECLARE definition text;
    image_rule text := '    -- Fixed when the image is stored; sending it again, also after it expired, starts a new interval.
    IF u.blob_id IS NULL AND b.content_type LIKE ''image/%'' AND chat.is_project_group(u.chat_id)
       AND NOT (chat.file_storage_of(u.account_id)->>''proactive_upload'')::boolean THEN
        UPDATE chat.file_transfer_storage_refs SET expires_at=now()+(chat.file_storage_of(u.account_id)->>''image_retention'')::interval
          WHERE storage_id=(SELECT id FROM chat.file_transfer_storage WHERE blob_id=b.id) AND chat_id=u.chat_id;
    END IF;
';
BEGIN
    -- Sent again after its copy expired: the copy is back, kept unless this upload declares otherwise (as a first send).
    definition := pg_temp.patch('chat.file_managed_upload_registered(text,text,jsonb)',
        'SET expired_at=NULL,last_download_at=NULL,retention_started_at=now()',
        'SET expired_at=NULL,expires_at=NULL,last_download_at=NULL,retention_started_at=now()');
    IF strpos(definition, image_rule) = 0 THEN RAISE EXCEPTION 'Unexpected file_managed_upload_registered definition; refusing a partial upgrade'; END IF;
    EXECUTE replace(definition, image_rule, '');
    EXECUTE pg_temp.patch('chat.file_transfer_expire(integer)',
        '              AND COALESCE(ref.last_download_at,ref.retention_started_at)<=now()-make_interval(secs=>idle_seconds::integer)
              AND NOT chat.is_project_group(ref.chat_id))',
        '              AND COALESCE(ref.last_download_at,ref.retention_started_at)<=now()-make_interval(secs=>idle_seconds::integer))');
    EXECUTE replace(pg_temp.patch('chat.file_storage_overview_as()',
        'CASE WHEN b.content_type LIKE ''image/%'' THEN ''image'' WHEN ref.expires_at IS NOT NULL THEN ''temporary'' ELSE ''kept'' END AS class',
        'CASE WHEN ref.expires_at IS NOT NULL THEN ''temporary'' ELSE ''kept'' END AS class'),
        'large_file_idle_seconds, project chats exempt); null when the deployment sets no such policy.',
        'large_file_idle_seconds; a cloud copy only); null when the deployment sets no such policy.');
    EXECUTE pg_temp.patch('file_private.storage_mark_audit_base(jsonb,text,text)',
        '                  AND CASE r->>''class'' WHEN ''image'' THEN b.content_type LIKE ''image/%''
                      WHEN ''temporary'' THEN b.content_type NOT LIKE ''image/%'' AND ref.expires_at IS NOT NULL
                      ELSE b.content_type NOT LIKE ''image/%'' AND ref.expires_at IS NULL END;',
        '                  AND CASE r->>''class'' WHEN ''image'' THEN false
                      WHEN ''temporary'' THEN ref.expires_at IS NOT NULL
                      ELSE ref.expires_at IS NULL END;');
    EXECUTE pg_temp.patch('chat.workspace_list_as_availability_base(text,text,integer,integer,text,text,text,boolean)',
        'CASE WHEN ref.found AND ref.expired_at IS NULL THEN CASE WHEN ref.content_type LIKE ''image/%'' THEN ''image''
               WHEN ref.expires_at IS NOT NULL THEN ''temporary'' ELSE ''kept'' END END,',
        'CASE WHEN ref.found AND ref.expired_at IS NULL THEN CASE WHEN ref.expires_at IS NOT NULL THEN ''temporary'' ELSE ''kept'' END END,');
END $plain$;

DO $regrant$
DECLARE r record;
BEGIN
    FOR r IN SELECT fn, grantee FROM replaced_grants LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', r.fn, r.grantee);
    END LOOP;
END $regrant$;

NOTIFY pgrst,'reload schema';
