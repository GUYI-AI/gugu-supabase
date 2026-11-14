-- One database-owned gate covers the cron dispatcher and in-process collection.
-- A five-candidate activation is one batch, then pauses for review. Normal
-- activation keeps the existing ten-minute cron and fifty-candidate bound.
CREATE TABLE chat.file_blob_gc_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  batch_limit integer NOT NULL DEFAULT 5 CHECK (batch_limit IN (5,50)),
  run_token uuid,
  run_until timestamptz,
  run_permitted boolean NOT NULL DEFAULT false,
  run_claimed boolean NOT NULL DEFAULT false,
  configured_at timestamptz,
  CHECK ((run_token IS NULL) = (run_until IS NULL))
);
INSERT INTO chat.file_blob_gc_control(singleton) VALUES (true);
REVOKE ALL ON chat.file_blob_gc_control FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION chat.file_blob_gc_control_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object(
    'configured', (SELECT count(*)=2 FROM vault.secrets WHERE name IN ('attachments_gc_url','attachments_gc_key')),
    'enabled',c.enabled,'batch_limit',c.batch_limit,'concurrency',1,
    'inflight',CASE WHEN c.run_token IS NOT NULL THEN 1 ELSE 0 END,
    'configuration_capable',true)
  FROM chat.file_blob_gc_control c WHERE singleton
$$;

CREATE FUNCTION chat.configure_file_blob_gc(p_endpoint text,p_key text,p_enabled boolean,p_batch_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c chat.file_blob_gc_control%ROWTYPE; secret_id uuid;
BEGIN
  IF p_enabled IS NULL OR p_batch_limit IS NULL OR p_batch_limit NOT IN (5,50)
     OR p_endpoint IS NULL OR p_endpoint !~ '^https?://[^[:space:]?#]+/functions/v1/attachments/gc$'
     OR NULLIF(btrim(p_key),'') IS NULL THEN RAISE EXCEPTION 'Invalid attachment GC configuration'; END IF;
  SELECT * INTO STRICT c FROM chat.file_blob_gc_control WHERE singleton FOR UPDATE;
  IF p_enabled AND c.run_token IS NOT NULL THEN
    RAISE EXCEPTION 'Attachment GC has an active consumer';
  END IF;
  -- The deployment trust gate must pass before this capability is called.
  -- Existing ciphertext is never returned to the caller.
  SELECT id INTO secret_id FROM vault.secrets WHERE name='attachments_gc_url';
  IF secret_id IS NULL THEN PERFORM vault.create_secret(p_endpoint,'attachments_gc_url');
  ELSE PERFORM vault.update_secret(secret_id,p_endpoint); END IF;
  SELECT id INTO secret_id FROM vault.secrets WHERE name='attachments_gc_key';
  IF secret_id IS NULL THEN PERFORM vault.create_secret(p_key,'attachments_gc_key');
  ELSE PERFORM vault.update_secret(secret_id,p_key); END IF;
  -- Verify encrypt/decrypt availability inside the server, returning a boolean
  -- only. A failed check rolls back both writes and never opens the consumer.
  IF NOT EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='attachments_gc_url' AND decrypted_secret=p_endpoint)
     OR NOT EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='attachments_gc_key' AND decrypted_secret=p_key) THEN
    RAISE EXCEPTION 'Attachment GC configuration is unavailable';
  END IF;
  UPDATE chat.file_blob_gc_control SET enabled=p_enabled,batch_limit=p_batch_limit,
    run_permitted=CASE WHEN p_enabled THEN run_permitted ELSE false END,configured_at=clock_timestamp()
    WHERE singleton;
  RETURN chat.file_blob_gc_control_status();
END $$;

CREATE FUNCTION chat.file_blob_gc_run_begin() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c chat.file_blob_gc_control%ROWTYPE; token uuid;
BEGIN
  SELECT * INTO STRICT c FROM chat.file_blob_gc_control WHERE singleton FOR UPDATE;
  IF NOT c.enabled OR c.run_token IS NOT NULL THEN
    RETURN jsonb_build_object('acquired',false,'batch_limit',c.batch_limit,'concurrency',1);
  END IF;
  -- Never steal an expired consumer: its provider call may still be running.
  -- A crashed consumer remains closed until an administrator proves it stopped
  -- and releases that exact token. Renewal expiry stops further deletions.
  token:=gen_random_uuid();
  UPDATE chat.file_blob_gc_control SET run_token=token,run_until=clock_timestamp()+interval '600 seconds',
    run_permitted=true,run_claimed=false,enabled=(c.batch_limit=50) WHERE singleton;
  RETURN jsonb_build_object('acquired',true,'token',token,'batch_limit',c.batch_limit,'concurrency',1);
END $$;

CREATE FUNCTION chat.file_blob_gc_run_renew(p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  UPDATE chat.file_blob_gc_control SET run_until=clock_timestamp()+interval '600 seconds'
    WHERE singleton AND run_token=p_token AND run_permitted AND run_until>clock_timestamp();
  RETURN FOUND;
END $$;

CREATE FUNCTION chat.file_blob_gc_run_claim(p_token uuid)
RETURNS TABLE(blob_id uuid,claim_token uuid,bucket_id text,object_name text,content_type text,attempt_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE bound integer;
BEGIN
  SELECT batch_limit INTO bound FROM chat.file_blob_gc_control
    WHERE singleton AND run_token=p_token AND run_permitted AND NOT run_claimed AND run_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attachment GC consumer is no longer permitted'; END IF;
  UPDATE chat.file_blob_gc_control SET run_claimed=true WHERE singleton;
  RETURN QUERY SELECT * FROM chat.file_blob_gc_claim(bound,600);
END $$;

CREATE FUNCTION chat.file_blob_gc_run_end(p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  UPDATE chat.file_blob_gc_control SET run_token=NULL,run_until=NULL,run_permitted=false
    WHERE singleton AND run_token=p_token;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION chat.file_blob_gc_kick() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_url text; v_key text;
BEGIN
  -- This check precedes expiry, Vault access and transport. Missing configuration
  -- is not a substitute for the shared consumer gate.
  IF NOT EXISTS(SELECT 1 FROM chat.file_blob_gc_control WHERE singleton AND enabled
      AND run_token IS NULL) THEN RETURN NULL; END IF;
  PERFORM chat.file_temporary_expire(500);
  PERFORM chat.file_transfer_expire(500);
  IF NOT EXISTS(SELECT 1 FROM chat.file_blob_gc WHERE status IN ('pending','failed') AND next_attempt_at<=now())
     AND NOT EXISTS(SELECT 1 FROM chat.file_blob_gc WHERE status='running' AND claimed_at<now()-interval '600 seconds') THEN
    RETURN NULL;
  END IF;
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name='attachments_gc_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name='attachments_gc_key';
  IF NULLIF(btrim(v_url),'') IS NULL OR NULLIF(btrim(v_key),'') IS NULL THEN
    RAISE EXCEPTION 'file_blob_gc_kick: blobs are due for collection but Vault has no attachments_gc_url / attachments_gc_key';
  END IF;
  RETURN net.http_post(url:=v_url,body:='{}'::jsonb,
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key),timeout_milliseconds:=120000);
END $$;

REVOKE ALL ON FUNCTION chat.file_blob_gc_kick() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION chat.file_blob_gc_control_status(),chat.configure_file_blob_gc(text,text,boolean,integer),
  chat.file_blob_gc_run_begin(),chat.file_blob_gc_run_renew(uuid),chat.file_blob_gc_run_claim(uuid),chat.file_blob_gc_run_end(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_blob_gc_control_status(),chat.configure_file_blob_gc(text,text,boolean,integer),
  chat.file_blob_gc_run_begin(),chat.file_blob_gc_run_renew(uuid),chat.file_blob_gc_run_claim(uuid),chat.file_blob_gc_run_end(uuid)
  TO service_role;
