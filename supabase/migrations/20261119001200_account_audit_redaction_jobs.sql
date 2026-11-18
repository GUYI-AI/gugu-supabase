-- Restricted registrations are committed with account erasure. Processing and
-- the two-round completion proof are installed by the following releases.
CREATE TABLE identity.account_audit_redaction_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_subject_id text NOT NULL,
    source_transaction_id xid8 NOT NULL,
    delete_user_ids text[] NOT NULL,
    auth_email text,
    deleted_at timestamptz NOT NULL,
    target_at timestamptz NOT NULL,
    hard_due_at timestamptz NOT NULL,
    scan_round integer NOT NULL DEFAULT 1 CHECK(scan_round IN (1,2)),
    next_scan_at timestamptz NOT NULL,
    first_scan_completed_at timestamptz,
    state text NOT NULL DEFAULT 'pending'
      CHECK(state IN ('pending','running','retry_wait','verifying','waiting_rescan','manual_review')),
    phase text NOT NULL DEFAULT 'auth' CHECK(phase IN ('auth','file_headers','file_items','verify')),
    cursor_id uuid,
    cursor_no bigint,
    lease_token uuid,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
    next_attempt_at timestamptz NOT NULL,
    last_error_code text CHECK(last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,64}$'),
    UNIQUE(source_subject_id,source_transaction_id),
    CHECK(cardinality(delete_user_ids)>0 AND array_position(delete_user_ids,NULL) IS NULL),
    CHECK(source_subject_id=ANY(delete_user_ids)),
    CHECK((lease_token IS NULL)=(lease_until IS NULL)),
    CHECK(state NOT IN ('running','verifying') OR lease_token IS NOT NULL),
    CHECK(target_at>deleted_at AND hard_due_at>target_at),
    CHECK(state<>'waiting_rescan' OR (scan_round=1 AND first_scan_completed_at IS NOT NULL
      AND next_scan_at>=deleted_at+interval '7 days')),
    CHECK(scan_round=1 OR (first_scan_completed_at IS NOT NULL AND next_scan_at>=deleted_at+interval '7 days'))
);
CREATE INDEX account_audit_redaction_due ON identity.account_audit_redaction_jobs(next_attempt_at,next_scan_at,id);
CREATE INDEX account_audit_redaction_lease ON identity.account_audit_redaction_jobs(lease_until,id)
  WHERE state IN ('running','verifying');

CREATE TABLE identity.account_audit_redaction_context (
    transaction_id xid8 PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES identity.account_audit_redaction_jobs(id) ON DELETE CASCADE,
    lease_token uuid NOT NULL,
    backend_pid integer NOT NULL
);
CREATE TABLE identity.account_audit_redaction_receipts (
    operation_id uuid NOT NULL,
    scan_round integer NOT NULL CHECK(scan_round IN (1,2)),
    state text NOT NULL CHECK(state IN ('redacted','closed')),
    completed_at timestamptz NOT NULL,
    auth_residual_count bigint NOT NULL CHECK(auth_residual_count=0),
    file_residual_count bigint NOT NULL CHECK(file_residual_count=0),
    PRIMARY KEY(operation_id,scan_round),
    CHECK((scan_round=1 AND state='redacted') OR (scan_round=2 AND state='closed'))
);
ALTER TABLE identity.account_audit_redaction_jobs OWNER TO postgres;
ALTER TABLE identity.account_audit_redaction_context OWNER TO postgres;
ALTER TABLE identity.account_audit_redaction_receipts OWNER TO postgres;
ALTER TABLE identity.account_audit_redaction_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.account_audit_redaction_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.account_audit_redaction_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.account_audit_redaction_jobs,identity.account_audit_redaction_context,
  identity.account_audit_redaction_receipts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.enqueue_account_audit_redaction(p_ids text[],p_auth_email text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE source identity.account_lifecycle_context%ROWTYPE;
    prior identity.account_audit_redaction_jobs%ROWTYPE;
    result uuid; stamp timestamptz:=clock_timestamp();
    email text:=NULLIF(lower(btrim(p_auth_email)),'');
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids)=0
       OR EXISTS(SELECT 1 FROM unnest(p_ids) id WHERE id IS NULL OR id='') THEN
        RAISE EXCEPTION 'Invalid audit redaction registration' USING ERRCODE='42501';
    END IF;
    SELECT * INTO source FROM identity.account_lifecycle_context c
      WHERE c.transaction_id=pg_current_xact_id() AND c.operation='privacy_erasure'
        AND c.subject_user_id=ANY(p_ids) AND c.delete_user_ids=p_ids;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Audit registration requires the account erasure transaction' USING ERRCODE='42501';
    END IF;
    SELECT * INTO prior FROM identity.account_audit_redaction_jobs j
      WHERE j.source_subject_id=source.subject_user_id AND j.source_transaction_id=source.transaction_id
      FOR UPDATE;
    IF FOUND THEN
        IF prior.delete_user_ids IS DISTINCT FROM p_ids OR prior.auth_email IS DISTINCT FROM email THEN
            RAISE EXCEPTION 'Audit registration input changed' USING ERRCODE='42501';
        END IF;
        RETURN prior.id;
    END IF;
    INSERT INTO identity.account_audit_redaction_jobs(source_subject_id,source_transaction_id,
      delete_user_ids,auth_email,deleted_at,target_at,hard_due_at,next_scan_at,next_attempt_at)
    VALUES(source.subject_user_id,source.transaction_id,p_ids,email,stamp,stamp+interval '24 hours',
      -- Conservative internal escalation: 15 calendar days is no later than
      -- the approved 15-working-day maximum; it does not reinterpret holidays.
      stamp+interval '15 days',stamp,stamp) RETURNING id INTO result;
    RETURN result;
END $$;
ALTER FUNCTION identity.enqueue_account_audit_redaction(text[],text) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.enqueue_account_audit_redaction(text[],text) FROM PUBLIC,anon,authenticated,service_role;

-- Helpers receive a job ID, never caller-supplied identity/email criteria.
-- Call at both ends of a batch so an expired lease rolls back its writes.
CREATE FUNCTION identity.assert_registered_audit_context(p_job_id uuid,p_phases text[])
RETURNS identity.account_audit_redaction_jobs
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE job identity.account_audit_redaction_jobs%ROWTYPE;
BEGIN
    SELECT j.* INTO job FROM identity.account_audit_redaction_jobs j
      JOIN identity.account_audit_redaction_context c ON c.job_id=j.id AND c.lease_token=j.lease_token
      WHERE j.id=p_job_id AND c.transaction_id=pg_current_xact_id() AND c.backend_pid=pg_backend_pid()
        AND j.state IN ('running','verifying') AND j.phase=ANY(p_phases)
        AND (j.scan_round=1 OR clock_timestamp()>=j.next_scan_at)
        AND j.lease_until>clock_timestamp()
      FOR UPDATE OF j;
    IF NOT FOUND OR job.lease_until<=clock_timestamp() THEN
        RAISE EXCEPTION 'A live registered audit context is required' USING ERRCODE='42501';
    END IF;
    RETURN job;
END $$;
ALTER FUNCTION identity.assert_registered_audit_context(uuid,text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.assert_registered_audit_context(uuid,text[]) FROM PUBLIC,anon,authenticated,service_role;
