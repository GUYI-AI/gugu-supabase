-- Account erasure queued the erased owner's S3 multipart uploads into identity.storage_multipart_abort_outbox,
-- which nothing consumes, and nothing in the product creates multipart uploads. Remove the dead queue and its producer.
DO $erase$
DECLARE definition text;
    before_text text := $old$    PERFORM 1 FROM storage.s3_multipart_uploads upload
    WHERE upload.owner_id = ANY(delete_user_ids)
    ORDER BY upload.id FOR UPDATE;
    INSERT INTO identity.storage_multipart_abort_outbox (upload_id, bucket_id, object_key)
    SELECT upload.id, upload.bucket_id, upload.key
    FROM storage.s3_multipart_uploads upload
    WHERE upload.owner_id = ANY(delete_user_ids)
    ON CONFLICT (upload_id) DO NOTHING;

$old$;
BEGIN
    SELECT pg_get_functiondef('identity.erase_human_account(text)'::regprocedure) INTO definition;
    IF position(before_text IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected predecessor: identity.erase_human_account(text)';
    END IF;
    EXECUTE replace(definition,before_text,'');
END $erase$;

-- Rows here would be real incomplete uploads with no other record: refuse to drop them silently.
DO $stock$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM identity.storage_multipart_abort_outbox;
    IF n>0 THEN
        RAISE EXCEPTION 'identity.storage_multipart_abort_outbox holds % rows; abort those uploads in Storage before this release', n;
    END IF;
END $stock$;
DROP TABLE identity.storage_multipart_abort_outbox;
