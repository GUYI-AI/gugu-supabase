# Atomic audit redaction in Auth account erasure

Refs #265 and #291. This adds the unified caller in `20261115101000`; it does not complete every residual-reference or account-deletion production gate.

The complete installation order is invitation admission `083000`, file action audit `090000` (#285), Auth audit helper `100000` (#292), then this caller `101000`. No lower version is added after a shared deployment. The Auth time index uses the separately reviewed normal CD preparation step; application installation does not change the platform owner. Keep all dependent candidates un-deployed until their final combined tree is accepted.

The installed erasure body is copied to the new closed `identity.erase_human_account(text,text)` capability with exact one-occurrence anchors. A mismatched predecessor, existing two-argument definition, missing helper or unexpected Auth trigger aborts the migration transaction. Existing lock/DML statements keep their order. Both signatures and the Auth trigger function are owned by `postgres`, SECURITY DEFINER, use the fixed `pg_catalog` search path, and remain closed to API roles.

`identity.handle_deleted_auth_user()` passes trusted `OLD.id` and `OLD.email` directly. No email or reverse identity mapping is put in a table, GUC, queue or log. The old one-argument private capability remains as a wrapper with NULL email; it still redacts the complete identity set, while the optional email match stays off. It is not exposed as a self-deletion endpoint.

The sequence in one Auth transaction is: create the exact privacy-erasure context; redact Auth audit email/name fields; perform the existing erasure and account-reference cleanup; redact file-action audit identities; clear the context. Any failure rolls back the Auth deletion and every preceding change. Retention pruning remains an independent bounded task; the deletion transaction does not run a 180-day batch.

Auth audit security IDs/actions/times/IP remain under the approved retention rule. Only reviewed personal paths are redacted. File audit actions/times/counts/deadlines remain, while the identity fields are replaced without a persistent reverse map. NULL/empty OLD.email must never skip ID-based redaction. The standalone helper permissions and writer fences remain their authors' implementation; this caller does not alter those functions.

`tests/integration/service/unifiedAuthAuditHttp.test.ts` uses the checkout-owned loopback Auth service, not SQL DELETE as an HTTP substitute. It checks real hard deletion, full owner/agent IDs, normalized email-only matches, an unrelated account, old session refusal, NULL/empty emails and the original capability. A row-specific late file-audit constraint failure must preserve Auth/identity/group/message state and the early Auth audit payload, with no leaked lifecycle context. This DDL fault-injection suite runs serially before parallel integration fixtures.

Pending production gates remain explicit: unhooked non-FK references and billing de-identification, invitation/runtime receipts, real confirmation-mail delivery, complete concurrent erasure/writer cases, source-session cleanup, and actual Auth end-to-end latency below the agreed target. A helper microbenchmark or a green installation is not a production deletion acceptance result.
