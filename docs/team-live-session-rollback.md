# Operational rollback of the live-session gate

`ops/rollback-team-live-session-gate.sql` restores the pre-gate semantics of the
Data API hook, the added application/Storage/Realtime policies, and the 071511
producer call substitutions. It leaves the installation region NULL and never
deletes members, Auth users, sessions, messages, financial history or ledgers.
The current file-server authorization helpers remain available to the deployed
file server; this is not a downgrade of its API contract or the migration ledger.

Full restoration is possible only with a closed region and **zero team
principals**, including disabled or orphaned membership bindings and nonpersonal
Auth metadata. Closing the region alone is insufficient once gate policies are
removed: an old team JWT could otherwise reach the prior personal RLS rules.
The script refuses this state; do not remove identities or history to bypass it.
Locks cover Auth/principal writes for the short transaction. Lock contention,
unknown hook values, changed policy shapes or changed security attributes fail
the transaction rather than leaving a partial restoration.

The pre-gate hook was empty/unset (the forward migration refused an independent
nonempty hook). Only the gate's own setting is reset; unrelated settings remain.
Only policies with the known gate name, role, command and helper expression are
removed. Existing permissive row scopes and RLS enablement remain. Producer
bodies receive the inverse call substitution; ownership, ACL, definer flag,
search path and execution attributes are checked unchanged. The new
`team_publish_realtime` entry remains gated and is not treated as an old producer.
Repetition after complete restoration reports zero changes.

Run only through the reviewed operational release path, against the same pinned
backend source. Rehearse with the final COMMIT replaced by ROLLBACK and read back
the original gate state. The release operator must verify personal REST and
Realtime before/after, region remains NULL and no principal appears. A region
activation must refuse while the hook/policies are rolled back. Restoring a gate
after an operational rollback requires a reviewed forward repair; unchanged
migration ledgers do not automatically replay old migrations.

If real team identities exist, a one-command full reset is **not available**.
A separate degradation decision may retain a minimal deny-team request fence,
Storage/Realtime restrictions and team-aware publishing while restoring the
personal fast path. That plan must keep new/old team JWTs closed and be measured
independently. It is not implemented or authorized by this rollback script.

## Separate degradation proposal when team identities already exist

This proposal requires a release decision and a separate implementation; no
command in this change applies it:

1. Close the region first. New model authorizations/renewals fail; legal late
   usage continues settling against its original team funding.
2. Keep a request fence and application restrictions that deny every caller
   classified as team by either verified JWT claims or authoritative principal
   bindings. A personal fast predicate can avoid team session/revision lookups;
   removing the request fence would reopen definer RPCs.
3. Retain Storage and Realtime deny-team restrictions, current-session file
   authorization and namespace-aware publishers. Cached team subscriptions must
   receive no new content. Do not restore all producers to raw shared topics
   while a team principal exists.
4. Restore/measure the personal path within those boundaries. The candidate
   predicate still performs authoritative classification, so zero overhead is
   not promised. Compare real personal JWT REST median/p95 and check disabled
   and active team JWT negatives, Storage, cached Realtime and files before any
   staged rollout. Identity/financial rows and original late settlements remain.

The full restoration script above is intentionally unavailable in this state.
