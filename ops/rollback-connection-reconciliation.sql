-- Operational rollback: stop/disable all reconciliation schedulers first.
-- Retain all attempts, fences, generations, evidence, resolutions and original
-- receipts. Never resurrect credentials or return an owner to stale authority.
-- Keep the read-only effective projection available to upgraded clients.
BEGIN;
SET LOCAL lock_timeout='250ms';
SET LOCAL statement_timeout='2s';
REVOKE ALL ON FUNCTION identity.connection_attempt_prepare(uuid,bigint,text),
    identity.connection_attempt_begin(text,uuid,bigint,text),
    identity.connection_attempt_initialize(text,uuid),
    identity.connection_attempt_write_fence(text,uuid,uuid,bigint),
    identity.connection_record_effect(text,uuid,uuid,uuid,text,text,text,text,text,jsonb),
    identity.connection_record_native_fence(text,uuid,uuid,text,uuid,text),identity.connection_resolve_attempt(text,uuid)
    FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
-- Re-enabling writers requires the matching custody/native adapters and the
-- original activation review. Replaying authorization or deletion is forbidden.
