BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='10s';
DO $gate$
DECLARE candidate uuid[]; current_target uuid; restricted boolean;
BEGIN
    SELECT test_user_id,test_only INTO STRICT current_target,restricted
      FROM account_deletion_private.access WHERE singleton FOR UPDATE;
    IF NOT restricted THEN RAISE EXCEPTION 'Dedicated-account restriction must remain enabled'; END IF;
    SELECT array_agg(id) INTO candidate FROM auth.users
      WHERE raw_app_meta_data->>'gugu_self_deletion_fixture'='v1'
        AND role='authenticated' AND email_confirmed_at IS NOT NULL
        AND deleted_at IS NULL AND created_at>=now()-interval '1 day';
    IF cardinality(candidate) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Exactly one new verified fixture is required'; END IF;
    IF current_target IS NOT NULL AND current_target<>candidate[1] THEN RAISE EXCEPTION 'Another dedicated account is already allowed'; END IF;
    IF EXISTS(SELECT 1 FROM account_deletion_private.requests
      WHERE state='processing' AND lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'Deletion is still in flight'; END IF;
    UPDATE account_deletion_private.access SET test_user_id=candidate[1] WHERE singleton;
END $gate$;
SELECT count(*) FILTER (WHERE test_only)::int AS restricted_gates,
       count(test_user_id)::int AS allowed_accounts
FROM account_deletion_private.access;
COMMIT;
