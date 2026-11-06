# Personal conversation-list state

List visibility is a personal account fact, separate from membership, history authorization and Agent lifecycle. Desktop and mobile consume the same server state. This protocol does not deploy a client or a backend.

## Hide a row

Call `chat.hide_my_conversation(p_chat_id text, p_operation_id uuid)` as an authenticated human member. Generate the operation UUID once when the person submits the action, and retain it through transport retries. A new deliberate action uses a new UUID.

The response contains `chat_id`, `operation_id`, `hidden_at`, `account_revision` and `already`. `account_revision` is a decimal **string**, not a JavaScript number. `already` records whether the row was hidden when this operation first executed. Retrying the same operation returns its original receipt, including its original revision; it does not hide a row which a later message restored. Reusing the UUID for a different chat is a conflict.

The RPC supports DMs, groups and topics without requiring group administration. It writes only the caller's `conversation_hidden_at`. Anonymous access, other-person writes, Agent callers and direct API updates of this field are denied. The optional removal of an owned Agent is a separate lifecycle operation; a failure there does not roll back hiding.

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

Chat-message insertion and native publication call the same restoration function inside their publishing transactions. A visible topic message also restores its source for a reader entitled to that message, including a source member who has not joined the topic. Invisible whispers, imports, edits, read receipts and status changes do not restore rows.

The account journal and its existing Realtime wake publish personal membership changes. Snapshots retain hidden chats and their own membership state for addressability. `list_my_chats_as` and unread locators exclude hidden rows; hiding a source also excludes descendant topic contributions until the source is restored. Read cursors, historical unread facts, drafts and opened tabs are retained.

`list_conversation_memberships(p_chat_ids text[])` is a caller-scoped **display** projection. It can return an owned removed historical DM peer with `historical_only: true`; it does not make that identity an active member or grant message/file access. Other members' personal hide/delete timestamps are not returned. A missing dependency or a denied read must never be interpreted as an explicit hide.

Clients must merge hide receipts and authoritative membership values by account revision. A delayed hide HTTP response must not replace a newer cleared value. Keep hidden chats in the addressable directory; filter only list/badge presentation. Search, contacts and shared-file navigation resolve the original chat and still await their actual opening receipt.

## Verification and rollout

Use a disposable loopback database for installation, ACL/RLS, visibility, transaction ordering, retry, snapshot/revision, historical peer and byte-retention tests. Desktop/mobile product acceptance requires the same candidate protocol and backend version. A backend-only deployment or an unchanged older mobile client does not complete acceptance.
