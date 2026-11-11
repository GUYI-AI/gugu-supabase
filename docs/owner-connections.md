# Owner connection primitives

These primitives require the preparation release in #209. The owner-runtime release
kept application and mutation RPCs closed to all API roles. Since the cutover release
(`20261111100000_connection_authority_cutover`, see `connection-authority-cutover.md`)
the eight owner RPCs are granted to `authenticated` only, and every one of them treats
an account whose authority mode is not `owner` as unavailable. Legacy RPCs are not
replaced and no minimum client version is selected. Do not run preparation again
after native activity. No credential is moved.

All application RPCs derive the owner from `auth.uid()`. Scope is `platform` or
`device:<owned device ID>`; platform requests have a null device target. Saved
metadata can be read offline, without an assistant, its home, or a private chat.
Uninitialized snapshots return `not-ready` and null collections. Provider catalog
presentation can come from the client registry while account state is unavailable.
The first owner write of an account with no connection head and no legacy
connection data initializes it natively as owner, epoch 1, stable: the same head the
cutover writer produces. Accounts with legacy rows, revocations or queued effects are
refused (`55000`) until imported. Platform publication then becomes ready without a
native host or a renderer-created collection marker. Any legacy-mode head, including
a prepared candidate, reads as not-ready from snapshot/resource, and writes and
pending refuse it (`55000`) until `connection_authority_cutover` hands it over.
Collection markers cannot promote a candidate.

The native API consists of snapshot/resource, commit, recreate_begin,
commit_batch, pending, admit and ack. Use named arguments and decimal strings for
bigint revisions. Commit/recreate compare item revisions; admit compares the owner
head. A single identity ledger binds every UUID to its owner, entry-point kind
and request hash. A UUID cannot be reused between single and batch publication,
for another account, or by another owner. Metadata documents are inline
UTF-8 JSON with an exact SHA-256 digest and a scalar account-field whitelist.
Null save content preserves the previous document; remove clears it and retains
the tombstone. Ordinary observation can never clear an account tombstone.
An owner may queue offline default selection only for an existing live device
account: a null document and exactly `providerId, accountId, isDefault: true`.
The identities must match the saved row. This restricted save preserves the
document and other public fields, becomes pending, and executes on the original
device. It cannot create, recreate or publish an account.

Explicit authorization starts a one-use recreation intent before the existing
provider flow. A known account uses item CAS. An unknown account uses a provider
intent fenced to the starting head; commit resolves the real returned account ID
to an existing resource key or creates a canonical key. A latest unconsumed
provider intent blocks ordinary account publication from all devices in that
scope, including after expiry or conflict. Recovery requires another explicit
authorization action; background observation cannot create replacement intent.

`connection_commit_batch(uuid,uuid,jsonb,text)` publishes one explicit provider
import atomically. The parent UUID matches its provider intent; each of 1–50
entries has its original `operationId`, `data` and complete `document`. The whole
request is bounded to 8 MiB. All entries share the intent's provider, scope and
device. Its immutable parent receipt contains the resolved child commit receipts;
a failed child rolls back every item and ticket consumption.

Runtime execution requires a current owned runtime (90-second heartbeat) for the
original device. Pending and per-operation admission exclude platform effects.
Admission durably records the UUID, request hash, operation revision and admission
ID before the effect. An already started operation cannot be admitted again.
Ack records an immutable outcome and never changes an item. A replacement runtime
on the same owned device can resend a known completed ack. An uncertain effect
must be terminal `CONNECTION_OUTCOME_UNKNOWN`, without replay or a fresh UUID.
Unknown outcomes continue to refuse new-task admission until reconciled; for
native (non-imported) operations the operator reconciles them with
`connection_resolve_unknown_outcome` (see `connection-authority-cutover.md`).
Null-operation admission is only a new-task barrier, never effect authorization.

Imported pending is not evidence of an unstarted effect. The maintenance-only
`connection_record_takeover(text,uuid,text,text,text,text,text)` requires the exact
prepared manifest, original operation/request hash, a SHA-256 of externally
verified offline-executor evidence, and a known outcome. The executor must also
be offline under the heartbeat rule. Evidence must establish actual quiescence;
an expired heartbeat or missing ack alone does not prove it. Only a verified
`not-started` record permits the original UUID to execute; applied, failed and
unknown outcomes remain recorded. Conflicting evidence is rejected. The original
scope must have a verified canonical mapping; unknown legacy routes cannot be
guessed. No activation or quiescence automation is provided here.

Rollback before activation closes/removes only the new entry points through a
separate reviewed release; leave prepared rows, original definitions, tombstones
and receipts intact. Legacy functions, tables and grants remain unchanged.
After activation, do not restore legacy authority until original receipts and
revocations have been reconciled; this release does not authorize that transition.

`connection_authority()` returns persisted mode/epoch/phase and intake eligibility
without initializing a head. Its default is explicitly legacy/0/stable, and it
must be installed before the first new-location client. An unavailable reader is
an error, not legacy discovery. The closed internal
`connection_authority_fence(text,bigint)` holds the authority advisory lock and
head row lock for its surrounding transaction, rejects stale epochs/quiescence,
and never grants operation admission. The epoch-based transition writer is the
maintenance-only `connection_authority_cutover`; draining legacy HTTP/OAuth effects
before it remains an operational step.

The installation fixture exercises eighteen groups in transactions that roll back
its users and temporary API grants; it runs before the cutover release, which is
what grants the owner RPCs to `authenticated`.
Owner RPC/RLS and the separate official credential-deletion wrapper require
non-author review before use.
