-- A device that keeps a file version can say it cannot send a requested copy, and why.
--
-- A reader asks the holder for a temporary copy (file_temporary_request) and polls the same request until it is ready.
-- When the holder could not send it (the file moved or changed on that computer, the upload failed, ...) it only logged
-- the failure locally: the request stayed 'requested' and the reader waited out its whole bound with no reason.
--
-- The holder now retires its own request with the cause in one line; the reader's next poll sees 'retired' with that
-- cause. A later request is a new generation, so the holder tries again (the file may be back).
ALTER TABLE chat.file_temporary_transfers ADD COLUMN declined text CHECK(char_length(declined) BETWEEN 1 AND 300);

CREATE FUNCTION chat.file_temporary_decline(p_id uuid,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 300 THEN
        RAISE EXCEPTION 'A decline needs a one-line reason' USING HINT='file_transfer_invalid';
    END IF;
    PERFORM chat.file_temporary_host_for(p_id,auth.uid()::text);
    UPDATE chat.file_temporary_transfers SET state='retired',declined=p_reason,data_key=NULL
        WHERE id=p_id AND state IN ('requested','uploading');
END $$;
REVOKE ALL ON FUNCTION chat.file_temporary_decline(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION chat.file_temporary_decline(uuid,text) TO authenticated;

-- The reader's poll returns the reason with the state. Patch only the return line, keeping later changes to the body.
DO $migration$
DECLARE definition text := pg_get_functiondef('chat.file_temporary_request(jsonb,text,uuid)'::regprocedure);
    anchor text := 'RETURN r||jsonb_build_object(''transfer_id'',t.id,''transfer_status'',t.state);';
BEGIN
    IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected temporary request predecessor'; END IF;
    EXECUTE replace(definition,anchor,'RETURN r||jsonb_build_object(''transfer_id'',t.id,''transfer_status'',t.state,''transfer_declined'',t.declined);');
END $migration$;
GRANT EXECUTE ON FUNCTION chat.file_temporary_request(jsonb,text,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
