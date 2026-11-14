BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='10s';
DO $gate$
BEGIN
    PERFORM 1 FROM account_deletion_private.access WHERE singleton FOR UPDATE;
    IF EXISTS(SELECT 1 FROM account_deletion_private.requests
      WHERE state='processing') THEN RAISE EXCEPTION 'Deletion outcome must be reconciled before closing'; END IF;
    UPDATE account_deletion_private.access SET test_only=true,test_user_id=NULL WHERE singleton;
    UPDATE account_deletion_private.requests SET state='expired',lease_token=NULL,lease_until=NULL
      WHERE state IN ('sending','challenge','verifying','retry_wait');
END $gate$;
SELECT count(*) FILTER (WHERE test_only)::int AS restricted_gates,
       count(test_user_id)::int AS allowed_accounts,
       (SELECT count(*)::int FROM account_deletion_private.requests
        WHERE state IN ('sending','challenge','verifying','processing','retry_wait')
          AND expires_at>clock_timestamp()) AS live_requests
FROM account_deletion_private.access;
COMMIT;
