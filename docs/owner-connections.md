# Owner connection primitives

These primitives require the preparation release in #209. They remain closed to
all API roles: this release does not activate a second writer, replace legacy
RPCs, select a minimum client version, or shut down old writes. Readiness and
canonical mapping of prepared legacy rows must be verified before a separate
authority transition can grant access. Do not run preparation again after native
activity. No credential is moved by this release.

All application RPCs derive the owner from `auth.uid()`. Scope is `platform` or
`device:<owned device ID>`; platform requests have a null device target. Saved
metadata can be read offline, without an assistant, its home, or a private chat.
Uninitialized snapshots return `not-ready` and null collections. Provider catalog
presentation can come from the client registry while account state is unavailable.
An explicit first authorization initializes a native head only after rejecting
unprepared legacy accounts, revocations and queued effects. Platform publication
then becomes ready without a native host or a renderer-created collection marker.
Prepared candidates keep a null native initialization timestamp, return not-ready
and reject writes until a separately approved handover. Collection markers cannot
promote a candidate.

The native API consists of snapshot/resource, commit, recreate_begin,
commit_batch, pending, admit and ack. Use named arguments and decimal strings for
bigint revisions. Commit/recreate compare item revisions; admit compares the owner
head. A repeated UUID must have the same request. Metadata documents are inline
UTF-8 JSON with an exact SHA-256 digest and a scalar account-field whitelist.
Null save content preserves the previous document; remove clears it and retains
the tombstone. Ordinary observation can never clear an account tombstone.

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

The installation fixture exercises eleven groups in a transaction that rolls back
its users and temporary API grants. The real production roles stay closed.
Owner RPC/RLS and the separate official credential-deletion wrapper require
non-author review before use.
