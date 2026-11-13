# Native personal conversation activity

Refs GUYI-AI/gugu#1974. This follow-up builds on the personal-hiding contract in
[conversation-list-protocol.md](conversation-list-protocol.md). Desktop and phone
consume the same caller-scoped projection.

## Publish and retain an activity fact

The existing `chat.publish_native_conversation_message` signature and stable
`(device_id, session_id, message_id)` key are retained. Its current owner, device,
Agent and canonical two-seat DM authorization runs before deduplication.

A first eligible publication materializes the maximum original occurrence time
for that caller and chat. Every such first publication advances the activity
facet using the existing caller account revision sequence, including an equal or
older original time. A matching retry returns `already: true` without advancing
the activity facet or restoring a hidden row again. Reusing a key with a different
owner, Agent, chat or original time remains a conflict.

The admission, retained deduplication receipt, inbox publication, restoration,
activity fact, account journal and private revision wake commit together. The new
state is kept in the closed `chat.native_personal_conversation_activity` table,
keyed by `(user_id, chat_id)`. Its only foreign-key parents are the caller identity
and chat. Device disconnect, directory replacement and device-record removal
cannot remove that activity row. Account erasure and permanent chat deletion
retain their existing authority.

The host must persist real personal admission and its stable outbox identity
atomically. Task activity, background/group work, replay, imports and streaming
fragments cannot supply a new personal publication. No native transcript body or
IM sequence/read/unread state is created by this metadata.

## Read and merge

`chat.list_conversation_memberships(text[])` preserves its array shape and prior
columns, then appends:

| Field | Meaning |
|---|---|
| `native_personal_activity_at` | The confirmed maximum original native personal occurrence time, or SQL NULL for an authorized caller seat without a stored fact. |
| `native_personal_activity_revision` | The facet's actual materialization revision as a canonical decimal **string**; `"0"` for that authorized absence. |
| `personal_state_observed_revision` | The caller head from the same STABLE/MVCC observation as the returned state, as a decimal **string**. |

All three added columns are SQL NULL on other people's seats. Decode the account
scope before validating activity fields: peer NULLs are not an authoritative
absence of the caller's activity. A missing/denied seat, missing protocol fields,
failed request and authoritative caller NULL/zero have different meanings.

`chat.sync_snapshot()` reads this same narrow projection while remaining
`SECURITY INVOKER`; its account boundary and projected values share one snapshot.
The private table has RLS and explicit table revokes, including `service_role`.
No personal activity is added to peer-readable membership rows or group member
broadcasts.

Activity and visibility merge as separate facets in the existing account
projection owner. Keep the activity fact version separate from its read coverage
boundary. Activity version 41 can be returned by an observation at head 47; it must
not be relabeled as activity version 47. A hide receipt only updates visibility.
Partial receipts cannot stamp an older cached activity as newer. Compare decimal
strings precisely, including values above `2^53`.

The existing own-membership revision key is reused:
`{chat_id, user_id: caller, kind: "own"}`. Consumers invalidate and reread the
related personal facets. Native RPC `account_revision` remains the current head
for confirmation and wake/coverage work, rather than an activity-state receipt.

## Time and upgrade boundaries

This version accepts a finite original occurrence time through one internal time
policy function and preserves that time. Clock policy C is a separate coordinated
follow-up with a fixed first `published_at`, private per-publication `sort_at` and
projected `native_personal_sort_at`; this release does not implement it.

The release does not infer personal admission from old task timestamps, directory
activity or retained historical publication keys. Existing pre-upgrade receipts
still deduplicate; a retry cannot manufacture a missing activity fact or restore
again. Historical backfill needs original personal-admission and owner evidence.

The TABLE function's output type is replaced with `RESTRICT`, inside the release
transaction, followed by its caller-checked definition and narrow ACL. The known
PL/pgSQL snapshot caller is restated with the three appended fields. An unexpected
catalog dependency or snapshot predecessor aborts the release; no dependency is
removed with `CASCADE`. Installation follows the existing version/digest ledger
and schema-cache reload protocol.

The native admission path keeps its owner-erasure guard and pre-head device,
identity and chat parent locks. Existing inbox/member admission completes before
the restoration helper holds the complete recipient head set. Activity writes
then use those already locked parents and the caller head. No late member lock,
chat-exclusive lock or new recipient-head enumeration is added.

## Verification

Run the matching disposable fixture's canonical integration command with
`tests/integration/service/nativePersonalActivity.test.ts` and
`tests/integration/service/nativePersonalActivityConcurrency.test.ts`.
The cases cover authorized absence, peer scope, equal/late first publication,
retries across hide, decimal precision, snapshot projection, retained history,
private ACLs, rollback, invalid time, native/hide ordering and concurrent MVCC
observations. Installation and return-type/dependency checks also require the
complete release chain.

Backend checks do not establish the desktop/phone admission, renderer wake,
shared-facet merge or real product-list acceptance. Those clients must consume
the same protocol before cross-client completion is reported.
