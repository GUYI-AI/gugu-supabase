BEGIN READ ONLY;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='10s';
SELECT (SELECT count(*)::int FROM account_deletion_private.access WHERE test_only) AS restricted_gates,
       (SELECT count(test_user_id)::int FROM account_deletion_private.access) AS allowed_accounts,
       (SELECT count(*)::int FROM account_deletion_private.operation_access WHERE enabled) AS operation_gates,
       (SELECT count(*)::int FROM account_deletion_private.device_preparation_access WHERE enabled) AS preparation_gates,
       (SELECT count(*)::int FROM auth.users WHERE raw_app_meta_data->>'gugu_self_deletion_fixture'='v2'
         AND role='authenticated' AND email_confirmed_at IS NOT NULL AND deleted_at IS NULL
         AND created_at>=clock_timestamp()-interval '1 day'
         AND (banned_until IS NULL OR banned_until<=clock_timestamp())
         AND identity.personal_principal_is_eligible(id)) AS fixture_candidates,
       (SELECT count(*)::int FROM account_deletion_private.operations WHERE state IN ('open','confirming','processing')) AS active_operations,
       (SELECT count(*)::int FROM account_deletion_private.device_preparations p
          JOIN account_deletion_private.operations o ON o.id=p.operation_id
          WHERE p.state='prepared' AND NOT (p.device_id IS NULL AND o.state='deleted')) AS prepared_devices,
       (SELECT count(*)::int FROM account_deletion_private.device_preparations p
          JOIN account_deletion_private.operations o ON o.id=p.operation_id
          WHERE p.state='prepared' AND p.device_id IS NULL AND o.state='deleted') AS deleted_operation_preparations,
       (SELECT count(*)::int FROM account_deletion_private.requests WHERE state IN ('verifying','processing','retry_wait')
         OR (state IN ('sending','challenge') AND expires_at>clock_timestamp())) AS live_requests;
ROLLBACK;
