-- Active team directory for the approved settings member list. Financial
-- projections consume this service contract rather than private identity tables.
CREATE FUNCTION identity.team_directory_page_for(p_actor uuid,p_session uuid,p_team_id uuid DEFAULT NULL,
    p_query text DEFAULT NULL,p_cursor text DEFAULT NULL,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor team_private.members%ROWTYPE; query_text text:=lower(btrim(p_query)); cursor_id uuid; result jsonb;
BEGIN
    actor:=team_private.caller(p_actor,p_session);
    IF p_team_id IS NOT NULL AND p_team_id<>actor.team_id THEN PERFORM team_private.refuse('forbidden'); END IF;
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR length(p_query)>254
        OR p_cursor IS NOT NULL AND p_cursor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        PERFORM team_private.refuse('invalid_request',400);
    END IF;
    cursor_id:=p_cursor::uuid;
    WITH visible AS MATERIALIZED (
        SELECT seat.id,seat.principal_user_id AS identity_id,u.display_name AS name,u.avatar,
            seat.email_normalized AS email,seat.role,seat.revision
        FROM team_private.members seat JOIN identity.users u ON u.id=seat.principal_user_id::text
        WHERE seat.team_id=actor.team_id AND seat.state='active' AND u.type='human' AND u.removed_at IS NULL
    ), matched AS MATERIALIZED (
        SELECT * FROM visible WHERE query_text IS NULL OR query_text=''
            OR strpos(lower(name),query_text)>0 OR strpos(email,query_text)>0
    ), selected AS MATERIALIZED (
        SELECT * FROM matched WHERE cursor_id IS NULL OR id>cursor_id ORDER BY id LIMIT p_limit+1
    ), page AS (
        SELECT * FROM selected ORDER BY id LIMIT p_limit
    )
    SELECT jsonb_build_object('team_id',actor.team_id,
        'total_count',(SELECT count(*) FROM visible),'matching_count',(SELECT count(*) FROM matched),
        'members',COALESCE(jsonb_agg(to_jsonb(page) ORDER BY page.id),'[]'::jsonb),
        'next_cursor',CASE WHEN (SELECT count(*) FROM selected)>p_limit THEN max(page.id::text) ELSE NULL END)
        INTO result FROM page;
    RETURN result;
END $$;
ALTER FUNCTION identity.team_directory_page_for(uuid,uuid,uuid,text,text,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.team_directory_page_for(uuid,uuid,uuid,text,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION identity.team_directory_page_for(uuid,uuid,uuid,text,text,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.team_account_read(p_action text,p_actor uuid,p_session uuid,p_input jsonb DEFAULT '{}'::jsonb)
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
    ELSIF p_action='directory' THEN
        RETURN identity.team_directory_page_for(p_actor,p_session,NULL,p_input->>'query',p_input->>'cursor',
            COALESCE((p_input->>'limit')::integer,50));
    ELSIF p_action='members' THEN
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
