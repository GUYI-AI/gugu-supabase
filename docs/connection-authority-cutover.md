# Connection authority cutover

Tracking: #238, GUYI-AI/gugu#1922. Release `20261111100000_connection_authority_cutover`
adds the only legacy-to-owner writer, opens the owner RPCs to signed-in owners and
makes them refuse every non-owner account. Legacy tables, rows, policies, function
definitions and ACLs are unchanged. The version policy is not touched (stays OFF).

## Owner RPC access

The eight owner RPCs (snapshot, resource, recreate_begin, commit, commit_batch,
pending, admit, ack) are granted EXECUTE to `authenticated` only (not PUBLIC, `anon`
or `service_role`), in the same transaction as the guard, so no legacy account can
write the owner tables at any point:

- Writes, admission, acknowledgement and platform revocation go through
  `connection_owner_lock`. A legacy-mode head (prepared or not) is refused with
  `55000`. An account with no head and no legacy connection data
  (`connection_has_legacy_data`: integrations account rows, tombstones or unfinished
  operations; catalogs and collection markers do not count) is initialized natively
  as owner, epoch 1, stable, and a `connection_changed` hint is sent.
- `connection_snapshot`/`connection_resource` return `not-ready` for a legacy-mode
  head and `connection_pending` refuses it. Their installed definitions are patched
  in place (one anchored condition each), keeping OIDs, owners and other grants.

## `identity.connection_authority_cutover(text,bigint,text,text) RETURNS jsonb`

Arguments: owner, expected authority epoch, and either both or neither of the
audited source digest and manifest hash. Maintenance role only; closed to every API
role. The caller must set `statement_timeout` and `transaction_timeout` to at most
2 s and `lock_timeout` to at most 250 ms first. Locks, in the same order as every
guarded management write: shared policy advisory lock, the owner's
`gugu:connection-authority:` advisory lock, the owner head row, then (import only)
the assistant row and the legacy control row.

- Native (no digest): requires no prepared candidate and no legacy connection data.
- Import (digest + manifest): requires a prepared, not yet handed-over candidate with
  that digest and manifest, a live legacy inventory with the same digest and source
  revision, zero unfinished legacy operations, and staged rows that equal the live
  legacy integrations rows exactly (tombstones included).
- Both: mode legacy, the expected epoch, phase stable. One UPDATE then writes owner,
  epoch + 1, stable and the handover timestamp (`native_initialized_at`). Any
  difference raises (`PT409` drift/repeat, `55000` not eligible) and rolls back the
  whole transaction; the account stays legacy. A second cutover is refused.

It returns exactly the `connection_authority()` DTO, e.g.
`{"version":1,"mode":"owner","epoch":"1","phase":"stable","acceptingNewOperations":true}`,
and sends `connection_changed` with `{revision, scopeKey:null, resourceKey:null,
authorityEpoch}` so online clients re-read. There is no function back to legacy.

## `identity.connection_resolve_unknown_outcome(text,uuid,text,text,text) RETURNS jsonb`

Maintenance only. For a native operation (not imported legacy; those keep
`connection_record_takeover`) whose last admission was acknowledged
`CONNECTION_OUTCOME_UNKNOWN`. Arguments: owner, original operation UUID, outcome
(`applied`, `failed`, `not-started`), SHA-256 of the external evidence, and an error
code only for `failed`. The decision is recorded once per unknown admission in
`identity.connection_unknown_outcome_resolutions` (RLS on, no API grants) with the
maintenance role. `applied` completes the operation, `failed` keeps it terminal with
the given code, `not-started` makes the same UUID admissible again. The admission
receipt and items are never rewritten. Repeating the identical decision returns the
original receipt; a different one is refused.

## `scripts/platform-connection-cutover.mjs`

```sh
node scripts/platform-connection-cutover.mjs --database-url-env NAME \
  --owners /private/task/owners.txt --bodies-from-storage \
  --output /private/task/cutover-report.json            # add --apply to write
```

The owner list is a JSON array or one UUID per line (`#` comments allowed), at most
500, run one account at a time. Per account: read state and the complete legacy
inventory; fetch referenced body files server-side; audit; then with `--apply`
prepare the candidate and call the cutover in a bounded transaction. Accounts with
no legacy connection data take the native path. Accounts with unfinished legacy
operations, legacy data but no provisioned assistant, several assistants, a
collection that is not ready, or a body that cannot be fetched or verified are
reported `kept-legacy` with a code and are never forced. Already switched accounts report `already-owner`, so rerunning is safe.

`--bodies-from-storage` reads only files in the owner's private DM with their
provisioned assistant (the rule the legacy commit enforced), with the attachments
function's variables: `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for Storage, and
`OSS_REGION`, `OSS_BUCKET`, `OSS_ENDPOINT_PUBLIC`, `OSS_ACCESS_KEY_ID`,
`OSS_ACCESS_KEY_SECRET` (+ `ATTACHMENTS_OBJECT_PREFIX`) for `oss` rows on OSS.
`--bodies-dir` reads pre-downloaded `<body UUID>` files instead. Every byte is checked
against the recorded SHA-256 before use.

The report is created exclusively with mode 0600. It holds owner IDs, before/after
mode/epoch, counts, manifest hashes and stable codes; never credentials, body text,
object names or raw database messages. Stdout has counts only. Exit 0: every account
switched, already owner or eligible; 2: some stayed legacy; 1: the tool failed.

## Order and rollback

Deploy this release with the rest of the backend while the version policy stays OFF,
then the matching gugu-cloud grant. Drain legacy HTTP/OAuth effects for the listed
accounts, dry-run the list, switch the test account and verify it on a real device,
then apply the named list. `ops/rollback-owner-connection-api.sql` still closes the
eight owner RPCs; switched accounts then cannot manage connections, and nothing
returns them to legacy. No data is deleted by either.
