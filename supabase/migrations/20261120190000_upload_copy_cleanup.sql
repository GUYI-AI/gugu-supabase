-- Every upload's leftover copy is removed by the attachments GC from the upload ledger, on every store. No provider
-- lifecycle rule takes part. (Community Storage keeps its listing of the staging prefix, which also finds copies the
-- ledger no longer names.)
--
-- Three kinds of leftover, each a row of chat.file_transfer_uploads whose copy is not yet removed (NOT staging_deleted):
--   abandoned  never registered and its permit released: the bytes at its staging key (older clients) or at its direct
--              object (unless a blob owns that object) can no longer be registered and no reader is signed for them;
--   registered a staging permit whose bytes were registered and its permit expired: the staging copy is redundant once
--              its blob's object exists with the same bytes, which the GC verifies before removing it (a replay of a
--              still-valid signature could recreate a copy removed earlier);
--   orphaned   a staging permit whose blob was collected since (blob_id is SET NULL, the reservation settled): nothing
--              names its staging copy any more. A direct permit's bytes were the blob's own object, collected with it.
-- A copy is recorded removed only after the store confirms it. A registered copy whose blob's object cannot be verified
-- is kept, and claimed again after every other candidate. Rows of relay uploads ('temporary/') are not upload copies.

ALTER TABLE chat.file_transfer_uploads ADD COLUMN cleanup_tried_at timestamptz;

CREATE VIEW file_private.upload_copy_leftovers AS
SELECT o.staging_key, o.cleanup_tried_at,
       CASE WHEN o.blob_id IS NOT NULL THEN 'registered' WHEN r.state = 'settled' THEN 'orphaned' ELSE 'abandoned' END AS kind,
       COALESCE(o.object_key, o.staging_key) AS copy_key, o.upload_id,
       o.object_key IS NOT NULL
           AND EXISTS(SELECT 1 FROM chat.file_blobs x WHERE x.bucket_id = 'oss' AND x.object_name = o.object_key) AS object_owned,
       b.object_name AS blob_object, b.size_bytes AS blob_size
  FROM chat.file_transfer_uploads o
  JOIN chat.file_transfer_reservations r ON r.id = o.reservation_id
  LEFT JOIN chat.file_blobs b ON b.id = o.blob_id
 WHERE NOT o.staging_deleted
   AND (o.staging_key LIKE 'staging/%' OR o.staging_key LIKE 'direct/%')
   AND (o.blob_id IS NULL AND r.state IN ('reserved', 'issued') AND r.release_at <= now()
        OR o.blob_id IS NULL AND r.state = 'settled' AND o.object_key IS NULL AND r.expires_at <= now()
        OR o.blob_id IS NOT NULL AND o.object_key IS NULL AND r.expires_at <= now() AND b.state = 'live');
ALTER VIEW file_private.upload_copy_leftovers OWNER TO postgres;
REVOKE ALL ON file_private.upload_copy_leftovers FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION chat.file_direct_upload_cleanup_claim(integer);
DROP FUNCTION chat.file_direct_upload_cleanup_done(text, boolean);

-- p_registered: whether the caller's store can verify a registered copy (size and content checksum); a store that
-- cannot is never handed one.
CREATE FUNCTION chat.file_upload_cleanup_claim(p_limit integer, p_registered boolean)
RETURNS TABLE(staging_key text, kind text, copy_key text, upload_id text, object_owned boolean, blob_object text, blob_size bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_registered IS NULL THEN RAISE EXCEPTION 'Invalid upload cleanup batch'; END IF;
    IF NOT pg_try_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota', 0)) THEN RETURN; END IF;
    RETURN QUERY
    WITH picked AS (
        SELECT l.staging_key, l.kind, l.copy_key, l.upload_id, l.object_owned, l.blob_object, l.blob_size, l.cleanup_tried_at
          FROM file_private.upload_copy_leftovers l
         WHERE p_registered OR l.kind <> 'registered'
         ORDER BY l.cleanup_tried_at NULLS FIRST, l.staging_key LIMIT p_limit
    ), tried AS (
        UPDATE chat.file_transfer_uploads u SET cleanup_tried_at = now() FROM picked p WHERE u.staging_key = p.staging_key
    )
    SELECT p.staging_key, p.kind, p.copy_key, p.upload_id, p.object_owned, p.blob_object, p.blob_size FROM picked p;
END $$;

-- The same candidates, read-only and in key order, for an operator's dry run before the first collection.
CREATE FUNCTION chat.file_upload_cleanup_audit(p_after text, p_limit integer)
RETURNS TABLE(staging_key text, kind text, copy_key text, upload_id text, object_owned boolean, blob_object text, blob_size bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT l.staging_key, l.kind, l.copy_key, l.upload_id, l.object_owned, l.blob_object, l.blob_size
      FROM file_private.upload_copy_leftovers l
     WHERE l.staging_key > COALESCE(p_after, '') ORDER BY l.staging_key LIMIT least(greatest(p_limit, 1), 500);
$$;

-- p_evidence says what the store confirmed. The first evidence on the row (a registration) is kept.
CREATE FUNCTION chat.file_upload_cleanup_done(p_key text, p_evidence text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF p_evidence IS NULL OR p_evidence NOT IN ('abandoned:object-deleted', 'abandoned:object-owned', 'abandoned:staging-deleted',
        'copy:verified-deleted', 'copy:absent', 'orphaned:deleted') THEN
        RAISE EXCEPTION 'Invalid upload cleanup evidence';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota', 0));
    UPDATE chat.file_transfer_uploads SET staging_deleted = true, close_evidence = COALESCE(close_evidence, p_evidence)
     WHERE file_transfer_uploads.staging_key = p_key AND NOT staging_deleted;
    IF NOT FOUND THEN RAISE EXCEPTION 'Upload cleanup is not pending for %', p_key; END IF;
END $$;

ALTER FUNCTION chat.file_upload_cleanup_claim(integer, boolean) OWNER TO postgres;
ALTER FUNCTION chat.file_upload_cleanup_audit(text, integer) OWNER TO postgres;
ALTER FUNCTION chat.file_upload_cleanup_done(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_upload_cleanup_claim(integer, boolean), chat.file_upload_cleanup_audit(text, integer),
    chat.file_upload_cleanup_done(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.file_upload_cleanup_claim(integer, boolean), chat.file_upload_cleanup_audit(text, integer),
    chat.file_upload_cleanup_done(text, text) TO service_role;
