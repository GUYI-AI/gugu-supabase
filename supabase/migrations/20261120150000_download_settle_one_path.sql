-- One settle path: the covered closure settles every expired eligible download before its cutoff, observed or not, and
-- its cutoff must be at least the provider log delivery window old. The uncovered per-row settle goes away.
SET LOCAL lock_timeout = '5s';

DO $closed$
DECLARE definition text;
    cutoff text:='OR p_until > now() THEN';
    unobserved text:=E'\n       AND NOT EXISTS (SELECT FROM chat.file_transfer_observations e WHERE e.reservation_id=r.id);';
BEGIN
    SELECT pg_get_functiondef('chat.file_transfer_downloads_closed(timestamptz,text[],text)'::regprocedure) INTO definition;
    IF strpos(definition,cutoff)=0 OR strpos(definition,unobserved)=0 THEN
        RAISE EXCEPTION 'Unexpected file_transfer_downloads_closed predecessor; refusing a partial upgrade';
    END IF;
    -- A missing window compares as NULL and refuses, like a cutoff inside it.
    EXECUTE replace(replace(definition,unobserved,';'),cutoff,'OR (p_until > now()-make_interval(secs=>(SELECT '
        ||'(settings->>''download_log_window_seconds'')::integer FROM chat.file_transfer_limits WHERE scope=''global''))) IS NOT FALSE THEN');
END $closed$;

DROP FUNCTION chat.file_transfer_settle(uuid);
NOTIFY pgrst,'reload schema';
