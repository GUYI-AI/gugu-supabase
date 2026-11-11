-- Close only the eight owner connection RPCs. No legacy definition, owner, ACL,
-- credential, tombstone, original UUID or receipt is deleted or reconstructed,
-- and no switched account returns to legacy authority: owner-mode accounts simply
-- cannot manage connections until ops/regrant-owner-connection-api.sql.
--
--   psql -X -f ops/rollback-owner-connection-api.sql                    dry run (default)
--   psql -X -v apply=1 -f ops/rollback-owner-connection-api.sql         commit
--   psql -X -v apply=1 -v force=1 -f ops/rollback-owner-connection-api.sql
--
-- The dry run prints the owner-mode count and the grants before and after, then
-- rolls back. Apply is refused (psql exit 3) while any account is in owner mode,
-- unless force=1. Only the exact value 1 counts for apply and force.
\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply 0
\endif
\if :{?force}
\else
\set force 0
\endif
SELECT :'apply' = '1' AS connection_api_apply, :'force' = '1' AS connection_api_force \gset
BEGIN;
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '2s';
SET LOCAL transaction_timeout = '2s';
SELECT count(*) AS owner_mode_accounts FROM identity.connection_heads WHERE authority_mode = 'owner' \gset
\echo owner-mode accounts: :owner_mode_accounts
CREATE TEMP VIEW owner_connection_api AS
    SELECT s.signature,has_function_privilege('authenticated',s.signature,'EXECUTE') AS authenticated,
        has_function_privilege('anon',s.signature,'EXECUTE') AS anon,
        has_function_privilege('service_role',s.signature,'EXECUTE') AS service_role
      FROM unnest(ARRAY['identity.connection_snapshot(text)','identity.connection_resource(text,text)',
        'identity.connection_recreate_begin(uuid,text,text,bigint,text,text,bigint)',
        'identity.connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid)',
        'identity.connection_commit_batch(uuid,uuid,jsonb,text)','identity.connection_pending(text)',
        'identity.connection_admit(text,bigint,uuid)','identity.connection_ack(text,uuid,uuid,text,boolean)']) s(signature);
\echo grants before:
SELECT * FROM owner_connection_api;
REVOKE ALL ON FUNCTION identity.connection_snapshot(text),identity.connection_resource(text,text),
    identity.connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid),identity.connection_pending(text),
    identity.connection_admit(text,bigint,uuid),identity.connection_ack(text,uuid,uuid,text,boolean),
    identity.connection_recreate_begin(uuid,text,text,bigint,text,text,bigint),identity.connection_commit_batch(uuid,uuid,jsonb,text)
    FROM PUBLIC,anon,authenticated,service_role;
\echo grants after:
SELECT * FROM owner_connection_api;
\if :connection_api_apply
SELECT set_config('gugu.connection_api_force',:'connection_api_force',true) AS connection_api_force_set \gset
DO $refuse_owner_mode$
BEGIN
    IF current_setting('gugu.connection_api_force') <> 't'
        AND EXISTS (SELECT 1 FROM identity.connection_heads WHERE authority_mode = 'owner') THEN
        RAISE EXCEPTION 'Accounts are in owner mode; closing the RPCs stops their connection management (force=1 to proceed)';
    END IF;
END;
$refuse_owner_mode$;
COMMIT;
\echo applied: owner connection RPCs closed
\else
ROLLBACK;
\echo dry run: rolled back (apply=1 to commit)
\endif
