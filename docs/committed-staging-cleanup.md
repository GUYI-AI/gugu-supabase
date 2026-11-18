# Committed staging cleanup

Immutable upload staging and final blob collection have different lifetimes.
Registering a blob is not publication: a subsequent message/file commit may fail.
An expired signed upload permit and an absent HEAD response also do not prove that
an upload accepted earlier cannot complete late. Published uploads require both a committed
publication for that exact staging key and trusted terminal provider evidence.

The publication transaction now records a durable private cleanup marker. Sweeping
the short upload receipt does not remove the marker. The worker deletes only
evidenced staging keys, confirms physical absence, then uses the existing upload
closure function to release its staging reservation. It never deletes final blobs
or changes final-file retention, readers or authorization.

Declared messages can precede their bytes. Registration and publication therefore
record the marker in either order. A resumed upload is bound to its original
publication by the verified settle transaction; equal content alone never creates
that relationship. Existing resumed uploads without this retained relationship
remain subject to the independent historical evidence requirements below.

The same staging worker also accepts verified physical issuance windows for expired managed uploads. Publication markers, lease, five-key limit, retries and settlement are shared. See [managed upload closure](file-transfer-budgets.md#establishing-the-closure-boundary) for scoped reports, backup and restore.

## Controls and retries

The control is disabled by default. The database grants one global run lease and
one claim of at most **five** objects per invocation. The worker processes them
sequentially with real abort signals and an overall time budget. An HTTP `limit`
field cannot change the database bound. A single-batch run needs explicit keys,
turns admission off as it starts and cannot consume unrelated queued objects.

Known failures keep the reservation and retry with exponential backoff, beginning
at 30 seconds and capped at one day. The periodic kick runs every ten minutes only
while explicitly enabled. Lost transport/confirmation responses retain the run
lease; another invocation cannot immediately start duplicate work. Expired claims
can be recovered after the lease interval. No response loss is reported as deletion.

Service-only routes below use the existing attachments service authentication:

| Route suffix | Request | Result |
| --- | --- | --- |
| `staging-cleanup-status` | `{}` or `{keys:[...]}` | Counts and control state only |
| `staging-cleanup-evidence` | Exact upload identity, permit expiry, terminal time/digest; historical publication time/digest when needed | `{recorded:boolean}` |
| `staging-cleanup-configure` | Explicit `enabled`, `single_batch`, optional exact `keys` | Counts and control state only |
| `staging-cleanup` | `{}` | Admission, claim, deletion, failure and uncertainty counts |

Evidence digests identify a protected, independently obtained provider export;
inventing a digest or using a shared content hash is not evidence. The trusted
importer must establish that all accepted writes under the permit are terminal.
Historical uploads whose publication receipt was swept also require independent
proof of successful publication for that exact staging key. These conditions are
revalidated by the database. Evidence cannot be changed after admission.

## Historical dry run

`scripts/staging-cleanup-plan.mjs` defaults to offline planning. It reads only two
bounded private JSON exports (mode 0600), writes an exclusive mode-0600 plan and
prints counts/digest. It has no storage calls or configuration changes in this mode:

```sh
node scripts/staging-cleanup-plan.mjs --snapshot private-snapshot.json \
  --evidence private-evidence.json --out private-plan.json
```

`scripts/staging-cleanup-snapshot.sql` provides a bounded read-only export for the
historical inventory, through the existing authorized export channel. Redirect its
single JSON result to a mode-0600 file. It uses retained publication receipts and
therefore deliberately reports swept historical receipts as lacking publication
proof. It does not synthesize evidence from a successful blob registration.

The snapshot shape is `{schema:1,kind:'staging-cleanup-snapshot',at,uploads:[...]}`.
Each row contains `staging_key`, `reservation_id`, `blob_id`, `permit_expires_at`,
`reservation_state`, `staging_deleted` and `publication_committed`.
The proof packet is `{schema:1,kind:'staging-cleanup-trusted-evidence',entries:[...]}`.
Each proof contains the same key/reservation/blob/expiry, `terminal_at` and
`terminal_sha256`, with `publication_sha256`/`publication_at` for historical rows.
Timestamps are UTC strings; expiry strings must use the same exported precision.
Empty proof packets are valid and produce blocked counts rather than guesses.

The default plan selects five eligible objects. A reviewed plan is bound to its
canonical SHA-256. `--apply --plan ... --confirm ...` is a separate explicit path
for an authorized CD execution; credentials come only from its protected runtime
environment, never arguments or output. It submits evidence, scopes a single
batch to the reviewed keys, then reads completion back independently. Mutations
are not automatically retried after an uncertain response.

Enablement and historical deletion require the ordinary deployment approval and
CD path. Do not use the script as a manual production exception. The kick reuses
the existing attachments GC dispatch configuration; no credential is created by
this change. Without trusted terminal/publication exports or dispatch configuration,
keep admission off and report the blocked counts. Deploying this code alone does
not prove that historical objects are safe to delete or that cleanup ran.
