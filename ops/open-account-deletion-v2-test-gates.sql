BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='10s';
DO $gates$
DECLARE candidate uuid[]; target uuid; restricted boolean; operations boolean; preparations boolean;
BEGIN
  SELECT test_user_id,test_only INTO STRICT target,restricted FROM account_deletion_private.access WHERE singleton FOR UPDATE;
  SELECT enabled INTO STRICT operations FROM account_deletion_private.operation_access WHERE singleton FOR UPDATE;
  SELECT enabled INTO STRICT preparations FROM account_deletion_private.device_preparation_access WHERE singleton FOR UPDATE;
  IF NOT restricted THEN RAISE EXCEPTION 'Dedicated account restriction must remain enabled'; END IF;
  SELECT array_agg(id) INTO candidate FROM auth.users
    WHERE raw_app_meta_data->>'gugu_self_deletion_fixture'='v2'
      AND role='authenticated' AND email_confirmed_at IS NOT NULL AND deleted_at IS NULL
      AND created_at>=clock_timestamp()-interval '1 day'
      AND (banned_until IS NULL OR banned_until<=clock_timestamp())
      AND identity.personal_principal_is_eligible(id);
  IF cardinality(candidate) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Exactly one new verified V2 fixture is required'; END IF;
  IF target IS NOT NULL AND target<>candidate[1] THEN RAISE EXCEPTION 'Another dedicated account is already allowed'; END IF;
  IF NOT (operations AND preparations AND target IS NOT DISTINCT FROM candidate[1]) AND (
    EXISTS(SELECT 1 FROM account_deletion_private.operations WHERE state IN ('open','confirming','processing'))
    -- A completed deletion erases the device row, so its preparation keeps state='prepared' with device_id NULL.
    -- That record seals no device (every seal check is device_id equality) and is not pending custody.
    -- Only a row that is BOTH device-erased AND under a deleted operation is exempt; any other prepared row blocks.
    OR EXISTS(SELECT 1 FROM account_deletion_private.device_preparations p
      JOIN account_deletion_private.operations o ON o.id=p.operation_id
      WHERE p.state='prepared' AND NOT (p.device_id IS NULL AND o.state='deleted'))
    OR EXISTS(SELECT 1 FROM account_deletion_private.requests WHERE state IN ('verifying','processing','retry_wait')
      OR (state IN ('sending','challenge') AND expires_at>clock_timestamp()))) THEN
    RAISE EXCEPTION 'Reconcile pending deletion custody before opening admission';
  END IF;
  UPDATE account_deletion_private.access SET test_user_id=candidate[1] WHERE singleton;
  UPDATE account_deletion_private.operation_access SET enabled=true WHERE singleton;
  UPDATE account_deletion_private.device_preparation_access SET enabled=true WHERE singleton;
END $gates$;
SELECT (SELECT count(*)::int FROM account_deletion_private.access WHERE test_only) AS restricted_gates,
       (SELECT count(test_user_id)::int FROM account_deletion_private.access) AS allowed_accounts,
       (SELECT count(*)::int FROM account_deletion_private.operation_access WHERE enabled) AS operation_gates,
       (SELECT count(*)::int FROM account_deletion_private.device_preparation_access WHERE enabled) AS preparation_gates;
COMMIT;
