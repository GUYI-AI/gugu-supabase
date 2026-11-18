-- Run only through an authorized read-only export channel. Redirect the single
-- JSON value to a protected file; it contains object identities and is not a log.
-- This export works before the cleanup migration and never infers publication
-- from blob registration, content equality or expired capability time.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s';
SELECT jsonb_build_object('schema',1,'kind','staging-cleanup-snapshot',
    'at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'uploads',coalesce(jsonb_agg(jsonb_build_object(
        'staging_key',u.staging_key,'reservation_id',u.reservation_id,'blob_id',u.blob_id,
        'permit_expires_at',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'reservation_state',r.state,'staging_deleted',u.staging_deleted,
        'publication_committed',EXISTS(SELECT 1 FROM chat.file_blob_uploads receipt
            WHERE receipt.staging_key=u.staging_key AND receipt.uploader=u.account_id AND receipt.blob_id=u.blob_id
              AND (receipt.message_id IS NOT NULL OR receipt.item_id IS NOT NULL OR receipt.session_attachment_id IS NOT NULL))
    ) ORDER BY u.staging_key),'[]'::jsonb))
  FROM chat.file_transfer_uploads u JOIN chat.file_transfer_reservations r ON r.id=u.reservation_id
 WHERE u.staging_key LIKE 'staging/%';
ROLLBACK;
