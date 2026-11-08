-- Preserve owner authorization before distinguishing a removed personal assistant.
-- Rebuild only this installed function, retaining its owner, attributes and exact ACL.
DO $panel_removed$
DECLARE
    target regprocedure := 'identity.assistant_panel_commit(text,uuid,text,text,bigint,text,jsonb,uuid,text,text,text)'::regprocedure;
    definition text; previous_acl aclitem[]; permission record;
    anchor text := 'v_owner := identity.assistant_panel_lock(p_assistant);';
BEGIN
    SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl, acldefault('f',p.proowner))
      INTO definition, previous_acl FROM pg_proc p WHERE p.oid=target;
    IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
        RAISE EXCEPTION 'Unexpected assistant panel commit predecessor';
    END IF;
    EXECUTE replace(definition,anchor,anchor || $guard$
    IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id=p_assistant AND u.removed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Personal assistant has been removed' USING ERRCODE='42501';
    END IF;$guard$);
    -- CREATE OR REPLACE is closed by the installation DDL guard. Restore only prior grants.
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
        FROM aclexplode(previous_acl) WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',target,
            CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
            CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
END;
$panel_removed$;

NOTIFY pgrst, 'reload schema';
