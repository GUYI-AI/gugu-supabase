-- A device that keeps a file version can say it cannot send a requested copy, and why.
--
-- A reader asks the holder for a temporary copy (file_temporary_request) and polls the same request until it is ready.
-- When the holder could not send it (the file moved or changed on that computer, the upload failed, ...) it only logged
-- the failure locally: the request stayed 'requested' and the reader waited out its whole bound (600 s) with no reason.
-- Seen 2026-11-05: a project file kept on another computer showed "Reading file..." for ten minutes per attempt.
--
-- The holder now retires its own request with the cause in one line; the reader's next poll sees 'retired' with that
-- cause and shows it. A later request is a new generation, so the holder tries again (the file may be back).
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

CREATE OR REPLACE FUNCTION chat.file_temporary_request(p_ref jsonb,p_as text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor text:=chat.workspace_actor_for(p_as); r jsonb; t chat.file_temporary_transfers%ROWTYPE; kept text; cfg jsonb;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    r:=chat.file_resolve_as(p_ref,actor);
    IF r->>'status'<>'ready' OR r->>'source'<>'local' THEN RETURN r; END IF;
    IF (r->>'temporary_transfer')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Temporary transfer is disabled for this file' USING HINT='file_transfer_denied';
    END IF;
    SELECT * INTO t FROM chat.file_temporary_transfers WHERE id=p_id;
    IF FOUND THEN
        IF (t.reader_account,t.reader_actor,t.item_id,t.version,t.source_ref)
           IS DISTINCT FROM (auth.uid()::text,actor,(r->>'item_id')::uuid,(r->>'version')::integer,p_ref) THEN
            RAISE EXCEPTION 'Transfer identity is immutable' USING HINT='file_transfer_conflict';
        END IF;
    ELSE
        kept:=chat.file_storage_of(r->>'host_account_id')->>'retention'; cfg:=chat.file_transfer_settings();
        IF kept<>'read-once' THEN
            SELECT generation.* INTO t FROM chat.file_temporary_transfers generation WHERE item_id=(r->>'item_id')::uuid AND version=(r->>'version')::integer
                AND retention<>'read-once' AND (state='ready' AND serve_until>now() AND created_at>now()-interval '30 days'
                    OR state='requested' AND created_at>now()-make_interval(secs=>chat.file_transfer_parameter(cfg,'upload_permit_seconds')::integer)
                    OR state='uploading' AND EXISTS(SELECT 1 FROM chat.file_transfer_reservations v WHERE v.id=generation.id AND v.state='issued' AND v.expires_at>now()))
                AND chat.file_temporary_current(generation)
                ORDER BY created_at DESC LIMIT 1;
        END IF;
        IF t.id IS NULL THEN
            IF (SELECT count(*) FROM chat.file_temporary_transfers WHERE reader_account=auth.uid()::text
                AND created_at>now()-make_interval(secs=>chat.file_transfer_parameter(cfg,'sign_window_seconds')::integer))
                >=chat.file_transfer_parameter(cfg,'sign_account_count') THEN
                RAISE EXCEPTION 'Too many temporary transfer requests' USING HINT='file_transfer_rate_limited';
            END IF;
            INSERT INTO chat.file_temporary_transfers(id,item_id,version,chat_id,host_device_id,reader_account,reader_actor,source_ref,retention,object_name)
            VALUES(p_id,(r->>'item_id')::uuid,(r->>'version')::integer,r->>'chat_id',r->>'host_device_id',auth.uid()::text,actor,p_ref,kept,
                'temporary/'||(r->>'chat_id')||'/'||(r->>'item_id')||'/'||(r->>'version')||'/'||(r->>'sha256')||'/'||p_id::text) RETURNING * INTO t;
            PERFORM realtime.send(jsonb_build_object('request_id',t.id),'files.transfer','gugu:'||t.host_device_id||':rpc',true);
        END IF;
    END IF;
    RETURN r||jsonb_build_object('transfer_id',t.id,'transfer_status',t.state,'transfer_declined',t.declined);
END $$;

REVOKE ALL ON FUNCTION chat.file_temporary_decline(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION chat.file_temporary_decline(uuid,text) TO authenticated;
