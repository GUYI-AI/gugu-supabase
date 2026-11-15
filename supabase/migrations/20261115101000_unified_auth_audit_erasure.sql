-- Both independent audit helpers must be installed before the unified Auth
-- caller. No audit retention batch is run inside account deletion.
DO $prerequisites$
DECLARE helper regprocedure;
BEGIN
    FOREACH helper IN ARRAY ARRAY[
        to_regprocedure('identity.erase_auth_audit_actor(text[],text)'),
        to_regprocedure('file_private.erase_storage_action_audit(text[])')
    ] LOOP
        IF helper IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p
            WHERE p.oid=helper AND p.prosecdef AND p.proowner='postgres'::regrole) THEN
            RAISE EXCEPTION 'Install the closed audit helpers before unified Auth erasure';
        END IF;
    END LOOP;
END $prerequisites$;

-- Keep the existing erasure body and its ordered locks/DML. The additional
-- email is trusted OLD.email from the Auth trigger, never a GUC or stored map.
DO $upgrade$
DECLARE definition text; trigger_definition text;
    old_header text := 'FUNCTION identity.erase_human_account(p_user_id text)';
    new_header text := 'FUNCTION identity.erase_human_account(p_user_id text, p_auth_email text)';
    context_anchor text := $context$    INSERT INTO identity.account_lifecycle_context (
        transaction_id, operation, subject_user_id, delete_user_ids
    ) VALUES (
        pg_current_xact_id(), 'privacy_erasure', p_user_id, delete_user_ids
    );
$context$;
    cleanup_anchor text := '    DELETE FROM identity.account_lifecycle_context';
    trigger_anchor text := '    PERFORM identity.erase_human_account(OLD.id::text);';
BEGIN
    SELECT pg_get_functiondef('identity.erase_human_account(text)'::regprocedure) INTO definition;
    IF to_regprocedure('identity.erase_human_account(text,text)') IS NOT NULL
       OR length(definition)-length(replace(definition,old_header,''))<>length(old_header)
       OR length(definition)-length(replace(definition,context_anchor,''))<>length(context_anchor)
       OR length(definition)-length(replace(definition,cleanup_anchor,''))<>length(cleanup_anchor) THEN
        RAISE EXCEPTION 'Unexpected unified account erasure predecessor';
    END IF;
    definition:=replace(definition,old_header,new_header);
    definition:=replace(definition,context_anchor,context_anchor||chr(10)
        ||'    PERFORM identity.erase_auth_audit_actor(delete_user_ids,p_auth_email);'||chr(10));
    definition:=replace(definition,cleanup_anchor,
        '    PERFORM file_private.erase_storage_action_audit(delete_user_ids);'||chr(10)||cleanup_anchor);
    EXECUTE definition;

    SELECT pg_get_functiondef('identity.handle_deleted_auth_user()'::regprocedure) INTO trigger_definition;
    IF length(trigger_definition)-length(replace(trigger_definition,trigger_anchor,''))<>length(trigger_anchor) THEN
        RAISE EXCEPTION 'Unexpected Auth deletion trigger predecessor';
    END IF;
    EXECUTE replace(trigger_definition,trigger_anchor,
        '    PERFORM identity.erase_human_account(OLD.id::text,OLD.email);');
END $upgrade$;

-- Preserve the original private capability signature for installed callers.
-- NULL closes only the extra email match; complete identity-set redaction still
-- runs under the same transaction context in the two-argument implementation.
CREATE OR REPLACE FUNCTION identity.erase_human_account(p_user_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM identity.erase_human_account(p_user_id,NULL::text);
END $$;
ALTER FUNCTION identity.erase_human_account(text) OWNER TO postgres;
ALTER FUNCTION identity.erase_human_account(text,text) OWNER TO postgres;
ALTER FUNCTION identity.handle_deleted_auth_user() OWNER TO postgres;
ALTER FUNCTION identity.erase_human_account(text,text) SET search_path=pg_catalog;
ALTER FUNCTION identity.handle_deleted_auth_user() SET search_path=pg_catalog;
REVOKE ALL ON FUNCTION identity.erase_human_account(text),identity.erase_human_account(text,text),
    identity.handle_deleted_auth_user() FROM PUBLIC,anon,authenticated,service_role;
