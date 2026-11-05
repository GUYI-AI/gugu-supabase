# Durable assistant panel state

The assistant panel reads saved account data independently of an execution host.
Today and diary retain their existing chat-folder document. Other domains use
`identity.assistant_panel_items`; committed edits also create ordered records in
`identity.assistant_panel_changes`. These tables are private to the signed-in
owner and the marked personal assistant. They do not start a device or model turn.

This release supplies the backend contract. Runtime application and desktop/mobile
readers are separate changes; installing it alone does not migrate an existing
assistant's files or change the interface.

## APIs

All functions below are in the `identity` schema. Only `authenticated` can call
them. The owner comes from `auth.uid()`, never a request field. Table access is
SELECT-only with RLS; internal helpers and direct writes are closed to clients.

| RPC | Arguments | Result |
| --- | --- | --- |
| `assistant_panel_snapshot` | `p_assistant` | `{version:1, revision, items, application}` from one database snapshot; excludes revoked and retired observations; an unprepared account has no collection marker; pending/failed mutations identify the affected resource without copying its body |
| `assistant_panel_resource` | `p_assistant`, `p_domain`, `p_resource_key` | `{version:1, item}` for a known key, including revocation/retirement state and a precise version; `item:null` means that key has never been stored |
| `assistant_panel_commit` | `p_assistant`, UUID `p_operation_id`, `p_domain`, `p_resource_key`, bigint `p_expected_revision`, `p_operation`; optional `p_data`, `p_body_item_id`, `p_body_sha256`, `p_device_id`, `p_runtime_instance_id` | `{operationId, revision, status}` after atomically committing the resource and its application record |
| `assistant_panel_notice` | `p_assistant`, `p_notice` | Durable metadata-only notice for an App edit already saved by its owning service; no desired-state row, execution command or message is created |
| `assistant_panel_pending` | `p_assistant`, `p_runtime_instance_id` | `{revision, changes, notices}`; changes include failed mutations requiring application; notices use a separate, non-blocking channel |
| `assistant_panel_ack` | `p_assistant`, `p_runtime_instance_id`, `p_operation_id`; optional `p_error_code` | Item-specific receipt; mutation failure blocks admission, while unsuccessful notice delivery remains pending without blocking anything |
| `assistant_panel_admit` | `p_assistant`, `p_runtime_instance_id`, `p_expected_revision` | `{admitted:true, revision}` only when the head still matches and all preceding panel changes have been applied; otherwise identifies the pending item or raises a version conflict |

Revisions in JSON results are decimal strings. An absent resource has expected
revision `0`. A stale expected revision returns SQLSTATE `PT409` (HTTP 409); retain the draft
and re-read before editing. An operation ID retry with the identical request
returns its existing receipt. Reusing the ID for different input is rejected.
Receipts are retained for 30 days after application or supersession; automatic
retries must keep the same ID and remain within that interval. Resource versions
and permanent tombstones continue to reject stale replay after receipt expiry.

The operation is `save`, `remove`, `enable`, `disable`, `prepared` or `error`.
Enable/disable accept an existing schedule/integration and no replacement data;
they preserve the current prompt, schedule, body and other metadata. Remove
accepts no content. A removed stable resource ID remains revoked; a late import
cannot republish it even if it supplies the tombstone's current version.
Each new commit marks older pending/failed changes for the same resource
`superseded`. Only the newest desired state requires application; a corrected
schedule or a deletion can therefore recover from an obsolete failed save.
Acknowledging a superseded operation returns that status without changing it.

## Data and preparation

Supported domains are `tasks`, `schedules`, `memory`, `personality`,
`integrations`, `voice-notes`, `capabilities`, `device-notes`, `files` and `skills`.
The migration contains each domain's metadata field allowlist. Integration data
contains account display/authorization metadata, never credentials or nested
configuration. Credentials stay in the existing encrypted store.

Collection markers use `__collection__`, or `__collection__:<device ID>` for an
individual device. Only the actual runtime publisher can submit `prepared` or
`error`. A prepared marker requires `{state:"ready", schemaVersion:1, itemCount}`
whose count matches all non-deleted, non-retired resources in that collection. A failed source
uses `{state:"error", schemaVersion:1, errorCode}` and leaves existing items intact.
No marker means not yet prepared, not a successfully read empty collection.
Paths in resource metadata must be normalized relative paths, without absolute
roots, drive prefixes, backslashes, percent escapes, control characters or dot
segments. The runtime must additionally resolve them inside its own resource root
and reject symbolic-link escapes; database validation is not a filesystem check.
Names/groups are bounded display labels, not filesystem locations. Note/provider
IDs use a bounded identifier grammar. Runtime handlers must constrain every
identifier they use in a path to the appropriate host-owned resource root.

The snapshot and pending APIs return complete data or an explicit response-budget
error; they never truncate a collection and present the remainder as absent.
Snapshot reads never create an initialization row or enqueue a wake command.
Metadata is limited to 256 KiB per item; larger content uses a file body. Every
resource commit checks the complete snapshot and required-change representations
against a 16 MiB budget, reserving room for failure codes. Notices are entirely
outside these write budgets; their separately bounded channel cannot make a
required resource write fail. Pending reads enforce 16 MiB for required changes
plus the independent bounded notice channel.

## Bodies and deletion

Large text and audio use existing file uploads into the exact owner/personal
assistant private DM. Commit a complete stored `file` object and its SHA-256;
the hash must match `chat.file_blobs`. Other chats, collaboratively mutable
documents and references already assigned to another panel resource are refused.
Today remains a collaborative document and is not subject to this file-body API.

A published body ID is immutable: changing its blob in place or deleting it from
the private folder is rejected while a current/history reference exists. Upload
a new object and atomically commit its reference instead. Failed uploads or
uncommitted objects continue through the existing file cleanup mechanisms.

Removal atomically writes the tombstone/application record and deletes all body
objects previously published for that resource through the existing authorized
workspace deletion API. Any deletion failure rolls back the complete operation.
Deleted body text is never copied into the removal record; it retains only the
resource/device and the paths or account IDs needed for local cleanup. All older
change payloads for that resource are scrubbed in the same transaction, including
inline personality text, schedule prompts and body references. File
storage bytes continue through existing retention and garbage collection.

The runtime must delete local originals, memory-index references and retrieval
caches, reject reads of revoked files and append a structured committed-change
notice before the next request. It preserves native conversation context and its
prefix; this protocol does not reset sessions or erase historical chat messages.
Compact tombstones remain for the lifetime of the assistant and disappear with
account deletion. They are excluded from complete reads and response budgets;
a publisher probes each known local key before uploading, using the exact
resource API to enforce revocation and obtain its version. Repeated removal of
an unapplied tombstone preserves the previous removal's original cleanup routing.
Up to 100 terminal receipts are pruned per mutation after 30 days;
pending/failed intent never expires. Unreferenced historical body files
are deleted through the existing authorized file API before their last history
reference is pruned. Each receipt has its own cleanup subtransaction: any cleanup
error retains only that receipt for a later attempt, allows other eligible
receipts to be cleaned, and cannot roll back an application acknowledgement.
Failed attempts record their last cleanup time and rotate behind untried
receipts, so a permanently failing first batch cannot starve later cleanup.
Parent-chat deletion can still cascade through referenced bodies, following the
existing workspace guard's administrative cleanup semantics.

## Writers, failure and admission

Panel commits do not require a runtime. Runtime publication supplies a current
`runtime_instances` lease owned by the account. Assistant-owned data requires the
assistant's assigned device; device/task metadata can originate from its actual
owned device. Non-home device metadata is currently read-only in the panel:
mutation is rejected until a corresponding per-device applier exists. Notices
about changes already saved elsewhere are informational and need no remote effect.
A still-live publisher cannot be replaced by another instance.
Expired, unowned or revoked assistant bindings are rejected. A runtime cannot
overwrite a resource with an unapplied panel change.
Assistant-owned domains follow the currently assigned home after adoption;
their former publisher's device ID cannot prevent a new home from publishing
either fresh content or an explicit read-failure marker. Device-scoped resources
remain bound to their actual publishing device.
On adoption, former-home observations and preparation markers are marked retired
and withdrawn from complete panel reads. Unapplied owner intent instead follows
the new home, including its cleanup routing. A fresh current-home publication
can replace a retired key.

The notice API accepts the existing App change fields (`operationId`, `resource`,
`operation`, `id`, optional owned `deviceId`, `section`, `before`, `after`). Both
summaries use a strict scalar-field allowlist, and the whole notice is limited to
16 KiB. It rejects bodies, prompts, credentials and arbitrary nested configuration.
Notices use a separate `notice` namespace with an encoded resource/key pair;
they cannot fence publication or supersede a mutation. Newer pending notices for
the same informational key replace obsolete notices. Notice writes do not advance
the admission version. Home execution attempts to append and acknowledge notices
separately. Their acknowledgements have no ordering dependency, unsuccessful
delivery never becomes `failed`, and pending notices do not block admission.
At most 64 pending notices are retained per assistant, for at most seven days;
older hints are superseded and their payloads scrubbed on the next mutation or
pending read. Required owner intent does not expire. Runtime publication always
assigns its actual lease device, including when replacing a retired observation
without an explicit device argument.
Clients persist retries for post-save notices themselves; saving an already
persisted App edit is not contingent on a live host acknowledgement.

The per-assistant control row serializes all commits, acknowledgements and
admission. Revisions are allocated after acquiring the lock, so sequence order
cannot skip a smaller, not-yet-committed change. Readers see the previous complete
state until the transaction commits. A private `assistant_panel_changed` event on
the existing owner user-events bus hints that readers should re-fetch, including
application receipts that do not change the desired-state revision; events are
not the durable mutation queue and never constitute a new assistant task.

Before ordinary messages or scheduled work enter the assistant, the runtime reads
pending changes, applies them idempotently and acknowledges successful effects in
order. It must wait for real local success before acknowledging. After brief
bounded retries, failure is recorded using a non-sensitive uppercase error code;
admission remains blocked and identifies the domain/resource that needs attention.
The saved desired value is retained. A crash between a local effect and its
acknowledgement is handled by verifying/reapplying the same operation ID.

Finally call admission with the observed head revision. A concurrent earlier edit
requires another application pass; an edit committed after admission is an
in-turn App change handled at the existing tool boundary. No API here delivers a
chat message, wakes a host, or acknowledges actual model execution.
