# Self-service account deletion

Final confirmation immediately hard-deletes the current account and forfeits
remaining usable credits. There is no cooldown, scheduled deletion or cancellation.
The generic identity channel belongs to this community backend; official billing
and its retained records remain outside this repository.

## HTTP contract

Prefix: `/functions/v1/account-deletion`. JSON responses use `Cache-Control: no-store`.
User routes require the current Bearer and a live matching Auth session. The
current confirmed email is read from Auth; body fields never select an identity.

| Method/suffix | Input | Result |
| --- | --- | --- |
| GET `/status` | Bearer | Availability, fixed immediate/forfeit consent version and active attempt |
| POST `/challenge` | Bearer, `consent_version: "immediate-forfeit-v1"` | Sends a fresh official email OTP; returns request and a secret receipt once |
| POST `/confirm` | Bearer, `request_id`, `receipt_token`, `consent_version`, `code`, `acknowledge_forfeit: true` | Immediately calls Auth Admin hard deletion; 200 only after absence readback |
| POST `/retry` | Bearer, same request/receipt | Bound retry of an already verified attempt within its original five-minute window |
| POST `/result` | Request/receipt capability, no login required | Minimal readback after deletion has removed the original session |

A receipt is random 256-bit capability material, stored only as its hash. Keep it
out of URLs, telemetry and logs. A 202 response means an uncertain in-flight
outcome, not a waiting period or completed deletion. A definite Auth failure is
503 with retry state; overlapping retries are refused and limited to three
attempts. Expired authorization requires a new code. Unsupported routes return404.

Official Auth `/otp` (`create_user=false`) sends a new code; `/verify` (`type=email`)
consumes it. The verified identity/email must match the original user and request.
The temporary verification session is immediately signed out locally and never
returned. A challenge expires five minutes after sending begins. Limits are one
send/minute, three/15min/user, five code attempts/request and ten/15min/user.
Changed emails, revoked sessions, stale consent and reused proofs fail closed.
An expired execution lease is not a failed deletion. A processing request remains
unconfirmed and blocks a new challenge or retry until its outcome is reconciled;
its result does not advertise `can_retry`. Only a definite `retry_wait` result
retains the original bounded retry authorization. Read the original capability
after a dispatch-recheck error: an HTTP error alone is not a cancellable workflow
terminal. Committed Auth absence takes precedence over an older failed/expired
classification. An orphaned processing operation whose account still exists
requires an authoritative recovery decision; this release does not invent a
timeout-based cancellation, background retry or recovery worker.
Reauthentication nonce is not used because its installed verification contract is
part of password updates. No password is changed and no custom OTP is generated.

## Retained messages and references

The existing Auth → identity erasure chain is reused. The following are its
existing physical-table effects; this PR does not add message or group deletion.

| Table | Existing erasure effect |
| --- | --- |
| `chat.messages` | Preserve rows, body, timestamps, replies, threads and file grouping; FK clears sender; remove erased IDs from recipients and per-user hidden markers |
| `chat.chats` | Preserve group rows; transfer owner to a surviving human or archive; creator becomes successor/NULL. Existing DM is renamed for the deleted peer |
| `chat.chat_members` | Cascade-delete erased human/owned-agent memberships; other memberships stay |
| `chat.message_agent_sends` | Delete erased owner's attribution rows; otherwise agent FK can become NULL; no message deletion |
| `chat.message_agent_wakes` | Cascade-delete erased agent's wake records; retain other recipients |
| `chat.message_agent_delivery_blocks` | Delete erased agent's blocks |
| `chat.message_deliveries` | Delete delivery records for erased agents' device identifiers; retain other receipts |
| `chat.message_reactions` | Cascade-delete erased identities' reactions; message stays |
| `chat.widgets` | Keep widget/message; clear `created_by` FK |
| `chat.session_attachments` | Private session delivery owned/sent by erased identities cascades; dead recipient-only grants are deleted, otherwise recipients are filtered. These are separate from group message attachments |
| `chat.workspace_items` | Shared file rows stay; clear creator/updater attribution under the existing erasure guard |
| `chat.workspace_item_versions` | Shared version history stays; maker FK becomes NULL |
| `chat.file_transfer_uploads` | Irreversibly anonymize actor/account attributes |
| `chat.file_transfer_storage` | Clear owner attribution |
| `chat.file_transfer_reservations` | Anonymize account reference |
| `chat.file_transfer_storage_refs` | Anonymize account reference |
| `chat.file_temporary_transfers` | Anonymize reader actor/account |
| `chat.group_tasks` | Keep task; erased owner/reviewer agent FK becomes NULL |
| `chat.group_outputs` | Keep output; producer FK becomes NULL |
| `chat.gugu_decision_events` | Remove erased per-user JSON keys and clear creator attribution |
| `chat.account_revisions` | Delete erased user's personal revision feed |
| `chat.account_revision_heads` | Delete erased user's revision head |
| `chat.presence_wake_throttles` | Delete erased viewer's throttles |
| `identity.gugu_device_commands` | Delete erased owner's/sender's commands; redact quoted sender IDs/names and filter recipient IDs on surviving commands |

The sender FK already anonymizes the author. A second forward release makes
`messages_view`, history, search and the agent inbox consistently say
“已注销用户” for a NULL sender; reply previews already do. It preserves all reader
columns, ACLs, invoker RLS, paging and authorization. Client rendering must also
show that label for a NULL author rather than suppressing the name/profile row.

Forfeiture means the removed account cannot consume its old balance. Historical
amounts remain anonymously retained under the existing accounting chain, so
revenue/consumption reconciliation does not change. No balance is transferred or
rewritten here. The UI reads its existing own-user `billing.user_credits` view,
selecting `balance_credits,credit_unit_version` with header
`x-gugu-credit-unit-version:2`; no new service-role financial read is added.

## Rollout, audit and verification

`account_deletion_private.access` is only a pre-release dedicated-account gate,
not a product-mode switch. It defaults to a closed test allowlist. Hard deletion
clears the allowlist FK, leaving other accounts closed; an authorized rollout can
remove that restriction. No cooldown/worker configuration exists.

The new workflow/audit state is private. Only the server role can execute its
RPC, not read/write its tables directly. Auth hard deletion and existing triggers
are one transaction. Trigger failure rolls them back; unknown HTTP outcomes are
reconciled before retrying. Original identity FKs, email digest and authorization
metadata are cleared on success. No original-to-accounting-tombstone map, OTP,
JWT, receipt or raw Auth/SQL error is logged.

Use an owned loopback fixture for installed-schema tests. Opt-in
`GUGU_TEST_EMAIL_OTP=1` enables only its local mail catcher/template.
`node scripts/test-account-deletion-http.mjs` exercises the exact handler over
loopback HTTP against real Auth/email/triggers, including failure rollback/retry;
it reports booleans/counts/times and is not a deployed Edge smoke test. Real
release acceptance must use Auth HTTP with the actual trigger owners/financial
grants. A SQL delete by a stronger role is insufficient. Shared branch testing
requires explicit approval; do not alter deployment pins during development.

## Review entry points

| Source | What to inspect |
| --- | --- |
| `_shared/account-deletion-auth.ts:31` | Auth `/user` validates the exact Bearer token before its session ID is decoded; SQL separately requires the live session. |
| `_shared/account-deletion-core.ts:74` | All mutating routes require that caller. `result` alone uses a hashed, unguessable receipt to read minimal status after login is deleted. |
| `_shared/account-deletion-core.ts:88` | Fresh challenge bound to the current confirmed email; consent and explicit forfeiture acknowledgment; official OTP identity comparison before execution. |
| `_shared/account-deletion-auth.ts:43` | Official `/otp` and `/verify`, with the temporary verification session revoked locally. No custom OTP implementation. |
| `20261115033000_self_account_deletion.sql:84` | Live Auth session, confirmed email, dedicated-account gate, five-minute authorization, rate limits, leases and bounded retries. Closing the gate also rejects already-verified retries. |
| `20261115033000_self_account_deletion.sql:48` | Clear workflow identity metadata on hard deletion. The final EXECUTE ACL is server-role-only; the private tables have no API-role grants. |
| `_shared/account-deletion-auth.ts:57` | The only account deletion call: server Auth Admin HTTP DELETE with `should_soft_delete:false`, followed by absence readback. The existing Auth trigger chain defines erasure scope. |
| `20261115033100_deleted_message_sender_label.sql:7` | Display projection only. No message/body/resource deletion is added; non-system NULL authors receive the deleted-user label. Original reader ACLs and senderless system behavior are preserved. |
| `config.toml:38` | This five-line entry disables the gateway's automatic JWT check for this function only, so post-deletion receipt readback can work. It does not disable the handler's live Auth checks or grant client service-role access. No worker route exists. |

The first migration adds workflow state, not a second erasure engine. The second
changes display text, not physical deletion scope. The physical table inventory
above describes the existing deletion chain reused by Auth.

## Controlled deployment and recovery

1. Merge reviewed, green sources to `dev`, then use the approved paired CD flow
   after the erasure-performance and financial-owner/permission prerequisites.
   The official deployment guard does not support an unmerged branch here. Only
   CD writes successful staging source pins; this validation does not edit pins.
   Install the outcome-reconciliation migration before the updated Edge handler:
   its internal `execute` recheck fails closed against an older workflow. An old
   handler can still finish an existing request, but must not be treated as proof
   that the new pre-dispatch recheck is deployed.
2. Installation leaves `test_only=true,test_user_id=NULL`: every ordinary user is
   closed. An authorized synthetic-account operator creates one new confirmed
   fixture through Auth Admin, with server-only app metadata
   `gugu_self_deletion_fixture=v1`. The email must be a disposable approved test
   inbox; no address, code or credential goes into reports or logs. User metadata
   supplied by a client is insufficient to mark a fixture.
3. The matching reviewed CD data-repair control `account-deletion-test:count`
   reads counts, `:rehearse` rolls the open script back, `:apply` permits exactly
   that one fresh verified server-marked account, and `:rollback` closes it.
   This control must be staging-only at both the dispatch and host boundaries.
   Until that control is available, keep the gate closed; do not substitute
   manual staging SQL, configuration edits or a general rollout activation.
4. Run the real deployed Edge challenge → receive the new email code → confirm
   with forfeiture acknowledgment → Auth Admin absence readback. Also check
   receipt idempotency, original-session refusal, the erased ID scan and the
   other-account negative control. Emit only booleans, counts and elapsed times.
5. Successful deletion removes the fixture and automatically clears its allowlist
   FK. Then execute CD `:rollback`, followed by `:count`: restricted gates must
   be 1, allowed accounts 0, live requests/active deletions 0, fixture candidates
   0. Confirm an ordinary account remains unavailable. Complete the mailbox
   claim and permanently remove that claimed account from its pool.
6. If validation fails while the account remains, reconcile any processing
   request first; closure refuses an unresolved deletion. CD `:rollback` then
   clears the allowlist and expires outstanding challenges/retries. Delete only
   the dedicated fixture through the authorized Auth path after the failure is
   understood; if that path is blocked, report it and keep the closed gate.
   Do not delete unrelated or pre-existing fixtures, bypass triggers or use
   stronger-role SQL as a substitute. Remove the mailbox from the pool on either
   outcome, and report any retained synthetic-account count without its email.

These are forward-installable additions; recovery closes the new entry rather
than rewriting installed migrations or rolling an old source tree over a newer
ledger. A staging deployment/pin change does not deploy production. Production
remains on its separately approved source pair. A later production deployment
would install the same default-closed gate; opening self-service for real users
requires a separately reviewed production rollout, not this staging-only test
control. No new Vault, SMTP, billing-rate or client financial permission is
introduced here.
