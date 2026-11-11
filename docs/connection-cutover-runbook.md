# Connection cutover runbook

Operator procedure for `scripts/platform-connection-cutover.mjs`; the design is in
`connection-authority-cutover.md`. Needs releases `20261111100000_connection_authority_cutover`
and `20261111130000_connection_cutover_rehearsal_followups`.

## Production order

1. Deploy the backend (both releases). The version policy stays OFF.
2. Deploy gugu-cloud (revoke grant and platform-credential guard, pinned to this backend).
3. Dry-run the tool over the full owner list (no `--apply`).
4. Review the report: every `kept-legacy`, `failed` and `stranded` account against the
   table below. Remove accounts that must stay legacy from the list.
5. Apply for one test account: a list holding only that owner, with `--apply`.
6. Verify it: report `switched` with no code; `identity.connection_authority()` as that
   owner is owner/1/stable; its connections on a real device; no
   `integrations.credentials` rows; `identity.connection_unknown_outcomes(owner)` empty.
7. Apply for the list. Rerunning is safe: switched accounts report `already-owner`.

Every run needs a new `--output` path and an `--operator` ID (recorded per switch).

## Report

Top level: `operator`, `dryRun`, `startedAt`, `finishedAt`, and `summary` (`accounts`,
`switched`, `already-owner`, `eligible`, `kept-legacy`, `failed`, `not-attempted`,
`stranded`). Per account: `readAt`, `switchedAt` or `failedAt`, `plan` (`native` or
`import`), `before`/`after` head, `inventory` (`connections` {live, retired, revoked},
`catalogs`, `markers`, `operations`, verified bodies, `manifestHash`), `removedAssistants`
(`importedTombstones`, `supersededTombstones`, `excludedRows`, `excludedOperations`),
`platformCredentials` (official overlay only), `code` and, for database refusals, `sqlstate`.

Exit 0: every account switched, already owner or eligible, nothing stranded. Exit 2: any
other account result or a stranded account. Exit 1: the run itself failed; stderr holds
one code and the report holds `error.code`.

## Codes

`CONNECTION_CUTOVER_` is omitted below. Unless noted the account stays legacy (`kept-legacy`).

| Code | Meaning | Operator |
|---|---|---|
| `ACCOUNT_UNAVAILABLE` | Owner missing, not a human, or removed | Drop from the list |
| `AUTHORITY_CHANGED` | Head quiescing, or it changed during the run | Rerun later |
| `ALREADY_OWNER` | Switched concurrently; preparation is closed | None; a rerun reports `already-owner` |
| `PLATFORM_CREDENTIAL` | Platform-held credentials (`platformCredentials`) with no owner mapping yet | Exclude until the cloud mapping ships |
| `STRANDED_PLATFORM_CREDENTIAL` | `switched`/`already-owner`, but `integrations.credentials` rows exist outside the owner snapshot | Stop applying; find the writing client; revoke via the platform path |
| `NO_LEGACY_ASSISTANT` | Legacy data but no live provisioned assistant | Leave legacy; needs a product decision |
| `AMBIGUOUS_ASSISTANT` | More than one live provisioned assistant | Leave legacy until one is removed, then rerun |
| `SEVERAL_ASSISTANTS` | Another live agent holds account rows or unfinished changes | Leave legacy until that agent is removed, then rerun |
| `UNFINISHED_OPERATIONS` | Pending or failed legacy changes of the assistant | Let the device come online and drain; rerun |
| `UNSCOPED_ROWS` | A row without a device, or under a device the owner no longer owns | Leave legacy |
| `COLLECTION_NOT_READY` | No ready collection marker, its count differs, or no legacy control row | Owner opens the client on that device once; rerun |
| `BODY_SOURCE_REQUIRED` | Bodies needed but no `--bodies-from-storage`/`--bodies-dir` | Rerun with one |
| `CONNECTION_BODY_*` (full code) | A referenced body cannot be read, or is too large | Check storage settings and rerun; if it persists, leave legacy |
| `CONNECTION_AUDIT_*` (full code) | The export fails the audit (hash, rows, metadata, limits) | Leave legacy; investigate the account |
| `TOO_LARGE` | Over 2000 rows or operations, or 16 MiB | Leave legacy |
| `SOURCE_CHANGED` | Legacy rows changed after the audit; rolled back | Rerun |
| `CANDIDATE_CHANGED` | The staged candidate differs from the audit or the source; rolled back | Rerun (it prepares again) |
| `LEGACY_DATA` | Native switch found legacy data, or a candidate lacks its digest | Rerun |
| `LOCK_TIMEOUT` | Lock (250 ms) or statement (2 s) timeout; rolled back | Rerun later |
| `UNVERIFIED` (`failed`) | The switch committed but the head read back differs | Stop; inspect the head and `connection_authority_switches` |
| `FAILED` (`failed`, with `sqlstate`) | Unexpected error; the run stops, later accounts `not-attempted` | Stop; investigate before rerunning |
| `DATABASE_CONNECTION_LOST` (`failed`) | Session lost mid-run; earlier accounts stay committed | Rerun the same list |
| `DATABASE_UNREACHABLE` (exit 1) | No connection at all; nothing ran | Check the URL and network |
| `OPERATOR_REQUIRED`, `INVALID_ARGUMENTS`, `DATABASE_REQUIRED`, `INVALID_OWNERS`, `DUPLICATE_OWNERS`, `CONNECTION_AUDIT_FILE_TOO_LARGE` (exit 1) | Invalid invocation or owner list (over 64 KiB); nothing ran | Fix and rerun |
| `REPORT_EXISTS`, `REPORT_UNWRITABLE` (exit 1) | `--output` exists or cannot be created | Use a new path |
| `CONNECTION_BODY_STORAGE_*` (exit 1) | Incomplete storage settings for `--bodies-from-storage` | Fix the environment |

## Unknown outcomes

`SELECT * FROM identity.connection_unknown_outcomes(NULL)` (maintenance role) lists every
operation stuck in `CONNECTION_OUTCOME_UNKNOWN` with owner, operation and admission IDs,
scope, resource, admitted and reported times, and the repair function:
`connection_resolve_unknown_outcome` (native) or `connection_record_takeover` (imported).

## Rollback

```sh
psql -X -f ops/rollback-owner-connection-api.sql                  # dry run: checks, then ROLLBACK
psql -X -v apply=1 -f ops/rollback-owner-connection-api.sql       # commit
psql -X -v apply=1 -f ops/regrant-owner-connection-api.sql        # reopen exactly the eight grants
```

Rollback prints how many accounts are in owner mode and refuses to apply while that is
non-zero (exit 3) unless `-v force=1`: those owners lose connection management until the
regrant. Nothing returns an account to legacy and no data is deleted. The gugu-cloud
counterpart is its own `ops/rollback-integration-operation-revoke.sql`.
