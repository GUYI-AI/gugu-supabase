-- Back up the exact IDs selected in one report. psql variables: namespace, ids (JSON array),
-- account, run (fresh UUID), evidence (the proof reference from report).
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS chat_private.managed_upload_closure_backup (
    run uuid NOT NULL, reservation_id uuid NOT NULL, account_id text NOT NULL, staging_key text NOT NULL,
    namespace jsonb NOT NULL, proof text NOT NULL, state text NOT NULL, staging_deleted boolean NOT NULL,
    close_evidence text, held_bytes bigint NOT NULL, PRIMARY KEY(run,reservation_id)
);
REVOKE ALL ON chat_private.managed_upload_closure_backup FROM PUBLIC,anon,authenticated,service_role,gugu_files;
CREATE TEMP TABLE closure_batch ON COMMIT DROP AS
SELECT c.reservation_id,c.account_id,c.staging_key,c.held_bytes,r.state,u.staging_deleted,u.close_evidence
FROM chat.file_managed_upload_closable(:'namespace'::jsonb,500,true,
    ARRAY(SELECT jsonb_array_elements_text(:'ids'::jsonb)::uuid)) c
JOIN chat.file_transfer_uploads u USING(reservation_id) JOIN chat.file_transfer_reservations r ON r.id=c.reservation_id
WHERE c.account_id=:'account' AND c.evidence=:'evidence';
-- CHECK fails atomically if any selected row changed or the submitted list contains duplicates.
CREATE TEMP TABLE closure_count (matched boolean NOT NULL CHECK(matched)) ON COMMIT DROP;
INSERT INTO closure_count SELECT count(*)=jsonb_array_length(:'ids'::jsonb) AND count(*) BETWEEN 1 AND 500 FROM closure_batch;
INSERT INTO chat_private.managed_upload_closure_backup
SELECT :'run'::uuid,reservation_id,account_id,staging_key,:'namespace'::jsonb,:'evidence',state,staging_deleted,close_evidence,held_bytes
FROM closure_batch;
SELECT count(*) AS backed_up,sum(held_bytes) AS held_bytes FROM closure_batch;
COMMIT;
