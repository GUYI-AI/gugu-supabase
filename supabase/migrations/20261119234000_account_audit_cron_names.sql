-- The procedure/check functions select their work window in Asia/Shanghai.
-- These names describe the scheduler trigger, independent of its timezone.
-- Replace names through pg_cron's owner-authorized API, never extension-table DML.
-- Job IDs change. Run history remains under the retired IDs; no history is erased.
DO $$
DECLARE expected record; installed record; replacement record; replacement_id bigint;
BEGIN
    IF current_user<>'postgres' THEN RAISE EXCEPTION 'Account audit cron installer must be postgres'; END IF;
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
        SELECT * INTO STRICT installed FROM cron.job WHERE jobname=expected.old_name AND username=current_user;
        IF installed.schedule<>expected.schedule OR installed.command<>expected.command
          OR installed.username<>'postgres' OR installed.database<>current_database()
          OR EXISTS(SELECT 1 FROM cron.job WHERE jobname=expected.new_name AND username=current_user) THEN
            RAISE EXCEPTION 'Account audit cron predecessor differs';
        END IF;
        replacement_id:=cron.schedule(expected.new_name,installed.schedule,installed.command);
        PERFORM cron.alter_job(replacement_id,active:=installed.active);
        SELECT * INTO STRICT replacement FROM cron.job WHERE jobid=replacement_id;
        IF replacement.schedule IS DISTINCT FROM installed.schedule
          OR replacement.command IS DISTINCT FROM installed.command
          OR replacement.username IS DISTINCT FROM installed.username
          OR replacement.database IS DISTINCT FROM installed.database
          OR replacement.nodename IS DISTINCT FROM installed.nodename
          OR replacement.nodeport IS DISTINCT FROM installed.nodeport
          OR replacement.active IS DISTINCT FROM installed.active THEN
            RAISE EXCEPTION 'Account audit cron replacement differs';
        END IF;
        IF NOT cron.unschedule(installed.jobid) THEN RAISE EXCEPTION 'Account audit cron removal failed'; END IF;
    END LOOP;
END $$;
