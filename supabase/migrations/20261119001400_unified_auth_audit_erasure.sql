-- Account deletion registers bounded background work; audit scans do not run
-- on the Auth request. Both rounds and the independent retention task remain.
DO $prerequisites$
DECLARE helper regprocedure;
BEGIN
    FOREACH helper IN ARRAY ARRAY[
        to_regprocedure('identity.enqueue_account_audit_redaction(text[],text)'),
        to_regprocedure('identity.redact_registered_auth_audit_batch(uuid,integer)'),
        to_regprocedure('file_private.redact_registered_storage_audit_batch(uuid,integer)'),
        to_regprocedure('identity.registered_auth_audit_residual(uuid)'),
        to_regprocedure('file_private.registered_storage_audit_residual(uuid)')
    ] LOOP
        IF helper IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p
            WHERE p.oid=helper AND p.prosecdef AND p.proowner='postgres'::regrole) THEN
            RAISE EXCEPTION 'Install the closed audit helpers before unified Auth erasure';
        END IF;
    END LOOP;
END $prerequisites$;

-- Keep the existing erasure body and its ordered locks/DML. The additional
-- email is trusted OLD.email from the Auth trigger, held only in the restricted
-- temporary registration until both approved scan rounds are verified.
DO $upgrade$
DECLARE definition text; trigger_definition text;
    old_header text := 'FUNCTION identity.erase_human_account(p_user_id text)';
    new_header text := 'FUNCTION identity.erase_human_account(p_user_id text, p_auth_email text)';
    context_anchor text := $context$    INSERT INTO identity.account_lifecycle_context (
        transaction_id, operation, subject_user_id, delete_user_ids
    ) VALUES (
        pg_current_xact_id(), 'privacy_erasure', p_user_id, delete_user_ids
    );
$context$;
    cleanup_anchor text := '    DELETE FROM identity.account_lifecycle_context';
    trigger_anchor text := '    PERFORM identity.erase_human_account(OLD.id::text);';
BEGIN
    SELECT pg_get_functiondef('identity.erase_human_account(text)'::regprocedure) INTO definition;
    IF to_regprocedure('identity.erase_human_account(text,text)') IS NOT NULL
       OR length(definition)-length(replace(definition,old_header,''))<>length(old_header)
       OR length(definition)-length(replace(definition,context_anchor,''))<>length(context_anchor)
       OR length(definition)-length(replace(definition,cleanup_anchor,''))<>length(cleanup_anchor) THEN
        RAISE EXCEPTION 'Unexpected unified account erasure predecessor';
    END IF;
    definition:=replace(definition,old_header,new_header);
    definition:=replace(definition,context_anchor,context_anchor||chr(10)
        ||'    PERFORM identity.enqueue_account_audit_redaction(delete_user_ids,p_auth_email);'||chr(10));
    EXECUTE definition;

    SELECT pg_get_functiondef('identity.handle_deleted_auth_user()'::regprocedure) INTO trigger_definition;
    IF length(trigger_definition)-length(replace(trigger_definition,trigger_anchor,''))<>length(trigger_anchor) THEN
        RAISE EXCEPTION 'Unexpected Auth deletion trigger predecessor';
    END IF;
    EXECUTE replace(trigger_definition,trigger_anchor,
        '    PERFORM identity.erase_human_account(OLD.id::text,OLD.email);');
END $upgrade$;

-- Preserve the original private capability signature for installed callers.
-- NULL closes only the extra email match; the complete identity set is still
-- registered under the same transaction context for the two background rounds.
CREATE OR REPLACE FUNCTION identity.erase_human_account(p_user_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM identity.erase_human_account(p_user_id,NULL::text);
END $$;
ALTER FUNCTION identity.erase_human_account(text) OWNER TO postgres;
ALTER FUNCTION identity.erase_human_account(text,text) OWNER TO postgres;
ALTER FUNCTION identity.handle_deleted_auth_user() OWNER TO postgres;
ALTER FUNCTION identity.erase_human_account(text,text) SET search_path=pg_catalog;
ALTER FUNCTION identity.handle_deleted_auth_user() SET search_path=pg_catalog;
REVOKE ALL ON FUNCTION identity.erase_human_account(text),identity.erase_human_account(text,text),
    identity.handle_deleted_auth_user() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.process_account_audit_redaction(p_job_id uuid,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='500ms' AS $$
DECLARE job identity.account_audit_redaction_jobs%ROWTYPE; stamp timestamptz:=clock_timestamp();
    batch record; auth_remaining bigint; file_remaining bigint; token uuid:=gen_random_uuid();
    failure text; wait_seconds integer; new_phase text; attempt_number integer;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid audit scan limit'; END IF;
    SELECT * INTO job FROM identity.account_audit_redaction_jobs WHERE id=p_job_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN jsonb_build_object('state','unavailable'); END IF;
    IF job.state='manual_review' THEN RETURN jsonb_build_object('state','manual_review'); END IF;
    IF job.state='waiting_rescan' AND job.next_scan_at>stamp THEN
        RETURN jsonb_build_object('state','waiting_rescan','scan_round',job.scan_round);
    END IF;
    IF job.state IN ('running','verifying') AND job.lease_until>stamp THEN
        RETURN jsonb_build_object('state','busy');
    END IF;
    IF job.state IN ('pending','retry_wait') AND job.next_attempt_at>stamp THEN
        RETURN jsonb_build_object('state','retry_wait');
    END IF;
    IF stamp>=job.hard_due_at THEN
        UPDATE identity.account_audit_redaction_jobs SET state='manual_review',lease_token=NULL,
          lease_until=NULL,last_error_code='AUDIT_HARD_DEADLINE' WHERE id=job.id;
        RAISE WARNING 'Account audit redaction requires deadline escalation';
        RETURN jsonb_build_object('state','manual_review','error_code','AUDIT_HARD_DEADLINE');
    END IF;
    attempt_number:=job.attempts+1;
    BEGIN
        IF job.state='waiting_rescan' THEN
            UPDATE identity.account_audit_redaction_jobs SET scan_round=2,state='pending',phase='auth',
              cursor_id=NULL,cursor_no=NULL WHERE id=job.id RETURNING * INTO job;
        END IF;
        UPDATE identity.account_audit_redaction_jobs SET state=CASE WHEN phase='verify' THEN 'verifying' ELSE 'running' END,
          lease_token=token,lease_until=stamp+interval '5 minutes',attempts=attempt_number,last_error_code=NULL
          WHERE id=job.id RETURNING * INTO job;
        INSERT INTO identity.account_audit_redaction_context VALUES(pg_current_xact_id(),job.id,token,pg_backend_pid());
        IF job.phase='verify' THEN
            auth_remaining:=identity.registered_auth_audit_residual(job.id);
            file_remaining:=file_private.registered_storage_audit_residual(job.id);
            PERFORM identity.assert_registered_audit_context(job.id,ARRAY['verify']);
            IF auth_remaining<>0 OR file_remaining<>0 THEN
                DELETE FROM identity.account_audit_redaction_context WHERE transaction_id=pg_current_xact_id() AND job_id=job.id;
                UPDATE identity.account_audit_redaction_jobs SET
                  state=CASE WHEN scan_round=2 THEN 'manual_review' ELSE 'retry_wait' END,
                  phase=CASE WHEN scan_round=2 THEN 'verify' ELSE 'auth' END,cursor_id=NULL,cursor_no=NULL,
                  lease_token=NULL,lease_until=NULL,next_attempt_at=stamp+interval '1 minute',
                  last_error_code='AUDIT_RESIDUAL_AFTER_SCAN' WHERE id=job.id;
                RETURN jsonb_build_object('state',CASE WHEN job.scan_round=2 THEN 'manual_review' ELSE 'retry_wait' END,
                  'scan_round',job.scan_round,'auth_residual_count',auth_remaining,'file_residual_count',file_remaining);
            END IF;
            IF job.scan_round=2 AND NOT EXISTS(SELECT 1 FROM identity.account_audit_redaction_receipts
              WHERE operation_id=job.id AND scan_round=1 AND state='redacted') THEN
                RAISE EXCEPTION 'First audit scan proof is missing';
            END IF;
            INSERT INTO identity.account_audit_redaction_receipts VALUES(job.id,job.scan_round,
              CASE WHEN job.scan_round=1 THEN 'redacted' ELSE 'closed' END,clock_timestamp(),0,0)
              ON CONFLICT(operation_id,scan_round) DO NOTHING;
            DELETE FROM identity.account_audit_redaction_context WHERE transaction_id=pg_current_xact_id() AND job_id=job.id;
            IF job.scan_round=2 THEN
                DELETE FROM identity.account_audit_redaction_jobs WHERE id=job.id;
                RETURN jsonb_build_object('state','closed','scan_round',2,'auth_residual_count',0,'file_residual_count',0);
            END IF;
            UPDATE identity.account_audit_redaction_jobs SET state='waiting_rescan',phase='auth',cursor_id=NULL,cursor_no=NULL,
              first_scan_completed_at=COALESCE(first_scan_completed_at,clock_timestamp()),
              next_scan_at=GREATEST(deleted_at+interval '7 days',clock_timestamp()),
              lease_token=NULL,lease_until=NULL WHERE id=job.id;
            RETURN jsonb_build_object('state','waiting_rescan','scan_round',1,'auth_residual_count',0,'file_residual_count',0);
        END IF;
        IF job.phase='auth' THEN
            SELECT * INTO batch FROM identity.redact_registered_auth_audit_batch(job.id,p_limit);
        ELSE
            SELECT * INTO batch FROM file_private.redact_registered_storage_audit_batch(job.id,p_limit);
        END IF;
        IF batch.scanned IS NULL OR batch.locked IS NULL OR batch.changed IS NULL
          OR batch.exhausted IS NULL OR batch.blocked IS NULL OR batch.scanned NOT BETWEEN 0 AND p_limit
          OR batch.locked NOT BETWEEN 0 AND batch.scanned OR batch.changed NOT BETWEEN 0 AND batch.locked
          OR (batch.blocked AND (batch.exhausted OR batch.next_id IS DISTINCT FROM job.cursor_id
            OR batch.next_no IS DISTINCT FROM job.cursor_no)) THEN
            RAISE EXCEPTION 'Invalid bounded audit batch result';
        END IF;
        new_phase:=CASE WHEN batch.exhausted THEN CASE job.phase
          WHEN 'auth' THEN 'file_headers' WHEN 'file_headers' THEN 'file_items' ELSE 'verify' END ELSE job.phase END;
        DELETE FROM identity.account_audit_redaction_context WHERE transaction_id=pg_current_xact_id() AND job_id=job.id;
        UPDATE identity.account_audit_redaction_jobs SET phase=new_phase,
          cursor_id=CASE WHEN batch.exhausted THEN NULL ELSE batch.next_id END,
          cursor_no=CASE WHEN batch.exhausted THEN NULL ELSE batch.next_no END,
          state=CASE WHEN batch.blocked THEN 'retry_wait' ELSE 'pending' END,
          lease_token=NULL,lease_until=NULL,next_attempt_at=stamp+CASE WHEN batch.blocked THEN interval '30 seconds' ELSE interval '0 seconds' END,
          last_error_code=CASE WHEN batch.blocked THEN 'AUDIT_PAGE_LOCKED' ELSE NULL END WHERE id=job.id;
        RETURN jsonb_build_object('state',CASE WHEN batch.blocked THEN 'retry_wait' ELSE 'pending' END,
          'scan_round',job.scan_round,'phase',new_phase,'scanned',batch.scanned,'changed',batch.changed,'blocked',batch.blocked);
    EXCEPTION WHEN OTHERS THEN
        failure:=SQLSTATE; wait_seconds:=LEAST(3600,30*(1<<LEAST(attempt_number-1,7)));
        UPDATE identity.account_audit_redaction_jobs SET state='retry_wait',lease_token=NULL,lease_until=NULL,
          scan_round=job.scan_round,phase=job.phase,cursor_id=job.cursor_id,cursor_no=job.cursor_no,
          attempts=attempt_number,next_attempt_at=clock_timestamp()+make_interval(secs=>wait_seconds),
          last_error_code=failure WHERE id=p_job_id;
        RAISE WARNING 'Account audit batch failed, safe SQLSTATE %',failure;
        RETURN jsonb_build_object('state','retry_wait','error_code',failure);
    END;
END $$;
ALTER FUNCTION identity.process_account_audit_redaction(uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.process_account_audit_redaction(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;

-- SECURITY INVOKER and no function SET clause are deliberate: the trusted cron
-- caller commits each bounded batch. API roles cannot invoke this procedure.
CREATE PROCEDURE identity.run_account_audit_redactions(p_limit integer DEFAULT 1000,p_seconds integer DEFAULT 20,
  p_retry_only boolean DEFAULT false)
LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE selected uuid; outcome jsonb; started timestamptz:=pg_catalog.clock_timestamp();
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 OR p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 20
      OR p_retry_only IS NULL THEN
        RAISE EXCEPTION 'Invalid audit worker budget';
    END IF;
    IF NOT p_retry_only AND extract(hour FROM (pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Shanghai'))<>1 THEN RETURN; END IF;
    LOOP
        EXIT WHEN pg_catalog.clock_timestamp()-started>=pg_catalog.make_interval(secs=>p_seconds);
        SELECT j.id INTO selected FROM identity.account_audit_redaction_jobs j WHERE
          ((j.state IN ('pending','retry_wait') AND j.next_attempt_at<=pg_catalog.clock_timestamp())
            OR (j.state='waiting_rescan' AND j.next_scan_at<=pg_catalog.clock_timestamp())
            OR (j.state IN ('running','verifying') AND j.lease_until<=pg_catalog.clock_timestamp()))
          AND (NOT p_retry_only OR j.state<>'pending' OR j.attempts>0 OR j.scan_round=2
            OR j.target_at<=pg_catalog.clock_timestamp()+interval '4 hours')
          ORDER BY j.target_at,j.id LIMIT 1 FOR UPDATE SKIP LOCKED;
        EXIT WHEN NOT FOUND;
        outcome:=identity.process_account_audit_redaction(selected,p_limit);
        COMMIT;
        IF outcome->>'state'='manual_review' OR outcome ? 'error_code' THEN
            -- The retry/manual state has already committed. Fail the cron run
            -- visibly without rolling back that durable recovery information.
            RAISE EXCEPTION 'Account audit worker requires retry or manual review';
        END IF;
    END LOOP;
END $$;
ALTER PROCEDURE identity.run_account_audit_redactions(integer,integer,boolean) OWNER TO postgres;
REVOKE ALL ON PROCEDURE identity.run_account_audit_redactions(integer,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE identity.account_audit_redaction_daily_checks (
    day date PRIMARY KEY,checked_at timestamptz NOT NULL,total_jobs integer NOT NULL,checked_jobs integer NOT NULL,
    incomplete_jobs integer NOT NULL,auth_residual_count bigint NOT NULL,file_residual_count bigint NOT NULL,
    manual_review_jobs integer NOT NULL,failed_jobs integer NOT NULL,hard_deadline_jobs integer NOT NULL
);
ALTER TABLE identity.account_audit_redaction_daily_checks OWNER TO postgres;
ALTER TABLE identity.account_audit_redaction_daily_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.account_audit_redaction_daily_checks FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.check_account_audit_redaction_daily(p_force boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job identity.account_audit_redaction_jobs%ROWTYPE; stamp timestamptz:=clock_timestamp();
    token uuid; total integer; checked integer:=0; incomplete integer:=0; a bigint:=0; f bigint:=0;
    one_a bigint; one_f bigint; failure text; manual_jobs integer; failed_jobs integer; hard_jobs integer;
BEGIN
    IF NOT p_force AND extract(hour FROM (stamp AT TIME ZONE 'Asia/Shanghai'))<>2 THEN
        RETURN jsonb_build_object('state','outside_daily_window');
    END IF;
    SELECT count(*) FILTER(WHERE state='manual_review'),
      count(*) FILTER(WHERE state='retry_wait' AND deleted_at<=stamp-interval '24 hours' AND last_error_code IS NOT NULL),
      count(*) FILTER(WHERE hard_due_at<=stamp) INTO manual_jobs,failed_jobs,hard_jobs
      FROM identity.account_audit_redaction_jobs;
    SELECT count(*) INTO total FROM identity.account_audit_redaction_jobs
      WHERE deleted_at<=stamp-interval '24 hours' OR state='manual_review' OR hard_due_at<=stamp;
    FOR job IN SELECT * FROM identity.account_audit_redaction_jobs
      WHERE deleted_at<=stamp-interval '24 hours' OR state='manual_review' OR hard_due_at<=stamp
      ORDER BY id FOR UPDATE SKIP LOCKED LOOP
        IF job.state IN ('running','verifying') AND job.lease_until>clock_timestamp() THEN CONTINUE; END IF;
        BEGIN
            token:=gen_random_uuid();
            UPDATE identity.account_audit_redaction_jobs SET state='verifying',lease_token=token,
              lease_until=clock_timestamp()+interval '5 minutes' WHERE id=job.id;
            INSERT INTO identity.account_audit_redaction_context VALUES(pg_current_xact_id(),job.id,token,pg_backend_pid());
            one_a:=identity.registered_auth_audit_residual(job.id);
            one_f:=file_private.registered_storage_audit_residual(job.id);
            DELETE FROM identity.account_audit_redaction_context WHERE transaction_id=pg_current_xact_id() AND job_id=job.id;
            UPDATE identity.account_audit_redaction_jobs SET state=job.state,lease_token=job.lease_token,
              lease_until=job.lease_until WHERE id=job.id;
            a:=a+one_a; f:=f+one_f; checked:=checked+1;
        EXCEPTION WHEN OTHERS THEN
            failure:=SQLSTATE;
            RAISE WARNING 'Account audit verification failed, safe SQLSTATE %',failure;
        END;
    END LOOP;
    incomplete:=GREATEST(total-checked,0);
    INSERT INTO identity.account_audit_redaction_daily_checks VALUES((stamp AT TIME ZONE 'Asia/Shanghai')::date,
      clock_timestamp(),total,checked,incomplete,a,f,manual_jobs,failed_jobs,hard_jobs) ON CONFLICT(day) DO UPDATE SET
      checked_at=EXCLUDED.checked_at,total_jobs=EXCLUDED.total_jobs,checked_jobs=EXCLUDED.checked_jobs,
      incomplete_jobs=EXCLUDED.incomplete_jobs,auth_residual_count=EXCLUDED.auth_residual_count,
      file_residual_count=EXCLUDED.file_residual_count,manual_review_jobs=EXCLUDED.manual_review_jobs,
      failed_jobs=EXCLUDED.failed_jobs,hard_deadline_jobs=EXCLUDED.hard_deadline_jobs;
    RETURN jsonb_build_object('state',CASE WHEN incomplete+a+f+manual_jobs+failed_jobs+hard_jobs=0 THEN 'clear' ELSE 'alert' END,
      'total_jobs',total,'checked_jobs',checked,'incomplete_jobs',incomplete,'auth_residual_count',a,'file_residual_count',f,
      'manual_review_jobs',manual_jobs,'failed_jobs',failed_jobs,'hard_deadline_jobs',hard_jobs);
END $$;
CREATE FUNCTION identity.assert_account_audit_redaction_daily(p_force boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    IF NOT p_force AND extract(hour FROM (clock_timestamp() AT TIME ZONE 'Asia/Shanghai'))<>2 THEN RETURN; END IF;
    IF NOT EXISTS(SELECT 1 FROM identity.account_audit_redaction_daily_checks c
      WHERE c.day=(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date
        AND c.checked_at>clock_timestamp()-interval '1 hour' AND c.incomplete_jobs=0
        AND c.auth_residual_count=0 AND c.file_residual_count=0 AND c.manual_review_jobs=0
        AND c.failed_jobs=0 AND c.hard_deadline_jobs=0) THEN
        RAISE EXCEPTION 'Account audit redaction daily check is missing, incomplete or has residuals';
    END IF;
END $$;
ALTER FUNCTION identity.check_account_audit_redaction_daily(boolean) OWNER TO postgres;
ALTER FUNCTION identity.assert_account_audit_redaction_daily(boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.check_account_audit_redaction_daily(boolean),
  identity.assert_account_audit_redaction_daily(boolean) FROM PUBLIC,anon,authenticated,service_role;
SELECT cron.schedule('account-audit-redaction-nightly','0 * * * *',
  'CALL identity.run_account_audit_redactions(1000,20,false);');
SELECT cron.schedule('account-audit-redaction-retry','*/10 * * * *',
  'CALL identity.run_account_audit_redactions(1000,20,true);');
SELECT cron.schedule('account-audit-redaction-daily','15 * * * *',
  'SET statement_timeout=''30s''; SELECT identity.check_account_audit_redaction_daily();');
SELECT cron.schedule('account-audit-redaction-daily-guard','20 * * * *',
  'SET statement_timeout=''30s''; SELECT identity.assert_account_audit_redaction_daily();');
