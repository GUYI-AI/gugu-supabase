-- Group enrollment must not roll back an otherwise valid task identity. The legacy
-- nine-argument RPC delegates here too. Preserve the allocator, admission guards and ACL.
DO $enrollment$
DECLARE
    definition text;
    previous text;
    acl aclitem[];
    permission record;
BEGIN
    SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl, acldefault('f', p.proowner))
      INTO previous, acl FROM pg_proc p
      WHERE p.oid = 'identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text,text)'::regprocedure;
    definition := replace(previous,
      '    IF p_group_name IS NOT NULL THEN',
      E'    IF p_group_name IS NOT NULL THEN\n      BEGIN');
    definition := replace(definition,
      E'        v_group := CASE WHEN v_prior = ''pending_approval'' THEN '''' ELSE v_target END;\n    END IF;',
      E'        v_group := CASE WHEN v_prior = ''pending_approval'' THEN '''' ELSE v_target END;\n'
      || E'        SET CONSTRAINTS ALL IMMEDIATE;\n'
      || E'      EXCEPTION WHEN OTHERS THEN\n'
      || E'        RAISE WARNING ''provision_taskpage_agent: project group enrollment failed for agent % in group % [%]: %'', v_minted.id, v_target, SQLSTATE, SQLERRM;\n'
      || E'        v_group := '''';\n'
      || E'        v_created := false;\n'
      || E'        v_prior := ''join_failed:'' || COALESCE(v_denial, SQLSTATE);\n'
      || E'      END;\n    END IF;');
    IF definition = previous OR position('EXCEPTION WHEN OTHERS' in definition) = 0
      OR position(E'      BEGIN' in definition) = 0 THEN
        RAISE EXCEPTION 'Unexpected task agent group enrollment predecessor';
    END IF;
    EXECUTE definition;
    -- The installation's DDL guard revokes API execution on CREATE OR REPLACE.
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
      FROM aclexplode(acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text,text) TO %s%s',
        CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
END $enrollment$;

-- Reuse the existing requested-by RLS policy to distinguish one's own pending
-- join request from a refused enrollment. Expose only these non-content fields.
GRANT SELECT (chat_id, requester_user_id, status) ON chat.group_join_requests TO authenticated;
NOTIFY pgrst, 'reload schema';
