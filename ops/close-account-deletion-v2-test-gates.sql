BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='10s';
-- Closing admission preserves all operations, preparations and unknown outcomes.
-- Receipt result and original-owner cancellation remain available independently.
DO $gates$
BEGIN
  PERFORM 1 FROM account_deletion_private.access WHERE singleton FOR UPDATE;
  PERFORM 1 FROM account_deletion_private.operation_access WHERE singleton FOR UPDATE;
  PERFORM 1 FROM account_deletion_private.device_preparation_access WHERE singleton FOR UPDATE;
  UPDATE account_deletion_private.access SET test_only=true,test_user_id=NULL WHERE singleton;
  UPDATE account_deletion_private.operation_access SET enabled=false WHERE singleton;
  UPDATE account_deletion_private.device_preparation_access SET enabled=false WHERE singleton;
END $gates$;
SELECT (SELECT count(*)::int FROM account_deletion_private.access WHERE test_only) AS restricted_gates,
       (SELECT count(test_user_id)::int FROM account_deletion_private.access) AS allowed_accounts,
       (SELECT count(*)::int FROM account_deletion_private.operation_access WHERE enabled) AS operation_gates,
       (SELECT count(*)::int FROM account_deletion_private.device_preparation_access WHERE enabled) AS preparation_gates,
       (SELECT count(*)::int FROM account_deletion_private.operations WHERE state IN ('open','confirming','processing')) AS active_operations,
       (SELECT count(*)::int FROM account_deletion_private.device_preparations WHERE state='prepared') AS prepared_devices;
COMMIT;
