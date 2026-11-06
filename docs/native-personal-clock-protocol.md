# Native personal conversation sort time

This follow-up adds an authoritative sort time to
[native-personal-activity-protocol.md](native-personal-activity-protocol.md).
Original message times, publication identity, personal admission, visibility and
read/unread authority keep their existing meanings.

## New messages

A first eligible native publication captures one server receive time in the
existing `published_at`. Its private `sort_at` is the earlier of that receive time
and the original `occurred_at`. The original payload remains immutable for key
conflict checks. A matching retry does not change any of these values.

The publication's private `personal_activity_applied_revision` records its actual
activity materialization version, in the same transaction. It does not have a
foreign key to the retained or pruned journal. Metadata alone does not prove a
personal admission, and matching old receipts never fill missing evidence.

Every first eligible publication advances the existing account activity facet,
even if its original and sorting maxima remain unchanged. The stored original
activity time is still the maximum original time. The stored sort time is the
maximum of the fixed legacy baseline, if any, and each new confirmed message's
individual sort time. It is not the minimum of independently aggregated maxima.

## Existing confirmed activity

Established v1 activity rows already represent confirmed personal facts. They do
not need a reconstructed complete transcript to receive a bounded sorting value.
Their private `legacy_personal_sort_at` is the earlier of their frozen original
aggregate and one real server migration time. `legacy_sort_migrated_at` retains
that migration anchor. These fields are fixed together and are not exposed to API
roles. New C-only conversations have no legacy baseline or migration anchor.

The anchor is captured once with `clock_timestamp()` after admission, parent,
head and DDL lock waits finish. It is an upper bound on the server's receipt of
the covered facts, not a fabricated first receipt for every old message. A
transaction-start `now()` is insufficient after waiting for a late old commit.

Migration publishes a new actual activity version and own wake for each upgraded
tuple. It preserves original times, original receipts, keys, hidden state and IM
sequence/read state. It does not create activity from ledger-only unknown history
or give old publications fabricated materialization associations. Normal old
times before the anchor remain identical; future old values are capped at the
anchor. Rebuilds retain that fixed baseline rather than scanning only new C keys
or recalculating the baseline from a later raw maximum.

## Cutover and failure

The migration takes the known owners' existing erasure guards and FK parent locks
before the ledger gate and all activity-owner heads. An additional owner detected
under the gate aborts with a retryable serialization failure; no late owner guard
or head is discovered. The activity DDL lock is `NOWAIT` after heads, so an old
reader aborts the release instead of creating a wait after holding those heads.
The installer transaction rolls back the tuple, anchor, functions and release
ledger together. Repeating the installed release skips its SQL, and repeating an
already completed legacy phase does not change the baseline or emit revisions.

An already executing old native body may resume after its owner guard is released
at cutover. A closed insertion guard rejects a new key from that old body with
`40001`, before inbox, restoration or activity changes. Retrying the unchanged
public RPC uses the new body. Existing-key candidates retain the original
authorization, deduplication and payload-conflict checks. Direct API table writes
remain revoked; privileged metadata maintenance never establishes activity.

## Read contract and consumers

`list_conversation_memberships(text[])` preserves every v1 column and appends only
`native_personal_sort_at`. The invoker snapshot reads that same narrow projection.
An authorized caller seat with no personal fact has both times NULL, activity
revision string `"0"` and its exact observed head. A stored fact has both times
non-NULL and a positive actual activity revision. All four personal fields on
peer seats are NULL and not applicable to the caller's facet.

Original time, sort time and activity revision merge as one complete tuple;
`personal_state_observed_revision` remains separate read coverage. A higher
version can correct the sorting value backwards. A missing sort field or a
partial non-NULL/NULL tuple is a protocol or upgrade error, not a legal old-data
sorting state or authoritative absence. An old incomplete cache cannot block a
complete authoritative tuple at the same activity revision.

Sorting and list date/relative-time rendering must use the same authoritative
sort value. Known hidden state still wins. The backend fixture compares normal
legacy time and membership inputs before and after migration. Desktop and phone
must separately verify the complete old row set, grouping, pin/draft/open state,
tie decisions, row order and date copy with identical viewing time and timezone.
Offline overlays and authorized IM sorting sources retain their client contracts;
backend checks alone do not establish that joint acceptance.
