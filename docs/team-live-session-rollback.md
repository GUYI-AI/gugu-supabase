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

## Trigger scope and execution path

| Installed trigger | Full restoration | Reason |
| --- | --- | --- |
| `auth.sessions.team_file_session_closed` | Removed | It runs on every logout/session deletion, including personal sessions. With zero team principals and a closed region, removing it removes that extra personal-path work. |
| `auth.users.team_identity_erasure_guard` | Removed | It runs on every Auth-user deletion. The no-team precondition permits removal without deleting any identity to bypass the guard. |
| `team_private.members.team_member_principal_guard` | Retained | Protects principal binding integrity; no calls on the zero-member personal delete/logout path. |
| `team_private.members.team_member_gate_changed` | Retained | Preserves membership revision invalidation; no calls on the zero-member personal delete/logout path. |

Reactivation requires a reviewed forward repair restoring the Auth triggers as
well as hook/policies/publishers; region activation must check the active gate.
The migration-backed CI measures Auth DELETE trigger timings before/after (64
samples after eight warmups for logout and user deletion), server lock-body time,
and a forced 500ms lock timeout. These component timings exclude HTTP/Auth
transport. The complete migration-backed run 43671482462 at `be59691` passed all
seven rollback cases and the full integration suite (1682 passed, two existing
skips across 182 files). It measured:

| Component | Before: median / p95 | After: median / p95 |
| --- | --- | --- |
| Personal session DELETE: added team-trigger time | 0.101 / 0.129 ms | 0 / 0 ms (Auth trigger removed) |
| Personal Auth-user DELETE: added team-trigger time | 0.128 / 0.145 ms | 0 / 0 ms (Auth triggers removed) |
| Member-trigger calls in those personal paths | 0 | 0 |

The server measured a 31 ms lock body; the whole SQL round trip, including
commit, was 31.673 ms, an upper bound on total lock duration in this fixture.
A conflicting session-table writer caused a clean `55P03` failure at 501.351 ms
with the 500 ms lock timeout. After rollback to the test savepoint, partially
acquired Auth-user ShareLocks were zero and hooks/producers were unchanged.
No production latency or complete HTTP logout/account-deletion duration is
claimed from this component benchmark.

The normal execution path is a named CD repair `team-live-session-gate` with
`count`, `rehearse` and `apply`: fixed `ops/count-team-live-session-gate.sql` and
this rollback SQL, with rehearsal replacing only the final COMMIT. The CD
registration is a companion private-operations change, targeted for the same
12:30 review handoff. Direct shared/production SQL execution is not an alternative.
