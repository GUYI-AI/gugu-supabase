-- Reopen the eight owner connection RPCs after ops/rollback-owner-connection-api.sql:
-- exactly the release's grants (EXECUTE to authenticated; PUBLIC, anon and
-- service_role closed). Nothing else changes.
--
--   psql -X -f ops/regrant-owner-connection-api.sql                     dry run (default)
--   psql -X -v apply=1 -f ops/regrant-owner-connection-api.sql          commit
--
-- The dry run prints the owner-mode count and the grants before and after, then
-- rolls back. Only the exact value 1 counts for apply.
\set ON_ERROR_STOP on
\if :{?apply}
\else
\set apply 0
\endif
SELECT :'apply' = '1' AS connection_api_apply \gset
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
    identity.connection_recreate_begin(uuid,text,text,bigint,text,text,bigint),
    identity.connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid),
    identity.connection_commit_batch(uuid,uuid,jsonb,text),identity.connection_pending(text),
    identity.connection_admit(text,bigint,uuid),identity.connection_ack(text,uuid,uuid,text,boolean)
    FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION identity.connection_snapshot(text),identity.connection_resource(text,text),
    identity.connection_recreate_begin(uuid,text,text,bigint,text,text,bigint),
    identity.connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid),
    identity.connection_commit_batch(uuid,uuid,jsonb,text),identity.connection_pending(text),
    identity.connection_admit(text,bigint,uuid),identity.connection_ack(text,uuid,uuid,text,boolean)
    TO authenticated;
\echo grants after:
SELECT * FROM owner_connection_api;
\if :connection_api_apply
COMMIT;
\echo applied: owner connection RPCs reopened to authenticated
\else
ROLLBACK;
\echo dry run: rolled back (apply=1 to commit)
\endif
