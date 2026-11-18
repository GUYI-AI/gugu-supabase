-- psql variables: account (account ID), namespace (the active adapter's physical namespace as JSON).
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
WITH ledger AS MATERIALIZED (
    SELECT r.id,r.account_id,r.subject,r.created_at,r.expires_at,r.bytes-r.actual_bytes AS held,
           u.staging_key,u.account_id AS uploader,u.blob_id,u.upload_id,u.staging_deleted,
           (row_number() OVER (ORDER BY r.id)-1)/500 AS batch
    FROM chat.file_transfer_reservations r LEFT JOIN chat.file_transfer_uploads u ON u.reservation_id=r.id
    WHERE r.kind='upload' AND r.state IN ('reserved','issued') AND r.account_id=:'account'
), batches AS (
    SELECT batch,array_agg(id) AS ids FROM ledger GROUP BY batch
), eligible AS MATERIALIZED (
    SELECT c.reservation_id FROM batches b
    CROSS JOIN LATERAL chat.file_managed_upload_closable(:'namespace'::jsonb,500,true,b.ids) c
), proof AS (
    SELECT (SELECT settings->'upload_closure' FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*') AS p
), report AS (
    SELECT CASE WHEN staging_key IS NULL THEN 'no managed upload row'
                WHEN staging_deleted OR uploader<>account_id OR subject<>staging_key
                  OR staging_key<>'staging/'||account_id||'/'||id::text THEN 'identity or ledger mismatch'
                WHEN expires_at>=now() THEN 'permit live'
                WHEN eligible.reservation_id IS NOT NULL THEN 'covered'
                WHEN p IS NULL OR p->'namespace' IS DISTINCT FROM :'namespace'::jsonb THEN 'no verified namespace and completion evidence'
                WHEN created_at<(p->>'issued_from')::timestamptz OR expires_at>=(p->>'issued_before')::timestamptz THEN 'outside verified namespace window'
                ELSE 'completion boundary not established' END AS disposition,
           blob_id IS NOT NULL AS registered,upload_id IS NOT NULL AS recorded_multipart,greatest(held,0) AS held
    FROM ledger LEFT JOIN eligible ON eligible.reservation_id=ledger.id CROSS JOIN proof
)
SELECT now() AS snapshot,disposition,registered,recorded_multipart,count(*) AS reservations,sum(held) AS held_bytes
FROM report GROUP BY disposition,registered,recorded_multipart ORDER BY disposition,registered,recorded_multipart;
COMMIT;
