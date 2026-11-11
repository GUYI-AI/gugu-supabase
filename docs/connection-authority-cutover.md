# Connection authority cutover

Tracking: #238, GUYI-AI/gugu#1922. Release `20261111100000_connection_authority_cutover`
adds the only legacy-to-owner writer, opens the owner RPCs to signed-in owners and
makes them refuse every account it has not switched. Legacy tables, rows, policies,
function definitions and ACLs are unchanged. The version policy stays OFF.

## Owner RPC access

The eight owner RPCs (snapshot, resource, recreate_begin, commit, commit_batch,
pending, admit, ack) are granted EXECUTE to `authenticated` only, in the same
transaction as the guard. Writes, admission, acknowledgement and platform revocation
go through `connection_owner_lock`, which refuses (`55000`) any account without an
owner head: no head, a legacy head or a prepared candidate. Owner writes never
initialize an account, so nobody switches themselves by calling them directly.
Snapshot/resource return `not-ready` for those accounts and pending refuses them
(installed definitions patched in place, one anchored condition each).

`connection_prepare_import` is patched the same way: it now takes the policy and
authority locks before the head, assistant and control rows (the cutover's order),
and refuses (`55000`) once the head is owner or natively initialized. Re-preparing
replaces the candidate tables, which after the switch are the owner's live rows.

## `identity.connection_authority_cutover(text,bigint,text,text,text) RETURNS jsonb`

Arguments: owner, expected authority epoch, operator ID, and either both or neither
of the audited source digest and manifest hash. Maintenance role only. The caller
sets `statement_timeout`/`transaction_timeout` ≤ 2 s and `lock_timeout` ≤ 250 ms.

- Native (no digest): no prepared candidate and no legacy connection data
  (`connection_has_legacy_data`: integrations account rows, tombstones or unfinished
  operations under any assistant; catalogs and collection markers do not count).
- Import: the prepared, not yet handed-over candidate with that digest and manifest; a
  live inventory with the same digest and source revision; zero unfinished legacy
  operations; no legacy rows under any other assistant (`55000`, e.g. tombstones kept
  from before a reinstall); every staged row in `platform` or `device:<a device the
  owner owns>` (`55000`; `legacy:unknown` could never be written again); staged rows
  equal to the live legacy rows, tombstones included.
- Both: mode legacy, the expected epoch, phase stable. One UPDATE writes owner,
  epoch + 1, stable and `native_initialized_at`, and one row goes into
  `identity.connection_authority_switches` (path, digest, manifest, operator,
  database role). Any difference raises (`PT409` drift/repeat, `55000` not eligible)
  and rolls back everything. There is no function back to legacy.

It returns the `connection_authority()` DTO and sends `connection_changed`
(`{revision, scopeKey:null, resourceKey:null, authorityEpoch}`).

## `identity.connection_resolve_unknown_outcome(text,uuid,text,text,text,text) RETURNS jsonb`

Maintenance only, for a native (not imported) operation whose current admission was
acknowledged `CONNECTION_OUTCOME_UNKNOWN`. Arguments: owner, original operation UUID,
outcome (`applied`, `failed`, `not-started`), SHA-256 of the external evidence,
operator ID, and an error code only for `failed`. One record per unknown admission in
`identity.connection_unknown_outcome_resolutions` (RLS on, no API grants). `applied`
completes, `failed` stays terminal, `not-started` makes the same UUID admissible.
Receipts and items are never rewritten. Repeating the identical decision for the
same admission returns its receipt; a later unknown admission needs a new decision.

## `scripts/platform-connection-cutover.mjs`

```sh
node scripts/platform-connection-cutover.mjs --database-url-env NAME --operator ID \
  --owners /private/task/owners.txt --bodies-from-storage \
  --output /private/task/cutover-report.json            # add --apply to write
```

The owner list is a JSON array or one UUID per line (`#` comments), at most 500, run
one account at a time. Per account: read state and the complete legacy inventory,
fetch referenced bodies server-side, audit, then with `--apply` prepare and cut over
in a bounded transaction. Reports `kept-legacy` with a code, never forced: platform-
held credentials with no platform mapping yet (`PLATFORM_CREDENTIAL`; the official
overlay also refuses the switch), unfinished operations, no or several provisioned
assistants, rows under several assistants, rows outside an owned scope, a collection
that is not ready, or a body that cannot be fetched or verified. Switched accounts
report `already-owner`, so rerunning is safe.

`--bodies-from-storage` reads only files in the owner's private DM with their
assistant (the legacy commit's rule): Storage via `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY`, `oss` rows via `OSS_REGION`, `OSS_BUCKET`,
`OSS_ENDPOINT_PUBLIC`, `OSS_ACCESS_KEY_ID`, `OSS_ACCESS_KEY_SECRET`
(+ `ATTACHMENTS_OBJECT_PREFIX`). `--bodies-dir` reads `<body UUID>` files instead.
Every byte is checked against the recorded SHA-256.

The report is claimed (exclusive create, mode 0600) before the database is touched;
an existing file is refused. It holds the operator, owner IDs, before/after
mode/epoch, counts, manifest hashes and stable codes; never credentials, body text,
object names or raw database messages. Stdout has counts only. Exit 0: every account
switched, already owner or eligible; 2: some stayed legacy; 1: the tool failed.

## Order, checks and rollback

Deploy with the backend while the version policy stays OFF, then the gugu-cloud
grant and guard. Drain legacy HTTP/OAuth effects, dry-run the list, switch the test
account and verify it on a real device, then apply the named list. After each run,
count `integrations.credentials` rows of switched owners: an old client can still
save a platform credential there, outside the owner snapshot. `ops/rollback-owner-
connection-api.sql` closes the eight RPCs; switched accounts then cannot manage
connections, and nothing returns them to legacy. No data is deleted by either.
