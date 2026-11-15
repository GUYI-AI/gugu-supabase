# Committed file-retention audit

`chat.file_storage_mark_as` records every authorized action that reaches the
shared write implementation and commits, including zero matches, equal-value
updates, overlapping references, and retries. This covers direct RPC calls and
the existing upload `keepAs` call to that same RPC.

The actions remain `temporary`, `permanent`, and `release`. Their authorization,
class expansion, return count, expiry handling, and physical GC path are retained.
A release is a cloud-copy action; it does not prove a device's bytes were deleted.
An audit failure fails the action rather than continuing with only a log warning.

Rejected or rolled-back attempts are outside this table. Edge/gateway request
logs are a separate concern; this feature does not claim to cover rejected legacy
direct RPC calls. A later rollback of the caller's transaction also removes the
action and audit together. There is no historical backfill or invented cause.

## Evidence

- `file_private.storage_action_audit`: server time, authenticated account,
  authorized effective actor, action, actual RPC entrypoint, requested reference
  count, validated item/message IDs and classes, and changed-copy count.
- `file_private.storage_action_audit_items`: exact storage/blob/chat identities,
  old/new deadlines, actual expiry state, and typed item/version pairs known at
  the time of the action. Class operations expand to the actual updated set.

A statement trigger captures OLD/NEW transition tables while a server-created
operation is active. It verifies the backend, transaction, and authenticated
account. The temporary backend/transaction context is cleared before returning;
a completed operation cannot be reused as a recording context. Expiry-consumer
updates to unrelated overdue copies are excluded. Original requested message IDs
are retained in the header; this is not a list of every forwarded message alias.

No names, email fields, file paths/content, URLs, credentials, or arbitrary request
JSON are stored. Tables have RLS and no API-role access; implementation, collector,
and prune functions are also closed to API roles. Inspect through the existing
restricted administrator read-only path, selecting only the required fields.

There are no foreign keys to accounts, agents, chats, files, or live copy rows.
Source deletion therefore cannot silently erase the evidence. The only cascade
is from an audit header to its own details. Actor fields allow the separately
approved subject de-identification policy; this release does not authorize
permanent retention of original identity identifiers or invent an erasure policy.

## Retention and cleanup

`file_private.prune_storage_action_audit(1000)` runs every ten minutes. Only rows
strictly older than `now() - interval '180 days'` are eligible. The boundary itself
is retained. Each call removes at most 1,000 expired details and at most 1,000
empty expired headers; large class actions cannot trigger an unbounded cascade.

The function returns deleted **header** count. It can return zero while making
progress through a large expired event's details. Evidence within the retention
window remains complete; an already-expired event can be partially drained until
its final details and header are removed. Cleanup can retain older records while
a backlog drains; it never shortens the minimum 180-day window.

Validation uses a disposable loopback database and covers exact sets/deadlines,
zero matches, retries/overlap, delegated identity, authorization/refusal rollback,
audit-write failure, unrelated expiry work, source deletion, API privileges, and
both retention and cleanup-batch boundaries.
