-- An unsettled download reservation counts against the download budget only in the UTC month it was signed.
--
-- Download usage already counts settled downloads by the UTC month of their observations, but an unsettled
-- (reserved or issued) reservation counted its full bytes with no time bound, so every signature that was never
-- reconciled kept consuming the monthly budget in every later month. A signed download now counts its reserved bytes
-- in the month it was created, the same month rule as settled observations. Settlement, explicit closure and the
-- reservation's other readers (signing rate limits, idle expiry, relay key lookup) are unchanged.
SET LOCAL lock_timeout = '5s';

DO $usage$
DECLARE definition text; step text:='OR p_kind = ''download'')';
BEGIN
    SELECT pg_get_functiondef('chat.file_transfer_usage(text,text,text)'::regprocedure) INTO definition;
    IF strpos(definition,step)=0 OR strpos(definition,'month_start')=0 THEN
        RAISE EXCEPTION 'Unexpected file_transfer_usage predecessor; refusing a partial upgrade';
    END IF;
    EXECUTE replace(definition,step,
        'OR p_kind = ''download'' AND (r.state = ''settled'' OR r.created_at >= month_start::timestamp AT TIME ZONE ''UTC''))');
END $usage$;

NOTIFY pgrst,'reload schema';
