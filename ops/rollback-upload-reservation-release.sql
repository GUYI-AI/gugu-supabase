-- Roll back 20261119160000: open upload holds count again until an explicit closure, and registration no longer settles.
-- Kept: file_private.upload_release_backup_20261119, and reservations already settled by a registration or a
-- confirmed staging removal (their stored bytes are counted as storage, so the ledger stays correct).
-- Not restored: the committed-staging cleanup worker the migration removed. It was disabled by default and is not
-- needed to keep the ledger correct (it only ever released holds early); its queue and control rows are kept in
-- file_private.staging_cleanup_backup_20261119 and _control_backup_20261119, and 20261118130100 holds its code.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
DROP TRIGGER file_upload_release_at ON chat.file_transfer_reservations;
DROP FUNCTION chat.file_upload_release_at();

CREATE FUNCTION pg_temp.swap(p_fn regprocedure,p_from text,p_to text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE definition text:=pg_get_functiondef(p_fn);
BEGIN
    IF strpos(definition,p_from)=0 THEN RAISE EXCEPTION 'Unexpected % body; refusing a partial rollback',p_fn; END IF;
    EXECUTE replace(definition,p_from,p_to);
END $$;
SELECT pg_temp.swap('chat.file_transfer_usage(text,text,text)',' AND (r.release_at IS NULL OR r.release_at>now())','');
SELECT pg_temp.swap('chat.file_temporary_usage(text)',' AND (release_at IS NULL OR release_at>now())','');
SELECT pg_temp.swap('chat.file_transfer_reference_guard()',
    E'\n          AND (reservation.release_at IS NULL OR reservation.release_at>now())','');
SELECT pg_temp.swap('chat.file_managed_upload_registered(text,text,jsonb)',
    E'UPDATE chat.file_transfer_reservations SET actual_bytes=b.size_bytes,state=''settled'' WHERE id=u.reservation_id;\n    UPDATE chat.file_transfer_uploads SET close_evidence=''registered:''||b.id::text WHERE staging_key=p_key AND close_evidence IS NULL;',
    'UPDATE chat.file_transfer_reservations SET actual_bytes=b.size_bytes WHERE id=u.reservation_id;');

CREATE OR REPLACE FUNCTION chat.file_managed_upload_closed(p_key text,p_evidence text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    -- Trusted cleanup calls this only with terminal upload evidence and confirmed physical removal.
    -- Expiry plus HEAD 404 alone does not prove that an accepted upload cannot finish late.
    IF length(COALESCE(p_evidence,'')) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Terminal provider evidence is required'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    UPDATE chat.file_transfer_reservations r SET state='settled'
     FROM chat.file_transfer_uploads u WHERE u.staging_key=p_key AND r.id=u.reservation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Upload reservation was not found'; END IF;
    UPDATE chat.file_transfer_uploads SET staging_deleted=true,close_evidence=p_evidence WHERE staging_key=p_key;
END $$;

CREATE OR REPLACE FUNCTION chat.attachment_expired_staging(p_bucket text)
RETURNS TABLE(name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $staging$
 SELECT name FROM storage.objects
 WHERE bucket_id=p_bucket AND name LIKE 'staging/%' AND created_at < now()-interval '1 day'
 ORDER BY created_at LIMIT 50
$staging$;

DROP FUNCTION chat.file_upload_release_bound();
ALTER TABLE chat.file_transfer_reservations DROP COLUMN release_at;
NOTIFY pgrst,'reload schema';
COMMIT;
