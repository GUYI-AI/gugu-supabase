-- A retained row lets delayed provider records debit the original reservation.
ALTER TABLE chat.file_transfer_reservations ADD COLUMN close_evidence text;

CREATE FUNCTION chat.file_transfer_downloads_closed(p_until timestamptz, p_sources text[], p_evidence text)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE closed_count integer;
BEGIN
    IF p_until IS NULL OR NOT isfinite(p_until) OR p_until > now() THEN
        RAISE EXCEPTION 'A finite completed provider cutoff is required';
    END IF;
    IF p_evidence IS NULL OR length(p_evidence) NOT BETWEEN 1 AND 160 OR p_evidence !~ '[^[:space:]]' THEN
        RAISE EXCEPTION 'A short terminal provider evidence reference is required';
    END IF;
    IF 'storage' = ANY(p_sources) THEN
        RAISE EXCEPTION 'Storage has no trusted usage import';
    END IF;
    IF coalesce(cardinality(p_sources),0) = 0 OR array_ndims(p_sources) <> 1
       OR NOT p_sources <@ ARRAY['cdn','oss'] OR cardinality(p_sources) <> (SELECT count(DISTINCT s) FROM unnest(p_sources) s) THEN
        RAISE EXCEPTION 'Expected distinct verified CDN or OSS log sources';
    END IF;

    -- Share the admission/observation fence before testing for absence of records.
    PERFORM 1 FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Global download limits are not configured'; END IF;
    UPDATE chat.file_transfer_reservations r
       SET state='settled', close_evidence=p_evidence
      FROM chat.file_transfer_storage o
     WHERE r.kind='download' AND r.state IN ('reserved','issued') AND r.expires_at < p_until
       AND r.subject='object:'||o.id::text
       AND ((o.bucket_id='oss' AND ARRAY['cdn','oss'] <@ p_sources)
         OR (o.bucket_id='temporary' AND 'oss'=ANY(p_sources)))
       AND NOT EXISTS (SELECT FROM chat.file_transfer_observations e WHERE e.reservation_id=r.id);
    GET DIAGNOSTICS closed_count = ROW_COUNT;
    RETURN closed_count;
END $$;
COMMENT ON FUNCTION chat.file_transfer_downloads_closed(timestamptz,text[],text) IS
'Operator attests complete imports for all eligible reservations before the cutoff, including completed responses admitted before expiry. Evidence must identify physical OSS and CDN history. Never call if Storage signed a candidate or provider history is unknown.';
REVOKE ALL ON FUNCTION chat.file_transfer_downloads_closed(timestamptz,text[],text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.file_transfer_downloads_closed(timestamptz,text[],text) TO service_role;

-- Include the selected generation's own policy after the request's existing authorization.
DO $migration$
DECLARE definition text := pg_get_functiondef('chat.file_temporary_request(jsonb,text,uuid)'::regprocedure);
    anchor text := 'RETURN r||jsonb_build_object(''transfer_id'',t.id,''transfer_status'',t.state);';
BEGIN
    IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected temporary request predecessor'; END IF;
    EXECUTE replace(definition,anchor,$body$IF t.state='ready' AND t.data_key IS NOT NULL AND t.serve_until>now()
       AND t.created_at>now()-interval '30 days' AND t.host_device_id=r->>'host_device_id'
       AND chat.is_chat_member(t.chat_id,r->>'host_account_id') AND chat.file_temporary_current(t) THEN
        r:=r||jsonb_build_object('retention',t.retention);
    END IF;
    $body$||anchor);
END $migration$;
GRANT EXECUTE ON FUNCTION chat.file_temporary_request(jsonb,text,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
