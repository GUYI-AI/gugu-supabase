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
