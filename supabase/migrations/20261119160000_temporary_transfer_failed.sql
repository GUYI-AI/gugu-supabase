-- A relay refusal the same request cannot cure is recorded on the transfer, so its reader stops waiting.
-- Until now a host refusal rolled back with the accept, the row stayed `requested`, and the reader waited out its bound.
ALTER TABLE chat.file_temporary_transfers DROP CONSTRAINT file_temporary_transfers_state_check;
ALTER TABLE chat.file_temporary_transfers ADD CONSTRAINT file_temporary_transfers_state_check
    CHECK(state IN ('requested','uploading','ready','failed','retired'));
ALTER TABLE chat.file_temporary_transfers ADD COLUMN failure_code text;
ALTER TABLE chat.file_temporary_transfers ADD CONSTRAINT file_temporary_transfers_failure_code_check
    CHECK(CASE state WHEN 'failed' THEN failure_code IS NOT NULL WHEN 'retired' THEN true ELSE failure_code IS NULL END
        AND failure_code IN ('account_storage_full','group_storage_full','global_storage_full','too_large','upload_changed'));

-- Service only: the edge calls it in its own transaction after the refused one rolled back, with the caller's JWT user.
-- Ownership is the device-and-member clause of file_temporary_host_for without its staleness clause: a refused accept on
-- a permit that just went stale is still this host's refusal. Each code moves the row only from the stage that raises it,
-- so a late failure never undoes a later success, and ready / retired / failed rows are never touched.
CREATE FUNCTION chat.file_temporary_fail(p_id uuid,p_host text,p_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE stage text:=CASE WHEN p_code IN ('account_storage_full','group_storage_full','global_storage_full','too_large') THEN 'requested'
    WHEN p_code='upload_changed' THEN 'uploading' END;
BEGIN
    IF stage IS NULL THEN RAISE EXCEPTION 'Not a terminal transfer refusal' USING HINT='file_transfer_invalid'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    UPDATE chat.file_temporary_transfers t SET state='failed',failure_code=p_code
    WHERE t.id=p_id AND t.state=stage AND EXISTS(SELECT 1 FROM identity.gugu_devices d
        WHERE d.device_id=t.host_device_id AND d.user_id::text=p_host AND chat.is_chat_member(t.chat_id,p_host));
    RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION chat.file_temporary_fail(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_temporary_fail(uuid,text,text) TO service_role;

-- The reader's own row reports its failure code next to its state. A joined request id owns no row; the reuse selector
-- admits only ready / requested / uploading, so after a failure it starts its own generation.
DO $migration$
DECLARE definition text := pg_get_functiondef('chat.file_temporary_request(jsonb,text,uuid)'::regprocedure);
    anchor text := 'RETURN r||jsonb_build_object(''transfer_id'',t.id,''transfer_status'',t.state);';
BEGIN
    IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected temporary request predecessor'; END IF;
    EXECUTE replace(definition,anchor,
        'RETURN r||jsonb_build_object(''transfer_id'',t.id,''transfer_status'',CASE WHEN t.failure_code IS NULL THEN t.state ELSE ''failed'' END,''failure_code'',t.failure_code);');
END $migration$;
GRANT EXECUTE ON FUNCTION chat.file_temporary_request(jsonb,text,uuid) TO authenticated;

-- A failed generation is retired like a stale request, after the upload permit lifetime; retirement hands any blob to
-- the existing collector (file_temporary_collect). The row keeps its failure_code, so the request above still answers
-- `failed` with the code to a reader that polls after expiry ran.
DO $migration$
DECLARE definition text := pg_get_functiondef('chat.file_temporary_expire(integer,uuid,text,bigint)'::regprocedure);
    anchor text := 'OR state=''requested'' AND created_at<=now()';
BEGIN
    IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected temporary expiry predecessor'; END IF;
    EXECUTE replace(definition,anchor,'OR state IN (''requested'',''failed'') AND created_at<=now()');
END $migration$;
NOTIFY pgrst,'reload schema';
