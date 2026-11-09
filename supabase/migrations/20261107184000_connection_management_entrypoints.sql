-- Entry-point guards for the upgrade-first rollout. There is no forwarding.
-- Policy OFF preserves the existing API behavior. Enabling the policy is a
-- separately approved CD action after both readers and the client have shipped.
CREATE FUNCTION identity.connection_management_assert(p_access jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
    IF NOT (p_access->>'allowed')::boolean THEN
        RAISE EXCEPTION USING ERRCODE='PT426', MESSAGE=p_access->>'message',
          DETAIL=jsonb_build_object('errorCode','CONNECTION_CLIENT_UPGRADE_REQUIRED',
            'feature','connection-management','minimumVersion',p_access->'minimumVersion',
            'clientPlatform',p_access->'clientPlatform','policyRevision',p_access->>'policyRevision')::text;
    END IF;
END;
$$;
CREATE FUNCTION identity.connection_management_require_read() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM identity.connection_management_assert(identity.connection_management_access());
END;
$$;

-- The caller of this closed helper has already established its owner. Service
-- callers derive that owner from their verified JWT, never a public body.
-- The policy lock is always acquired before this owner-authority lock.
CREATE FUNCTION identity.connection_management_write_fence(p_owner text,p_legacy boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE head identity.connection_heads%ROWTYPE;
BEGIN
    IF p_owner IS NULL OR NOT EXISTS (SELECT 1 FROM identity.users WHERE id=p_owner AND type='human' AND removed_at IS NULL) THEN
        RAISE EXCEPTION 'Connection account is unavailable' USING ERRCODE='42501'; END IF;
    PERFORM identity.connection_management_require_access();
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:connection-authority:' || p_owner,0));
    SELECT * INTO head FROM identity.connection_heads WHERE owner_user_id=p_owner FOR UPDATE;
    IF COALESCE(head.authority_phase,'stable')<>'stable' OR p_legacy AND head.authority_mode='owner' THEN
        RAISE EXCEPTION 'Connection authority changed or is quiescing' USING ERRCODE='PT409'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_management_assert(jsonb),identity.connection_management_require_read(),
    identity.connection_management_write_fence(text,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- Transform the installed definitions rather than restoring a repository
-- spelling of them. In particular the legacy membership rewrite is preserved.
-- CREATE OR REPLACE retains OIDs/owners; its DDL privilege guard closes API
-- access, so replay the captured effective ACL under each original grantor.
DO $upgrade_entrypoints$
DECLARE spec record; fn oid; v_definition text; acl jsonb; grant_entry jsonb; role_before text:=current_user;
    target text; grantor text; grantee text; access_statement text; existing_grant record;
BEGIN
    FOR spec IN SELECT * FROM (VALUES
      ('identity.connection_snapshot(text)','PERFORM identity.connection_management_require_read();',false),
      ('identity.connection_resource(text,text)','PERFORM identity.connection_management_require_read();',false),
      ('identity.connection_recreate_begin(uuid,text,text,bigint,text,text,bigint)','PERFORM identity.connection_management_write_fence(owner_id);',false),
      ('identity.connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid)','PERFORM identity.connection_management_write_fence(owner_id);',false),
      ('identity.connection_commit_batch(uuid,uuid,jsonb,text)','PERFORM identity.connection_management_write_fence(owner_id);',false),
      ('identity.connection_pending(text)','PERFORM identity.connection_management_write_fence(owner_id);',false),
      ('identity.connection_admit(text,bigint,uuid)','IF p_operation_id IS NOT NULL THEN PERFORM identity.connection_management_write_fence(owner_id); END IF;',false),
      ('identity.assistant_panel_commit(text,uuid,text,text,bigint,text,jsonb,uuid,text,text,text)',
       'IF p_domain = ''integrations'' THEN PERFORM identity.connection_management_write_fence(identity.connection_owner(),true); END IF;',true)
    ) AS patches(signature,guard,legacy)
    LOOP
        fn:=to_regprocedure(spec.signature);
        IF fn IS NULL THEN RAISE EXCEPTION 'Missing connection entry point: %',spec.signature; END IF;
        SELECT pg_get_functiondef(fn),
          COALESCE((SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
            'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
            'grantable',a.is_grantable) ORDER BY a.ordinality)
            FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) WITH ORDINALITY a WHERE a.privilege_type='EXECUTE'),'[]'::jsonb)
          INTO v_definition,acl FROM pg_proc p WHERE p.oid=fn;
        IF spec.legacy AND NOT EXISTS (SELECT 1 FROM identity.connection_legacy_functions b
          WHERE b.signature=spec.signature AND b.original_oid=fn
            AND encode(sha256(convert_to(v_definition,'UTF8')),'hex')=
                encode(sha256(convert_to(b.definition,'UTF8')),'hex')) THEN
            RAISE EXCEPTION 'Legacy connection entry point differs from the captured predecessor';
        END IF;
        IF (length(v_definition)-length(replace(v_definition,E'\nBEGIN\n','')))/length(E'\nBEGIN\n')<>1 THEN
            RAISE EXCEPTION 'Connection entry point has an unexpected body: %',spec.signature; END IF;
        -- Remove dependent grants before CREATE's privilege guard runs.
        FOR existing_grant IN SELECT DISTINCT a.grantee FROM pg_proc p,
            LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=fn AND a.grantee<>p.proowner LOOP
            target:=CASE WHEN existing_grant.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(existing_grant.grantee)) END;
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s CASCADE',spec.signature,target);
        END LOOP;
        EXECUTE replace(v_definition,E'\nBEGIN\n',E'\nBEGIN\n    ' || spec.guard || E'\n');
        -- Drop only API-role grants introduced by defaults; retain the captured
        -- grant graph, including owner/grant-option and delegated grantors.
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',spec.signature);
        FOR grant_entry IN SELECT * FROM jsonb_array_elements(acl) LOOP
            grantor:=grant_entry->>'grantor'; grantee:=grant_entry->>'grantee';
            EXECUTE format('SET LOCAL ROLE %I',grantor);
            target:=CASE WHEN grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grantee) END;
            access_statement:=format('GRANT EXECUTE ON FUNCTION %s TO %s%s',spec.signature,target,
              CASE WHEN (grant_entry->>'grantable')::boolean THEN ' WITH GRANT OPTION' ELSE '' END);
            EXECUTE access_statement;
            EXECUTE format('SET LOCAL ROLE %I',role_before);
        END LOOP;
    END LOOP;
END;
$upgrade_entrypoints$;

-- No gate on authority/access readers, ordinary whole-head task admission, or
-- acknowledgement of an already admitted operation. Existing receipts must be
-- finishable/readable while management is disabled. Shared legacy snapshots and
-- non-integrations requests keep their byte representation and revision rules.
