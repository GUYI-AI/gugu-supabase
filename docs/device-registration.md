# Atomic device registration

`identity.register_gugu_device(p_device jsonb)` returns one JSON object with
`device_id` and `created`. Only `authenticated` can execute it. Identity comes
from `auth.uid()`, never a payload owner. The caller must be a live human Auth
principal. `created` is true only for the transaction that inserts the row.

Required nonempty strings are `device_id`, `machine_id`, `tier`, `hostname`
and `platform`. `label` is a required string that may be empty: an empty label
on a new row takes the platform default name (`Linux 1`), and an existing row
keeps its stored name. `capabilities` is an object. `session_digest` is an
optional array; omitting it on an existing row preserves the stored digest.
`reserve_only` is an optional boolean, default false. Owner, timestamps, status,
custom-label markers and Auth session IDs are not accepted from the caller.

Registration resolves `(auth.uid(), machine_id, tier)` atomically. Existing
rows keep their primary key, owner, machine, tier, creation time, custom label
and all agent/project/command/file references. Full registration refreshes
metadata and marks the row online. Invoker rights preserve owner RLS and the
restrictive team policy; the existing machine-limit, removal, lease, label and
revision triggers remain active.

`reserve_only=true` must supply `capabilities.host_kind` (`desktop`, `server`
or `phone`), with only optional empty `terminals`/`runtimes` arrays. A nonempty
digest or other capabilities are refused. An existing tuple is locked and
returned without any UPDATE. A missing tuple is inserted offline with only
those initial capabilities. This is not a machine-limit exemption. An unused
server reservation retains its total-machine slot until the owner removes it;
the existing seven-day offline rule releases only its remote tunnel slot.
There is no new TTL deletion or automatic rekeying.

Clients must reserve before publishing runtime capabilities, caching identity,
or joining device-specific channels. They then adopt the returned ID at that
startup boundary and perform full registration. An unexpected ID change while
already bound is a client failure, not permission to silently switch channels.

Phone IDs remain `phone-<installationId>-<auth.uid()>`. A malformed phone ID,
or an existing phone tuple with a different ID, fails with
`P0001 / PHONE_DEVICE_ID_CONFLICT`, leaving the old row unchanged.

Other fixed messages are `42501 / DEVICE_REGISTRATION_FORBIDDEN`,
`22023 / DEVICE_REGISTRATION_INVALID`, and
`P0001 / DEVICE_REGISTRATION_SCOPE_CONFLICT`. PostgREST returns its ordinary
error response and rolls back the RPC. No successful error envelope, bare
upsert fallback, primary-key replacement or caught-23505 success exists.
Existing machine-limit/removal errors remain errors with their existing shape.

A read-only classifier in the unexposed `device_private` schema checks a
candidate's global ID binding and principal liveness without returning any
other owner's data. It accepts no owner parameter. The public registration
function remains SECURITY INVOKER for all DML. The classifier is not an
additional client identity-resolution endpoint.

The forward release is `20261116121500`; no installed migration is edited.
Removing the new API before updating its consumers makes them fail explicitly;
deploy the backend before pinning clients to this contract.

## Client consumers and remaining boundary

- `packages/core/src/cloud/deviceRuntime.ts`: shared desktop and server path.
- `apps/desktop/src/mobile/phone-device/phoneDeviceRuntime.ts`: phone WebView.
- `apps/mobile/runtime/phone-agent-host.mjs`: Android service's Node host.
- `apps/mobile/ios/Host/GuguIOSCloudBroker.swift`: separate native iOS path,
  tracked by client issue #2866 and not changed by this backend PR. Until that
  client follows the RPC it can still encounter the original raw-upsert error.

The backend tracks #309 and the consuming client tracks GUYI-AI/gugu#2863.
Real-database tests include independent concurrent connections, reservations,
phone conflicts, owner/tier isolation, retained references, custom labels,
RLS, removal and machine limits. Client startup/channel adoption and deployed
acceptance remain separate; source changes do not prove deployment.
