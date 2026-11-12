# Owner-scoped connection migration

Tracking: GUYI-AI/gugu#1922. This preparation-only release adds owner-scoped candidate tables, RLS, bounded
maintenance import/export helpers and exact legacy-function backup/restore.
It never changes a live source, routes an old RPC, executes queued work, enables
a writer, authorizes a provider or deploys a backend. Legacy tables, functions,
ACLs and clients remain unchanged. No application-facing owner RPC is activated.

## Check installed function definitions first

`ops/platform-connections/legacy-functions.json` contains UTF-8 SHA-256 hashes of
`pg_get_functiondef` for seven installed legacy entry points. These were generated
by installing backend commit `40dd744195204fce8c14cf00e81da5cfa80b45d0` into an
empty, isolated Supabase PostgreSQL 17.6 fixture, rather than hashing SQL source
files. Source-level migrations can alter an earlier function definition.

The deployment operator must run this read-only check during the separately
approved staging rehearsal. Keep the connection value in the named environment
variable; do not put it in arguments, reports, or logs:

```sh
node scripts/platform-connection-preflight.mjs \
  --database-url-env GUGU_INSTALL_TEST_DATABASE_URL \
  --output /private/task/predecessor-report.json
```

Exit 0 means all seven definitions match, exit 2 means drift or a missing
function, and exit 1 means the check itself failed. Both 1 and 2 prevent migration.
The report contains signatures and hashes, never connection values or function
bodies. Reports are created exclusively with mode 0600 and never overwritten.

Do not update expected hashes to bless an unexplained difference. Investigate the
installed release and review the difference first. A matching definition hash
does not prove that table policies or ACLs match; those must also be preserved
and compared by the migration and rollback verification.

## Audit the complete legacy inventory

The inventory is `identity.connection_legacy_inventory(owner)`, read in
maintenance scope by the operator through the cutover tool's dry run
(`connection-cutover-runbook.md`). There is no owner-run export: an earlier one
copied the import rule and drifted from this function. The inventory includes
collection markers, retired rows, permanent tombstones, and pending/failed cleanup
operations. The regular visible panel snapshot omits some of those records and is
not a valid migration input.

The inventory includes `databaseDigest`, computed by PostgreSQL over its exact
`jsonb::text` representation. This is separate from the normalized manifest hash;
JavaScript JSON serialization and PostgreSQL JSON serialization are not assumed
to have identical bytes. A handoff must recheck the database digest while holding
the source lock and reject a changed source.

Download every referenced immutable body through the original owner's authorized
file reader. Save its bytes as `<body UUID>` in a private task directory. A stored
blob hash alone does not prove that a file can be downloaded or that its actual
bytes match. The audit reads bounded regular files and refuses symlinks.

```sh
node scripts/platform-connection-audit.mjs \
  --source /private/task/source.json \
  --candidate /private/task/candidate.json \
  --bodies-dir /private/task/bodies \
  --output /private/task/inventory-report.json
```

The tool preserves operation identity and cleanup routing in the comparison. It
hashes normalized metadata without logging body text, account names or unknown
fields. Source and candidate use the same normalizer. A missing candidate can be
audited, but cannot become eligible for handoff. A genuinely new account without
an assistant is reported as eligible for native initialization, not legacy
rollback. No account is created by either tool.

## Prepare a verified candidate without activating it

The new `identity.connection_heads`, `connection_items` and
`connection_operations` are preparation candidates only. Authenticated users
have SELECT for their own rows; direct writes and maintenance helpers are closed
to PUBLIC, anon, authenticated and service_role. The function-definition backup
is also closed to those roles. No assistant/home/DM foreign key can delete these
candidates when an assistant is removed.

An authorized deployment operator can first dry-run, then explicitly stage an
import in the approved isolated rehearsal. This is not permission to run it on
staging or production from a development session:

```sh
node scripts/platform-connection-prepare.mjs \
  --database-url-env GUGU_INSTALL_TEST_DATABASE_URL \
  --source /private/task/source.json --bodies-dir /private/task/bodies \
  --output /private/task/dry-run.json
```

Adding `--apply` stages the candidate, reconstructs an inventory from its actual
columns and stored body bytes, runs the same normalizer on source and candidate,
and commits only when counts/hashes/tombstones/operation receipts match. A source
digest mismatch, body mismatch, missing row or exception rolls back the candidate.
Re-preparation atomically replaces only this owner's candidate. The original
legacy state is never modified. Reports always say `activated: false`.

Unfinished operations keep their original UUID, revision, request hash, payload,
cleanup routing, terminal status and applied-device/cleanup timestamps. They are
marked `source = 'legacy'` and are not executable from preparation tables. Actual
execution takeover requires the later owner runtime contract and authority fence;
copying a pending row is not claimed as completed execution takeover. Recheck the
source digest at that future boundary: a valid candidate can become stale after
preparation commits.

Accounts with no legacy assistant are reported distinctly. The import refuses to
create a fake assistant or pretend a legacy rollback exists. Native initialization
belongs to the owner runtime contract, not this preparation release.

## Bounded work and lock discipline

The initial planning envelope is tens of providers and hundreds of metadata
records per account; this is not a measurement of production inventories. The
first implementation refuses an owner exceeding any of these limits:

| Limit | Maximum |
| --- | --- |
| Inventory records, including markers/tombstones | 2,000 |
| Pending/failed operations | 2,000 |
| Serialized inventory | 16 MiB |
| One downloaded body | 1 MiB |
| Total downloaded bodies | 8 MiB |

The handoff must be atomic for the owner. Exceeding a limit rejects handoff; it
does not silently drop records or split one owner into two writable authorities.
Large inventories require a separately reviewed preparation strategy before
raising the bound. Body downloads and normalization occur before taking locks.

The preparation transaction sets `transaction_timeout = '2s'`,
`lock_timeout = '250ms'` and `statement_timeout = '2s'` **before** issuing the handoff statement. Setting a
statement timeout inside an already-running function does not establish a hard
deadline for its outer statement. The import rejects an unbounded caller. PostgreSQL 17 transaction_timeout bounds
the complete transaction, including candidate verification after the import
statement; a per-statement timeout alone would leave locks held between queries.
Acquire the original assistant control lock before the owner control lock, and
use the same order for rollback. Exceeding a timeout aborts the transaction and
leaves the owner on its previous authority.

An isolated-database test must record lock-hold time with a larger bounded sample,
as well as test rejection above the bounds. A fast audit alone is not evidence of
bounded database lock time.

## Exact restoration and evidence

`ops/restore-platform-connection-functions.sql` runs one bounded transaction,
executes each stored original definition text, restores its original owner and
ACL entries (including grant options and grantors), and verifies UTF-8 bytes,
OID, exact ACL including NULL, owner and function attributes. Restoration fails
atomically if any value cannot be reproduced. It does not reconstruct an
"equivalent" body, delete candidate data, revoke provider credentials, or rewrite
the installation ledger. It is restricted to the approved maintenance workflow.

Each grant is replayed with `SET LOCAL ROLE` to its captured grantor, then the
original maintenance role is restored. PostgreSQL's object `GRANTED BY` clause
cannot impersonate a different current role, even for a superuser. The authorized
maintenance session therefore needs existing SET permission for the captured
roles (or a superuser session); the restoration script never grants memberships.
Missing permission fails the entire transaction. The isolated test includes a
function owner different from maintenance and a delegated EXECUTE grantor, and
checks that the original maintenance identity is restored as well as the ACL.

This preparation release never changes the old RPCs, so restoring these backups
leaves the live legacy path usable. Prepared owners remain on that path; new
accounts are not fabricated in the old assistant model. If a future release
activates owner state, reconcile that state and its receipts before restoring
old routing. This script alone is not a rollback for a future authority switch.

Isolated evidence covers definition-hash drift refusal, byte-identical original
non-integration snapshot/resource/pending/admission responses, original revision
semantics, owner/stranger/anon isolation, closed maintenance helpers, complete
body-byte verification and candidate comparison. A larger fixture uses 1,804
items including tombstones and 1,001 unfinished operations. One observed run held
the old control lock through pre-commit verification for 245.27 ms; commit itself
is outside that diagnostic interval. The whole transaction remains bounded by
PostgreSQL's 2-second transaction timeout. This is an isolated measurement, not a
production sizing claim.

Deferred until the rollout decision: old-RPC real-time adapters, dual-path routing,
minimum-version gates, old-write shutdown and legacy-client successful read/write
acceptance. Owner runtime RPCs, actual execution takeover and native initialization
are separate follow-up implementation, not implicitly enabled by this release.

The backend and private specification PRs cross-link, and the client PR will link
when available. RLS/ACL and account-data changes require non-author review. This
work never authorizes merging or staging/production deployment.
