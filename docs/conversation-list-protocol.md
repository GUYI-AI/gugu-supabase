# Personal conversation-list state

List visibility is a personal account fact, separate from membership, history authorization and Agent lifecycle. Desktop and mobile consume the same server state. This protocol does not deploy a client or a backend.

## Hide a row

Call `chat.hide_my_conversation(p_chat_id text, p_operation_id uuid)` as an authenticated human member. Generate the operation UUID once when the person submits the action, and retain it through transport retries. A new deliberate action uses a new UUID.

The response contains `chat_id`, `operation_id`, `hidden_at`, `account_revision` and `already`. `account_revision` is a decimal **string**, not a JavaScript number. `already` records whether the row was hidden when this operation first executed. Retrying the same operation returns its original receipt, including its original revision; it does not hide a row which a later message restored. Reusing the UUID for a different chat is a conflict.

The RPC supports DMs, groups and topics without requiring group administration. It writes only the caller's `conversation_hidden_at` in the closed `conversation_list_state` table, never in a peer-readable membership row. Anonymous access, other-person writes, Agent callers and direct API updates of this field are denied. The optional removal of an owned Agent is a separate lifecycle operation; a failure there does not roll back hiding.

Existing permanent `conversation_deleted_at` records are not converted or automatically restored. The legacy `delete_my_dm_conversation` entry retains its DM receipt shape; future calls use temporary hiding. Legacy clients lack operation UUIDs and revision-aware restoration and must not be presented as supporting this new cross-device protocol.

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

The lock order is explicit. A hide first reuses the existing owner-erasure lifecycle guard, then takes its operation-key advisory lock, identity and chat parent `KEY SHARE` locks (covering both private tables' foreign keys), and then only its own account revision head. After that head it only writes private state/receipt rows and publishes its own revision: it never calls the roster publisher or locks other accounts. Chat `KEY SHARE` permits message sequence/preview `NO KEY UPDATE`, and waits before the head for management's `FOR UPDATE`.

Existing message publishers retain their device/chat/member admission and globally sorted chat+source account-head order. Restoration locks that complete head set before updating only existing private state; it takes no new chat `FOR UPDATE`/`NO KEY UPDATE` or membership locks after the heads. Native first publication also takes that owner-erasure guard before device, identity and chat FK parent locks before its ledger/inbox/member admission; it completes the inbox update before restoring. No visibility barrier is added to nested management, topic, file, project-file or handoff paths. The owner-erasure guard prevents a private-row FK parent lock from meeting account erasure after it has already visited another chat/head. Private list state and hide receipts cascade with their owner/chat parents. Native publication evidence is owned by the human account and survives device unregister/re-register, Agent removal and chat removal; only actual owner-account erasure purges it. Current registered-device, Agent ownership and two-seat DM authorization are rechecked on every request; retaining an old identifier grants no access. A matching authorized tuple remains a duplicate. Real `remove_device` archives and detaches its Agent identities; those immutable removed identities cannot be rebound and their retries are denied. After device registration, a new Agent/chat cannot reuse the old key: it conflicts rather than publishing new activity or restoring visibility. Ordinary social archival remains separate.

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
