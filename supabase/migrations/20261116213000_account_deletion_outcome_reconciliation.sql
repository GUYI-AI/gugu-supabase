-- Lease expiry is not proof that an accepted Auth deletion did not execute.
-- Keep the original capability usable until an authoritative outcome is known.
DO $outcome$
DECLARE definition text; old_parts text[] := ARRAY[
$old$            IF existing.state='processing' AND existing.lease_until>now_at$old$,
$old$        IF r.user_id IS NULL AND r.state IN ('processing','retry_wait') THEN$old$,
$old$    ELSIF p_action='retry' THEN
        IF c.test_only$old$,
$old$        IF NOT(r.state='retry_wait' OR (r.state='processing' AND r.lease_until<now_at)) OR r.expires_at<=now_at THEN$old$,
$old$    ELSIF p_action='finish' THEN
        IF r.state='deleted' THEN RETURN jsonb_build_object('ok',true,'request',account_deletion_private.view_request(r)); END IF;
        IF r.state<>'processing' OR r.lease_token IS DISTINCT FROM p_lease_token THEN RETURN jsonb_build_object('ok',false,'error','state_conflict','status',409); END IF;$old$,
$old$        ELSIF p_error_code IN ('auth_delete_failed','auth_user_still_exists') THEN
            UPDATE account_deletion_private.requests SET state='retry_wait',last_error=p_error_code,
                lease_token=NULL,lease_until=NULL WHERE id=r.id RETURNING * INTO r;
            INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,r.user_id,'delete_failed');$old$,
$old$        IF r.receipt_digest IS DISTINCT FROM p_receipt_digest THEN RETURN jsonb_build_object('ok',false,'error','not_found','status',404); END IF;$old$
]; new_parts text[] := ARRAY[
$new$            IF existing.state IN ('processing','retry_wait')$new$,
$new$        IF r.user_id IS NULL AND r.state<>'deleted' THEN$new$,
$new$    ELSIF p_action='retry' THEN
        IF r.state IN ('processing','retry_wait') THEN
            RETURN jsonb_build_object('ok',false,'error','request_active','status',409);
        END IF;
        IF c.test_only$new$,
$new$        IF r.state<>'retry_wait' OR r.expires_at<=now_at THEN$new$,
$new$    ELSIF p_action='execute' THEN
        -- This check precedes the destructive external request. It never turns
        -- an uncertain processing request into a cancellable terminal state.
        IF r.user_id IS NULL THEN
            IF r.state<>'deleted' THEN
                UPDATE account_deletion_private.requests SET state='deleted',completed_at=now_at,last_error=NULL,
                    email_digest=NULL,session_id=NULL,verified_at=NULL,lease_token=NULL,lease_until=NULL
                    WHERE id=r.id RETURNING * INTO r;
                INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,NULL,'deleted');
            END IF;
            RETURN jsonb_build_object('ok',true,'request',account_deletion_private.view_request(r));
        END IF;
        IF r.state<>'processing' OR p_lease_token IS NULL OR r.lease_token IS DISTINCT FROM p_lease_token
           OR r.lease_until IS NULL OR r.lease_until<=now_at THEN
            RETURN jsonb_build_object('ok',false,'error','state_conflict','status',409);
        END IF;
        IF r.expires_at<=now_at OR (c.test_only AND c.test_user_id IS DISTINCT FROM r.user_id)
           OR NOT EXISTS(SELECT 1 FROM auth.users u JOIN auth.sessions s ON s.user_id=u.id
               WHERE u.id=r.user_id AND s.id=r.session_id AND (s.not_after IS NULL OR s.not_after>now_at)
                 AND u.email_confirmed_at IS NOT NULL
                 AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=now_at)
                 AND encode(sha256(convert_to(lower(u.email),'UTF8')),'hex')=r.email_digest) THEN
            RETURN jsonb_build_object('ok',false,'error','authorization_expired','status',410);
        END IF;
        RETURN jsonb_build_object('ok',true,'request',account_deletion_private.view_request(r),
            'user_id',r.user_id,'lease_token',r.lease_token);
    ELSIF p_action='finish' THEN
        IF r.state='deleted' THEN RETURN jsonb_build_object('ok',true,'request',account_deletion_private.view_request(r)); END IF;
        -- The FK is cleared only by committed Auth deletion. A late commit wins
        -- even over a legacy expired state or a superseded execution lease.
        IF r.user_id IS NOT NULL AND (r.state<>'processing' OR r.lease_token IS DISTINCT FROM p_lease_token) THEN
            RETURN jsonb_build_object('ok',false,'error','state_conflict','status',409);
        END IF;$new$,
$new$        ELSIF p_error_code IN ('auth_delete_failed','auth_user_still_exists') THEN
            -- Legacy Edge error labels are not transaction-termination evidence.
            UPDATE account_deletion_private.requests SET last_error='outcome_unknown',lease_until=now_at+interval '90 seconds'
                WHERE id=r.id RETURNING * INTO r;$new$,
$new$        IF r.receipt_digest IS DISTINCT FROM p_receipt_digest THEN RETURN jsonb_build_object('ok',false,'error','not_found','status',404); END IF;
        IF r.user_id IS NOT NULL AND r.state='retry_wait' THEN
            -- Normalize only after checking the original result capability.
            UPDATE account_deletion_private.requests SET state='processing',last_error='outcome_unknown',lease_token=NULL,lease_until=NULL
                WHERE id=r.id RETURNING * INTO r;
        END IF;$new$
]; i integer;
BEGIN
    SELECT pg_get_functiondef('public.account_deletion_flow(text,uuid,uuid,uuid,text,text,text,uuid,text)'::regprocedure)
      INTO definition;
    FOR i IN 1..array_length(old_parts,1) LOOP
        IF length(definition)-length(replace(definition,old_parts[i],''))<>length(old_parts[i]) THEN
            RAISE EXCEPTION 'Unexpected account deletion predecessor at section %',i;
        END IF;
        definition:=replace(definition,old_parts[i],new_parts[i]);
    END LOOP;
    EXECUTE definition;

    SELECT pg_get_functiondef('account_deletion_private.view_request(account_deletion_private.requests)'::regprocedure)
      INTO definition;
    IF position($old$(r.state='retry_wait' OR (r.state='processing' AND r.lease_until<clock_timestamp()))$old$ IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected account deletion request projection';
    END IF;
    IF position($old$'state',r.state$old$ IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected account deletion state projection';
    END IF;
    definition:=replace(definition,$old$'state',r.state$old$,
        $new$'state',CASE WHEN r.state='retry_wait' THEN 'processing' ELSE r.state END$new$);
    EXECUTE replace(definition,
        $old$(r.state='retry_wait' OR (r.state='processing' AND r.lease_until<clock_timestamp()))$old$,
        $new$false$new$);
END $outcome$;

ALTER FUNCTION public.account_deletion_flow(text,uuid,uuid,uuid,text,text,text,uuid,text) OWNER TO postgres;
ALTER FUNCTION account_deletion_private.view_request(account_deletion_private.requests) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_deletion_flow(text,uuid,uuid,uuid,text,text,text,uuid,text)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.account_deletion_flow(text,uuid,uuid,uuid,text,text,text,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION account_deletion_private.view_request(account_deletion_private.requests)
    FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
