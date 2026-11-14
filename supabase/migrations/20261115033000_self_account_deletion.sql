-- Identity workflow only. Auth Admin performs the hard delete and the existing
-- Auth triggers perform erasure. No billing implementation or key is stored here.
CREATE SCHEMA account_deletion_private;
REVOKE ALL ON SCHEMA account_deletion_private FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE account_deletion_private.policy (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    enabled boolean NOT NULL DEFAULT false,
    test_only boolean NOT NULL DEFAULT false,
    test_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    mode text CHECK(mode IN ('immediate','pending')),
    delay_seconds integer CHECK(delay_seconds BETWEEN 0 AND 2592000),
    credit_treatment_key text CHECK(length(credit_treatment_key) BETWEEN 1 AND 64),
    version uuid NOT NULL DEFAULT gen_random_uuid(),
    worker_seen_at timestamptz,
    worker_owner uuid,
    worker_until timestamptz,
    CHECK(NOT enabled OR (mode IS NOT NULL AND credit_treatment_key IS NOT NULL
        AND ((mode='immediate' AND delay_seconds=0) OR (mode='pending' AND delay_seconds>0))))
);
INSERT INTO account_deletion_private.policy(singleton) VALUES(true);

CREATE TABLE account_deletion_private.requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    session_id uuid REFERENCES auth.sessions(id) ON DELETE SET NULL,
    email_digest text CHECK(email_digest IS NULL OR email_digest ~ '^[a-f0-9]{64}$'),
    receipt_digest text NOT NULL CHECK(receipt_digest ~ '^[a-f0-9]{64}$'),
    state text NOT NULL CHECK(state IN ('sending','challenge','verifying','pending','processing','retry_wait','deleted','cancelled','failed','expired')),
    mode text NOT NULL CHECK(mode IN ('immediate','pending')),
    policy_version uuid NOT NULL,
    delay_seconds integer NOT NULL,
    credit_treatment_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',
    verified_at timestamptz,
    delete_after timestamptz,
    next_attempt_at timestamptz,
    lease_token uuid,
    lease_until timestamptz,
    verification_attempts integer NOT NULL DEFAULT 0,
    deletion_attempts integer NOT NULL DEFAULT 0,
    last_error text,
    completed_at timestamptz
);
CREATE UNIQUE INDEX account_deletion_one_active ON account_deletion_private.requests(user_id)
    WHERE user_id IS NOT NULL AND state IN ('sending','challenge','verifying','pending','processing','retry_wait');
CREATE INDEX account_deletion_due ON account_deletion_private.requests(next_attempt_at,delete_after)
    WHERE state IN ('pending','processing','retry_wait');
CREATE INDEX account_deletion_user_time ON account_deletion_private.requests(user_id,created_at);

CREATE TABLE account_deletion_private.events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id uuid NOT NULL REFERENCES account_deletion_private.requests(id) ON DELETE CASCADE,
    actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    event text NOT NULL CHECK(event IN ('send_started','send_failed','code_sent','verification_started',
        'verification_failed','verified','scheduled','delete_started','delete_failed','deleted','cancelled','expired'))
);
CREATE INDEX account_deletion_attempt_rate ON account_deletion_private.events(actor_user_id,occurred_at)
    WHERE event='verification_started';
ALTER TABLE account_deletion_private.policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_private.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_private.events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA account_deletion_private FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA account_deletion_private FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION account_deletion_private.forget_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL THEN
        NEW.email_digest:=NULL;
        NEW.session_id:=NULL;
        NEW.verified_at:=NULL;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION account_deletion_private.forget_identity() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER account_deletion_forget_identity BEFORE UPDATE OF user_id
    ON account_deletion_private.requests FOR EACH ROW EXECUTE FUNCTION account_deletion_private.forget_identity();

CREATE FUNCTION account_deletion_private.view_request(r account_deletion_private.requests) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
    SELECT jsonb_build_object('request_id',r.id,'state',r.state,'mode',r.mode,
        'expires_at',r.expires_at,'delete_after',r.delete_after,'last_error',r.last_error,
        'can_cancel',r.state='pending' AND clock_timestamp()<r.delete_after,
        'can_retry',r.state='retry_wait' AND r.mode='immediate' AND clock_timestamp()<r.expires_at)
$$;
REVOKE ALL ON FUNCTION account_deletion_private.view_request(account_deletion_private.requests)
    FROM PUBLIC,anon,authenticated,service_role;

-- The service-only RPC is an internal Edge adapter. End-user JWTs cannot call
-- it or select the tables. User/session IDs come from Auth-verified tokens.
CREATE FUNCTION public.account_deletion_flow(
    p_action text,
    p_user_id uuid DEFAULT NULL,
    p_session_id uuid DEFAULT NULL,
    p_request_id uuid DEFAULT NULL,
    p_receipt_digest text DEFAULT NULL,
    p_email_digest text DEFAULT NULL,
    p_policy_version uuid DEFAULT NULL,
    p_lease_token uuid DEFAULT NULL,
    p_error_code text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,account_deletion_private AS $$
DECLARE
    r account_deletion_private.requests%ROWTYPE;
    existing account_deletion_private.requests%ROWTYPE;
    c account_deletion_private.policy%ROWTYPE;
    now_at timestamptz:=clock_timestamp();
    current_email text;
    result jsonb;
BEGIN
    SELECT * INTO STRICT c FROM account_deletion_private.policy WHERE singleton;

    IF p_action='heartbeat' THEN
        UPDATE account_deletion_private.policy SET worker_seen_at=now_at WHERE singleton;
        RETURN jsonb_build_object('ok',true);
    END IF;

    IF p_action='worker_release' THEN
        UPDATE account_deletion_private.policy SET worker_owner=NULL,worker_until=NULL
            WHERE singleton AND worker_owner=p_lease_token;
        RETURN jsonb_build_object('ok',true);
    END IF;

    IF p_action='claim_due' THEN
        IF p_lease_token IS NULL THEN RETURN jsonb_build_object('ok',false,'error','invalid_request','status',400); END IF;
        SELECT * INTO STRICT c FROM account_deletion_private.policy WHERE singleton FOR UPDATE;
        now_at:=clock_timestamp();
        IF c.worker_until>now_at AND c.worker_owner IS DISTINCT FROM p_lease_token THEN
            RETURN jsonb_build_object('ok',true,'claims','[]'::jsonb,'busy',true);
        END IF;
        UPDATE account_deletion_private.policy SET worker_seen_at=now_at,worker_owner=p_lease_token,
            worker_until=now_at+interval '90 seconds' WHERE singleton;
        result:='[]'::jsonb;
        FOR r IN SELECT * FROM account_deletion_private.requests q
            WHERE (q.state='pending' AND q.delete_after<=now_at AND COALESCE(q.next_attempt_at,q.delete_after)<=now_at)
               OR (q.state='processing' AND q.lease_until<now_at)
               OR (q.state='retry_wait' AND q.mode='pending' AND q.next_attempt_at<=now_at)
            ORDER BY q.created_at FOR UPDATE SKIP LOCKED LIMIT 1
        LOOP
            IF r.user_id IS NULL THEN
                UPDATE account_deletion_private.requests SET state='deleted',completed_at=now_at,
                    email_digest=NULL,session_id=NULL,verified_at=NULL,lease_token=NULL,lease_until=NULL,last_error=NULL
                    WHERE id=r.id;
                INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,NULL,'deleted');
                CONTINUE;
            END IF;
            IF r.mode='immediate' AND r.expires_at<=now_at THEN
                UPDATE account_deletion_private.requests SET state='expired',lease_token=NULL,lease_until=NULL WHERE id=r.id;
                INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,r.user_id,'expired');
                CONTINUE;
            END IF;
            UPDATE account_deletion_private.requests SET state='processing',lease_token=gen_random_uuid(),
                lease_until=now_at+interval '90 seconds',deletion_attempts=deletion_attempts+1
                WHERE id=r.id RETURNING * INTO r;
            INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,r.user_id,'delete_started');
            result:=result||jsonb_build_array(jsonb_build_object('request_id',r.id,'user_id',r.user_id,'lease_token',r.lease_token));
        END LOOP;
        RETURN jsonb_build_object('ok',true,'claims',result);
    END IF;

    IF p_action IN ('status','begin','attempt','retry','cancel') THEN
        SELECT lower(u.email) INTO current_email FROM auth.users u
            WHERE u.id=p_user_id AND u.email_confirmed_at IS NOT NULL AND u.deleted_at IS NULL
              AND EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=p_session_id AND s.user_id=u.id);
        IF current_email IS NULL THEN RETURN jsonb_build_object('ok',false,'error','unauthorized','status',401); END IF;
        IF p_action IN ('begin','attempt','retry') AND encode(sha256(convert_to(current_email,'UTF8')),'hex') IS DISTINCT FROM p_email_digest THEN
            RETURN jsonb_build_object('ok',false,'error','identity_changed','status',409);
        END IF;
    END IF;

    IF p_action='status' THEN
        SELECT * INTO r FROM account_deletion_private.requests
            WHERE user_id=p_user_id AND state IN ('sending','challenge','verifying','pending','processing','retry_wait')
            ORDER BY created_at DESC LIMIT 1;
        RETURN jsonb_build_object('ok',true,'policy',jsonb_build_object('enabled',COALESCE(c.enabled AND (NOT c.test_only OR c.test_user_id=p_user_id),false),
            'mode',c.mode,'delay_seconds',c.delay_seconds,'credit_treatment_key',c.credit_treatment_key,'version',c.version,
            'worker_ready',COALESCE(c.worker_seen_at>now_at-interval '2 minutes',false)),
            'request',CASE WHEN r.id IS NULL THEN NULL ELSE account_deletion_private.view_request(r) END);
    END IF;

    IF p_action='begin' THEN
        IF NOT c.enabled OR (c.test_only AND c.test_user_id IS DISTINCT FROM p_user_id) THEN RETURN jsonb_build_object('ok',false,'error','disabled','status',503); END IF;
        IF c.version IS DISTINCT FROM p_policy_version THEN RETURN jsonb_build_object('ok',false,'error','policy_changed','status',409); END IF;
        IF c.mode='pending' AND (c.worker_seen_at IS NULL OR c.worker_seen_at<=now_at-interval '2 minutes') THEN
            RETURN jsonb_build_object('ok',false,'error','worker_unavailable','status',503);
        END IF;
        IF p_receipt_digest IS NULL OR p_receipt_digest !~ '^[a-f0-9]{64}$' THEN
            RETURN jsonb_build_object('ok',false,'error','invalid_request','status',400);
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||p_user_id::text,0));
        IF EXISTS(SELECT 1 FROM account_deletion_private.requests WHERE user_id=p_user_id AND created_at>now_at-interval '60 seconds')
           OR (SELECT count(*) FROM account_deletion_private.requests WHERE user_id=p_user_id AND created_at>now_at-interval '15 minutes')>=3 THEN
            RETURN jsonb_build_object('ok',false,'error','rate_limited','status',429);
        END IF;
        SELECT * INTO existing FROM account_deletion_private.requests WHERE user_id=p_user_id
            AND state IN ('sending','challenge','verifying','pending','processing','retry_wait') FOR UPDATE;
        IF existing.id IS NOT NULL THEN
            IF existing.state IN ('pending','processing') OR (existing.state IN ('verifying','retry_wait') AND existing.expires_at>now_at) THEN
                RETURN jsonb_build_object('ok',false,'error','request_active','status',409);
            END IF;
            UPDATE account_deletion_private.requests SET state='expired',lease_token=NULL,lease_until=NULL WHERE id=existing.id;
        END IF;
        INSERT INTO account_deletion_private.requests(user_id,session_id,email_digest,receipt_digest,state,mode,policy_version,delay_seconds,credit_treatment_key)
            VALUES(p_user_id,p_session_id,p_email_digest,p_receipt_digest,'sending',c.mode,c.version,c.delay_seconds,c.credit_treatment_key)
            RETURNING * INTO r;
        INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,p_user_id,'send_started');
        RETURN jsonb_build_object('ok',true,'request',account_deletion_private.view_request(r));
    END IF;

    SELECT * INTO r FROM account_deletion_private.requests WHERE id=p_request_id FOR UPDATE;
    now_at:=clock_timestamp();
    IF r.id IS NULL THEN RETURN jsonb_build_object('ok',false,'error','not_found','status',404); END IF;
    IF p_action='result' THEN
        IF r.receipt_digest IS DISTINCT FROM p_receipt_digest THEN RETURN jsonb_build_object('ok',false,'error','not_found','status',404); END IF;
        IF r.user_id IS NULL AND r.state IN ('processing','pending','retry_wait') THEN
            UPDATE account_deletion_private.requests SET state='deleted',completed_at=now_at,last_error=NULL,
                email_digest=NULL,session_id=NULL,verified_at=NULL,lease_token=NULL,lease_until=NULL
                WHERE id=r.id RETURNING * INTO r;
            INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,NULL,'deleted');
        END IF;
        RETURN jsonb_build_object('ok',true,'request',account_deletion_private.view_request(r));
    END IF;

    IF p_action IN ('attempt','retry','cancel') AND r.user_id IS DISTINCT FROM p_user_id THEN
        RETURN jsonb_build_object('ok',false,'error','not_found','status',404);
    END IF;
    IF p_action IN ('attempt','retry') AND (r.receipt_digest IS DISTINCT FROM p_receipt_digest
        OR r.session_id IS DISTINCT FROM p_session_id OR r.email_digest IS DISTINCT FROM p_email_digest) THEN
        RETURN jsonb_build_object('ok',false,'error','invalid_proof','status',403);
    END IF;

    IF p_action='sent' THEN
        IF r.state<>'sending' THEN RETURN jsonb_build_object('ok',false,'error','state_conflict','status',409); END IF;
        UPDATE account_deletion_private.requests SET state=CASE WHEN p_error_code IS NULL THEN 'challenge' ELSE 'failed' END,
            last_error=CASE WHEN p_error_code IS NULL THEN NULL ELSE 'email_unavailable' END WHERE id=r.id RETURNING * INTO r;
        INSERT INTO account_deletion_private.events(request_id,actor_user_id,event)
            VALUES(r.id,r.user_id,CASE WHEN p_error_code IS NULL THEN 'code_sent' ELSE 'send_failed' END);
    ELSIF p_action='attempt' THEN
        IF r.state<>'challenge' THEN RETURN jsonb_build_object('ok',false,'error','state_conflict','status',409); END IF;
        IF r.expires_at<=now_at THEN
            UPDATE account_deletion_private.requests SET state='expired' WHERE id=r.id;
            RETURN jsonb_build_object('ok',false,'error','expired','status',410);
        END IF;
        IF NOT c.enabled OR (c.test_only AND c.test_user_id IS DISTINCT FROM p_user_id)
           OR c.version IS DISTINCT FROM r.policy_version OR c.version IS DISTINCT FROM p_policy_version THEN
            RETURN jsonb_build_object('ok',false,'error','policy_changed','status',409);
        END IF;
        IF r.verification_attempts>=5 OR (SELECT count(*) FROM account_deletion_private.events
            WHERE actor_user_id=r.user_id AND event='verification_started' AND occurred_at>now_at-interval '15 minutes')>=10 THEN
            RETURN jsonb_build_object('ok',false,'error','rate_limited','status',429);
        END IF;
        UPDATE account_deletion_private.requests SET state='verifying',verification_attempts=verification_attempts+1,
            lease_token=gen_random_uuid(),lease_until=now_at+interval '90 seconds' WHERE id=r.id RETURNING * INTO r;
        INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,r.user_id,'verification_started');
        RETURN jsonb_build_object('ok',true,'lease_token',r.lease_token,'request',account_deletion_private.view_request(r));
    ELSIF p_action IN ('verification_failed','verified') THEN
        IF r.state<>'verifying' OR r.lease_token IS DISTINCT FROM p_lease_token OR r.lease_until<=now_at THEN
            RETURN jsonb_build_object('ok',false,'error','state_conflict','status',409);
        END IF;
        IF p_action='verification_failed' THEN
            UPDATE account_deletion_private.requests SET state=CASE WHEN verification_attempts>=5 OR expires_at<=now_at THEN 'failed' ELSE 'challenge' END,
                lease_token=NULL,lease_until=NULL,last_error='verification_failed' WHERE id=r.id RETURNING * INTO r;
            INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,r.user_id,'verification_failed');
        ELSE
            IF r.expires_at<=now_at OR NOT c.enabled OR (c.test_only AND c.test_user_id IS DISTINCT FROM r.user_id)
               OR c.version IS DISTINCT FROM r.policy_version
               OR NOT EXISTS(SELECT 1 FROM auth.users u JOIN auth.sessions s ON s.user_id=u.id
                   WHERE u.id=r.user_id AND s.id=r.session_id AND u.email_confirmed_at IS NOT NULL
                     AND encode(sha256(convert_to(lower(u.email),'UTF8')),'hex')=r.email_digest) THEN
                UPDATE account_deletion_private.requests SET state='expired',lease_token=NULL,lease_until=NULL WHERE id=r.id;
                RETURN jsonb_build_object('ok',false,'error','authorization_expired','status',410);
            END IF;
            IF r.mode='pending' AND (c.worker_seen_at IS NULL OR c.worker_seen_at<=now_at-interval '2 minutes') THEN
                UPDATE account_deletion_private.requests SET state='failed',last_error='worker_unavailable',lease_token=NULL,lease_until=NULL WHERE id=r.id;
                RETURN jsonb_build_object('ok',false,'error','worker_unavailable','status',503);
            END IF;
            UPDATE account_deletion_private.requests SET verified_at=now_at,
                state=CASE WHEN mode='pending' THEN 'pending' ELSE 'processing' END,
                delete_after=now_at+make_interval(secs=>delay_seconds),next_attempt_at=now_at+make_interval(secs=>delay_seconds),
                lease_token=CASE WHEN mode='pending' THEN NULL ELSE gen_random_uuid() END,
                lease_until=CASE WHEN mode='pending' THEN NULL ELSE now_at+interval '90 seconds' END,
                deletion_attempts=CASE WHEN mode='pending' THEN 0 ELSE 1 END,last_error=NULL WHERE id=r.id RETURNING * INTO r;
            INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,r.user_id,'verified');
            INSERT INTO account_deletion_private.events(request_id,actor_user_id,event)
                VALUES(r.id,r.user_id,CASE WHEN r.mode='pending' THEN 'scheduled' ELSE 'delete_started' END);
            RETURN jsonb_build_object('ok',true,'request',account_deletion_private.view_request(r),'user_id',r.user_id,'lease_token',r.lease_token);
        END IF;
    ELSIF p_action='retry' THEN
        IF r.mode<>'immediate' OR r.state<>'retry_wait' OR r.expires_at<=now_at THEN
            RETURN jsonb_build_object('ok',false,'error','new_verification_required','status',409);
        END IF;
        UPDATE account_deletion_private.requests SET state='processing',lease_token=gen_random_uuid(),
            lease_until=now_at+interval '90 seconds',deletion_attempts=deletion_attempts+1,last_error=NULL WHERE id=r.id RETURNING * INTO r;
        INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,r.user_id,'delete_started');
        RETURN jsonb_build_object('ok',true,'request',account_deletion_private.view_request(r),'user_id',r.user_id,'lease_token',r.lease_token);
    ELSIF p_action='cancel' THEN
        IF r.state='cancelled' THEN RETURN jsonb_build_object('ok',true,'request',account_deletion_private.view_request(r)); END IF;
        IF r.state<>'pending' OR r.delete_after<=now_at THEN RETURN jsonb_build_object('ok',false,'error','cancellation_closed','status',409); END IF;
        UPDATE account_deletion_private.requests SET state='cancelled',completed_at=now_at,lease_token=NULL,lease_until=NULL WHERE id=r.id RETURNING * INTO r;
        INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,r.user_id,'cancelled');
    ELSIF p_action='finish' THEN
        IF r.state='deleted' THEN RETURN jsonb_build_object('ok',true,'request',account_deletion_private.view_request(r)); END IF;
        IF r.state<>'processing' OR r.lease_token IS DISTINCT FROM p_lease_token THEN
            RETURN jsonb_build_object('ok',false,'error','state_conflict','status',409);
        END IF;
        IF r.user_id IS NULL THEN
            UPDATE account_deletion_private.requests SET state='deleted',completed_at=now_at,last_error=NULL,
                email_digest=NULL,session_id=NULL,verified_at=NULL,lease_token=NULL,lease_until=NULL WHERE id=r.id RETURNING * INTO r;
            INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,NULL,'deleted');
        ELSIF p_error_code='outcome_unknown' THEN
            UPDATE account_deletion_private.requests SET last_error='outcome_unknown',lease_until=now_at+interval '90 seconds'
                WHERE id=r.id RETURNING * INTO r;
        ELSIF p_error_code IN ('auth_delete_failed','auth_user_still_exists') THEN
            UPDATE account_deletion_private.requests SET state='retry_wait',last_error=p_error_code,
                lease_token=NULL,lease_until=NULL,next_attempt_at=now_at+make_interval(secs=>LEAST(900,30*(2^LEAST(deletion_attempts,5))::integer))
                WHERE id=r.id RETURNING * INTO r;
            INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(r.id,r.user_id,'delete_failed');
        ELSE
            RETURN jsonb_build_object('ok',false,'error','auth_user_still_exists','status',503);
        END IF;
    ELSE
        RETURN jsonb_build_object('ok',false,'error','invalid_action','status',400);
    END IF;
    RETURN jsonb_build_object('ok',true,'request',account_deletion_private.view_request(r));
END $$;
REVOKE ALL ON FUNCTION public.account_deletion_flow(text,uuid,uuid,uuid,text,text,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_flow(text,uuid,uuid,uuid,text,text,uuid,uuid,text) TO service_role;
