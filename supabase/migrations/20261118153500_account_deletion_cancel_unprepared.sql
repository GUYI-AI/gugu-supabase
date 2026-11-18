-- Leaving the email/impact screen must close its operation even when no device
-- preparation exists yet. Keep the installed protocol and its prepared path.
DO $capture$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.account_deletion_operation_flow(text,text,text,uuid,uuid,text,text,integer,uuid,uuid,text,text,uuid,uuid)'::regprocedure)
    INTO definition;
  IF position('Closing the whole pre-confirmation operation' IN definition)=0 THEN
    RAISE EXCEPTION 'Unexpected account deletion operation predecessor';
  END IF;
  EXECUTE replace(definition,'FUNCTION public.account_deletion_operation_flow(',
    'FUNCTION account_deletion_private.operation_flow_233100(');
END $capture$;
REVOKE ALL ON FUNCTION account_deletion_private.operation_flow_233100(text,text,text,uuid,uuid,text,text,integer,uuid,uuid,text,text,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.account_deletion_operation_flow(
  p_action text,p_operation_digest text,p_receipt_digest text,
  p_user_id uuid DEFAULT NULL,p_session_id uuid DEFAULT NULL,p_email_digest text DEFAULT NULL,
  p_consent_version text DEFAULT NULL,p_generation integer DEFAULT NULL,p_confirmation_id uuid DEFAULT NULL,
  p_lease_token uuid DEFAULT NULL,p_error_code text DEFAULT NULL,p_device_id text DEFAULT NULL,
  p_native_generation uuid DEFAULT NULL,p_server_generation uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  op account_deletion_private.operations%ROWTYPE;
  prepared account_deletion_private.device_preparations%ROWTYPE;
  child account_deletion_private.requests%ROWTYPE;
BEGIN
  IF p_action<>'cancel_operation' THEN
    RETURN account_deletion_private.operation_flow_233100(p_action,p_operation_digest,p_receipt_digest,
      p_user_id,p_session_id,p_email_digest,p_consent_version,p_generation,p_confirmation_id,
      p_lease_token,p_error_code,p_device_id,p_native_generation,p_server_generation);
  END IF;
  IF p_operation_digest IS NULL OR p_operation_digest !~ '^[a-f0-9]{64}$'
    OR p_receipt_digest IS NULL OR p_receipt_digest !~ '^[a-f0-9]{64}$' OR p_native_generation IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','invalid_request','status',400);
  END IF;
  IF NOT account_deletion_private.operation_caller_is_current(p_user_id,p_session_id,p_email_digest) THEN
    RETURN jsonb_build_object('ok',false,'error','unauthorized','status',401);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('account-deletion:'||p_user_id::text,0));
  PERFORM 1 FROM auth.users WHERE id=p_user_id FOR KEY SHARE NOWAIT;
  PERFORM 1 FROM auth.sessions WHERE id=p_session_id FOR KEY SHARE NOWAIT;
  SELECT * INTO op FROM account_deletion_private.operations WHERE operation_digest=p_operation_digest FOR UPDATE;
  IF NOT account_deletion_private.operation_caller_is_current(p_user_id,p_session_id,p_email_digest) THEN
    RETURN jsonb_build_object('ok',false,'error','unauthorized','status',401);
  END IF;
  IF op.id IS NULL OR op.receipt_digest IS DISTINCT FROM p_receipt_digest THEN
    RETURN jsonb_build_object('ok',false,'error','not_found','status',404);
  END IF;
  IF op.user_id IS DISTINCT FROM p_user_id OR op.session_id IS DISTINCT FROM p_session_id
    OR op.email_digest IS DISTINCT FROM p_email_digest THEN
    RETURN jsonb_build_object('ok',false,'error','scope_conflict','status',409);
  END IF;
  IF op.state NOT IN ('open','closed_before_confirm') OR op.confirm_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'error','request_active','status',409);
  END IF;
  -- A concurrent prepare/confirm takes this same parent first. Absence here is
  -- stable until commit; never turn a missing generation into a prepared cancel.
  SELECT * INTO prepared FROM account_deletion_private.device_preparations WHERE operation_id=op.id FOR UPDATE;
  IF FOUND THEN
    IF prepared.native_generation IS DISTINCT FROM p_native_generation
      OR prepared.server_generation IS DISTINCT FROM p_server_generation THEN
      RETURN jsonb_build_object('ok',false,'error','scope_conflict','status',409);
    END IF;
    RETURN account_deletion_private.operation_flow_233100('cancel_preparation',p_operation_digest,p_receipt_digest,
      p_user_id,p_session_id,p_email_digest,p_consent_version,p_generation,p_confirmation_id,
      p_lease_token,p_error_code,p_device_id,p_native_generation,p_server_generation);
  END IF;
  IF p_server_generation IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'error','scope_conflict','status',409);
  END IF;
  IF op.request_id IS NOT NULL THEN
    SELECT * INTO child FROM account_deletion_private.requests WHERE id=op.request_id FOR UPDATE NOWAIT;
    IF child.state NOT IN ('sending','challenge','failed','expired') THEN
      RETURN jsonb_build_object('ok',false,'error','request_active','status',409);
    END IF;
  END IF;
  IF op.state='open' THEN
    UPDATE account_deletion_private.operations SET state='closed_before_confirm',preparation_cancelled=true,
      send_lease=NULL,revision=revision+1,updated_at=clock_timestamp()
      WHERE id=op.id AND state='open' AND confirm_started_at IS NULL
        AND account_deletion_private.operation_caller_is_current(user_id,session_id,email_digest)
      RETURNING * INTO op;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','unauthorized','status',401); END IF;
    UPDATE account_deletion_private.requests SET state='expired',lease_token=NULL,lease_until=NULL
      WHERE operation_id=op.id AND state IN ('sending','challenge');
  END IF;
  -- This is an authoritative pre-confirmation closure, never evidence that a
  -- native runtime stopped. Native custody still checks its own generation.
  RETURN jsonb_build_object('ok',true,'operation',account_deletion_private.operation_view(op),
    'preparation',jsonb_build_object('cancelled',true,'native_generation',p_native_generation,'server_generation',NULL));
EXCEPTION WHEN lock_not_available THEN
  RETURN jsonb_build_object('ok',false,'error','operation_busy','status',503);
WHEN insufficient_privilege THEN
  RETURN jsonb_build_object('ok',false,'error','preparation_unavailable','status',503);
END $$;
ALTER FUNCTION public.account_deletion_operation_flow(text,text,text,uuid,uuid,text,text,integer,uuid,uuid,text,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_deletion_operation_flow(text,text,text,uuid,uuid,text,text,integer,uuid,uuid,text,text,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.account_deletion_operation_flow(text,text,text,uuid,uuid,text,text,integer,uuid,uuid,text,text,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
