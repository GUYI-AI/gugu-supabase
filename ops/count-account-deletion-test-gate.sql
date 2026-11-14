BEGIN READ ONLY;
SELECT count(*) FILTER (WHERE test_only)::int AS restricted_gates,
       count(test_user_id)::int AS allowed_accounts,
       (SELECT count(*)::int FROM auth.users
        WHERE raw_app_meta_data->>'gugu_self_deletion_fixture'='v1'
          AND role='authenticated' AND email_confirmed_at IS NOT NULL
          AND deleted_at IS NULL AND created_at>=now()-interval '1 day') AS fixture_candidates,
       (SELECT count(*)::int FROM account_deletion_private.requests
        WHERE state='processing') AS active_deletions,
       (SELECT count(*)::int FROM account_deletion_private.requests
        WHERE state IN ('sending','challenge','verifying','processing','retry_wait')
          AND expires_at>clock_timestamp()) AS live_requests
FROM account_deletion_private.access;
ROLLBACK;
