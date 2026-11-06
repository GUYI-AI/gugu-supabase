# Legacy screenshot migration

This is manually operated tooling for the contract introduced by #192, tracked in #202.
It is supplied for review only. Creating or merging this file does not authorize a scan,
rehearsal, deployment, production connection, migration, or deletion. Release owners arrange
the backend-first rollout and a separate staging rehearsal. Keep the implementation PR in
draft until a non-author reviewer has reviewed the destructive path.

The reviewed backend contract is the three screenshot migrations in #192 at
`bbc43eb774392acdc9e8781ade61cf357d06c275`. That is a source reference, not a claim of final
review approval. Backend, client and support readers must be compatible before migrating
data. This script adds no schema release, disables no trigger, and never modifies a released
migration, storage metadata directly, collector state, or historical issues.

## Modes and privacy

Run `scripts/migrate-legacy-feedback.mjs` with Node 24. It uses the repository's pinned `pg`
dependency at runtime; offline tests use Node built-ins and do not load that dependency.

| Mode | Behavior | Output |
| --- | --- | --- |
| omitted / `dry-run` | Read only feedback reference fields and object metadata; no image GET/HEAD, upload, update, journal, or removal | Feedback row count, distinct object count, total metadata bytes, numeric failure list |
| `migrate` | Persist a fixed inventory; sequentially copy and verify complete bytes, then atomically switch each feedback row | Inventory counts and numeric failure list |
| `report` | Separate invocation: read complete source and destination bytes again; verify every feedback mapping and absence of remaining legacy rows | Counts, verified object/byte totals, run/script/state/window/report hashes, complete flag, numeric failure list |
| `delete` | Requires the explicit execution switch, immutable successful report, and separate human approval file; preflight all objects, then recheck each source/target before removal | Counts, confirmed removal count, numeric failure list |

No image is downloaded from a stored public address. Addresses are parsed against an exact
privately configured root, then the object is found in metadata. Source and destination GETs
use the authenticated Storage endpoint with redirects disabled. Files outside the original
owner's screenshot namespace, duplicates within a row, ambiguous roots, query capabilities,
missing objects, malformed sizes, unsupported media types, and objects over the private
storage limit fail closed. Display order and original ownership are preserved.

Output never includes object names, object IDs, owner IDs, feedback IDs, addresses, bucket
values, database locations, credentials, provider error bodies, or raw exception messages.
Failure lists contain only stable numeric inventory entry numbers. Run identifiers and
hashes identify a private receipt without exposing its storage location. A top-level refusal
prints only `{"failed":true}` and exits nonzero; detailed private investigation is a separate
authorized operator action. Invalid inventory numbers describe an incomplete scan; do not
treat its partial counts as a migration approval.

## Private runtime inputs

Provision runtime files in an existing mode-0700 operator directory outside every Git checkout,
owned by the operator. Files must be regular, non-symlink, mode-0600 files. The script rejects
runtime files in a checkout and checks directory ownership and permissions. Do not paste
deployment values, inventory, images, credentials, or addresses into source control, issues,
PRs, chat, shell arguments, or test logs.

Set these environment variables privately, without enabling shell tracing:

- `GUGU_LEGACY_CONFIG`: absolute path of a private JSON configuration file.
- `GUGU_LEGACY_ENV_AUTH`: absolute path of an independently human-approved environment authorization.
- `GUGU_LEGACY_DATABASE_URL`: administrative database connection for the authorized installation.
- `GUGU_LEGACY_STORAGE_KEY`: the matching installation's server Storage credential.

The configuration has these keys; this guide deliberately supplies no deployment values:

| Key | Meaning |
| --- | --- |
| `environment` | Explicit `local`, `staging`, or `production` classification, matched against the independent grant |
| `installationId` | Opaque UUID from the approved installation inventory, matched against the independent grant |
| `sourceBucket` | Explicit legacy source storage identifier; must currently be public |
| `targetBucket` | Must equal the installed feedback validator's actual reference target, which must be private and different |
| `publicRoot` | Exact historical public object root, including its storage identifier and trailing slash |
| `storageRoot` | Direct Storage API root for this installation, without a trailing slash |
| `maxBytes` | Positive integer at most 5242880, matching the installed destination limit |
| `maintenanceWindow` | Explicit operator assertion `true`, required for every non-statistical mode |
| `maintenanceId` | Opaque identifier for the approved, continuously enforced maintenance window |

Every mode, including the default statistics mode, requires a separate environment grant
**before importing the database driver or opening any database/Storage connection**. The grant
must be a distinct private regular file, not the configuration file, a symlink, a hard link to
that configuration, or a command-line flag. The runtime configuration and maintenance assertion
alone never authorize an environment. Missing grants, wrong identifiers/fingerprints, wrong
script hashes, and unapproved modes are refused before connecting.

The independently provisioned environment authorization contains these fields:

| Field | Required value or meaning |
| --- | --- |
| `schema` | `1` |
| `kind` | `gugu-legacy-environment-authorization` |
| `environment`, `installationId` | The independently approved environment classification and inventory UUID |
| `fingerprint` | Independently approved exact runtime mapping digest produced by `environmentFingerprint(config, databaseUrl)` |
| `scriptSha256` | Human-approved SHA-256 of this complete script file |
| `databaseIdentitySha256` | Digest of the approved database cluster system identifier, database name, and database OID, in that order as strings |
| `feedbackValidatorSha256` | SHA-256 of the exact approved installed validator function body (`pg_proc.prosrc`) |
| `modes` | Explicit approved subset of `dry-run`, `migrate`, `report`, `delete` |
| `approvedBy` | Human environment approver identifier |
| `productionApproved` | Must explicitly be `true` for any production connection, including statistics; otherwise production is refused |

The human environment approver must obtain the classification, installation identity,
database identity, endpoints and validator hash from independently authorized installation
records and approved backend source. Do not infer staging from an HTTPS endpoint, let this
tool discover an unapproved endpoint, or generate an approval from untrusted runtime settings.
These fields describe an external human grant; the script does not issue one or authenticate
a human signature. Its enforcement binds the supplied grant to the exact connection mapping
and operation. The environment grant does not replace the later numeric deletion approval.

The mapping digest covers the environment classification, installation UUID, explicit database
host/port/name/user, permitted TLS option, both API roots, both storage identifiers, and size
limit. Database URL query parameters that could override host, port, user, database or options
are rejected; only a single supported `sslmode` is accepted. Passwords are excluded from the
digest. After the authorized connection, the first query compares the approved database identity
with `pg_control_system()` and the current database name/OID, before any inventory or Storage
operation. The administrative connection must have permission to read that identity; absence
of that permission fails closed, with no weaker fallback.

The active feedback trigger must call the approved validator function. Its exact installed
body must match the independently approved hash. The script resolves the reference target
from the validator's object lookup, blob registration, and fallback lookup, requires all three
to agree, and rejects any configured destination mismatch. Every destination existence check,
upload and read uses that bound target. Readback and deletion recheck the active contract,
including immediately before removal; a correct copy in some other private store cannot
authorize deletion when the reader's actual object is corrupt. Unknown or changed validator
semantics require review and a new grant, not a guessed destination.

Remote API roots require HTTPS. The database and Storage credentials must belong to the same
installation; their correspondence remains an operator prerequisite, not something an HTTP
status alone proves. A fingerprint binds the journal to the approved mapping. There are no
default installations, endpoints, storage identifiers, credentials, or environment approvals.

The private journal contains row/object IDs, source names, expected metadata/row digests,
content lengths and hashes, and deletion progress. It contains no image bytes, credentials,
or complete public/signed addresses. Keep it private; numeric failures can be resolved only
against this journal. Writes use mode 0600, fsync, atomic rename, and directory fsync. The
initial inventory and reports are exclusive creations. Do not edit a journal to bypass a
failure, change its inventory, or mark missing sources as deleted.

## Establish the maintenance window

A human assertion is a prerequisite, not an automatically verified fence. Before `migrate`,
keep the inventory's source/destination objects and relevant feedback stable. Before `report`
and throughout approval and `delete`, freeze operations that can reference, overwrite or
remove these objects, related account erasure, and parallel migration/cleanup. Keep the deployed
feedback validator and reader storage mapping unchanged during this window. Stop relevant
collector scheduling and wait for already claimed workers and in-flight HTTP requests to
finish. Freeze only the affected scope when its completeness can be established; otherwise
do not proceed. Read-only feedback/support access may continue.

The script's database session lock excludes another instance of this tool. Its additional
quota session lock prevents subsequent collector claims, but **does not** stop already
claimed workers, feedback reference creation, account erasure, or administrative Storage
writes. It is not evidence of a drained maintenance window. It can also block unrelated
quota RPCs; keep the window short and do not call dependent RPCs from another connection
while holding it. No object/blob/feedback row lock or table write barrier is held across
a Storage HTTP operation. The only feedback row transaction is the short compare-and-swap
update after copying, using the installed validation/registration triggers.

There is no targeted claim API in this contract. This tool never calls the global claim
function, takes a batch and discards unrelated work, creates collector leases, or changes
`deleting`/`running` state. Ordinary delayed collection belongs to the existing consumer.
The optional direct public-source cleanup here is a separately approved maintenance action.

## Operator sequence (not authorization to execute)

The following commands use only operator-chosen private file paths. Supply environment
values through the approved private mechanism. The variable names refer to absolute private
paths, not storage addresses. No command is executed by this documentation or by installation.

```sh
# Statistics only; never downloads image content.
node scripts/migrate-legacy-feedback.mjs

# Only after the approved maintenance window is established and drained.
node scripts/migrate-legacy-feedback.mjs migrate --state "$MIGRATION_STATE"

# Separate readback; use a fresh immutable report filename for every new report.
node scripts/migrate-legacy-feedback.mjs report \
  --state "$MIGRATION_STATE" --report "$MIGRATION_REPORT"
```

Migration chooses one deterministic private name per original object and owner. It saves the
source digest before a possible upload, uses create-only uploads, and verifies an existing
destination rather than overwriting it. Every object's length and SHA-256 must match before
any feedback row is changed. Each row switches private paths and clears old addresses in one
short transaction, only if its original owner/reference snapshot is unchanged. A row already
switched to exactly the intended paths is accepted on restart. Changed/deleted rows are
preserved and cause failure; the tool never recreates feedback. The installed trigger owns
blob registration, locking and collector checks. A `deleting` blob is an error, never reset.

Send the numeric readback report to the approving human. Require `complete: true`, no failed
numbers, and verified private counts/bytes equal to the inventory. The report separately counts
sources still verified and sources already removed after a recorded delete intent; both
object and byte subtotals must sum to the inventory. The approving human independently
checks the installed script SHA-256, the run/report hashes, exact row/object/byte counts, and
maintenance window. The human then provisions a separate mode-0600 approval JSON with:

```text
schema: 1
run: exact report run identifier
scriptSha256: human-approved SHA-256 of the complete script file
reportSha256: exact printed report hash
maintenanceSha256: exact report window hash
rows: approved numeric feedback row count
objects: approved numeric distinct object count
bytes: approved numeric total bytes
approvedBy: human approver identifier
maintenanceWindow: true
```

These are field descriptions, not an approval template with preapproved values. The script
cannot authenticate a human signature: an operator creating this file is asserting the human
decision. Its checks bind that decision to the exact script, inventory, report, numbers, and
window. Obtain the independent decision outside the tool. A changed script requires review
and a new run; never patch a journal to accept a new hash. If the window was released, establish
a new window, generate a new readback report, and obtain approval for that new report.

```sh
# Still disabled unless BOTH the human approval and explicit execution switch are supplied.
node scripts/migrate-legacy-feedback.mjs delete \
  --state "$MIGRATION_STATE" --report "$MIGRATION_REPORT" \
  --approval "$MIGRATION_APPROVAL" --execute-delete
```

Before the first removal the tool rechecks all private bytes and row mappings, all source
versions and bytes, all remaining references through `identity.storage_object_is_referenced`,
and absence of other legacy feedback. It repeats object checks immediately before each
removal. These checks do not make the cross-database/Storage operation atomic: the externally
enforced maintenance window is essential. Remaining non-feedback references retain the source
and fail this deletion run; the tool does not force-remove shared media or weaken that check.

Only the fixed source inventory can be removed, through Storage API, one object at a time.
The destination is never removed. A delete intent is durably saved before HTTP removal;
source metadata disappearance and an authenticated GET returning an explicit `NoSuchKey`
semantic 404 are checked before recording completion. The deployed Storage v1.60.15 wraps
that semantic 404 in HTTP 400; generic HTTP 404, permission errors, missing storage containers,
and server errors do not count as absence. Empty successful API
responses alone are not completion. Public caches and downstream copies are outside this
tool's control; coordinate any cache policy through the installation's authorized operator.
The tool does not rewrite historical issues; old embedded images may cease loading.

## Restart, failure and retention

For interrupted copying, use the same script, configuration and `--state`. Existing correct
destinations and already switched feedback are reverified without a second upload. For a
partial deletion, rerun `delete` with the same approved report and window. A source missing
after a persisted delete intent is reconciled; an unexplained missing source or a replacement
at its old name fails. A changed source, destination, mapping, remaining reference or window
requires investigation and, where applicable, a new report and human approval. After an
interrupted deletion, `report` can reconcile recorded intents/completions in a newly established
window: it verifies all private bytes, remaining source bytes, and explicit absence of each
recorded removed source, then reports both subtotals for fresh human approval. Deletion stops
at the first object failure. Keep the journal even after success.

The state sidecar lock is exclusive and records only the local PID. Graceful exit releases it.
After a process or machine crash, first prove the recorded process has exited on the original
host and that no operator is using the same state; only then remove that specific stale lock
file and resume. Do not reuse a state directory across hosts or automatically reap a live or
uncertain owner. Journal atomic writes protect restart state; unreferenced private copies are
kept for investigation, not removed speculatively.

Rollback preserves private evidence and authenticated readers. It never restores public
addresses, republishes bytes, or disables the private deletion guard. Keep source copies until
the readback report has been read and the separate destructive action approved. Retain private
journal/report/approval files under the installation's operational retention policy, and keep
only aggregate receipts in ordinary chat/issues.

## Offline verification and deferred rehearsal

```sh
node --test tests/installation/legacy-feedback-migration.test.mjs
```

The tests use synthetic bytes, generated identifiers and in-memory database/Storage doubles.
They exercise metadata-only inventory, parser gates, wrong approvals, conflicting targets,
compare-and-swap failures, restart without repeated uploads, readback corruption, remaining
references, a crash after remote deletion, the wrong-private-target/reader-corruption counterexample,
and refusal of unauthorized or mismatched environments before any connection. They are not real Storage/database integration
evidence. The release owner must separately arrange a disposable owned-fixture rehearsal of
copying, trigger registration, HTTP removal, maintenance isolation, interruption recovery and
the authorized owner/support reader paths before approving any real data operation.
