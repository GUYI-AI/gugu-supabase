-- Disable further closures and preserve existing evidence and observed usage.
BEGIN;
SET LOCAL lock_timeout='5s';
DROP FUNCTION chat.file_transfer_downloads_closed(timestamptz,text[],text);
DO $rollback$
DECLARE definition text := pg_get_functiondef('chat.file_temporary_request(jsonb,text,uuid)'::regprocedure);
    extra text := $body$IF t.state='ready' AND t.data_key IS NOT NULL AND t.serve_until>now()
       AND t.created_at>now()-interval '30 days' AND t.host_device_id=r->>'host_device_id'
       AND chat.is_chat_member(t.chat_id,r->>'host_account_id') AND chat.file_temporary_current(t) THEN
        r:=r||jsonb_build_object('retention',t.retention);
    END IF;
    $body$;
BEGIN
    IF position(extra IN definition)=0 THEN RAISE EXCEPTION 'Unexpected temporary request body'; END IF;
    EXECUTE replace(definition,extra,'');
END $rollback$;
GRANT EXECUTE ON FUNCTION chat.file_temporary_request(jsonb,text,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
