-- Roll back 20261115120000_attachment_bytes_after_message (and its two validation releases): attachments are uploaded
-- before their message again. Run on that schema only, after the attachments function is redeployed from the release
-- before it (its `finish` route and declared commit go away; until then a new client's declared send is refused).
--
-- Messages already sent with an attachment whose bytes never settled cannot be settled any more. They stay, and their file
-- reads as an object not found (shown as unavailable), the same as any lost object:
-- - a declaration whose content is already stored joins that stored blob (its references move to it), so it reads;
-- - any other declaration becomes a content-addressed 'oss' row for its declared sha256 with no object behind it.
-- Bytes uploaded under a pending key but not settled stay in staging and are collected with it.
--
-- The release ledger keeps its rows (do not delete or edit them); a source that rolls back must still recognize them.
BEGIN;
SET LOCAL lock_timeout = '1s';

DO $pending$
DECLARE p chat.file_blobs%ROWTYPE; live uuid;
BEGIN
    FOR p IN SELECT * FROM chat.file_blobs WHERE bucket_id='pending' FOR UPDATE LOOP
        -- The release's own trigger bypass is still installed: moving references off the declaration is allowed.
        PERFORM pg_catalog.set_config('chat.file_blob_settling',p.id::text,true);
        SELECT id INTO live FROM chat.file_blobs WHERE sha256=p.declared_sha256;
        IF live IS NOT NULL THEN
            UPDATE chat.messages SET file_blob_id=live WHERE file_blob_id=p.id;
            UPDATE chat.workspace_items SET blob_id=live WHERE blob_id=p.id;
            UPDATE chat.workspace_item_versions SET blob_id=live WHERE blob_id=p.id;
            UPDATE chat.file_blob_uploads SET blob_id=live WHERE blob_id=p.id;
            DELETE FROM chat.file_blob_gc WHERE blob_id=p.id;
            DELETE FROM chat.file_blobs WHERE id=p.id;
        ELSE
            UPDATE chat.file_blobs SET bucket_id='oss',object_name=substr(p.declared_sha256,1,2)||'/'||p.declared_sha256,
                sha256=p.declared_sha256,declared_sha256=NULL,declared_width=NULL,declared_height=NULL,declared_failed_at=NULL
             WHERE id=p.id;
        END IF;
        PERFORM pg_catalog.set_config('chat.file_blob_settling','',true);
    END LOOP;
END $pending$;

-- Readers: the predecessors take their names (and so the views' bindings) back.
DO $readers$
DECLARE f record;
BEGIN
    FOR f IN SELECT * FROM (VALUES ('chat.file_resolve_as_pending_base(jsonb,text)','chat.file_resolve_as_pending_base(','chat.file_resolve_as('),
        ('chat.file_transfer_download_as_pending_base(jsonb,text,uuid)','chat.file_transfer_download_as_pending_base(','chat.file_transfer_download_as('),
        ('chat.file_urls_as_pending_base(jsonb,text)','chat.file_urls_as_pending_base(','chat.file_urls_as(')) t(sig,base,head) LOOP
        EXECUTE replace(pg_get_functiondef(f.sig::regprocedure),'CREATE OR REPLACE FUNCTION '||f.base,'CREATE OR REPLACE FUNCTION '||f.head);
        EXECUTE 'DROP FUNCTION '||f.sig;
    END LOOP;
END $readers$;
-- The predecessors' grants, as their own releases left them.
REVOKE ALL ON FUNCTION chat.file_resolve_as(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION chat.file_transfer_download_as(jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION chat.file_urls_as(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.file_resolve_as(jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.file_transfer_download_as(jsonb,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.file_urls_as(jsonb,text) TO authenticated;

-- Triggers and the storage ledger: the release's added lines come out again.
DO $patched$
DECLARE definition text;
BEGIN
    definition:=pg_get_functiondef('chat.messages_file_ref()'::regprocedure);
    EXECUTE replace(definition,
        'OR NEW.file_blob_id IS DISTINCT FROM OLD.file_blob_id AND OLD.file_blob_id::text IS DISTINCT FROM NULLIF(current_setting(''chat.file_blob_settling'',true),'''') THEN',
        'OR NEW.file_blob_id IS DISTINCT FROM OLD.file_blob_id THEN');
    definition:=pg_get_functiondef('chat.workspace_bytes_pinned()'::regprocedure);
    EXECUTE replace(definition,'
    IF OLD.blob_id::text IS NOT DISTINCT FROM NULLIF(current_setting(''chat.file_blob_settling'',true),'''') THEN RETURN NEW; END IF;','');
    definition:=pg_get_functiondef('chat.append_user_revision(text,text,jsonb,boolean)'::regprocedure);
    EXECUTE replace(definition,'''message_deleted'',
      ''message_file_changed'',','''message_deleted'',');
    definition:=pg_get_functiondef('chat.file_transfer_track(uuid,text,text)'::regprocedure);
    EXECUTE replace(definition,'
    IF b.bucket_id=''pending'' THEN RETURN NULL; END IF;','');
END $patched$;

DROP FUNCTION chat.attachment_declare(text,text,bigint,text,integer,integer);
DROP FUNCTION chat.attachment_pending_mine();
DROP FUNCTION chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb);
DROP FUNCTION chat.file_pending_changed(uuid);
DROP FUNCTION chat.file_pending_state(text,text);
DROP FUNCTION chat.file_pending_deadline();

ALTER TABLE chat.file_blobs DROP CONSTRAINT file_blobs_pending_shape;
ALTER TABLE chat.file_blobs DROP CONSTRAINT file_blobs_bucket_id_check;
ALTER TABLE chat.file_blobs ADD CONSTRAINT file_blobs_bucket_id_check
    CHECK (bucket_id IN ('oss','temporary','workspace','avatars','chat-media','attachments','feedback-screenshots')) NOT VALID;
ALTER TABLE chat.file_blobs DROP COLUMN declared_sha256, DROP COLUMN declared_width, DROP COLUMN declared_height,
    DROP COLUMN declared_failed_at;

NOTIFY pgrst,'reload schema';
COMMIT;

-- Then, on its own (not in a transaction), validate the restored bucket CHECK without holding the table:
-- ALTER TABLE chat.file_blobs VALIDATE CONSTRAINT file_blobs_bucket_id_check;
