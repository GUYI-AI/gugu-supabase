-- A read-only V2 admission policy, and a personal-identity check after the
-- existing account/operation waits. No installation or API role opens a gate.
CREATE FUNCTION account_deletion_private.operation_personal_is_eligible(p_actor uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE eligible boolean;
BEGIN
  -- The separately reviewed classification release may be installed second.
  -- Missing classification is unavailable, never eligibility by default.
  IF to_regprocedure('identity.personal_principal_is_eligible(uuid)') IS NULL THEN RETURN NULL; END IF;
  EXECUTE 'SELECT identity.personal_principal_is_eligible($1)' INTO eligible USING p_actor;
  RETURN COALESCE(eligible,false);
END $$;
ALTER FUNCTION account_deletion_private.operation_personal_is_eligible(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION account_deletion_private.operation_personal_is_eligible(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION account_deletion_private.operation_policy(p_user_id uuid,p_session_id uuid,p_email_digest text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE eligible boolean; available boolean;
BEGIN
  IF NOT account_deletion_private.operation_caller_is_current(p_user_id,p_session_id,p_email_digest) THEN
    RETURN jsonb_build_object('ok',false,'error','unauthorized','status',401);
  END IF;
  eligible:=account_deletion_private.operation_personal_is_eligible(p_user_id);
  IF eligible IS NULL THEN RETURN jsonb_build_object('ok',false,'error','unavailable','status',503); END IF;
  SELECT COALESCE(o.enabled AND d.enabled AND eligible AND
    (NOT a.test_only OR COALESCE(a.test_user_id=p_user_id,false)),false) INTO available
  FROM account_deletion_private.access a
  JOIN account_deletion_private.operation_access o ON o.singleton=a.singleton
  JOIN account_deletion_private.device_preparation_access d ON d.singleton=a.singleton
  WHERE a.singleton;
  RETURN jsonb_build_object('ok',true,'policy',jsonb_build_object(
    'protocol_version',2,'available',COALESCE(available,false),'deletion','immediate',
    'credit_treatment','forfeit_remaining','consent_version','immediate-forfeit-v1','device_preparation_required',true));
END $$;
ALTER FUNCTION account_deletion_private.operation_policy(uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION account_deletion_private.operation_policy(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

DO $upgrade$
DECLARE definition text; anchor text;
BEGIN
  SELECT pg_get_functiondef('account_deletion_private.operation_flow_233100(text,text,text,uuid,uuid,text,text,integer,uuid,uuid,text,text,uuid,uuid)'::regprocedure)
    INTO definition;
  anchor:='  IF o.id IS NULL AND p_action IN (''register'',''begin'') THEN';
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor)
    OR position('The advisory/parent wait may outlive the original SID' IN definition)=0
    OR position('operation_personal_is_eligible' IN definition)<>0 THEN
    RAISE EXCEPTION 'Unexpected V2 personal admission predecessor';
  END IF;
  -- actor is selected from the stored operation for service phases, and the
  -- verified caller for admission phases. Never accept a body-selected actor.
  -- Preserve result, finish, failed-verification and cancellation/release paths.
  definition:=replace(definition,anchor,$guard$  IF p_action IN ('register','begin','claim_confirmation','prepare_device','verified','execute') THEN
    DECLARE eligible boolean;
    BEGIN
      -- Re-read after admission/parent waits: a CD rollback must not be
      -- bypassed by a caller that observed an open gate before waiting.
      IF NOT COALESCE((SELECT enabled FROM account_deletion_private.operation_access WHERE singleton),false) THEN
        RETURN jsonb_build_object('ok',false,'error','operation_unavailable','status',503);
      END IF;
      IF NOT COALESCE((SELECT enabled FROM account_deletion_private.device_preparation_access WHERE singleton),false) THEN
        RETURN jsonb_build_object('ok',false,'error','preparation_unavailable','status',503);
      END IF;
      IF NOT EXISTS(SELECT 1 FROM account_deletion_private.access a WHERE a.singleton
        AND (NOT a.test_only OR a.test_user_id=actor)) THEN
        RETURN jsonb_build_object('ok',false,'error','rollout_unavailable','status',503);
      END IF;
      eligible:=account_deletion_private.operation_personal_is_eligible(actor);
      IF eligible IS NULL THEN
        RETURN jsonb_build_object('ok',false,'error','unavailable','status',503);
      END IF;
      IF NOT eligible THEN
        RETURN jsonb_build_object('ok',false,'error','personal_account_required','status',403);
      END IF;
    END;
  END IF;
$guard$||anchor);

  -- A prepare may have committed while its HTTP response was lost. Returning
  -- only the operation would strand custody without the server generation
  -- once new admission is closed. The parent is already locked here; expose
  -- only its existing generation pair, never create or release a preparation.
  anchor:=$result$    RETURN jsonb_build_object('ok',true,'operation',account_deletion_private.operation_view(o));
  END IF;

  IF p_action IN ('prepare_device','read_preparation','cancel_preparation') THEN$result$;
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'Unexpected V2 result recovery predecessor';
  END IF;
  definition:=replace(definition,anchor,$result$    RETURN jsonb_build_object('ok',true,'operation',account_deletion_private.operation_view(o))
      ||COALESCE((SELECT jsonb_build_object('preparation',jsonb_build_object(
        'prepared',p.state='prepared','cancelled',p.state='released',
        'native_generation',p.native_generation,'server_generation',p.server_generation))
        FROM account_deletion_private.device_preparations p WHERE p.operation_id=o.id),'{}'::jsonb);
  END IF;

  IF p_action IN ('prepare_device','read_preparation','cancel_preparation') THEN$result$);

  -- A rejected verification is not an unknown DELETE. The original state/
  -- lease checks and legacy rejection run first. Clear the active-confirmation
  -- fence only after all verification/execution work is authoritatively absent;
  -- retain rejected intents so a late old lease cannot become verified.
  anchor:=$rejected$    UPDATE account_deletion_private.operations SET state=CASE WHEN p_action='verified' THEN 'processing' ELSE 'open' END,
      revision=revision+1,updated_at=now_at WHERE id=o.id RETURNING * INTO o;$rejected$;
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'Unexpected V2 rejected-verification predecessor';
  END IF;
  EXECUTE replace(definition,anchor,$rejected$    UPDATE account_deletion_private.operations SET state=CASE WHEN p_action='verified' THEN 'processing' ELSE 'open' END,
      confirm_started_at=CASE WHEN p_action='verification_failed'
        AND NOT EXISTS(SELECT 1 FROM account_deletion_private.confirmation_intents c
          WHERE c.operation_id=o.id AND c.state IN ('verifying','processing','deleted'))
        AND NOT EXISTS(SELECT 1 FROM account_deletion_private.requests r
          WHERE r.operation_id=o.id AND r.state IN ('verifying','processing','retry_wait'))
        THEN NULL ELSE confirm_started_at END,
      revision=revision+1,updated_at=now_at WHERE id=o.id RETURNING * INTO o;$rejected$);

  SELECT pg_get_functiondef('public.account_deletion_operation_flow(text,text,text,uuid,uuid,text,text,integer,uuid,uuid,text,text,uuid,uuid)'::regprocedure)
    INTO definition;
  anchor:='  IF p_action<>''cancel_operation'' THEN';
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor)
    OR position('native runtime stopped' IN definition)=0 THEN
    RAISE EXCEPTION 'Unexpected V2 policy entry predecessor';
  END IF;
  EXECUTE replace(definition,anchor,$policy$  IF p_action='status' THEN
    RETURN account_deletion_private.operation_policy(p_user_id,p_session_id,p_email_digest);
  END IF;
$policy$||anchor);
END $upgrade$;
REVOKE ALL ON FUNCTION account_deletion_private.operation_flow_233100(text,text,text,uuid,uuid,text,text,integer,uuid,uuid,text,text,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.account_deletion_operation_flow(text,text,text,uuid,uuid,text,text,integer,uuid,uuid,text,text,uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_operation_flow(text,text,text,uuid,uuid,text,text,integer,uuid,uuid,text,text,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
