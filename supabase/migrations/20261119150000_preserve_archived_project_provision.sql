-- Background task identity provisioning does not authorize replacing an archived
-- project group. Keep the identity usable and report the existing enrollment
-- failure contract until its human owner explicitly restores that same group.
DO $archived_project$
DECLARE
    definition text;
    previous text;
    acl aclitem[];
    permission record;
    archived_branch text := $before$        ELSIF v_status = 'archived' THEN
            v_prior := 'archived';
            IF p_new_group_id IS NULL OR p_new_group_id = '' THEN
                RAISE EXCEPTION 'p_new_group_id is required when the mapped project group is archived';
            END IF;
            v_target := p_new_group_id;
$before$;
BEGIN
    SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl, acldefault('f', p.proowner))
      INTO previous, acl FROM pg_proc p
      WHERE p.oid = 'identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text,text)'::regprocedure;
    IF position(archived_branch in previous) = 0 THEN
        RAISE EXCEPTION 'Unexpected archived project provisioning predecessor';
    END IF;
    definition := replace(previous, archived_branch, $after$        ELSIF v_status = 'archived' THEN
            v_target := p_group_chat_id;
            v_denial := 'group_archived';
            RAISE EXCEPTION 'provision_taskpage_agent: project group % requires explicit restoration', v_target
                USING ERRCODE = '55000';
$after$);
    definition := replace(definition,
      '            -- 与「映射指着一个归档群」同处置:另建一个项目群,客户端按返回的 group_chat_id 改指映射。',
      '            -- 外来映射另建项目群；自己的归档群必须由用户显式恢复，不替换映射。');
    EXECUTE definition;
    -- CREATE OR REPLACE runs the installation's API-close DDL guard. Restore
    -- exactly the predecessor's execution ACL; the legacy overload delegates here.
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
      FROM aclexplode(acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text,text) TO %s%s',
        CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
END $archived_project$;

NOTIFY pgrst, 'reload schema';
