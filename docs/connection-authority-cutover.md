# Connection authority cutover

Tracking: #238, GUYI-AI/gugu#1922. Release `20261111100000_connection_authority_cutover`
adds the only legacy-to-owner writer, opens the owner RPCs to signed-in owners and
makes them refuse every account it has not switched. Legacy tables, rows, policies,
function definitions and ACLs are unchanged. The version policy stays OFF. Release
`20261111130000_connection_cutover_rehearsal_followups` makes reinstalled owners
switchable and gives the refusals stable codes. Operator steps: `connection-cutover-runbook.md`.

## Owner RPC access

The eight owner RPCs (snapshot, resource, recreate_begin, commit, commit_batch,
pending, admit, ack) are granted EXECUTE to `authenticated` only, in the same
transaction as the guard. Writes, admission, acknowledgement and platform revocation
go through `connection_owner_lock`, which refuses any account without an owner head
(no head, a legacy head or a prepared candidate). Owner writes never initialize an
account, so nobody switches themselves by calling them directly. Snapshot/resource
return `not-ready` for those accounts and pending refuses them (installed
definitions patched in place, one anchored condition each). Expected refusals are
`PT409` (HTTP 409) with DETAIL `{errorCode, feature:"connection-management"}`:
`CONNECTION_AUTHORITY_NOT_OWNER` (not switched), `CONNECTION_AUTHORITY_QUIESCING`,
and `CONNECTION_AUTHORITY_SWITCHED` for a legacy integrations write after the switch.

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
  operations; every staged row in `platform` or `device:<a device the owner owns>`
  (`55000`; `legacy:unknown` could never be written again); staged rows equal, both
  ways and with each row's assistant, to the rows the import rule selects.
- Import rule: the source is the owner's single provisioned assistant that is not
  removed (two: `55000` ambiguous). Its rows are imported, plus account tombstones of
  removed assistants for keys the source lacks (the latest wins), so revocations
  survive a reinstall. Removed assistants' live rows and unfinished changes are not
  imported, only counted (`removedAssistants`). Another live agent with account rows
  or unfinished changes keeps the account legacy (`55000`). The head revision is the
  higher of the control revision and the newest imported row.
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
in a bounded transaction. Anything not eligible stays legacy with a code, never
forced. Switched and already-owner accounts with `integrations.credentials` rows
(an old client can still save there, outside the owner snapshot) are reported as
stranded and exit 2. Codes, exit status and the production order:
`connection-cutover-runbook.md`.

`--bodies-from-storage` reads only files in the owner's private DM with their
assistant (the legacy commit's rule): Storage via `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY`, `oss` rows via `OSS_REGION`, `OSS_BUCKET`,
`OSS_ENDPOINT_PUBLIC`, `OSS_ACCESS_KEY_ID`, `OSS_ACCESS_KEY_SECRET`
(+ `ATTACHMENTS_OBJECT_PREFIX`). `--bodies-dir` reads `<body UUID>` files instead.
Every byte is checked against the recorded SHA-256.

The report is claimed (exclusive create, mode 0600) before the database is touched;
an existing file is refused. It holds the operator, owner IDs, timestamps,
before/after heads, counts, manifest hashes and stable codes; never credentials, body
text, object names or raw database messages. Stdout has counts only.
`ops/rollback-owner-connection-api.sql` (dry run by default) closes the eight RPCs and
`ops/regrant-owner-connection-api.sql` reopens them; nothing returns an account to
legacy and no data is deleted.
