-- The GC kick calls the attachments function only when it has work. It counted only blobs due for collection, but the
-- same run also aborts expired multipart uploads and removes upload copies (file_private.upload_copy_leftovers); with no
-- blob due, those waited for one. The kick now calls when any of the three is due. Same call, same lease and budget.
DO $kick$
DECLARE definition text := pg_get_functiondef('chat.file_blob_gc_kick()'::regprocedure);
    step text := '     AND NOT EXISTS(SELECT 1 FROM chat.file_blob_gc WHERE status=''running'' AND claimed_at<now()-interval ''600 seconds'') THEN
    RETURN NULL;';
BEGIN
    IF strpos(definition, step) = 0 THEN RAISE EXCEPTION 'Unexpected file_blob_gc_kick definition; refusing a partial upgrade'; END IF;
    EXECUTE replace(definition, step, '     AND NOT EXISTS(SELECT 1 FROM chat.file_blob_gc WHERE status=''running'' AND claimed_at<now()-interval ''600 seconds'')
     AND NOT EXISTS(SELECT 1 FROM file_private.upload_copy_leftovers)
     AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_uploads u JOIN chat.file_transfer_reservations r ON r.id=u.reservation_id
                     WHERE u.upload_id IS NOT NULL AND r.expires_at<=now()) THEN
    RETURN NULL;');
END $kick$;

-- The kick runs every few minutes; its two new checks must not scan the upload ledger. Each partial index holds only rows
-- that can become due: copies not yet removed, except direct uploads that registered (their object is the blob's own and
-- never a leftover), and permits with an open multipart upload. Both stay small once the backlog is collected.
CREATE INDEX file_transfer_uploads_copy_pending_idx ON chat.file_transfer_uploads (reservation_id)
    WHERE NOT staging_deleted AND (blob_id IS NULL OR object_key IS NULL);
CREATE INDEX file_transfer_uploads_open_parts_idx ON chat.file_transfer_uploads (reservation_id)
    WHERE upload_id IS NOT NULL;
