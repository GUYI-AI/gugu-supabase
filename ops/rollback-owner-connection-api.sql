-- Close only the new owner entry points. No legacy definition, owner, ACL,
-- credential, tombstone, original UUID or receipt is deleted or reconstructed.
-- This is not permission to return a migrated owner to stale legacy authority.
BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='2s';
SET LOCAL transaction_timeout='2s';
REVOKE ALL ON FUNCTION identity.connection_snapshot(text),identity.connection_resource(text,text),
    identity.connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid),identity.connection_pending(text),
    identity.connection_admit(text,bigint,uuid),identity.connection_ack(text,uuid,uuid,text,boolean),
    identity.connection_recreate_begin(uuid,text,text,bigint,text,text,bigint),identity.connection_commit_batch(uuid,uuid,jsonb,text)
    FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
