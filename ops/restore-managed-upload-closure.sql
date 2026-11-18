-- Restore conservative ledger holds for this run after disabling its proof and draining cleanup workers.
-- Physical removal is irreversible; registered final objects and receipts were never selected for deletion.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
WITH restored AS (
    UPDATE chat.file_transfer_uploads u SET staging_deleted=b.staging_deleted,close_evidence=b.close_evidence
    FROM chat_private.managed_upload_closure_backup b,chat.file_transfer_reservations r
    WHERE b.run=:'run'::uuid AND u.reservation_id=b.reservation_id AND u.account_id=b.account_id
      AND u.staging_key=b.staging_key AND r.id=b.reservation_id AND r.kind='upload' AND r.state='settled'
      AND r.account_id=b.account_id AND r.subject=b.staging_key AND u.staging_deleted
      AND u.close_evidence='sweep:'||b.run::text||':'||b.proof
    RETURNING u.reservation_id,b.state
)
UPDATE chat.file_transfer_reservations r SET state=b.state FROM restored b WHERE r.id=b.reservation_id;
COMMIT;
