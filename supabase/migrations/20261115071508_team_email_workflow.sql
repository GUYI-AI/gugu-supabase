CREATE FUNCTION public.team_email_workflow(p_action text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c team_private.email_challenges%ROWTYPE; invitation team_private.invitations%ROWTYPE;
    address text; purpose text; now_at timestamptz:=clock_timestamp(); lease uuid;
BEGIN
    IF p_action='begin' THEN
        address:=lower(btrim(p_input->>'email')); purpose:=p_input->>'purpose';
        IF address IS NULL OR length(address)>254 OR address !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
            OR purpose NOT IN ('create','sign_in','accept_invitation') THEN
            PERFORM team_private.refuse('invalid_request',400);
        END IF;
        -- Serialize the rate check and insertion; the server never passes a
        -- caller-selected region or a plain code to this function.
        IF identity.team_deployment_region() IS NULL THEN PERFORM team_private.refuse('dependency_unavailable',503); END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('team-email:'||address,0));
        IF EXISTS(SELECT 1 FROM team_private.email_challenges WHERE email_normalized=address AND created_at>now_at-interval '60 seconds')
           OR (SELECT count(*) FROM team_private.email_challenges WHERE email_normalized=address AND created_at>now_at-interval '15 minutes')>=3 THEN
            PERFORM team_private.refuse('rate_limited',429);
        END IF;
        IF purpose='accept_invitation' THEN
            SELECT * INTO invitation FROM team_private.invitations
                WHERE token_digest=p_input->>'invitation_digest' FOR UPDATE;
            IF invitation.id IS NULL OR invitation.state<>'invited' OR invitation.expires_at<=now_at
                OR invitation.email_normalized<>address THEN PERFORM team_private.refuse('invitation_invalid',404); END IF;
        END IF;
        INSERT INTO team_private.email_challenges(email_normalized,purpose,team_id,invitation_id)
          VALUES(address,purpose,CASE WHEN invitation.id IS NOT NULL THEN invitation.team_id ELSE (p_input->>'team_id')::uuid END,invitation.id)
          RETURNING * INTO c;
    ELSE
        SELECT * INTO c FROM team_private.email_challenges WHERE id=(p_input->>'challenge_id')::uuid FOR UPDATE;
        IF c.id IS NULL THEN PERFORM team_private.refuse('verification_required',401); END IF;
        IF c.expires_at<=now_at THEN PERFORM team_private.refuse('verification_expired',401); END IF;
        IF p_action='sent' THEN
            IF c.state<>'sending' THEN PERFORM team_private.refuse('version_conflict',409); END IF;
            UPDATE team_private.email_challenges SET state=CASE WHEN (p_input->>'sent')::boolean THEN 'challenge' ELSE 'failed' END
              WHERE id=c.id RETURNING * INTO c;
        ELSIF p_action='claim' THEN
            IF c.state<>'challenge' OR c.attempts>=5 THEN PERFORM team_private.refuse('invalid_code',401); END IF;
            IF (SELECT COALESCE(sum(attempts),0) FROM team_private.email_challenges
                WHERE email_normalized=c.email_normalized AND created_at>now_at-interval '15 minutes')>=10 THEN
                PERFORM team_private.refuse('rate_limited',429);
            END IF;
            UPDATE team_private.email_challenges SET state='verifying',attempts=attempts+1,lease_token=gen_random_uuid()
              WHERE id=c.id RETURNING * INTO c;
        ELSIF p_action IN ('verified','rejected') THEN
            IF c.state<>'verifying' OR c.lease_token IS DISTINCT FROM (p_input->>'lease_token')::uuid THEN
                PERFORM team_private.refuse('version_conflict',409);
            END IF;
            IF p_action='verified' THEN
                IF lower(p_input->>'verified_email') IS DISTINCT FROM c.email_normalized
                    OR COALESCE(p_input->>'receipt_digest','')!~'^[a-f0-9]{64}$' THEN PERFORM team_private.refuse('invalid_code',401); END IF;
                UPDATE team_private.email_challenges SET state='verified',lease_token=NULL,receipt_digest=p_input->>'receipt_digest'
                  WHERE id=c.id RETURNING * INTO c;
            ELSE
                UPDATE team_private.email_challenges SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'challenge' END,lease_token=NULL
                  WHERE id=c.id RETURNING * INTO c;
            END IF;
        ELSE PERFORM team_private.refuse('invalid_request',400);
        END IF;
    END IF;
    -- Server-only reply. The Edge handler projects safe client fields and must
    -- never forward the email/lease/private purpose object wholesale.
    RETURN jsonb_build_object('challenge_id',c.id,'email',c.email_normalized,'purpose',c.purpose,
        'expires_at',c.expires_at,'state',c.state,'lease_token',c.lease_token);
END $$;
ALTER FUNCTION public.team_email_workflow(text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.team_email_workflow(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.team_email_workflow(text,jsonb) TO service_role;

CREATE FUNCTION public.team_account_read(p_action text,p_actor uuid,p_session uuid,p_input jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m team_private.members%ROWTYPE; address text; result jsonb; pending jsonb;
    page_limit integer:=LEAST(100,GREATEST(1,COALESCE((p_input->>'limit')::integer,50)));
BEGIN
    IF p_action='contexts' THEN
        SELECT lower(u.email) INTO address FROM auth.users u JOIN auth.sessions s ON s.user_id=u.id
          WHERE u.id=p_actor AND s.id=p_session AND u.email_confirmed_at IS NOT NULL
            AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=now())
            AND (s.not_after IS NULL OR s.not_after>now());
        IF address IS NULL THEN PERFORM team_private.refuse('unauthenticated',401); END IF;
        -- For a team principal, the displayed member email is authoritative;
        -- an internal routing alias is never used as a discovery address.
        SELECT COALESCE((SELECT email_normalized FROM team_private.members WHERE principal_user_id=p_actor),address) INTO address;
        RETURN jsonb_build_object('personal_available',EXISTS(SELECT 1 FROM auth.users WHERE lower(email)=address
          AND COALESCE(raw_app_meta_data->>'gugu_account_kind','personal')='personal' AND deleted_at IS NULL),
          'teams',COALESCE((SELECT jsonb_agg(jsonb_build_object('team_id',t.id,'team_name',t.name,
            'role',seat.role,'member_state',seat.state,'region',t.region) ORDER BY t.id)
            FROM team_private.members seat JOIN team_private.teams t ON t.id=seat.team_id
            WHERE seat.email_normalized=address AND seat.state='active' AND t.state='active'
              AND t.region=identity.team_deployment_region()),'[]'::jsonb));
    END IF;
    m:=team_private.caller(p_actor,p_session);
    IF p_action='delivery_settings' THEN
        RETURN (SELECT jsonb_build_object('site_origin',site_origin) FROM team_private.delivery_configuration WHERE singleton);
    ELSIF p_action='profile' THEN
        SELECT jsonb_build_object('challenge_id',c.id,'new_email',c.email_normalized,'expires_at',c.expires_at)
          INTO pending FROM team_private.email_challenges c WHERE c.target_member_id=m.id
            AND c.purpose='change_email' AND c.state IN ('sending','challenge','verifying') AND c.expires_at>now()
          ORDER BY c.created_at DESC LIMIT 1;
        SELECT jsonb_build_object('team',jsonb_build_object('id',t.id,'name',t.name),
            'membership',team_private.member_json(m),'membership_revision',m.revision,'context',identity.team_context_for(p_actor,m.team_id),
            'profile',jsonb_build_object('name',u.display_name,'avatar',u.avatar,'bio',u.bio,'email',m.email_normalized),
            'pending_email_change',pending,'realtime_namespace',identity.team_realtime_namespace_for(p_actor,p_session),
            'entitlements',jsonb_build_object('plus_features',true,'personal_assistant',true,'free_credits',false))
          INTO result FROM team_private.teams t JOIN identity.users u ON u.id=p_actor::text WHERE t.id=m.team_id;
        RETURN result;
    ELSIF p_action IN ('directory','members') THEN
        IF p_action='members' AND m.role NOT IN ('superadmin','admin') THEN PERFORM team_private.refuse('forbidden'); END IF;
        SELECT jsonb_build_object('members',COALESCE(jsonb_agg(selected.item ORDER BY selected.id),'[]'::jsonb),
            'next_cursor',CASE WHEN count(*)=page_limit THEN max(selected.id::text) ELSE NULL END) INTO result
        FROM (SELECT seat.id,CASE WHEN p_action='members' THEN team_private.member_json(seat)||jsonb_build_object('name',COALESCE(u.display_name,seat.display_name),
                  'email',seat.email_normalized) ELSE jsonb_build_object('identity_id',seat.principal_user_id,
                  'name',u.display_name,'avatar',u.avatar,'role',seat.role) END item
          FROM team_private.members seat LEFT JOIN identity.users u ON u.id=seat.principal_user_id::text
          WHERE seat.team_id=m.team_id AND seat.state=CASE WHEN p_action='directory' THEN 'active' ELSE COALESCE(p_input->>'state','active') END
            AND (p_input->>'cursor' IS NULL OR seat.id>(p_input->>'cursor')::uuid)
            AND (p_input->>'query' IS NULL OR COALESCE(u.display_name,seat.display_name,'') ILIKE '%'||(p_input->>'query')||'%')
          ORDER BY seat.id LIMIT page_limit) selected;
        RETURN result;
    ELSE PERFORM team_private.refuse('invalid_request',400); END IF;
    RETURN NULL;
END $$;
ALTER FUNCTION public.team_account_read(text,uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.team_account_read(text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.team_account_read(text,uuid,uuid,jsonb) TO service_role;
