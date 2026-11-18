-- Logical staging keys survive provider changes. An operator's verified issuance window
-- binds them to a physical namespace. No deployment gets a default completion bound.
SET LOCAL lock_timeout = '5s';

ALTER TABLE chat.file_transfer_uploads ADD COLUMN closure_tried_at timestamptz;

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
    tried uuid[];
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
    IF first_issue IS NULL OR NOT isfinite(first_issue) OR last_issue IS NULL OR first_issue>=last_issue
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
        WHERE r.kind='upload' AND r.state IN ('reserved','issued') AND NOT u.staging_deleted
          AND r.account_id=u.account_id AND r.subject=u.staging_key
          AND u.staging_key='staging/'||r.account_id||'/'||r.id::text
          AND r.account_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
          AND r.created_at<=r.expires_at AND r.created_at>=first_issue AND r.expires_at<least(last_issue,cutoff)
          AND (p_ids IS NULL OR r.id=ANY(p_ids))
        ORDER BY u.closure_tried_at NULLS FIRST,r.expires_at,r.id LIMIT p_limit
    LOOP
        evidence := ref;
        IF NOT p_report THEN tried := array_append(tried,reservation_id); END IF;
        RETURN NEXT;
    END LOOP;
    IF tried IS NOT NULL THEN
        UPDATE chat.file_transfer_uploads u SET closure_tried_at=clock_timestamp() WHERE u.reservation_id=ANY(tried);
    END IF;
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
              AND b.bucket_id='oss' AND b.id=receipt.blob_id)
        THEN RETURN jsonb_build_object('status','ready','blob_id',receipt.blob_id,'created',false); END IF;
        RAISE EXCEPTION 'No matching completed upload receipts' USING HINT='file_transfer_conflict';
    END IF;
    $new$||step);
END $replay$;

-- The existing cron kick also needs to wake the HTTP collector when only staging is due.
DO $kick$
DECLARE definition text; step text:='IF NOT EXISTS(SELECT 1 FROM chat.file_blob_gc WHERE status IN';
BEGIN
    SELECT pg_get_functiondef('chat.file_blob_gc_kick()'::regprocedure) INTO definition;
    IF strpos(definition,step)=0 THEN RAISE EXCEPTION 'Missing GC kick predecessor'; END IF;
    EXECUTE replace(definition,step,$new$IF NOT EXISTS (
        SELECT 1 FROM chat.file_transfer_limits l CROSS JOIN LATERAL
            chat.file_managed_upload_closable(l.settings->'upload_closure'->'namespace',1) c
        WHERE l.scope='global' AND l.scope_id='*' AND l.settings->'upload_closure'->'periodic'='true'::jsonb)
       AND NOT EXISTS(SELECT 1 FROM chat.file_blob_gc WHERE status IN$new$);
END $kick$;
NOTIFY pgrst,'reload schema';
