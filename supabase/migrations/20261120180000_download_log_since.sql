-- Provider logs cover downloads only from the moment their collection began. A closure settles an expired download only
-- if it was signed at or after that moment (`download_log_since` in the global limits); older holds stay counted as
-- signed. The closure refuses while the setting is missing or when its cutoff is not after it.
SET LOCAL lock_timeout = '5s';

DO $since$
DECLARE definition text; since text:='(SELECT (settings->>''download_log_since'')::timestamptz FROM chat.file_transfer_limits '
        ||'WHERE scope=''global'' AND scope_id=''*'')';
    cutoff text:=') IS NOT FALSE THEN'; scope text:='AND r.expires_at < p_until';
BEGIN
    SELECT pg_get_functiondef('chat.file_transfer_downloads_closed(timestamptz,text[],text)'::regprocedure) INTO definition;
    IF strpos(definition,cutoff)=0 OR strpos(definition,scope)=0 THEN
        RAISE EXCEPTION 'Unexpected file_transfer_downloads_closed predecessor; refusing a partial upgrade';
    END IF;
    EXECUTE replace(replace(definition,cutoff,' OR p_until <= '||since||cutoff),scope,scope||' AND r.created_at >= '||since);
END $since$;
NOTIFY pgrst,'reload schema';
