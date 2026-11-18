-- Immutable staging is separate from final blob collection. Publication and
-- terminal upload evidence are both required; elapsed time is not evidence.
CREATE TABLE chat.file_staging_cleanup (
    staging_key text PRIMARY KEY REFERENCES chat.file_transfer_uploads(staging_key) ON DELETE CASCADE,
    reservation_id uuid NOT NULL,
    registered_blob_id uuid NOT NULL,
    committed_at timestamptz,
    publication_evidence text NOT NULL CHECK(publication_evidence='database-commit' OR publication_evidence ~ '^[0-9a-f]{64}$'),
    terminal_evidence_sha256 text CHECK(terminal_evidence_sha256 ~ '^[0-9a-f]{64}$'),
    terminal_at timestamptz,
    permit_expires_at timestamptz,
    state text NOT NULL DEFAULT 'awaiting_evidence' CHECK(state IN ('awaiting_evidence','pending','running','failed','completed')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    claim_token uuid,
    claimed_at timestamptz,
    completed_at timestamptz,
    last_error text CHECK(last_error IN ('storage_failed','storage_timeout','still_present','confirmation_failed','stale_lease')),
    CHECK(staging_key ~ '^staging/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    CHECK((terminal_evidence_sha256 IS NULL)=(terminal_at IS NULL)),
    CHECK((terminal_at IS NULL)=(permit_expires_at IS NULL)),
    CHECK(terminal_at IS NULL OR terminal_at>=permit_expires_at)
);
CREATE INDEX file_staging_cleanup_due_idx ON chat.file_staging_cleanup(next_attempt_at,staging_key)
    WHERE state IN ('pending','failed');
ALTER TABLE chat.file_staging_cleanup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.file_staging_cleanup FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE chat.file_staging_cleanup_control (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    enabled boolean NOT NULL DEFAULT false,
    single_batch boolean NOT NULL DEFAULT true,
    allowed_keys text[],
    run_token uuid,
    run_until timestamptz,
    run_permitted boolean NOT NULL DEFAULT false,
    run_claimed boolean NOT NULL DEFAULT false
);
INSERT INTO chat.file_staging_cleanup_control(singleton) VALUES(true);
ALTER TABLE chat.file_staging_cleanup_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.file_staging_cleanup_control FROM PUBLIC,anon,authenticated,service_role;

-- A resumed permit is tied to its original publication by the verified settle
-- transaction, never by content equality or by the expiry of either permit.
CREATE TABLE chat.file_staging_publication_sources (
    staging_key text PRIMARY KEY REFERENCES chat.file_transfer_uploads(staging_key) ON DELETE CASCADE,
    publication_key text NOT NULL,
    CHECK(staging_key<>publication_key)
);
ALTER TABLE chat.file_staging_publication_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.file_staging_publication_sources FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION chat.file_staging_cleanup_record_publication(p_key text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
    INSERT INTO chat.file_staging_cleanup(staging_key,reservation_id,registered_blob_id,committed_at,publication_evidence)
    SELECT u.staging_key,u.reservation_id,r.blob_id,clock_timestamp(),'database-commit'
      FROM chat.file_blob_uploads r JOIN chat.file_transfer_uploads u
        ON u.account_id=r.uploader AND u.blob_id=r.blob_id
       AND (u.staging_key=r.staging_key OR EXISTS(SELECT 1 FROM chat.file_staging_publication_sources s
         WHERE s.staging_key=u.staging_key AND s.publication_key=r.staging_key))
     WHERE r.staging_key=p_key AND (r.message_id IS NOT NULL OR r.item_id IS NOT NULL OR r.session_attachment_id IS NOT NULL)
       AND u.staging_key ~ '^staging/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ON CONFLICT(staging_key) DO NOTHING
$$;
REVOKE ALL ON FUNCTION chat.file_staging_cleanup_record_publication(text) FROM PUBLIC,anon,authenticated,service_role;

-- The original commit functions update their receipt in the publication
-- transaction. A failed publication rolls this marker back as well. The short
-- receipt may later be swept without losing the committed staging identity.
CREATE FUNCTION chat.file_staging_cleanup_record_commit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    PERFORM chat.file_staging_cleanup_record_publication(NEW.staging_key);
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION chat.file_staging_cleanup_record_commit() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER file_staging_cleanup_committed AFTER INSERT OR UPDATE ON chat.file_blob_uploads
FOR EACH ROW EXECUTE FUNCTION chat.file_staging_cleanup_record_commit();

-- Declared messages can commit before registration; the later registration is
-- equally part of their publication proof, including a resumed staging key.
CREATE FUNCTION chat.file_staging_cleanup_record_registered() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NEW.blob_id IS NOT NULL THEN
      PERFORM chat.file_staging_cleanup_record_publication(COALESCE(
        (SELECT publication_key FROM chat.file_staging_publication_sources WHERE staging_key=NEW.staging_key),NEW.staging_key));
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION chat.file_staging_cleanup_record_registered() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER file_staging_cleanup_registered AFTER UPDATE OF blob_id ON chat.file_transfer_uploads
FOR EACH ROW EXECUTE FUNCTION chat.file_staging_cleanup_record_registered();

INSERT INTO chat.file_staging_cleanup(staging_key,reservation_id,registered_blob_id,committed_at,publication_evidence)
-- A consumed historical receipt proves publication, but its creation time is
-- registration time, not the unknown commit time. Preserve that distinction.
SELECT r.staging_key,u.reservation_id,r.blob_id,NULL::timestamptz,'database-commit'
  FROM chat.file_blob_uploads r JOIN chat.file_transfer_uploads u
    ON u.staging_key=r.staging_key AND u.account_id=r.uploader AND u.blob_id=r.blob_id
 WHERE (r.message_id IS NOT NULL OR r.item_id IS NOT NULL OR r.session_attachment_id IS NOT NULL)
   AND r.staging_key ~ '^staging/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Preserve the current declared keep/registration contract while binding resumed permits.
CREATE OR REPLACE FUNCTION chat.file_blob_settle(p_uploader text,p_pending_key text,p_upload_key text,p_sha256 text,p_size_bytes bigint,
    p_content_type text,p_width integer DEFAULT NULL,p_height integer DEFAULT NULL,p_document jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE receipt chat.file_blob_uploads%ROWTYPE; p chat.file_blobs%ROWTYPE; l chat.file_blobs%ROWTYPE; created boolean:=false;
    sha text:=lower(btrim(COALESCE(p_sha256,''))); v record; hint text;
BEGIN
    SELECT * INTO receipt FROM chat.file_blob_uploads WHERE staging_key=p_pending_key AND uploader=p_uploader FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'no declared upload %',p_pending_key USING HINT='attachment_upload_not_found'; END IF;
    SELECT * INTO p FROM chat.file_blobs WHERE id=receipt.blob_id FOR UPDATE;
    IF p.bucket_id<>'pending' THEN
        -- Settled before (a retried request): the same bytes answer the same blob.
        IF p.sha256 IS DISTINCT FROM sha OR p.size_bytes IS DISTINCT FROM p_size_bytes THEN RAISE EXCEPTION 'upload % settled with other content',p_pending_key USING HINT='file_transfer_conflict'; END IF;
        l:=p;
    ELSE
        IF sha IS DISTINCT FROM p.declared_sha256 OR p_size_bytes IS DISTINCT FROM p.size_bytes THEN
            UPDATE chat.file_blobs SET declared_failed_at=now() WHERE id=p.id;
            PERFORM chat.file_pending_changed(p.id);
            RETURN jsonb_build_object('status','failed','blob_id',p.id);
        END IF;
        INSERT INTO chat.file_blobs AS b(bucket_id,object_name,sha256,size_bytes,content_type,created_by)
        VALUES('oss',substr(sha,1,2)||'/'||sha,sha,p_size_bytes,COALESCE(NULLIF(btrim(COALESCE(p_content_type,'')),''),'application/octet-stream'),p_uploader)
        ON CONFLICT (sha256) DO NOTHING RETURNING b.* INTO l;
        created:=FOUND;
        IF NOT created THEN SELECT * INTO l FROM chat.file_blobs WHERE sha256=sha; END IF;
        PERFORM chat.file_blob_take(l.id);
        IF p_width IS NOT NULL AND p_height IS NOT NULL THEN
            INSERT INTO chat.file_contents(sha256,width,height) VALUES(sha,p_width,p_height)
            ON CONFLICT (sha256) DO UPDATE SET width=EXCLUDED.width,height=EXCLUDED.height;
        END IF;
        -- Every reference the declaration collected moves to the bytes; each move is tracked in the ledger as that reference's.
        PERFORM pg_catalog.set_config('chat.file_blob_settling',p.id::text,true);
        PERFORM chat.file_pending_changed(p.id);
        UPDATE chat.messages SET file_blob_id=l.id WHERE file_blob_id=p.id;
        UPDATE chat.workspace_items SET blob_id=l.id WHERE blob_id=p.id;
        FOR v IN UPDATE chat.workspace_item_versions SET blob_id=l.id WHERE blob_id=p.id RETURNING item_id,made_by LOOP
            PERFORM chat.file_transfer_track(l.id,(SELECT chat_id FROM chat.workspace_items WHERE id=v.item_id),v.made_by);
        END LOOP;
        UPDATE chat.file_blob_uploads SET blob_id=l.id,document=COALESCE(document,p_document) WHERE blob_id=p.id;
        PERFORM pg_catalog.set_config('chat.file_blob_settling','',true);
        DELETE FROM chat.file_blob_gc WHERE blob_id=p.id;
        DELETE FROM chat.file_blobs WHERE id=p.id;
        -- A folder file replaced while its first bytes were still coming has its newer version imported on its own; the stale
        -- import is skipped, never left to fail the settle (and every retry of it).
        BEGIN PERFORM chat.workspace_ingest_upload(p_pending_key);
        EXCEPTION WHEN raise_exception THEN
            GET STACKED DIAGNOSTICS hint=PG_EXCEPTION_HINT;
            IF hint IS DISTINCT FROM 'workspace_version_conflict' THEN RAISE; END IF;
        END;
    END IF;
    -- A lost response may resume under a new permit even when the declaration is already settled.
    -- Both cases must leave that permit's receipt for file_managed_upload_registered.
    IF p_upload_key<>p_pending_key THEN
        INSERT INTO chat.file_blob_uploads(staging_key,uploader,blob_id,document,keep) VALUES(p_upload_key,p_uploader,l.id,p_document,receipt.keep)
        ON CONFLICT (staging_key) DO NOTHING;
        IF NOT EXISTS(SELECT 1 FROM chat.file_blob_uploads WHERE staging_key=p_upload_key AND uploader=p_uploader AND blob_id=l.id) THEN
            RAISE EXCEPTION 'upload % is registered for other content',p_upload_key USING HINT='file_transfer_conflict';
        END IF;
    END IF;
    -- A ready declaration includes its storage reference, retention and upload accounting in this transaction.
    IF p_upload_key<>p_pending_key THEN
        INSERT INTO chat.file_staging_publication_sources(staging_key,publication_key)
        VALUES(p_upload_key,p_pending_key) ON CONFLICT(staging_key) DO NOTHING;
        IF NOT EXISTS(SELECT 1 FROM chat.file_staging_publication_sources
            WHERE staging_key=p_upload_key AND publication_key=p_pending_key) THEN
            RAISE EXCEPTION 'Upload is tied to another publication' USING HINT='file_transfer_conflict';
        END IF;
    END IF;
    PERFORM chat.file_managed_upload_registered(p_upload_key,p_uploader,p_document);
    RETURN jsonb_build_object('status','ready','blob_id',l.id,'object_name',l.object_name,'created',created);
END $$;
ALTER FUNCTION chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb) TO service_role;


CREATE FUNCTION chat.file_staging_cleanup_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT jsonb_build_object('enabled',c.enabled,'single_batch',c.single_batch,'batch_limit',5,'concurrency',1,
      'scope_count',cardinality(c.allowed_keys),'inflight',CASE WHEN c.run_token IS NOT NULL AND c.run_until>clock_timestamp() THEN 1 ELSE 0 END,
      'awaiting_evidence',(SELECT count(*) FROM chat.file_staging_cleanup WHERE state='awaiting_evidence'),
      'eligible',(SELECT count(*) FROM chat.file_staging_cleanup WHERE state IN ('pending','failed') AND next_attempt_at<=now()),
      'completed',(SELECT count(*) FROM chat.file_staging_cleanup WHERE state='completed'))
    FROM chat.file_staging_cleanup_control c WHERE singleton
$$;

CREATE FUNCTION chat.file_staging_cleanup_scope_status(p_keys text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF p_keys IS NULL OR cardinality(p_keys) NOT BETWEEN 1 AND 500
       OR EXISTS(SELECT 1 FROM unnest(p_keys) k WHERE k IS NULL OR k !~ '^staging/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
        RAISE EXCEPTION 'Invalid staging cleanup status scope';
    END IF;
    RETURN (SELECT jsonb_build_object('known',count(*),'completed',count(*) FILTER(WHERE state='completed'),
        'running',count(*) FILTER(WHERE state='running'),
        'awaiting_evidence',count(*) FILTER(WHERE state='awaiting_evidence'),
        'eligible',count(*) FILTER(WHERE state IN ('pending','failed') AND next_attempt_at<=now()))
      FROM chat.file_staging_cleanup WHERE staging_key=ANY(p_keys));
END $$;

CREATE FUNCTION chat.configure_file_staging_cleanup(p_enabled boolean,p_single_batch boolean DEFAULT true,p_keys text[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF p_enabled IS NULL OR p_single_batch IS NULL THEN RAISE EXCEPTION 'Explicit staging cleanup controls are required'; END IF;
    IF p_keys IS NOT NULL AND (cardinality(p_keys) NOT BETWEEN 1 AND 500
        OR EXISTS(SELECT 1 FROM unnest(p_keys) k WHERE k IS NULL OR k !~ '^staging/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        OR cardinality(p_keys)<>(SELECT count(DISTINCT k) FROM unnest(p_keys) k)) THEN
        RAISE EXCEPTION 'Invalid staging cleanup scope';
    END IF;
    IF p_enabled AND p_single_batch AND p_keys IS NULL THEN RAISE EXCEPTION 'A single batch needs an explicit approved scope'; END IF;
    PERFORM 1 FROM chat.file_staging_cleanup_control WHERE singleton FOR UPDATE;
    IF p_enabled AND EXISTS(SELECT 1 FROM chat.file_staging_cleanup_control WHERE singleton
       AND run_token IS NOT NULL AND run_until>clock_timestamp()) THEN RAISE EXCEPTION 'A staging cleanup run is still active'; END IF;
    UPDATE chat.file_staging_cleanup_control SET enabled=p_enabled,single_batch=p_single_batch,
        allowed_keys=CASE WHEN p_enabled THEN p_keys ELSE allowed_keys END,
        run_permitted=CASE WHEN p_enabled THEN run_permitted ELSE false END WHERE singleton;
    RETURN chat.file_staging_cleanup_status();
END $$;

-- A trusted importer supplies hashes of its protected provider terminal export.
-- For swept historical receipts it must ALSO supply independent publication
-- evidence. Neither a shared content hash nor HEAD 404 is publication evidence.
CREATE FUNCTION chat.file_staging_cleanup_evidence(p_key text,p_reservation uuid,p_blob uuid,
    p_permit_expires_at timestamptz,p_terminal_at timestamptz,p_terminal_sha256 text,
    p_publication_sha256 text DEFAULT NULL,p_publication_at timestamptz DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u chat.file_transfer_uploads%ROWTYPE; r chat.file_transfer_reservations%ROWTYPE; q chat.file_staging_cleanup%ROWTYPE;
BEGIN
    IF p_terminal_sha256 IS NULL OR p_terminal_sha256 !~ '^[0-9a-f]{64}$'
       OR p_publication_sha256 IS NOT NULL AND p_publication_sha256 !~ '^[0-9a-f]{64}$'
       OR p_permit_expires_at IS NULL OR p_terminal_at IS NULL
       OR p_terminal_at<p_permit_expires_at OR p_terminal_at>clock_timestamp() THEN
        RAISE EXCEPTION 'Invalid trusted terminal evidence' USING HINT='file_transfer_invalid';
    END IF;
    SELECT * INTO u FROM chat.file_transfer_uploads WHERE staging_key=p_key;
    SELECT * INTO r FROM chat.file_transfer_reservations WHERE id=u.reservation_id;
    IF u.staging_key IS NULL OR p_key !~ '^staging/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR u.reservation_id IS DISTINCT FROM p_reservation OR r.kind IS DISTINCT FROM 'upload'
       OR r.expires_at IS DISTINCT FROM p_permit_expires_at OR r.expires_at>clock_timestamp()
       THEN
        RAISE EXCEPTION 'Upload capability does not match terminal evidence' USING HINT='file_transfer_conflict';
    END IF;
    SELECT * INTO q FROM chat.file_staging_cleanup WHERE staging_key=p_key FOR UPDATE;
    IF q.state='completed' AND (q.registered_blob_id,q.reservation_id,q.terminal_evidence_sha256,q.terminal_at,q.permit_expires_at)
       IS NOT DISTINCT FROM (p_blob,p_reservation,p_terminal_sha256,p_terminal_at,p_permit_expires_at) THEN RETURN false; END IF;
    IF u.staging_deleted OR r.state NOT IN ('reserved','issued') THEN
        RAISE EXCEPTION 'Upload capability is already closed' USING HINT='file_transfer_conflict';
    END IF;
    IF q.staging_key IS NULL THEN
        IF p_publication_sha256 IS NULL OR p_publication_at IS NULL OR p_publication_at<u.created_at
           OR p_publication_at>clock_timestamp() OR u.blob_id IS DISTINCT FROM p_blob OR p_blob IS NULL THEN
            RAISE EXCEPTION 'Committed publication evidence is required' USING HINT='file_transfer_conflict';
        END IF;
        INSERT INTO chat.file_staging_cleanup(staging_key,reservation_id,registered_blob_id,committed_at,publication_evidence)
        VALUES(p_key,p_reservation,p_blob,p_publication_at,p_publication_sha256)
        ON CONFLICT(staging_key) DO NOTHING;
        SELECT * INTO STRICT q FROM chat.file_staging_cleanup WHERE staging_key=p_key FOR UPDATE;
    END IF;
    IF q.registered_blob_id IS DISTINCT FROM p_blob OR q.reservation_id IS DISTINCT FROM p_reservation
       OR q.terminal_evidence_sha256 IS NOT NULL AND
          (q.terminal_evidence_sha256,q.terminal_at,q.permit_expires_at) IS DISTINCT FROM
          (p_terminal_sha256,p_terminal_at,p_permit_expires_at) THEN
        RAISE EXCEPTION 'Terminal evidence is immutable' USING HINT='file_transfer_conflict';
    END IF;
    IF q.terminal_evidence_sha256 IS NOT NULL THEN RETURN false; END IF;
    UPDATE chat.file_staging_cleanup SET terminal_evidence_sha256=p_terminal_sha256,
        terminal_at=p_terminal_at,permit_expires_at=p_permit_expires_at,state='pending',next_attempt_at=now()
      WHERE staging_key=p_key;
    RETURN true;
END $$;

CREATE FUNCTION chat.file_staging_cleanup_run_begin() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c chat.file_staging_cleanup_control%ROWTYPE; token uuid;
BEGIN
    SELECT * INTO STRICT c FROM chat.file_staging_cleanup_control WHERE singleton FOR UPDATE;
    IF NOT c.enabled OR c.run_token IS NOT NULL AND c.run_until>clock_timestamp() THEN
        RETURN jsonb_build_object('admitted',false,'batch_limit',5,'concurrency',1);
    END IF;
    token:=gen_random_uuid();
    UPDATE chat.file_staging_cleanup_control SET run_token=token,run_until=clock_timestamp()+interval '600 seconds',
        run_permitted=true,run_claimed=false,enabled=CASE WHEN single_batch THEN false ELSE enabled END WHERE singleton;
    RETURN jsonb_build_object('admitted',true,'run_token',token,'batch_limit',5,'concurrency',1);
END $$;

CREATE FUNCTION chat.file_staging_cleanup_run_renew(p_run uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    UPDATE chat.file_staging_cleanup_control SET run_until=clock_timestamp()+interval '600 seconds'
      WHERE singleton AND run_token=p_run AND run_until>clock_timestamp() AND run_permitted;
    RETURN FOUND;
END $$;

CREATE FUNCTION chat.file_staging_cleanup_claim(p_run uuid)
RETURNS TABLE(staging_key text,claim_token uuid,attempt_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    PERFORM 1 FROM chat.file_staging_cleanup_control WHERE singleton AND run_token=p_run
      AND run_until>clock_timestamp() AND run_permitted AND NOT run_claimed FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Staging cleanup run is not admitted'; END IF;
    UPDATE chat.file_staging_cleanup_control SET run_claimed=true WHERE singleton;
    UPDATE chat.file_staging_cleanup SET state='failed',claim_token=NULL,claimed_at=NULL,
        last_error='stale_lease',next_attempt_at=now()
      WHERE state='running' AND claimed_at<clock_timestamp()-interval '600 seconds';
    RETURN QUERY WITH due AS (
        SELECT q.staging_key FROM chat.file_staging_cleanup q
        JOIN chat.file_transfer_uploads u ON u.staging_key=q.staging_key
        JOIN chat.file_transfer_reservations r ON r.id=q.reservation_id AND r.id=u.reservation_id
        WHERE q.state IN ('pending','failed') AND q.next_attempt_at<=now()
          AND q.terminal_evidence_sha256 IS NOT NULL AND q.terminal_at>=r.expires_at
          AND q.permit_expires_at=r.expires_at AND r.expires_at<=clock_timestamp()
          AND NOT u.staging_deleted AND r.state IN ('reserved','issued')
          AND EXISTS(SELECT 1 FROM chat.file_staging_cleanup_control c WHERE c.singleton
              AND (c.allowed_keys IS NULL OR q.staging_key=ANY(c.allowed_keys)))
        ORDER BY q.next_attempt_at,q.staging_key LIMIT 5 FOR UPDATE OF q SKIP LOCKED
    ) UPDATE chat.file_staging_cleanup q SET state='running',claim_token=gen_random_uuid(),
        claimed_at=clock_timestamp(),attempt_count=q.attempt_count+1,last_error=NULL
      FROM due WHERE q.staging_key=due.staging_key
      RETURNING q.staging_key,q.claim_token,q.attempt_count;
END $$;

CREATE FUNCTION chat.file_staging_cleanup_finish(p_run uuid,p_key text,p_claim uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE q chat.file_staging_cleanup%ROWTYPE;
BEGIN
    -- Same quota fence/order as file_managed_upload_closed; never release a
    -- hold before the worker has confirmed the physical object is absent.
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    PERFORM 1 FROM chat.file_staging_cleanup_control WHERE singleton AND run_token=p_run
      AND run_until>clock_timestamp() AND run_permitted FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Staging cleanup run expired'; END IF;
    SELECT * INTO q FROM chat.file_staging_cleanup WHERE staging_key=p_key FOR UPDATE;
    IF q.claim_token IS DISTINCT FROM p_claim OR p_claim IS NULL OR q.state NOT IN ('running','completed') THEN
        RAISE EXCEPTION 'Staging cleanup claim changed';
    END IF;
    IF q.state='completed' THEN RETURN false; END IF;
    PERFORM chat.file_managed_upload_closed(p_key,q.terminal_evidence_sha256);
    UPDATE chat.file_staging_cleanup SET state='completed',completed_at=clock_timestamp(),last_error=NULL WHERE staging_key=p_key;
    RETURN true;
END $$;

CREATE FUNCTION chat.file_staging_cleanup_fail(p_run uuid,p_key text,p_claim uuid,p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF p_error IS NULL OR p_error NOT IN ('storage_failed','storage_timeout','still_present','confirmation_failed') THEN
        RAISE EXCEPTION 'Invalid staging cleanup failure code';
    END IF;
    PERFORM 1 FROM chat.file_staging_cleanup_control WHERE singleton AND run_token=p_run
      AND run_until>clock_timestamp() AND run_permitted FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    UPDATE chat.file_staging_cleanup SET state='failed',claim_token=NULL,claimed_at=NULL,last_error=p_error,
        next_attempt_at=clock_timestamp()+make_interval(secs=>least(86400,30*power(2,least(attempt_count-1,12)))::integer)
      WHERE staging_key=p_key AND claim_token=p_claim AND state='running';
    RETURN FOUND;
END $$;

CREATE FUNCTION chat.file_staging_cleanup_run_end(p_run uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    UPDATE chat.file_staging_cleanup_control SET run_token=NULL,run_until=NULL,run_permitted=false,run_claimed=false
      WHERE singleton AND run_token=p_run;
    RETURN FOUND;
END $$;

CREATE FUNCTION chat.file_staging_cleanup_kick() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE endpoint text; capability text;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM chat.file_staging_cleanup_control WHERE singleton AND enabled
        AND (run_token IS NULL OR run_until<=clock_timestamp()))
       OR NOT EXISTS(SELECT 1 FROM chat.file_staging_cleanup q CROSS JOIN chat.file_staging_cleanup_control c
        WHERE c.singleton AND q.state IN ('pending','failed','running')
        AND q.terminal_evidence_sha256 IS NOT NULL AND q.next_attempt_at<=now()
        AND (c.allowed_keys IS NULL OR q.staging_key=ANY(c.allowed_keys))) THEN RETURN NULL; END IF;
    SELECT decrypted_secret INTO endpoint FROM vault.decrypted_secrets WHERE name='attachments_gc_url';
    SELECT decrypted_secret INTO capability FROM vault.decrypted_secrets WHERE name='attachments_gc_key';
    IF endpoint IS NULL OR endpoint !~ '^https?://[^[:space:]?#]+/functions/v1/attachments/gc$' OR capability IS NULL THEN
        RAISE EXCEPTION 'Staging cleanup dispatch configuration is missing';
    END IF;
    RETURN net.http_post(url=>regexp_replace(endpoint,'/gc$','/staging-cleanup'),
        headers=>jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||capability),
        body=>'{}'::jsonb,timeout_milliseconds=>120000);
END $$;
REVOKE ALL ON FUNCTION chat.file_staging_cleanup_kick() FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION chat.file_staging_cleanup_status(),chat.file_staging_cleanup_scope_status(text[]),chat.configure_file_staging_cleanup(boolean,boolean,text[]),
    chat.file_staging_cleanup_evidence(text,uuid,uuid,timestamptz,timestamptz,text,text,timestamptz),
    chat.file_staging_cleanup_run_begin(),chat.file_staging_cleanup_run_renew(uuid),chat.file_staging_cleanup_claim(uuid),
    chat.file_staging_cleanup_finish(uuid,text,uuid),chat.file_staging_cleanup_fail(uuid,text,uuid,text),
    chat.file_staging_cleanup_run_end(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.file_staging_cleanup_status(),chat.file_staging_cleanup_scope_status(text[]),chat.configure_file_staging_cleanup(boolean,boolean,text[]),
    chat.file_staging_cleanup_evidence(text,uuid,uuid,timestamptz,timestamptz,text,text,timestamptz),
    chat.file_staging_cleanup_run_begin(),chat.file_staging_cleanup_run_renew(uuid),chat.file_staging_cleanup_claim(uuid),
    chat.file_staging_cleanup_finish(uuid,text,uuid),chat.file_staging_cleanup_fail(uuid,text,uuid,text),
    chat.file_staging_cleanup_run_end(uuid) TO service_role;

-- Installed by the ordinary migration path; disabled until an approved release
-- configures the control. No host timer or separate storage deletion path.
SELECT cron.schedule('file-staging-cleanup-kick','*/10 * * * *',$job$SELECT chat.file_staging_cleanup_kick()$job$);
NOTIFY pgrst,'reload schema';
