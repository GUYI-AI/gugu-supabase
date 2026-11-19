-- A relay refusal the same request cannot cure ends that request the way a holder's own decline does
-- (20261119200000_file_transfer_decline): retired, with the reason, so its reader stops waiting. Until now the refusal
-- rolled back with the accept, the row stayed `requested`, and the reader waited out its bound.
--
-- Service only: the edge calls it in its own transaction after the refused one rolled back, with the caller's JWT user.
-- Ownership is the device-and-member clause of file_temporary_host_for without its staleness clause: a refused accept
-- on a permit that just went stale is still this host's refusal. Each code retires the row only from the stage that
-- raises it, so a late refusal never undoes a later success, and ready or retired rows are never touched. The holder's
-- own decline (file_temporary_decline) is unchanged.
CREATE FUNCTION chat.file_temporary_refuse(p_id uuid,p_host text,p_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE stage text:=CASE WHEN p_code IN ('account_storage_full','group_storage_full','global_storage_full','too_large') THEN 'requested'
    WHEN p_code='upload_changed' THEN 'uploading' END;
BEGIN
    IF stage IS NULL THEN RAISE EXCEPTION 'Not a terminal transfer refusal' USING HINT='file_transfer_invalid'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    UPDATE chat.file_temporary_transfers t SET state='retired',declined=p_code,data_key=NULL
    WHERE t.id=p_id AND t.state=stage AND EXISTS(SELECT 1 FROM identity.gugu_devices d
        WHERE d.device_id=t.host_device_id AND d.user_id::text=p_host AND chat.is_chat_member(t.chat_id,p_host));
    RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION chat.file_temporary_refuse(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_temporary_refuse(uuid,text,text) TO service_role;
