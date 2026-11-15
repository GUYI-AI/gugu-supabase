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
is from an audit header to its own details. The 180-day rule covers action
evidence, not an exception permitting original identity IDs to survive account
erasure. Actors must be irreversibly replaced and embedded subject IDs removed
from typed references while action/time/count/deadline evidence remains.

## Closed erasure integration contract

`file_private.erase_storage_action_audit(p_ids text[]) RETURNS void` has no API
execute grant. It requires an exact `identity.account_lifecycle_context` row for
the current `pg_current_xact_id()`, operation `privacy_erasure`, and the full
`delete_user_ids = p_ids` set. A caller-set flag cannot authorize it.

The helper replaces matching actor/effective IDs with a random `erased:` token,
keeps no reverse map, clears matching/embedded identity references in header IDs
and copy/item/version references, and preserves item/version pairing. Literal
identifiers cannot inject LIKE wildcards. Non-identifying shared references and
the action evidence remain intact; repeated erasure is idempotent.

Writers take a shared transaction lock on the existing human-owner
`identity:erase-human:` key, then recheck identity liveness. The Auth eraser takes
that key exclusively, so a completed erasure cannot be followed by a late JWT
recording the original identity again. The writer locks the current identity
tuple with `FOR KEY SHARE`, checks `removed_at` and the live-identity predicate;
an older repeatable-read snapshot must serialize/fail after a concurrent removal
instead of recording the original ID from its stale snapshot. The tuple lock
follows the owner advisory lock, matching the eraser's order.

**Pending integration:** the unified Auth erasure migration must call this helper
before deleting its private lifecycle context. This PR intentionally does not
edit that entrypoint. Full Auth deletion, large-data erasure latency, and the
complete concurrent Auth/write path are acceptance gates for that integration;
direct helper tests do not stand in for them.

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
