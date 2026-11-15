ALTER TABLE team_private.email_challenges ADD COLUMN operation_id uuid REFERENCES team_private.member_operations;

CREATE FUNCTION public.team_account_provision(p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c team_private.email_challenges%ROWTYPE; op team_private.member_operations%ROWTYPE;
    seat team_private.members%ROWTYPE; invitation team_private.invitations%ROWTYPE;
    choices jsonb; request_hash text; email_hash text; key text; region text; tid uuid;
BEGIN
    region:=identity.team_deployment_region();
    IF region IS NULL THEN PERFORM team_private.refuse('dependency_unavailable',503); END IF;
    IF p_action='activate' THEN
        SELECT * INTO seat FROM team_private.members WHERE id=(p_input->>'member_id')::uuid FOR UPDATE;
        IF seat.id IS NULL OR seat.planned_principal_id IS DISTINCT FROM (p_input->>'principal_id')::uuid
            OR seat.state NOT IN ('provisioning','active') THEN PERFORM team_private.refuse('version_conflict',409); END IF;
        IF NOT EXISTS(SELECT 1 FROM auth.users u JOIN identity.users i ON i.id=u.id::text
            JOIN team_private.teams t ON t.id=seat.team_id
            WHERE u.id=seat.planned_principal_id AND u.deleted_at IS NULL AND u.email_confirmed_at IS NOT NULL
              AND (u.banned_until IS NULL OR u.banned_until<=now()) AND i.type='human' AND i.removed_at IS NULL
              AND u.email='team-'||replace(seat.id::text,'-','')||'@team.gugu.invalid'
              AND u.raw_app_meta_data->>'gugu_account_kind'='team_member'
              AND u.raw_app_meta_data->>'gugu_team_id'=seat.team_id::text
              AND u.raw_app_meta_data->>'gugu_member_id'=seat.id::text
              AND u.raw_app_meta_data->>'gugu_team_region'=t.region AND t.region=region) THEN
            PERFORM team_private.refuse('dependency_unavailable',503);
        END IF;
        UPDATE team_private.members SET principal_user_id=planned_principal_id,state='active',updated_at=clock_timestamp()
          WHERE id=seat.id RETURNING * INTO seat;
        IF seat.role='superadmin' THEN UPDATE team_private.teams SET state='active' WHERE id=seat.team_id AND state='provisioning'; END IF;
        UPDATE team_private.invitations SET state='accepted' WHERE member_id=seat.id AND state='invited';
        UPDATE team_private.member_operations SET state='complete' WHERE target_member_id=seat.id AND action IN ('create','accept_invitation');
        RETURN jsonb_build_object('membership',team_private.member_json(seat),
            'context',identity.team_context_for(seat.principal_user_id,seat.team_id),'plan',team_private.principal_plan(seat));
    END IF;
    IF p_action NOT IN ('create','accept_invitation','sign_in') THEN PERFORM team_private.refuse('invalid_request',400); END IF;
    SELECT * INTO c FROM team_private.email_challenges WHERE receipt_digest=p_input->>'receipt_digest' FOR UPDATE;
    IF c.id IS NULL OR c.expires_at<=clock_timestamp() OR c.state NOT IN ('verified','consumed') OR c.purpose<>p_action THEN
        PERFORM team_private.refuse('verification_expired',401);
    END IF;
    email_hash:=encode(sha256(convert_to(c.email_normalized,'UTF8')),'hex');
    key:=CASE WHEN p_action='sign_in' THEN c.receipt_digest ELSE p_input->>'idempotency_key' END;
    request_hash:=encode(sha256(convert_to((p_input-'receipt_digest')::text,'UTF8')),'hex');
    PERFORM pg_advisory_xact_lock(hashtextextended('team-provision:'||email_hash||':'||p_action||':'||key,0));
    SELECT * INTO op FROM team_private.member_operations WHERE actor_member_id IS NULL AND subject_email_digest=email_hash
        AND action=p_action AND idempotency_key=key FOR UPDATE;
    IF op.id IS NOT NULL THEN
        IF op.request_digest<>request_hash OR c.state='consumed' AND c.operation_id IS DISTINCT FROM op.id THEN
            PERFORM team_private.refuse('idempotency_conflict',409);
        END IF;
        SELECT * INTO seat FROM team_private.members WHERE id=op.target_member_id FOR UPDATE;
        IF seat.state NOT IN ('provisioning','active') THEN PERFORM team_private.refuse('membership_disabled'); END IF;
    ELSE
        IF c.state<>'verified' THEN PERFORM team_private.refuse('verification_required',401); END IF;
        IF p_action='create' THEN
            IF length(btrim(p_input->>'name')) NOT BETWEEN 1 AND 100 THEN PERFORM team_private.refuse('invalid_request',400); END IF;
            INSERT INTO team_private.teams(name,region) VALUES(btrim(p_input->>'name'),region) RETURNING id INTO tid;
            INSERT INTO team_private.members(team_id,email_normalized,role,state,planned_principal_id,display_name)
              VALUES(tid,c.email_normalized,'superadmin','provisioning',gen_random_uuid(),split_part(c.email_normalized,'@',1)) RETURNING * INTO seat;
        ELSIF p_action='accept_invitation' THEN
            SELECT * INTO invitation FROM team_private.invitations WHERE id=c.invitation_id
                AND token_digest=p_input->>'invitation_digest' FOR UPDATE;
            IF invitation.id IS NULL OR invitation.email_normalized<>c.email_normalized
                OR invitation.state<>'invited' OR invitation.expires_at<=clock_timestamp() THEN
                PERFORM team_private.refuse('invitation_invalid',404);
            END IF;
            SELECT * INTO seat FROM team_private.members WHERE id=invitation.member_id FOR UPDATE;
            IF seat.state<>'invited' THEN PERFORM team_private.refuse('invitation_used',409); END IF;
            UPDATE team_private.members SET state='provisioning',planned_principal_id=gen_random_uuid(),updated_at=clock_timestamp()
              WHERE id=seat.id RETURNING * INTO seat;
        ELSE
            SELECT COALESCE(jsonb_agg(jsonb_build_object('team_id',t.id,'team_name',t.name,'role',m.role,
                'member_state',m.state,'region',t.region) ORDER BY t.id),'[]'::jsonb) INTO choices
              FROM team_private.members m JOIN team_private.teams t ON t.id=m.team_id
              WHERE m.email_normalized=c.email_normalized AND m.state='active' AND t.state='active' AND t.region=region;
            IF p_input->>'team_id' IS NULL AND jsonb_array_length(choices)>1 THEN
                RETURN jsonb_build_object('refusal','context_required','contexts',choices);
            END IF;
            SELECT * INTO seat FROM team_private.members m WHERE m.email_normalized=c.email_normalized AND m.state='active'
              AND EXISTS(SELECT 1 FROM team_private.teams t WHERE t.id=m.team_id AND t.state='active' AND t.region=region)
              AND (p_input->>'team_id' IS NULL OR m.team_id=(p_input->>'team_id')::uuid) ORDER BY m.id LIMIT 1 FOR UPDATE;
            IF seat.id IS NULL THEN PERFORM team_private.refuse('membership_disabled'); END IF;
            IF c.team_id IS NOT NULL AND seat.team_id<>c.team_id THEN PERFORM team_private.refuse('forbidden'); END IF;
        END IF;
        INSERT INTO team_private.member_operations(subject_email_digest,action,idempotency_key,request_digest,team_id,target_member_id)
          VALUES(email_hash,p_action,key,request_hash,seat.team_id,seat.id) RETURNING * INTO op;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM team_private.teams WHERE id=seat.team_id AND region=region AND state IN ('active','provisioning')) THEN
        PERFORM team_private.refuse('region_mismatch');
    END IF;
    UPDATE team_private.email_challenges SET state='consumed',operation_id=op.id WHERE id=c.id;
    RETURN jsonb_build_object('operation_id',op.id,'plan',team_private.principal_plan(seat),
        'membership',team_private.member_json(seat));
END $$;
ALTER FUNCTION public.team_account_provision(text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.team_account_provision(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.team_account_provision(text,jsonb) TO service_role;

CREATE FUNCTION public.team_member_workflow(p_action text,p_actor uuid,p_session uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor team_private.members%ROWTYPE; target team_private.members%ROWTYPE; recipient team_private.members%ROWTYPE;
    op team_private.member_operations%ROWTYPE; invitation team_private.invitations%ROWTYPE;
    request_hash text:=encode(sha256(convert_to(p_input::text,'UTF8')),'hex'); c team_private.email_challenges%ROWTYPE;
BEGIN
    IF p_action='invitation_info' THEN
        SELECT * INTO invitation FROM team_private.invitations WHERE token_digest=p_input->>'invitation_digest';
        IF invitation.id IS NULL OR invitation.state<>'invited' OR invitation.expires_at<=clock_timestamp() THEN
            PERFORM team_private.refuse('invitation_invalid',404);
        END IF;
        RETURN (SELECT jsonb_build_object('invitation_id',invitation.id,'team_id',t.id,'team_name',t.name,
            'region',t.region,'email_hint',left(invitation.email_normalized,1)||'***@'||split_part(invitation.email_normalized,'@',2),
            'expires_at',invitation.expires_at,'state','invited') FROM team_private.teams t
            WHERE t.id=invitation.team_id AND t.region=identity.team_deployment_region());
    END IF;
    actor:=team_private.caller(p_actor,p_session);
    PERFORM pg_advisory_xact_lock(hashtextextended('team-members:'||actor.team_id::text,0));
    -- A peer operation may have disabled/demoted this actor while it waited.
    actor:=team_private.caller(p_actor,p_session);
    IF p_action='bind_invitation' THEN
        SELECT * INTO invitation FROM team_private.invitations WHERE id=(p_input->>'invitation_id')::uuid FOR UPDATE;
        IF actor.role NOT IN ('superadmin','admin') OR invitation.team_id IS DISTINCT FROM actor.team_id
            OR invitation.created_by_member_id IS DISTINCT FROM actor.id
            OR COALESCE(p_input->>'token_digest','')!~'^[a-f0-9]{64}$'
            OR invitation.token_digest IS NOT NULL AND invitation.token_digest<>p_input->>'token_digest' THEN
            PERFORM team_private.refuse('forbidden');
        END IF;
        UPDATE team_private.invitations SET token_digest=p_input->>'token_digest' WHERE id=invitation.id;
        RETURN jsonb_build_object('bound',true);
    END IF;
    IF p_action IN ('revocation_result','revocation_checkpoint') THEN
        SELECT * INTO op FROM team_private.member_operations WHERE id=(p_input->>'operation_id')::uuid FOR UPDATE;
        IF op.id IS NULL OR op.team_id<>actor.team_id OR actor.role NOT IN ('superadmin','admin') THEN PERFORM team_private.refuse('not_found',404); END IF;
        SELECT * INTO target FROM team_private.members WHERE id=op.target_member_id;
        IF actor.role='admin' AND target.role<>'member' THEN PERFORM team_private.refuse('forbidden'); END IF;
        IF p_action='revocation_checkpoint' THEN
            IF op.action<>'disable' OR target.state<>'disabled' THEN PERFORM team_private.refuse('version_conflict',409); END IF;
            UPDATE team_private.member_operations SET
                auth_sessions_revoked=auth_sessions_revoked OR COALESCE((p_input->>'auth_sessions_revoked')::boolean,false),
                auth_banned=auth_banned OR COALESCE((p_input->>'auth_banned')::boolean,false),
                model_authorization_revoked=model_authorization_revoked OR COALESCE((p_input->>'model_authorization_revoked')::boolean,false)
              WHERE id=op.id RETURNING * INTO op;
            IF op.auth_sessions_revoked AND op.auth_banned AND op.model_authorization_revoked AND op.handoff_complete THEN
                UPDATE team_private.member_operations SET state='complete' WHERE id=op.id RETURNING * INTO op;
            END IF;
        END IF;
        RETURN jsonb_build_object('operation_id',op.id,'state',CASE WHEN op.state='complete' THEN 'complete' ELSE 'revoking' END,
            'plan',team_private.principal_plan(target),'revision',target.revision,'member_id',target.id,'team_id',target.team_id,
            'principal_id',target.principal_user_id,
            'checks',jsonb_build_object('new_data_calls_denied',target.state='disabled',
                'new_model_calls_denied',op.model_authorization_revoked,'session_followups_stopped',op.auth_sessions_revoked),
            'auth_banned',op.auth_banned,'handoff_complete',op.handoff_complete);
    END IF;
    IF actor.role NOT IN ('superadmin','admin') THEN PERFORM team_private.refuse('forbidden'); END IF;
    SELECT * INTO op FROM team_private.member_operations WHERE actor_member_id=actor.id AND subject_email_digest IS NULL
      AND action=p_action AND idempotency_key=p_input->>'idempotency_key' FOR UPDATE;
    IF op.id IS NOT NULL THEN
        IF op.request_digest<>request_hash THEN PERFORM team_private.refuse('idempotency_conflict',409); END IF;
        IF actor.role='admin' AND EXISTS(SELECT 1 FROM team_private.members
            WHERE id=op.target_member_id AND role<>'member') THEN PERFORM team_private.refuse('forbidden'); END IF;
        RETURN op.result||jsonb_build_object('operation_id',op.id);
    END IF;
    IF p_action='invite' THEN
        IF p_input->>'role' IS DISTINCT FROM 'member' THEN PERFORM team_private.refuse('forbidden'); END IF;
        IF EXISTS(SELECT 1 FROM team_private.members WHERE team_id=actor.team_id AND email_normalized=lower(p_input->>'email')) THEN
            PERFORM team_private.refuse('version_conflict',409);
        END IF;
        INSERT INTO team_private.members(team_id,email_normalized,display_name)
          VALUES(actor.team_id,lower(p_input->>'email'),split_part(lower(p_input->>'email'),'@',1)) RETURNING * INTO target;
        INSERT INTO team_private.invitations(team_id,member_id,created_by_member_id,email_normalized)
          VALUES(actor.team_id,target.id,actor.id,target.email_normalized) RETURNING * INTO invitation;
        INSERT INTO team_private.member_operations(actor_member_id,action,idempotency_key,request_digest,team_id,target_member_id,state,result)
          VALUES(actor.id,p_action,p_input->>'idempotency_key',request_hash,actor.team_id,target.id,'complete',
            jsonb_build_object('invitation_id',invitation.id,'seed',invitation.seed,'expires_at',invitation.expires_at,'state','invited',
                'region',(SELECT region FROM team_private.teams WHERE id=actor.team_id))) RETURNING * INTO op;
        RETURN op.result||jsonb_build_object('operation_id',op.id);
    END IF;
    SELECT * INTO target FROM team_private.members WHERE id=(p_input->>'member_id')::uuid AND team_id=actor.team_id FOR UPDATE;
    IF target.id IS NULL THEN PERFORM team_private.refuse('not_found',404); END IF;
    IF target.id=actor.id OR target.role='superadmin' OR actor.role='admin' AND target.role<>'member'
      OR p_action='set_role' AND actor.role<>'superadmin' THEN PERFORM team_private.refuse('forbidden'); END IF;
    IF target.revision IS DISTINCT FROM (p_input->>'expected_revision')::bigint
      OR target.state<>CASE WHEN p_action='restore' THEN 'disabled' ELSE 'active' END THEN
        PERFORM team_private.refuse('version_conflict',409);
    END IF;
    IF p_action='set_role' THEN
        IF p_input->>'role' NOT IN ('admin','member') THEN PERFORM team_private.refuse('invalid_request',400); END IF;
        UPDATE team_private.members SET role=p_input->>'role',revision=revision+1,updated_at=clock_timestamp() WHERE id=target.id RETURNING * INTO target;
    ELSIF p_action='disable' THEN
        SELECT * INTO recipient FROM team_private.members WHERE team_id=actor.team_id AND state='active'
            AND CASE WHEN p_input->>'handoff_member_id' IS NULL THEN role='superadmin' ELSE id=(p_input->>'handoff_member_id')::uuid END FOR UPDATE;
        IF recipient.id IS NULL OR recipient.id=target.id THEN PERFORM team_private.refuse('invalid_recipient',409); END IF;
        UPDATE team_private.members SET state='disabled',revision=revision+1,updated_at=clock_timestamp() WHERE id=target.id RETURNING * INTO target;
        -- The live gate and credential revocation deny follow-up calls. Do not
        -- force-stop an agent process: an already-issued upstream stream may
        -- finish and settle. Never reassign its legacy owner/private history.
        UPDATE team_private.asset_custody SET custodian_member_id=recipient.id WHERE team_id=actor.team_id AND custodian_member_id=target.id;
    ELSE
        -- Restore and email change require their Auth-side reconciliation. They
        -- remain closed until that part of the workflow is installed and tested.
        PERFORM team_private.refuse('dependency_unavailable',503);
    END IF;
    INSERT INTO team_private.member_operations(actor_member_id,action,idempotency_key,request_digest,team_id,target_member_id,recipient_member_id,
        state,handoff_complete,result) VALUES(actor.id,p_action,p_input->>'idempotency_key',request_hash,actor.team_id,target.id,recipient.id,
        CASE WHEN p_action='set_role' THEN 'complete' ELSE 'pending' END,false,
        jsonb_build_object('membership',team_private.member_json(target),'handoff',jsonb_build_object('recipient_member_id',recipient.id))) RETURNING * INTO op;
    RETURN op.result||jsonb_build_object('operation_id',op.id);
END $$;
ALTER FUNCTION public.team_member_workflow(text,uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.team_member_workflow(text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.team_member_workflow(text,uuid,uuid,jsonb) TO service_role;
