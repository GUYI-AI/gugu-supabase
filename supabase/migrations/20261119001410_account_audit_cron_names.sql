-- The procedure/check functions select their work window in Asia/Shanghai.
-- These names describe the scheduler trigger, independent of its timezone.
-- Rename in place so job IDs, run history, active state and execution binding remain.
DO $$
DECLARE expected record; installed record;
BEGIN
    FOR expected IN SELECT * FROM (VALUES
      ('account-audit-redaction-nightly','account-audit-redaction-hourly','0 * * * *',
        'CALL identity.run_account_audit_redactions(1000,20,false);'),
      ('account-audit-redaction-retry','account-audit-redaction-retry-10min','*/10 * * * *',
        'CALL identity.run_account_audit_redactions(1000,20,true);'),
      ('account-audit-redaction-daily','account-audit-redaction-check-hourly','15 * * * *',
        'SET statement_timeout=''30s''; SELECT identity.check_account_audit_redaction_daily();'),
      ('account-audit-redaction-daily-guard','account-audit-redaction-guard-hourly','20 * * * *',
        'SET statement_timeout=''30s''; SELECT identity.assert_account_audit_redaction_daily();')
    ) AS definitions(old_name,new_name,schedule,command)
    LOOP
        SELECT * INTO STRICT installed FROM cron.job WHERE jobname=expected.old_name;
        IF installed.schedule<>expected.schedule OR installed.command<>expected.command
          OR installed.username<>'postgres' OR installed.database<>current_database()
          OR EXISTS(SELECT 1 FROM cron.job WHERE jobname=expected.new_name) THEN
            RAISE EXCEPTION 'Account audit cron predecessor differs';
        END IF;
        UPDATE cron.job SET jobname=expected.new_name WHERE jobid=installed.jobid;
    END LOOP;
END $$;
