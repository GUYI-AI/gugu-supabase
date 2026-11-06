-- Maintenance-only, run through the approved rollback workflow.
-- Restore exact captured definitions/ACLs; retain all prepared data and ledgers.
-- This preparation release never switches authority, so old tables remain live.
-- Future cutover releases must reconcile authority before using this restoration.
BEGIN;
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '2s';
SET LOCAL transaction_timeout = '2s';
DO $restore$
DECLARE saved record; actual record; grant_entry record; grantee text; owner_name text;
BEGIN
    IF (SELECT count(*) FROM identity.connection_legacy_functions) <> 7 THEN
        RAISE EXCEPTION 'Connection function backup set is incomplete';
    END IF;
    FOR saved IN SELECT * FROM identity.connection_legacy_functions ORDER BY signature LOOP
        IF saved.definition_sha256 <> encode(sha256(convert_to(saved.definition, 'UTF8')), 'hex')
            OR to_regprocedure(saved.signature)::oid IS DISTINCT FROM saved.original_oid THEN
            RAISE EXCEPTION 'Connection function backup or identity differs';
        END IF;
        SELECT rolname INTO STRICT owner_name FROM pg_roles WHERE oid = saved.original_owner;
        EXECUTE saved.definition;
        EXECUTE format('ALTER FUNCTION %s OWNER TO %I', saved.signature, owner_name);
        -- CREATE FUNCTION's DDL guard revokes API grants. Rebuild the original
        -- ACL in stored order, including grant options and original grantors.
        FOR grant_entry IN SELECT DISTINCT a.grantee FROM aclexplode(
            (SELECT proacl FROM pg_proc WHERE oid = saved.original_oid)) a LOOP
            grantee := CASE WHEN grant_entry.grantee = 0 THEN 'PUBLIC'
                ELSE quote_ident((SELECT rolname FROM pg_roles WHERE oid = grant_entry.grantee)) END;
            EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s CASCADE', saved.signature, grantee);
        END LOOP;
        FOR grant_entry IN SELECT * FROM aclexplode(saved.original_acl) LOOP
            IF grant_entry.privilege_type <> 'EXECUTE' THEN
                RAISE EXCEPTION 'Connection function backup has unsupported privileges';
            END IF;
            grantee := CASE WHEN grant_entry.grantee = 0 THEN 'PUBLIC'
                ELSE quote_ident((SELECT rolname FROM pg_roles WHERE oid = grant_entry.grantee)) END;
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s GRANTED BY %I', saved.signature, grantee,
                CASE WHEN grant_entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END,
                (SELECT rolname FROM pg_roles WHERE oid = grant_entry.grantor));
        END LOOP;
        SELECT p.oid, pg_get_functiondef(p.oid) AS definition, p.proacl, p.proowner,
            jsonb_build_object('prosecdef', p.prosecdef, 'provolatile', p.provolatile, 'proisstrict', p.proisstrict,
                'proparallel', p.proparallel, 'proconfig', to_jsonb(p.proconfig), 'prorettype', p.prorettype,
                'proargtypes', p.proargtypes::text, 'prokind', p.prokind, 'proleakproof', p.proleakproof) AS attributes
          INTO STRICT actual FROM pg_proc p WHERE p.oid = saved.original_oid;
        IF convert_to(actual.definition, 'UTF8') <> convert_to(saved.definition, 'UTF8')
            OR actual.proacl IS DISTINCT FROM saved.original_acl
            OR actual.proowner <> saved.original_owner OR actual.attributes <> saved.original_attributes THEN
            -- NULL and explicit default ACL are intentionally not conflated.
            -- If exact restoration is impossible, the entire transaction fails.
            RAISE EXCEPTION 'Connection function restoration did not match its exact backup';
        END IF;
    END LOOP;
END;
$restore$;
COMMIT;
