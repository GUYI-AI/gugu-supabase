# Personal conversation-list state

List visibility is a personal account fact, separate from membership, history authorization and Agent lifecycle. Desktop and mobile consume the same server state. This protocol does not deploy a client or a backend.

## Hide a row

Call `chat.hide_my_conversation(p_chat_id text, p_operation_id uuid)` as an authenticated human member. Generate the operation UUID once when the person submits the action, and retain it through transport retries. A new deliberate action uses a new UUID.

The response contains `chat_id`, `operation_id`, `hidden_at`, `account_revision` and `already`. `account_revision` is a decimal **string**, not a JavaScript number. `already` records whether the row was hidden when this operation first executed. Retrying the same operation returns its original receipt, including its original revision; it does not hide a row which a later message restored. Reusing the UUID for a different chat is a conflict.

The RPC supports DMs, groups and topics without requiring group administration. It writes only the caller's `conversation_hidden_at` in the closed `conversation_list_state` table, never in a peer-readable membership row. Anonymous access, other-person writes, Agent callers and direct API updates of this field are denied. The optional removal of an owned Agent is a separate lifecycle operation; a failure there does not roll back hiding.

Existing permanent `conversation_deleted_at` records are not converted or automatically restored. The legacy `delete_my_dm_conversation` entry retains its DM receipt shape; future calls use temporary hiding. Legacy clients lack operation UUIDs and revision-aware restoration and must not be presented as supporting this new cross-device protocol.

## Undo the current hide

The hide notice can call `chat.undo_my_conversation_hide(p_chat_id text, p_hide_operation_id uuid, p_operation_id uuid)`. Retain the undo operation UUID through retries. Its durable receipt includes both operation IDs, `restored`, the current `hidden_at` and a decimal-string `account_revision`.

Undo only restores a row when the referenced hide actually hid it and remains its latest hide intent. A fresh deliberate hide invalidates older undo actions even if the row was already hidden. A newer clear, restoration/new message or hide is never reversed by an older notice. An unchanged authorized state returns `restored: false`; denied access, an unknown hide or changed retry parameters remain errors. Retrying a completed undo returns its original receipt without overriding later state. History floors, membership, read cursors, notifications and Agent lifecycle are unchanged. Only the authenticated person's checked RPC is exposed; the intent marker and undo receipts remain private.

## Publish a native personal message

Ordinary personal Agent messages can live in a native transcript without a `chat.messages` row. Their host calls:

```text
chat.publish_native_conversation_message(
  p_device_id text, p_agent_user_id text, p_session_id text,
  p_message_id text, p_chat_id text, p_occurred_at timestamptz
)
```

The owner, registered device, Agent and two-seat personal DM must match. Session/message identifiers are deduplication keys, never authorization credentials. This RPC does not copy message bodies or change notification/read rules.

At the first durable admission of a real personal input or reply, persist a publication UUID and an outbox item atomically with that message. Retain that UUID through streaming, finalization, provider aliases, local turn renumbering, process restart and network retries. Preserve the original message timestamp. Do not generate IDs by reading/replaying history, launching a task, or observing heartbeat/status changes. A job ID alone cannot identify several messages within a job.

The server deduplicates `(device_id, session_id, message_id)`. First publication returns `already: false`; a matching retry returns `already: true` without restoring again. Changing the Agent, chat or original timestamp under the same key is a conflict. The response includes the current decimal-string account revision.

Only new live personal inputs, replies directed to the owner, and explicit owner notifications enter this outbox. Group-delivery work, background tasks, historical imports/replay and repeated stream fragments do not create a new personal publication.

## Ordering and projection

Server transaction order decides whether a row is hidden. A delayed offline live message first published after hiding restores it, even if its original message time is earlier. A message published before hiding cannot restore it again through an outbox retry. Message timestamps and client clocks do not decide this order.

Chat-message insertion and native publication call the same restoration function inside their publishing transactions. The canonical `is_pending_delivery` predicate excludes both `notAdmitted` and `undelivered` status rows before restoration.

The lock order follows the installed deferred revision protocol. Hide and clear first share the existing owner-erasure lifecycle guard, then take their operation-key lock and identity/chat FK parent locks before the shared chat-line lock and private state. Message restoration takes that same line lock and updates only existing private rows. Native first publication completes its device, identity, chat and inbox admission before restoring. No early account-head lock or new visibility barrier is added to management, topic, file or handoff paths.

Ordinary publishers continue staging revisions until commit. These personal RPCs need a durable revision in their synchronous operation receipt: after all admission, state writes and recipient discovery, their terminal step flushes the complete staged recipient set in sorted user order. The deferred trigger and this terminal receipt step share one internal implementation; neither invents a new event or changes existing payloads. After this step only the already-admitted receipt/activity rows are written, with their FK parents and line already held. The internal finalizer is closed to every API role. Native publication evidence survives device unregister/re-register, Agent removal and chat removal; only owner erasure purges it. Every request still rechecks current device ownership, Agent ownership and two-seat DM authorization; retained identifiers grant no access.

The private table has RLS and explicit `REVOKE ALL` for PUBLIC, anon, authenticated and service_role. Caller-checked SECURITY DEFINER display projection is the only API read path, including from the SECURITY INVOKER snapshot. A permission/transport/missing-dependency failure is an error; an explicit null from that authorized projection means not hidden. Personal writes publish only the affected person's revision wake, never an entire member row or a peer event. A visible topic message also restores its source for a reader entitled to that message, including a source member who has not joined the topic. Invisible whispers, imports, edits, read receipts and status changes do not restore rows.

The account journal and its existing Realtime wake publish caller-only list-state changes using the own-membership projection key. Existing member views and member-row broadcasts carry no personal list state. Snapshots retain hidden chats and their own membership state for addressability. `list_my_chats_as` and unread locators exclude hidden rows; hiding a source also excludes descendant topic contributions until the source is restored. Read cursors, historical unread facts, drafts and opened tabs are retained.

`list_conversation_memberships(p_chat_ids text[])` is a caller-scoped **display** projection. It can return an owned removed historical DM peer with `historical_only: true`; it does not make that identity an active member or grant message/file access. Other members' personal hide/delete timestamps are not returned. A missing dependency or a denied read must never be interpreted as an explicit hide.

Clients must merge hide receipts and authoritative membership values by account revision. A delayed hide HTTP response must not replace a newer cleared value. Keep hidden chats in the addressable directory; filter only list/badge presentation. Search, contacts and shared-file navigation resolve the original chat and still await their actual opening receipt.

## Verification and rollout

Use a disposable loopback database for installation, ACL/RLS, visibility, transaction ordering, retry, snapshot/revision, historical peer and byte-retention tests. Desktop/mobile product acceptance requires the same candidate protocol and backend version. A backend-only deployment or an unchanged older mobile client does not complete acceptance.

## Installed publisher audit

Restoration is attached to successful `chat.messages` INSERTs, rather than a caller allowlist. This covers direct authenticated inserts and `send_message_idempotent`; owner friend-message/file helpers; ordinary attachment, version, share and forward placement; project-file publication and handoff paths which delegate to those send helpers. The installed direct-insert producers were also checked: `announce_group_management`, `create_topic`, invitation decisions/member insertion, flood-rule notices, provisioning completion/legacy provisioning, and history import. Native personal publication is the sole non-INSERT path and calls the same restoration helper only on its first ledger insertion.

The shared rules still decide whether any given row counts. History import root/turn rows are excluded. The reaction-notification producer writes an Agent-only whisper, so the human visibility predicate does not restore a human list row. Ordinary read/reaction/status mutations without a new visible message do not restore; the two persisted pending-delivery markers are explicitly excluded. Existing file-send and topic-join lock-order regression suites remain unchanged and run in the full PostgreSQL 17 integration command.

The migration changes only the three named predecessor projections (`list_my_chats_as`, `sync_snapshot`, `list_unread_locators_for_chats`), preserving their signatures and ACLs. It does not rewrite management, topic creation, file, project-file or handoff functions to add a barrier or a late row lock. `active_members`, peer membership RLS and legacy member broadcasts remain unchanged because no private list column is added to their source row.

### Cross-member erasure lock order

`identity.erase_human_account` materializes its affected chat ID array once from the original live-membership predicate. Chat prelocks, physical member prelocks and the later management traversal all use that exact array: subsequent READ COMMITTED snapshots cannot expand it after heads have been published. It locks chats by chat ID, then their physical memberships by chat/user ID before its first mutation can publish any surviving peer revision. Its subsequent per-chat locks are reentrant. A concurrent invitation admitted after this snapshot is removed by the erased identity’s existing FK cascade; it does not add a late chat-row lock to the traversal. This prevents holding a peer head while requesting another chat row held by that peer’s hide. Hide still acquires FK parents before only its own head. The installed erasure body and ACL are preserved, with a single guarded admission prelude; the real two-DM erasure regression uses a fixture trigger without rewriting the production function.
