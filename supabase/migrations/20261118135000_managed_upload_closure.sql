-- Logical staging keys survive provider changes. An operator's verified issuance window
-- binds them to a physical namespace. No deployment gets a default completion bound.
SET LOCAL lock_timeout = '5s';

-- Abandoned uploads have no publication. Only a namespace-bound terminal proof can enqueue them.
ALTER TABLE chat.file_staging_cleanup
    ALTER COLUMN registered_blob_id DROP NOT NULL, ALTER COLUMN publication_evidence DROP NOT NULL,
    ADD COLUMN window_namespace jsonb, ADD COLUMN window_reference text, ADD COLUMN closure_receipt text,
    ADD CONSTRAINT file_staging_cleanup_proof_kind CHECK (
        (registered_blob_id IS NOT NULL AND publication_evidence IS NOT NULL)
        OR (registered_blob_id IS NULL AND publication_evidence IS NULL AND window_namespace IS NOT NULL AND terminal_evidence_sha256 IS NOT NULL));


CREATE FUNCTION chat.file_managed_upload_closable(p_namespace jsonb, p_limit integer,
    p_report boolean DEFAULT true, p_ids uuid[] DEFAULT NULL)
RETURNS TABLE (reservation_id uuid, account_id text, staging_key text, upload_id text, held_bytes bigint, evidence text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    proof jsonb;
    first_issue timestamptz;
    last_issue timestamptz;
    cutoff timestamptz;
    ref text;
    terminal_hash text;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR cardinality(p_ids)>500 OR p_report IS NULL THEN
        RAISE EXCEPTION 'Expected a managed upload batch of 1 to 500';
    END IF;
    SELECT settings->'upload_closure' INTO proof FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*';
    IF proof IS NULL OR p_namespace IS NULL OR proof->'namespace' IS DISTINCT FROM p_namespace THEN RETURN; END IF;
    IF NOT p_report AND p_ids IS NULL AND proof->'periodic' IS DISTINCT FROM 'true'::jsonb THEN RETURN; END IF;
    first_issue := (proof->>'issued_from')::timestamptz;
    last_issue := (proof->>'issued_before')::timestamptz;
    ref := proof->>'evidence';
    terminal_hash := proof->>'terminal_sha256';
    IF first_issue IS NULL OR NOT isfinite(first_issue) OR last_issue IS NULL OR first_issue>=last_issue
        OR terminal_hash IS NULL OR terminal_hash !~ '^[0-9a-f]{64}$'
        OR ref IS NULL OR ref !~ '^[A-Za-z0-9_.:-]{1,80}$'
        OR (proof ? 'drained_through') = (proof ? 'upload_inflight_seconds') THEN
        RAISE EXCEPTION 'Invalid managed upload completion evidence';
    END IF;
    IF proof ? 'drained_through' THEN
        cutoff := (proof->>'drained_through')::timestamptz;
        IF cutoff IS NULL OR NOT isfinite(cutoff) OR cutoff>now() THEN RAISE EXCEPTION 'Invalid managed upload drain cutoff'; END IF;
    ELSE
        cutoff := now() - make_interval(secs=>chat.file_transfer_parameter(proof,'upload_inflight_seconds')::integer);
    END IF;

    FOR reservation_id, account_id, staging_key, upload_id, held_bytes IN
        SELECT r.id, u.account_id, u.staging_key, u.upload_id, greatest(0,r.bytes-r.actual_bytes)
        FROM chat.file_transfer_uploads u JOIN chat.file_transfer_reservations r ON r.id=u.reservation_id
        LEFT JOIN chat.file_staging_cleanup q ON q.staging_key=u.staging_key
        WHERE r.kind='upload' AND r.state IN ('reserved','issued') AND NOT u.staging_deleted
          AND r.account_id=u.account_id AND r.subject=u.staging_key
          AND u.staging_key='staging/'||r.account_id||'/'||r.id::text
          AND r.account_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
          AND r.created_at<=r.expires_at AND r.created_at>=first_issue AND r.expires_at<least(last_issue,cutoff)
          AND (p_ids IS NULL OR r.id=ANY(p_ids))
          AND (u.blob_id IS NULL AND q.registered_blob_id IS NULL OR u.blob_id=q.registered_blob_id AND q.publication_evidence IS NOT NULL)
          AND (q.staging_key IS NULL OR q.state='awaiting_evidence'
               OR q.window_namespace=p_namespace AND q.window_reference=ref AND q.terminal_evidence_sha256=terminal_hash
                 AND q.permit_expires_at=r.expires_at AND q.state IN ('pending','failed') AND q.next_attempt_at<=now())
        ORDER BY CASE WHEN q.state IN ('pending','failed') THEN 1 ELSE 0 END,r.expires_at,r.id LIMIT p_limit
    LOOP
        evidence := ref;
        RETURN NEXT;
    END LOOP;
END $$;
ALTER FUNCTION chat.file_managed_upload_closable(jsonb,integer,boolean,uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_managed_upload_closable(jsonb,integer,boolean,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_closable(jsonb,integer,boolean,uuid[]) TO service_role;

-- Preserve the first receipt if independent workers finish the same physical cleanup.
DO $update$
DECLARE definition text; step text:='UPDATE chat.file_transfer_uploads SET staging_deleted=true,close_evidence=p_evidence WHERE staging_key=p_key;';
BEGIN
    SELECT pg_get_functiondef('chat.file_managed_upload_closed(text,text)'::regprocedure) INTO definition;
    IF strpos(definition,step)=0 THEN RAISE EXCEPTION 'Missing upload closure predecessor'; END IF;
    EXECUTE replace(definition,step,'UPDATE chat.file_transfer_uploads SET staging_deleted=true,close_evidence=p_evidence WHERE staging_key=p_key AND NOT staging_deleted;');
END $update$;

-- The original declaration outlives a successor's temporary blob receipt. Its ready
-- blob and the registered upload ledger can answer a finish replay after cleanup.
DO $replay$
DECLARE definition text; step text:='IF NOT FOUND THEN RAISE EXCEPTION ''no declared upload %'',p_pending_key';
BEGIN
    SELECT pg_get_functiondef('chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb)'::regprocedure) INTO definition;
    IF strpos(definition,step)=0 THEN RAISE EXCEPTION 'Missing declared upload settle predecessor'; END IF;
    EXECUTE replace(definition,step,$new$IF p_sha256 IS NULL AND p_size_bytes IS NULL THEN
        IF receipt.expires_at>now() AND EXISTS (
            SELECT 1 FROM chat.file_transfer_uploads u
            JOIN chat.file_transfer_reservations r ON r.id=u.reservation_id
            JOIN chat.file_blobs b ON b.id=u.blob_id
            WHERE u.staging_key=p_upload_key AND u.account_id=p_uploader AND u.staging_deleted
              AND r.kind='upload' AND r.account_id=u.account_id AND r.subject=u.staging_key
              AND u.staging_key='staging/'||p_uploader||'/'||r.id::text
              AND b.bucket_id='oss' AND b.id=receipt.blob_id
              AND (p_upload_key=p_pending_key OR EXISTS (
                SELECT 1 FROM chat.file_staging_publication_sources src
                WHERE src.staging_key=p_upload_key AND src.publication_key=p_pending_key)))
        THEN RETURN jsonb_build_object('status','ready','blob_id',receipt.blob_id,'created',false); END IF;
        RAISE EXCEPTION 'No matching completed upload receipts' USING HINT='file_transfer_conflict';
    END IF;
    $new$||step);
END $replay$;

-- Both publication-backed and abandoned uploads use one queue, one five-key claim and one finish.
CREATE FUNCTION chat.file_managed_staging_claim(p_run uuid,p_namespace jsonb,p_ids uuid[],p_limit integer,p_batch uuid,p_evidence text)
RETURNS TABLE(staging_key text,claim_token uuid,attempt_count integer,upload_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE ctrl chat.file_staging_cleanup_control%ROWTYPE; proof jsonb; ids uuid[]; max_jobs integer;
BEGIN
    SELECT * INTO STRICT ctrl FROM chat.file_staging_cleanup_control WHERE singleton FOR UPDATE;
    IF ctrl.run_token IS DISTINCT FROM p_run OR p_run IS NULL OR ctrl.run_until<=clock_timestamp()
       OR NOT ctrl.run_permitted OR ctrl.run_claimed THEN RAISE EXCEPTION 'Staging cleanup run is not admitted'; END IF;
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 OR cardinality(p_ids)>500 THEN RAISE EXCEPTION 'Invalid staging batch'; END IF;
    max_jobs:=least(p_limit,5);
    ids:=p_ids;
    IF ctrl.allowed_keys IS NOT NULL THEN
        SELECT COALESCE(array_agg(u.reservation_id),ARRAY[]::uuid[]) INTO ids FROM chat.file_transfer_uploads u
        WHERE u.staging_key=ANY(ctrl.allowed_keys) AND (p_ids IS NULL OR u.reservation_id=ANY(p_ids));
    END IF;
    SELECT settings->'upload_closure' INTO proof FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*' FOR SHARE;
    IF p_ids IS NOT NULL AND (p_batch IS NULL OR p_evidence IS NULL OR p_evidence IS DISTINCT FROM proof->>'evidence'
      OR p_namespace IS DISTINCT FROM proof->'namespace') THEN RAISE EXCEPTION 'Prepared staging evidence changed' USING HINT='file_transfer_conflict'; END IF;
    UPDATE chat.file_staging_cleanup_control SET run_claimed=true WHERE singleton;
    UPDATE chat.file_staging_cleanup SET state='failed',claim_token=NULL,claimed_at=NULL,last_error='stale_lease',next_attempt_at=now()
        WHERE state='running' AND claimed_at<clock_timestamp()-interval '600 seconds';
    IF p_namespace IS NOT NULL AND (p_ids IS NOT NULL OR proof->'periodic'='true'::jsonb) THEN
        INSERT INTO chat.file_staging_cleanup AS q(staging_key,reservation_id,registered_blob_id,publication_evidence,
            terminal_evidence_sha256,terminal_at,permit_expires_at,state,window_namespace,window_reference)
        SELECT c.staging_key,c.reservation_id,u.blob_id,pub.publication_evidence,proof->>'terminal_sha256',now(),r.expires_at,'pending',p_namespace,c.evidence
        FROM chat.file_managed_upload_closable(p_namespace,max_jobs,true,ids) c
        JOIN chat.file_transfer_uploads u ON u.reservation_id=c.reservation_id
        JOIN chat.file_transfer_reservations r ON r.id=c.reservation_id
        LEFT JOIN chat.file_staging_cleanup pub ON pub.staging_key=c.staging_key
        WHERE u.blob_id IS NULL OR pub.registered_blob_id=u.blob_id AND pub.publication_evidence IS NOT NULL
        ON CONFLICT ON CONSTRAINT file_staging_cleanup_pkey DO UPDATE SET
            terminal_evidence_sha256=excluded.terminal_evidence_sha256,terminal_at=excluded.terminal_at,
            permit_expires_at=excluded.permit_expires_at,state='pending',next_attempt_at=now(),
            window_namespace=excluded.window_namespace,window_reference=excluded.window_reference
        WHERE q.state='awaiting_evidence' AND q.terminal_evidence_sha256 IS NULL AND q.registered_blob_id=excluded.registered_blob_id;
    END IF;
    RETURN QUERY WITH due AS (
        SELECT q.staging_key,u.upload_id FROM chat.file_staging_cleanup q
        JOIN chat.file_transfer_uploads u ON u.staging_key=q.staging_key
        JOIN chat.file_transfer_reservations r ON r.id=q.reservation_id AND r.id=u.reservation_id
        WHERE q.state IN ('pending','failed') AND q.next_attempt_at<=now() AND q.terminal_evidence_sha256 IS NOT NULL
          AND q.terminal_at>=r.expires_at AND q.permit_expires_at=r.expires_at AND r.expires_at<=clock_timestamp()
          AND NOT u.staging_deleted AND r.kind='upload' AND r.state IN ('reserved','issued')
          AND u.blob_id IS NOT DISTINCT FROM q.registered_blob_id AND u.account_id=r.account_id AND r.subject=u.staging_key
          AND u.staging_key='staging/'||r.account_id||'/'||r.id::text
          AND (ids IS NULL OR r.id=ANY(ids)) AND (ctrl.allowed_keys IS NULL OR u.staging_key=ANY(ctrl.allowed_keys))
          AND (q.window_namespace IS NULL AND p_ids IS NULL AND q.registered_blob_id IS NOT NULL OR
            q.window_namespace=p_namespace AND proof->'namespace'=p_namespace AND q.window_reference=proof->>'evidence'
            AND (p_ids IS NOT NULL OR proof->'periodic'='true'::jsonb)
            AND EXISTS(SELECT 1 FROM chat.file_managed_upload_closable(p_namespace,1,true,ARRAY[r.id])))
        ORDER BY q.next_attempt_at,q.staging_key LIMIT max_jobs FOR UPDATE OF q SKIP LOCKED
    ) UPDATE chat.file_staging_cleanup q SET state='running',claim_token=gen_random_uuid(),claimed_at=clock_timestamp(),
      attempt_count=q.attempt_count+1,last_error=NULL,closure_receipt=CASE WHEN q.window_namespace IS NOT NULL
        THEN 'sweep:'||coalesce(p_batch,p_run)::text||':'||q.window_reference END FROM due WHERE q.staging_key=due.staging_key
      RETURNING q.staging_key,q.claim_token,q.attempt_count,due.upload_id;
END $$;
REVOKE ALL ON FUNCTION chat.file_managed_staging_claim(uuid,jsonb,uuid[],integer,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_staging_claim(uuid,jsonb,uuid[],integer,uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION chat.file_staging_cleanup_claim(p_run uuid)
RETURNS TABLE(staging_key text,claim_token uuid,attempt_count integer)
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
    SELECT c.staging_key,c.claim_token,c.attempt_count FROM chat.file_managed_staging_claim(p_run,NULL,NULL,5,NULL,NULL) c
$$;

DO $finish$
DECLARE definition text; step text:='PERFORM chat.file_managed_upload_closed(p_key,q.terminal_evidence_sha256);';
BEGIN
    SELECT pg_get_functiondef('chat.file_staging_cleanup_finish(uuid,text,uuid)'::regprocedure) INTO definition;
    IF strpos(definition,step)=0 THEN RAISE EXCEPTION 'Missing staging finish predecessor'; END IF;
    EXECUTE replace(definition,step,'PERFORM chat.file_managed_upload_closed(p_key,coalesce(q.closure_receipt,q.terminal_evidence_sha256));');
END $finish$;

-- The staging scheduler can wake for a newly covered window even before it has a queued key.
DO $kick$
DECLARE definition text; step text:='OR NOT EXISTS(SELECT 1 FROM chat.file_staging_cleanup q';
BEGIN
    SELECT pg_get_functiondef('chat.file_staging_cleanup_kick()'::regprocedure) INTO definition;
    IF strpos(definition,step)=0 THEN RAISE EXCEPTION 'Missing staging kick predecessor'; END IF;
    definition := replace(definition,'WHERE c.singleton AND q.state IN',$gate$WHERE c.singleton
        AND (q.window_namespace IS NULL OR EXISTS(SELECT 1 FROM chat.file_transfer_limits l
          WHERE l.scope='global' AND l.scope_id='*' AND l.settings->'upload_closure'->'periodic'='true'::jsonb
          AND l.settings->'upload_closure'->'namespace'=q.window_namespace
          AND l.settings->'upload_closure'->>'evidence'=q.window_reference
          AND l.settings->'upload_closure'->>'terminal_sha256'=q.terminal_evidence_sha256))
        AND q.state IN$gate$);
    EXECUTE replace(definition,step,$new$OR NOT EXISTS(
      SELECT 1 FROM chat.file_transfer_limits l CROSS JOIN chat.file_staging_cleanup_control c
      CROSS JOIN LATERAL chat.file_managed_upload_closable(l.settings->'upload_closure'->'namespace',1,true,
        CASE WHEN c.allowed_keys IS NOT NULL THEN ARRAY(SELECT u.reservation_id FROM chat.file_transfer_uploads u WHERE u.staging_key=ANY(c.allowed_keys)) END) w
      WHERE l.scope='global' AND l.scope_id='*' AND c.singleton AND l.settings->'upload_closure'->'periodic'='true'::jsonb)
      AND NOT EXISTS(SELECT 1 FROM chat.file_staging_cleanup q$new$);
END $kick$;

-- Final-object GC may still remove untracked legacy Storage staging. Managed keys have their own worker.
CREATE OR REPLACE FUNCTION chat.attachment_expired_staging(p_bucket text)
RETURNS TABLE(name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT o.name FROM storage.objects o WHERE o.bucket_id=p_bucket AND o.name LIKE 'staging/%'
      AND o.created_at<now()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_uploads u WHERE u.staging_key=o.name)
    ORDER BY o.created_at LIMIT 50
$$;
NOTIFY pgrst,'reload schema';
