-- Restore conservative ledger holds for this run after disabling its proof and draining cleanup workers.
-- Physical removal is irreversible; registered final objects and receipts were never selected for deletion.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
CREATE TEMP TABLE closure_restore ON COMMIT DROP AS
SELECT b.* FROM chat_private.managed_upload_closure_backup b
JOIN chat.file_transfer_uploads u USING(reservation_id,account_id,staging_key)
JOIN chat.file_transfer_reservations r ON r.id=b.reservation_id AND r.account_id=b.account_id AND r.subject=b.staging_key
JOIN chat.file_staging_cleanup q ON q.staging_key=b.staging_key AND q.reservation_id=b.reservation_id
WHERE b.run=:'run'::uuid AND r.kind='upload' AND r.state='settled' AND u.staging_deleted
  AND q.state='completed' AND q.window_namespace=b.namespace AND q.window_reference=b.proof
  AND q.closure_receipt=u.close_evidence AND u.close_evidence='sweep:'||b.run::text||':'||b.proof;
-- Restore a publication marker or a retryable job as it was before this batch.
UPDATE chat.file_staging_cleanup q SET (state,terminal_at,permit_expires_at,terminal_evidence_sha256,
  attempt_count,next_attempt_at,claim_token,claimed_at,last_error,completed_at,window_namespace,window_reference,closure_receipt)=
  (old.state,old.terminal_at,old.permit_expires_at,old.terminal_evidence_sha256,
   old.attempt_count,old.next_attempt_at,old.claim_token,old.claimed_at,old.last_error,old.completed_at,old.window_namespace,old.window_reference,old.closure_receipt)
FROM closure_restore b CROSS JOIN LATERAL jsonb_populate_record(NULL::chat.file_staging_cleanup,b.queue_before) old
WHERE b.staging_key=q.staging_key AND b.queue_before IS NOT NULL;
DELETE FROM chat.file_staging_cleanup q USING closure_restore b
WHERE b.staging_key=q.staging_key AND b.queue_before IS NULL AND q.registered_blob_id IS NULL;
UPDATE chat.file_transfer_uploads u SET staging_deleted=b.staging_deleted,close_evidence=b.close_evidence
FROM closure_restore b WHERE u.staging_key=b.staging_key;
UPDATE chat.file_transfer_reservations r SET state=b.state FROM closure_restore b WHERE r.id=b.reservation_id;
SELECT count(*) AS restored,sum(held_bytes) AS held_bytes FROM closure_restore;
COMMIT;
