-- Result custody and explicit request intents. Installation never enables V2.
CREATE TABLE account_deletion_private.operation_access (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false
);
INSERT INTO account_deletion_private.operation_access(singleton) VALUES(true);
CREATE TABLE account_deletion_private.operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_digest text NOT NULL UNIQUE CHECK(operation_digest ~ '^[a-f0-9]{64}$'),
  receipt_digest text NOT NULL CHECK(receipt_digest ~ '^[a-f0-9]{64}$'),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id uuid REFERENCES auth.sessions(id) ON DELETE SET NULL,
  email_digest text CHECK(email_digest IS NULL OR email_digest ~ '^[a-f0-9]{64}$'),
  consent_version text NOT NULL CHECK(consent_version='immediate-forfeit-v1'),
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','confirming','processing','deleted','closed_before_confirm')),
  revision bigint NOT NULL DEFAULT 1,
  confirm_started_at timestamptz,
  challenge_generation integer NOT NULL DEFAULT 0 CHECK(challenge_generation>=0),
  request_id uuid REFERENCES account_deletion_private.requests(id),
  send_lease uuid,
  preparation_cancelled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX account_deletion_one_operation ON account_deletion_private.operations(user_id)
  WHERE user_id IS NOT NULL AND state NOT IN ('deleted','closed_before_confirm');
ALTER TABLE account_deletion_private.requests ADD COLUMN operation_id uuid REFERENCES account_deletion_private.operations(id);
ALTER TABLE account_deletion_private.requests ADD COLUMN challenge_generation integer;
CREATE UNIQUE INDEX account_deletion_operation_challenge ON account_deletion_private.requests(operation_id,challenge_generation)
  WHERE operation_id IS NOT NULL;
CREATE TABLE account_deletion_private.confirmation_intents (
  operation_id uuid NOT NULL REFERENCES account_deletion_private.operations(id),
  id uuid NOT NULL,
  challenge_generation integer NOT NULL,
  request_id uuid NOT NULL REFERENCES account_deletion_private.requests(id),
  native_generation uuid NOT NULL,
  server_generation uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('verifying','rejected','processing','deleted')),
  lease_token uuid,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(operation_id,id)
);
ALTER TABLE account_deletion_private.operation_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_private.operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_private.confirmation_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON account_deletion_private.operation_access,account_deletion_private.operations,
  account_deletion_private.confirmation_intents FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION account_deletion_private.operation_forget_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL THEN
    NEW.session_id:=NULL; NEW.email_digest:=NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION account_deletion_private.operation_forget_identity() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER operation_forget_identity BEFORE UPDATE OF user_id ON account_deletion_private.operations
  FOR EACH ROW EXECUTE FUNCTION account_deletion_private.operation_forget_identity();

-- Preserve the exact installed reconciliation core privately. Public legacy
-- callers cannot use a V2 child to bypass parent/preparation/intent checks.
DO $copy$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef('public.account_deletion_flow(text,uuid,uuid,uuid,text,text,text,uuid,text)'::regprocedure) INTO d;
  IF position('s.not_after>now_at' IN d)=0 OR position('Legacy Edge error labels' IN d)=0 THEN
    RAISE EXCEPTION 'Account deletion reconciliation dependency is missing';
  END IF;
  d:=replace(d,'public.account_deletion_flow(', 'account_deletion_private.legacy_flow_213000(');
  EXECUTE d;
END $copy$;
REVOKE ALL ON FUNCTION account_deletion_private.legacy_flow_213000(text,uuid,uuid,uuid,text,text,text,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.account_deletion_flow(
  p_action text,p_user_id uuid DEFAULT NULL,p_session_id uuid DEFAULT NULL,p_request_id uuid DEFAULT NULL,
  p_receipt_digest text DEFAULT NULL,p_email_digest text DEFAULT NULL,p_consent_version text DEFAULT NULL,
  p_lease_token uuid DEFAULT NULL,p_error_code text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid;
BEGIN
  IF p_action IN ('begin','attempt','retry','verified','execute') THEN
    actor:=COALESCE(p_user_id,(SELECT user_id FROM account_deletion_private.requests WHERE id=p_request_id));
    IF actor IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||actor::text,0));
    END IF;
    IF EXISTS(SELECT 1 FROM account_deletion_private.operations WHERE user_id=actor) THEN
      RETURN jsonb_build_object('ok',false,'error','operation_protocol_required','status',409);
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM account_deletion_private.requests WHERE id=p_request_id AND operation_id IS NOT NULL) THEN
    RETURN jsonb_build_object('ok',false,'error','operation_protocol_required','status',409);
  END IF;
  IF p_action='begin' AND EXISTS(SELECT 1 FROM account_deletion_private.operations
      WHERE user_id=p_user_id AND state NOT IN ('deleted','closed_before_confirm')) THEN
    RETURN jsonb_build_object('ok',false,'error','request_active','status',409);
  END IF;
  RETURN account_deletion_private.legacy_flow_213000(p_action,p_user_id,p_session_id,p_request_id,
    p_receipt_digest,p_email_digest,p_consent_version,p_lease_token,p_error_code);
END $$;
ALTER FUNCTION public.account_deletion_flow(text,uuid,uuid,uuid,text,text,text,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_deletion_flow(text,uuid,uuid,uuid,text,text,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.account_deletion_flow(text,uuid,uuid,uuid,text,text,text,uuid,text) TO service_role;

CREATE FUNCTION account_deletion_private.operation_view(o account_deletion_private.operations) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('operation_id',o.id,'state',o.state,'revision',o.revision,
    'challenge_generation',o.challenge_generation,'request_id',o.request_id,
    'request',(SELECT account_deletion_private.view_request(r) FROM account_deletion_private.requests r WHERE r.id=o.request_id),
    'confirmation',(SELECT jsonb_build_object('confirmation_id',c.id,'state',c.state,'error_code',c.error_code,
      'challenge_generation',c.challenge_generation) FROM account_deletion_private.confirmation_intents c
      WHERE c.operation_id=o.id ORDER BY c.created_at DESC,c.id DESC LIMIT 1),
    'can_retry',false,'can_release_preparation',o.state='closed_before_confirm' AND o.confirm_started_at IS NULL AND o.preparation_cancelled)
$$;
REVOKE ALL ON FUNCTION account_deletion_private.operation_view(account_deletion_private.operations) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION account_deletion_private.operation_caller_is_current(p_user_id uuid,p_session_id uuid,p_email_digest text)
RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM auth.users u JOIN auth.sessions s ON s.user_id=u.id
    WHERE u.id=p_user_id AND s.id=p_session_id AND (s.not_after IS NULL OR s.not_after>clock_timestamp())
      AND u.email_confirmed_at IS NOT NULL AND u.deleted_at IS NULL
      AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
      AND encode(sha256(convert_to(lower(u.email),'UTF8')),'hex')=p_email_digest)
$$;
REVOKE ALL ON FUNCTION account_deletion_private.operation_caller_is_current(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.account_deletion_operation_flow(
  p_action text,p_operation_digest text,p_receipt_digest text,
  p_user_id uuid DEFAULT NULL,p_session_id uuid DEFAULT NULL,p_email_digest text DEFAULT NULL,
  p_consent_version text DEFAULT NULL,p_generation integer DEFAULT NULL,p_confirmation_id uuid DEFAULT NULL,
  p_lease_token uuid DEFAULT NULL,p_error_code text DEFAULT NULL,p_device_id text DEFAULT NULL,
  p_native_generation uuid DEFAULT NULL,p_server_generation uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,account_deletion_private AS $$
DECLARE
  o account_deletion_private.operations%ROWTYPE;
  ci account_deletion_private.confirmation_intents%ROWTYPE;
  req account_deletion_private.requests%ROWTYPE;
  rollout account_deletion_private.access%ROWTYPE;
  actor uuid; original_sid uuid; current_email text; now_at timestamptz; answer jsonb; prep jsonb;
  fresh boolean:=false; needed text;
BEGIN
  IF p_operation_digest IS NULL OR p_operation_digest !~ '^[a-f0-9]{64}$'
    OR p_receipt_digest IS NULL OR p_receipt_digest !~ '^[a-f0-9]{64}$' THEN
    RETURN jsonb_build_object('ok',false,'error','invalid_request','status',400);
  END IF;
  IF p_action NOT IN ('result','finish','verification_failed','cancel_preparation') AND NOT COALESCE(
      (SELECT enabled FROM account_deletion_private.operation_access WHERE singleton),false) THEN
    RETURN jsonb_build_object('ok',false,'error','operation_unavailable','status',503);
  END IF;
  -- Account admission is always outside the parent/child/device lock order.
  SELECT user_id,session_id INTO actor,original_sid FROM account_deletion_private.operations WHERE operation_digest=p_operation_digest;
  IF p_action IN ('register','begin','claim_confirmation','prepare_device','read_preparation','cancel_preparation') THEN
    actor:=p_user_id; original_sid:=p_session_id;
    SELECT lower(u.email) INTO current_email FROM auth.users u JOIN auth.sessions s ON s.user_id=u.id
      WHERE u.id=p_user_id AND s.id=p_session_id AND (s.not_after IS NULL OR s.not_after>clock_timestamp())
        AND u.email_confirmed_at IS NOT NULL AND u.deleted_at IS NULL
        AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp());
    IF current_email IS NULL THEN RETURN jsonb_build_object('ok',false,'error','unauthorized','status',401); END IF;
    IF encode(sha256(convert_to(current_email,'UTF8')),'hex') IS DISTINCT FROM p_email_digest THEN
      RETURN jsonb_build_object('ok',false,'error','identity_changed','status',409);
    END IF;
  END IF;
  IF p_action<>'result' AND actor IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||actor::text,0));
  END IF;
  -- FK writers in Auth may already hold the identity row before touching our
  -- parent/child rows. Never wait for them while holding an operation lock.
  IF actor IS NOT NULL THEN PERFORM 1 FROM auth.users WHERE id=actor FOR KEY SHARE NOWAIT; END IF;
  IF original_sid IS NOT NULL THEN PERFORM 1 FROM auth.sessions WHERE id=original_sid FOR KEY SHARE NOWAIT; END IF;
  SELECT * INTO o FROM account_deletion_private.operations WHERE operation_digest=p_operation_digest FOR UPDATE;
  now_at:=clock_timestamp();
  -- The advisory/parent wait may outlive the original SID. Key-share locks
  -- protect identity rows, never the clock or mutable authorization attributes.
  IF p_action IN ('register','begin','claim_confirmation','prepare_device','read_preparation','cancel_preparation')
    AND NOT account_deletion_private.operation_caller_is_current(p_user_id,p_session_id,p_email_digest) THEN
    RETURN jsonb_build_object('ok',false,'error','unauthorized','status',401);
  END IF;
  IF o.id IS NULL AND p_action IN ('register','begin') THEN
    SELECT * INTO STRICT rollout FROM account_deletion_private.access WHERE singleton;
    IF rollout.test_only AND rollout.test_user_id IS DISTINCT FROM p_user_id THEN
      RETURN jsonb_build_object('ok',false,'error','rollout_unavailable','status',503);
    END IF;
    IF p_consent_version IS DISTINCT FROM 'immediate-forfeit-v1' THEN
      RETURN jsonb_build_object('ok',false,'error','consent_changed','status',409);
    END IF;
    IF EXISTS(SELECT 1 FROM account_deletion_private.operations WHERE user_id=p_user_id
        AND state NOT IN ('deleted','closed_before_confirm')) OR EXISTS(SELECT 1 FROM account_deletion_private.requests
        WHERE user_id=p_user_id AND state IN ('sending','challenge','verifying','processing','retry_wait')
          AND (state IN ('processing','retry_wait','verifying') OR expires_at>now_at)) THEN
      RETURN jsonb_build_object('ok',false,'error','request_active','status',409);
    END IF;
    UPDATE account_deletion_private.requests SET state='expired',lease_token=NULL,lease_until=NULL
      WHERE user_id=p_user_id AND operation_id IS NULL AND state IN ('sending','challenge') AND expires_at<=now_at;
    BEGIN
      INSERT INTO account_deletion_private.operations(operation_digest,receipt_digest,user_id,session_id,email_digest,consent_version)
        VALUES(p_operation_digest,p_receipt_digest,p_user_id,p_session_id,p_email_digest,p_consent_version) RETURNING * INTO o;
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('ok',false,'error','scope_conflict','status',409);
    END;
    fresh:=true;
  END IF;
  IF o.id IS NULL OR o.receipt_digest IS DISTINCT FROM p_receipt_digest THEN
    RETURN jsonb_build_object('ok',false,'error','not_found','status',404);
  END IF;
  IF p_action IN ('register','begin','claim_confirmation','prepare_device','read_preparation','cancel_preparation') AND
      (o.user_id IS DISTINCT FROM p_user_id OR o.session_id IS DISTINCT FROM p_session_id
       OR o.email_digest IS DISTINCT FROM p_email_digest) THEN
    RETURN jsonb_build_object('ok',false,'error','scope_conflict','status',409);
  END IF;
  IF p_action IN ('register','begin','claim_confirmation') AND p_consent_version IS DISTINCT FROM o.consent_version THEN
    RETURN jsonb_build_object('ok',false,'error','consent_changed','status',409);
  END IF;
  IF o.request_id IS NOT NULL THEN
    PERFORM 1 FROM account_deletion_private.requests WHERE id=o.request_id FOR UPDATE NOWAIT;
  END IF;
  IF p_action='register' THEN
    RETURN jsonb_build_object('ok',true,'operation',account_deletion_private.operation_view(o),'replayed',NOT fresh);
  ELSIF p_action='result' THEN
    IF o.request_id IS NOT NULL THEN
      answer:=account_deletion_private.legacy_flow_213000('result',p_request_id:=o.request_id,p_receipt_digest:=o.receipt_digest);
    END IF;
    IF o.user_id IS NULL OR answer#>>'{request,state}'='deleted' THEN
      UPDATE account_deletion_private.operations SET state='deleted',revision=revision+1,updated_at=now_at
        WHERE id=o.id AND state<>'deleted' RETURNING * INTO o;
      IF NOT FOUND THEN SELECT * INTO o FROM account_deletion_private.operations WHERE operation_digest=p_operation_digest; END IF;
    END IF;
    RETURN jsonb_build_object('ok',true,'operation',account_deletion_private.operation_view(o));
  END IF;

  IF p_action IN ('prepare_device','read_preparation','cancel_preparation') THEN
    IF p_native_generation IS NULL THEN RETURN jsonb_build_object('ok',false,'error','invalid_request','status',400); END IF;
    needed:=CASE p_action WHEN 'prepare_device' THEN 'account_deletion_private.device_preparation_prepare(uuid,text,uuid)'
      WHEN 'read_preparation' THEN 'account_deletion_private.device_preparation_read(uuid,uuid,uuid)'
      ELSE 'account_deletion_private.device_preparation_cancel(uuid,uuid,uuid)' END;
    IF to_regprocedure(needed) IS NULL THEN RETURN jsonb_build_object('ok',false,'error','preparation_unavailable','status',503); END IF;
    IF p_action='cancel_preparation' THEN
      IF o.state NOT IN ('open','closed_before_confirm') OR o.confirm_started_at IS NOT NULL THEN
        RETURN jsonb_build_object('ok',false,'error','request_active','status',409);
      END IF;
      IF o.state='open' THEN
        UPDATE account_deletion_private.operations SET state='closed_before_confirm',revision=revision+1,updated_at=clock_timestamp()
          WHERE id=o.id AND state='open' AND confirm_started_at IS NULL
            AND account_deletion_private.operation_caller_is_current(user_id,session_id,email_digest)
          RETURNING * INTO o;
        IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','unauthorized','status',401); END IF;
      END IF;
    ELSIF o.state<>'open' AND p_action='prepare_device' THEN
      RETURN jsonb_build_object('ok',false,'error','request_active','status',409);
    END IF;
    IF p_action='prepare_device' THEN
      EXECUTE 'SELECT account_deletion_private.device_preparation_prepare($1,$2,$3)' INTO prep USING o.id,p_device_id,p_native_generation;
    ELSIF p_action='read_preparation' THEN
      EXECUTE 'SELECT account_deletion_private.device_preparation_read($1,$2,$3)' INTO prep USING o.id,p_native_generation,p_server_generation;
    ELSE
      EXECUTE 'SELECT account_deletion_private.device_preparation_cancel($1,$2,$3)' INTO prep USING o.id,p_native_generation,p_server_generation;
      IF prep->>'cancelled'='true' AND prep->>'native_generation'=p_native_generation::text
        AND prep->>'server_generation'=p_server_generation::text THEN
        -- Closing the whole pre-confirmation operation also fences a late OTP
        -- send receipt. Its child must stop occupying the account's single
        -- active-request slot. Never retire a verification or DELETE here.
        UPDATE account_deletion_private.requests SET state='expired',lease_token=NULL,lease_until=NULL
          WHERE operation_id=o.id AND state IN ('sending','challenge');
        UPDATE account_deletion_private.operations SET preparation_cancelled=true,send_lease=NULL
          WHERE id=o.id RETURNING * INTO o;
      END IF;
    END IF;
    RETURN jsonb_build_object('ok',true,'operation',account_deletion_private.operation_view(o),'preparation',prep);
  END IF;

  IF p_action='begin' THEN
    IF p_generation=o.challenge_generation AND o.request_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok',true,'operation',account_deletion_private.operation_view(o),'dispatch_required',false);
    END IF;
    IF o.state<>'open' OR p_generation IS NULL OR p_generation<1 THEN
      RETURN jsonb_build_object('ok',false,'error','request_active','status',409);
    END IF;
    IF p_generation<>o.challenge_generation+1 THEN RETURN jsonb_build_object('ok',false,'error','scope_conflict','status',409); END IF;
    SELECT * INTO STRICT rollout FROM account_deletion_private.access WHERE singleton;
    IF rollout.test_only AND rollout.test_user_id IS DISTINCT FROM o.user_id THEN
      RETURN jsonb_build_object('ok',false,'error','rollout_unavailable','status',503);
    END IF;
    IF EXISTS(SELECT 1 FROM account_deletion_private.requests WHERE user_id=o.user_id AND created_at>now_at-interval '60 seconds')
      OR (SELECT count(*) FROM account_deletion_private.requests WHERE user_id=o.user_id AND created_at>now_at-interval '15 minutes')>=3 THEN
      RETURN jsonb_build_object('ok',false,'error','rate_limited','status',429);
    END IF;
    SELECT * INTO req FROM account_deletion_private.requests WHERE user_id=o.user_id
      AND state IN ('sending','challenge','verifying','processing','retry_wait') FOR UPDATE;
    IF req.id IS NOT NULL THEN
      IF req.state NOT IN ('challenge','failed','expired') THEN RETURN jsonb_build_object('ok',false,'error','request_active','status',409); END IF;
      UPDATE account_deletion_private.requests SET state='expired',lease_token=NULL,lease_until=NULL WHERE id=req.id;
    END IF;
    INSERT INTO account_deletion_private.requests(user_id,session_id,email_digest,receipt_digest,state,operation_id,challenge_generation)
      VALUES(o.user_id,o.session_id,o.email_digest,o.receipt_digest,'sending',o.id,p_generation) RETURNING * INTO req;
    INSERT INTO account_deletion_private.events(request_id,actor_user_id,event) VALUES(req.id,o.user_id,'send_started');
    UPDATE account_deletion_private.operations SET request_id=req.id,challenge_generation=p_generation,send_lease=gen_random_uuid(),
      revision=revision+1,updated_at=now_at WHERE id=o.id RETURNING * INTO o;
    RETURN jsonb_build_object('ok',true,'operation',account_deletion_private.operation_view(o),'dispatch_required',true,'lease_token',o.send_lease);
  END IF;
  IF p_generation IS DISTINCT FROM o.challenge_generation OR o.request_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','scope_conflict','status',409);
  END IF;
  IF p_action='sent' THEN
    IF o.state<>'open' OR p_lease_token IS NULL OR o.send_lease IS DISTINCT FROM p_lease_token THEN
      RETURN jsonb_build_object('ok',false,'error','state_conflict','status',409);
    END IF;
    IF p_error_code IS NOT NULL THEN
      UPDATE account_deletion_private.requests SET last_error='email_outcome_unknown' WHERE id=o.request_id AND state='sending';
      RETURN jsonb_build_object('ok',true,'operation',account_deletion_private.operation_view(o));
    END IF;
    answer:=account_deletion_private.legacy_flow_213000('sent',p_request_id:=o.request_id);
    RETURN jsonb_build_object('ok',answer->'ok','operation',account_deletion_private.operation_view(o));
  END IF;
  SELECT * INTO ci FROM account_deletion_private.confirmation_intents WHERE operation_id=o.id AND id=p_confirmation_id FOR UPDATE;
  IF p_action='claim_confirmation' THEN
    IF p_confirmation_id IS NULL OR p_native_generation IS NULL OR p_server_generation IS NULL THEN
      RETURN jsonb_build_object('ok',false,'error','invalid_request','status',400);
    END IF;
    IF ci.id IS NOT NULL THEN
      IF ci.challenge_generation<>p_generation OR ci.native_generation<>p_native_generation OR ci.server_generation<>p_server_generation THEN
        RETURN jsonb_build_object('ok',false,'error','scope_conflict','status',409);
      END IF;
      RETURN jsonb_build_object('ok',true,'operation',account_deletion_private.operation_view(o),'dispatch_required',false,'confirmation_state',ci.state);
    END IF;
    IF o.state<>'open' THEN RETURN jsonb_build_object('ok',false,'error','request_active','status',409); END IF;
    IF to_regprocedure('account_deletion_private.device_preparation_read(uuid,uuid,uuid)') IS NULL THEN
      RETURN jsonb_build_object('ok',false,'error','preparation_unavailable','status',503);
    END IF;
    EXECUTE 'SELECT account_deletion_private.device_preparation_read($1,$2,$3)' INTO prep USING o.id,p_native_generation,p_server_generation;
    IF prep->>'prepared' IS DISTINCT FROM 'true' OR prep->>'native_generation' IS DISTINCT FROM p_native_generation::text
      OR prep->>'server_generation' IS DISTINCT FROM p_server_generation::text THEN
      RETURN jsonb_build_object('ok',false,'error','closure_not_prepared','status',409);
    END IF;
    answer:=account_deletion_private.legacy_flow_213000('attempt',p_user_id:=o.user_id,p_session_id:=o.session_id,
      p_request_id:=o.request_id,p_receipt_digest:=o.receipt_digest,p_email_digest:=o.email_digest,p_consent_version:=o.consent_version);
    IF NOT COALESCE((answer->>'ok')::boolean,false) THEN RETURN answer; END IF;
    INSERT INTO account_deletion_private.confirmation_intents(operation_id,id,challenge_generation,request_id,native_generation,server_generation,state,lease_token)
      VALUES(o.id,p_confirmation_id,p_generation,o.request_id,p_native_generation,p_server_generation,'verifying',(answer->>'lease_token')::uuid);
    UPDATE account_deletion_private.operations SET state='confirming',confirm_started_at=COALESCE(confirm_started_at,now_at),
      revision=revision+1,updated_at=now_at WHERE id=o.id RETURNING * INTO o;
    RETURN jsonb_build_object('ok',true,'operation',account_deletion_private.operation_view(o),'dispatch_required',true,'lease_token',answer->'lease_token');
  END IF;
  IF ci.id IS NULL OR p_lease_token IS NULL OR ci.lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN jsonb_build_object('ok',false,'error','state_conflict','status',409);
  END IF;
  IF p_action IN ('verified','verification_failed') THEN
    IF o.state<>'confirming' OR ci.state<>'verifying' THEN RETURN jsonb_build_object('ok',false,'error','state_conflict','status',409); END IF;
    answer:=account_deletion_private.legacy_flow_213000(p_action,p_request_id:=o.request_id,p_lease_token:=p_lease_token);
    IF NOT COALESCE((answer->>'ok')::boolean,false) THEN RETURN answer; END IF;
    UPDATE account_deletion_private.confirmation_intents SET state=CASE WHEN p_action='verified' THEN 'processing' ELSE 'rejected' END,
      lease_token=CASE WHEN p_action='verified' THEN (answer->>'lease_token')::uuid ELSE NULL END,
      error_code=CASE WHEN p_action='verification_failed' THEN 'verification_failed' END WHERE operation_id=o.id AND id=ci.id;
    UPDATE account_deletion_private.operations SET state=CASE WHEN p_action='verified' THEN 'processing' ELSE 'open' END,
      revision=revision+1,updated_at=now_at WHERE id=o.id RETURNING * INTO o;
    RETURN answer||jsonb_build_object('operation',account_deletion_private.operation_view(o));
  ELSIF p_action='execute' THEN
    IF o.state<>'processing' OR ci.state<>'processing' THEN RETURN jsonb_build_object('ok',false,'error','state_conflict','status',409); END IF;
    IF to_regprocedure('account_deletion_private.device_preparation_read(uuid,uuid,uuid)') IS NULL THEN
      RETURN jsonb_build_object('ok',false,'error','preparation_unavailable','status',503);
    END IF;
    EXECUTE 'SELECT account_deletion_private.device_preparation_read($1,$2,$3)' INTO prep USING o.id,ci.native_generation,ci.server_generation;
    IF prep->>'prepared' IS DISTINCT FROM 'true' OR prep->>'native_generation' IS DISTINCT FROM ci.native_generation::text
      OR prep->>'server_generation' IS DISTINCT FROM ci.server_generation::text THEN
      RETURN jsonb_build_object('ok',false,'error','closure_not_prepared','status',409);
    END IF;
    answer:=account_deletion_private.legacy_flow_213000('execute',p_request_id:=o.request_id,p_lease_token:=p_lease_token);
    RETURN answer||jsonb_build_object('operation',account_deletion_private.operation_view(o));
  ELSIF p_action='finish' THEN
    answer:=account_deletion_private.legacy_flow_213000('finish',p_request_id:=o.request_id,p_lease_token:=p_lease_token,
      p_error_code:=CASE WHEN p_error_code IS NULL THEN NULL ELSE 'outcome_unknown' END);
    IF answer#>>'{request,state}'='deleted' THEN
      UPDATE account_deletion_private.operations SET state='deleted',revision=revision+1,updated_at=now_at WHERE id=o.id RETURNING * INTO o;
      UPDATE account_deletion_private.confirmation_intents SET state='deleted',lease_token=NULL WHERE operation_id=o.id AND id=ci.id;
    END IF;
    RETURN answer||jsonb_build_object('operation',account_deletion_private.operation_view(o));
  END IF;
  RETURN jsonb_build_object('ok',false,'error','invalid_action','status',400);
EXCEPTION WHEN lock_not_available THEN
  RETURN jsonb_build_object('ok',false,'error','operation_busy','status',503);
WHEN insufficient_privilege THEN
  -- Device helpers reject with fixed 42501. The exception subtransaction
  -- rolls back parent CAS/intent changes before returning this safe category.
  RETURN jsonb_build_object('ok',false,'error','preparation_unavailable','status',503);
END $$;
ALTER FUNCTION public.account_deletion_operation_flow(text,text,text,uuid,uuid,text,text,integer,uuid,uuid,text,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_deletion_operation_flow(text,text,text,uuid,uuid,text,text,integer,uuid,uuid,text,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.account_deletion_operation_flow(text,text,text,uuid,uuid,text,text,integer,uuid,uuid,text,text,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
