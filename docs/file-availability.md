# File availability metadata

Workspace list, search, recent, detail, version history, and `file_resolve_as`
append `availability` and `expired_at`. Existing columns and resolver `status`
remain unchanged. Existing temporary-request and download paths that forward a
resolver result also retain these additive metadata fields; their authorization,
status and budget behavior is unchanged. A reader can render an unavailable file before opening it.

| `availability` | Meaning |
| --- | --- |
| `available` | This version has a valid cloud or device source. |
| `expired` | No valid source remains and an elapsed retention deadline is recorded. |
| `deleted` | Reserved for explicit file/version deletion evidence. |
| `unavailable` | No valid source is known, without enough evidence to identify the cause. |

`expired_at` is a UTC timestamp only for `expired`; otherwise it is null.
It is separate from the existing cloud-copy deadline fields. JSON RPC responses
use timestamps; clients may map the snake-case field to `expiredAt`.

A device-held version remains available while its device is offline. Its device
must exist and its project must still be bound to the room, or be a device store.
An expired temporary cloud copy does not override that valid source. Historical
versions are evaluated independently. Folders and database documents remain
available to authorized readers.

The predicates use recorded metadata. They never sign a URL, reserve a download,
extend retention, or probe a device/object store. A storage object confirmed gone
without an expiry record is `unavailable`, not an invented expiry or deletion.
Existing records do not establish a distinct deliberate-deletion cause, so this
release does not emit `deleted` from those records. Existing expiry records also
do not identify the person or operation that caused a cloud release.

The original readers retain authorization, pagination, ordering, defaults, and
their old fields behind closed implementation functions. The new predicates and
implementation functions are not callable by API roles. Unreadable references
retain their old refusal and reveal no additional cause or timestamp.

Clients encountering an older server without these fields should keep their
existing display behavior rather than treating a missing field as expiry.
