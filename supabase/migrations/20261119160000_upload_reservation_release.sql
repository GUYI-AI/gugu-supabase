-- An upload reservation counts against storage only while a write to its staging key is still possible.
--
-- release_at = expires_at + upload_edge_seconds + upload_sign_seconds + upload_inflight_seconds
--   upload_edge_seconds     T_edge: longest Edge invocation that passed file_managed_upload_for just before expiry and
--                           can still re-sign or write (parts Complete, document snapshot put).
--   upload_sign_seconds     L_sign: how long a signature issued at the last moment before expiry still admits a write.
--   upload_inflight_seconds T_inflight: longest an accepted provider request can take to land.
-- The terms are in series, so they add. Each value is a sourced platform or provider limit set by the deployer
-- (docs/file-transfer-budgets.md lists the sources). After release_at an unregistered permit can never be registered
-- (file_managed_upload_for refuses expired permits) and no signed write can land, so usage stops counting the hold.
-- No job runs for the ledger; physical staging bytes are left to the staging lifecycle below.
SET LOCAL lock_timeout = '5s';

-- A configured deployment must set the three bounds before this migration: issuing would otherwise refuse.
-- A fresh install has no global settings yet and refuses every transfer until configured anyway.
DO $precheck$
DECLARE cfg jsonb; missing text;
BEGIN
    SELECT settings INTO cfg FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*';
    IF cfg IS NULL THEN RETURN; END IF;
    SELECT string_agg(k,', ') INTO missing
      FROM unnest(ARRAY['upload_edge_seconds','upload_sign_seconds','upload_inflight_seconds']) k
     WHERE cfg->>k IS NULL OR cfg->>k !~ '^[0-9]{1,16}$';
    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'Set these upload release bounds in the global file_transfer_limits settings first: %',missing;
    END IF;
END $precheck$;

CREATE FUNCTION chat.file_upload_release_bound() RETURNS interval
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT make_interval(secs=>(chat.file_transfer_parameter(s,'upload_edge_seconds')
        +chat.file_transfer_parameter(s,'upload_sign_seconds')
        +chat.file_transfer_parameter(s,'upload_inflight_seconds'))::double precision)
    FROM (SELECT chat.file_transfer_settings() AS s) cfg
$$;
ALTER FUNCTION chat.file_upload_release_bound() OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_upload_release_bound() FROM PUBLIC,anon,authenticated;

-- Back up every hold this migration can stop counting, before any change, and print what it releases.
CREATE TABLE chat_private.file_upload_release_backup_20261119 AS
SELECT r.*,now() AS backed_up_at FROM chat.file_transfer_reservations r
 WHERE r.kind='upload' AND r.subject LIKE 'staging/%' AND r.state IN ('reserved','issued');
REVOKE ALL ON chat_private.file_upload_release_backup_20261119 FROM PUBLIC,anon,authenticated,service_role,gugu_files;

ALTER TABLE chat.file_transfer_reservations ADD COLUMN release_at timestamptz;
DO $backfill$
DECLARE bound interval; held_rows bigint; held bigint; released_rows bigint; released bigint; accounts bigint;
BEGIN
    SELECT count(*),COALESCE(sum(greatest(0,bytes-actual_bytes)),0),count(DISTINCT account_id)
      INTO held_rows,held,accounts FROM chat_private.file_upload_release_backup_20261119;
    RAISE NOTICE 'upload release backup: % reservations, % held bytes, % accounts',held_rows,held,accounts;
    IF NOT EXISTS(SELECT 1 FROM chat.file_transfer_reservations WHERE kind='upload' AND subject LIKE 'staging/%') THEN RETURN; END IF;
    bound:=chat.file_upload_release_bound();
    UPDATE chat.file_transfer_reservations SET release_at=expires_at+bound
     WHERE kind='upload' AND subject LIKE 'staging/%';
    SELECT count(*),COALESCE(sum(greatest(0,bytes-actual_bytes)),0) INTO released_rows,released
      FROM chat.file_transfer_reservations WHERE kind='upload' AND subject LIKE 'staging/%'
       AND state IN ('reserved','issued') AND release_at<=now();
    RAISE NOTICE 'upload release backfill: % reservations, % held bytes stop counting now',released_rows,released;
END $backfill$;

-- Every managed upload reservation carries its release time from issue on. An extension of the permit (a multipart
-- part report) moves it forward with the expiry; it never moves back. A missing bound refuses the issue.
CREATE FUNCTION chat.file_upload_release_at() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NEW.kind='upload' AND NEW.subject LIKE 'staging/%' THEN
        NEW.release_at:=greatest(NEW.release_at,NEW.expires_at+chat.file_upload_release_bound());
    END IF;
    RETURN NEW;
END $$;
ALTER FUNCTION chat.file_upload_release_at() OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_upload_release_at() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER file_upload_release_at BEFORE INSERT OR UPDATE OF expires_at ON chat.file_transfer_reservations
FOR EACH ROW EXECUTE FUNCTION chat.file_upload_release_at();

-- Usage, and the upload hold that covers a reference, count an open upload reservation only until its release time.
DO $usage$
DECLARE definition text; step text:='AND (p_kind = ''upload'' AND r.state IN (''reserved'',''issued'')';
BEGIN
    SELECT pg_get_functiondef('chat.file_transfer_usage(text,text,text)'::regprocedure) INTO definition;
    IF strpos(definition,step)=0 THEN RAISE EXCEPTION 'Unexpected file_transfer_usage predecessor'; END IF;
    EXECUTE replace(definition,step,step||' AND (r.release_at IS NULL OR r.release_at>now())');
END $usage$;
DO $guard$
DECLARE definition text; step text:='AND up.account_id=NEW.account_id AND reservation.state=''issued'')';
BEGIN
    SELECT pg_get_functiondef('chat.file_transfer_reference_guard()'::regprocedure) INTO definition;
    IF strpos(definition,step)=0 THEN RAISE EXCEPTION 'Unexpected file_transfer_reference_guard predecessor'; END IF;
    EXECUTE replace(definition,step,'AND up.account_id=NEW.account_id AND reservation.state=''issued''
          AND (reservation.release_at IS NULL OR reservation.release_at>now()))');
END $guard$;

-- Community Storage staging older than a day is collected, except a managed key whose hold still counts (a multipart
-- permit can be extended up to a day after issue, and its release time follows). OSS uses its bucket lifecycle rule.
CREATE OR REPLACE FUNCTION chat.attachment_expired_staging(p_bucket text)
RETURNS TABLE(name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $staging$
    SELECT o.name FROM storage.objects o
     WHERE o.bucket_id=p_bucket AND o.name LIKE 'staging/%' AND o.created_at<now()-interval '1 day'
       AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_uploads u JOIN chat.file_transfer_reservations r ON r.id=u.reservation_id
            WHERE u.staging_key=o.name AND r.state IN ('reserved','issued') AND (r.release_at IS NULL OR r.release_at>now()))
     ORDER BY o.created_at LIMIT 50
$staging$;

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

NOTIFY pgrst,'reload schema';
