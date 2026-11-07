# Optional APNs transport

This worker consumes the community backend's existing account revision stream.
It does not create identities, messages, task execution or background Agent work.
The service is opt-in and is not installed or deployed by a client release.

It sends **visible alerts** for unread incoming DMs, addressed group/topic
messages and owned Agents entering `needs_user`. It rechecks canonical message
visibility, membership, read cursors, mutes and task state before sending.
Completion, error and online transitions alone do not notify. Generic alert
text contains no message body, contact name, task prompt or file URL.

## Client contract

Call the identity schema RPCs through the existing authenticated backend client:

```text
mobile_push_register(
  p_installation_id uuid,
  p_device_id text,
  p_token text,
  p_environment text,
  p_topic text,
  p_chat_enabled boolean,
  p_task_enabled boolean,
  p_sound_enabled boolean
) -> { registration_id: UUID, generation: UUID }

mobile_push_revoke(
  p_installation_id uuid,
  p_registration_id uuid,
  p_generation uuid
) -> boolean
```

The owner and login session come from the verified JWT. Both must still exist
and belong to a live human account. Installation identity is the existing
native UUID, and the device ID is exactly
`phone-${installationId}-${ownerId}`, with UUIDs in canonical lowercase form.
Notification registration does not require enabling the phone Agent host or
inserting a device heartbeat. It must not advertise host availability.

The supported topic is `app.gugu.chat`. Environment is `sandbox` or
`production`; use the environment of the actual signed build. The token is
lowercase hexadecimal made from the complete native token bytes, with no
assumption of a 32-byte token. The protocol input limit is 4096 hexadecimal
characters. Tokens are sensitive and must never enter application logs.

Register only after the user grants notification permission and a matching
owner session is available. Re-register after token, preference or login
changes. An identical registration is idempotent and preserves its generation;
rotation/preferences change its generation. An installation changing login
sessions receives a new registration ID and starts at the current account
revision, rather than replaying old notifications. Another account cannot
move an installation binding without presenting its current APNs token.

Before clearing credentials, revoke the exact returned registration and
generation. `true` means that exact binding was removed; `false` is **not**
confirmation that a newer binding was revoked. A network failure must remain
visible/pending rather than being reported as a successful revoke. Deleting
the Auth session also deletes its token registrations. Guard all asynchronous
registration callbacks by the current owner and installation epoch. Clearing
local credentials alone while offline cannot revoke a server registration.

The visible APNs payload has `aps.alert`, optional `aps.sound = "default"`, and:

```text
gugu: {
  v: 1,
  notificationId: UUID,
  ownerId: UUID,
  installationId: UUID,
  registrationId: UUID,
  generation: UUID,
  kind: "chat_message" | "task_attention",
  revision: decimal-string,
  chatId?: string,
  messageId?: string,
  agentId?: string
}
```

Validate owner, installation, registration and generation before presenting or
navigating. A tap opens the normal application path and reconciles canonical
state with the current login; it never executes a device action from the
payload. Foreground presentation must honor the existing on-screen/notification
preferences and use one OS notification outlet with the local message consumer.
Remove delivered notifications on logout. Already admitted/in-flight APNs
requests cannot be recalled by the revoke RPC; their text is deliberately generic.

## Delivery and failure semantics

Each installation consumes the existing `message_created` and `presence_changed`
events using a durable cursor. No account revision event is added or changed.
Message IDs deduplicate repeated publications. Task attention compares adjacent
canonical `needs_user` readings and detail changes, following the existing
client policy. An earlier wait is suppressed if a later state already left it.

Reservations and one-time admission commit **before** network I/O. Worker
restarts, duplicate admissions and uncertain results never replay a reservation.
This matches the client's existing commit-before-notify rule: a crash may lose
an alert, but must not create repeated OS side effects. Explicit APNs refusals,
including throttling, are also terminal for that event. Opening/foreground
reconciliation, rather than notification delivery, is authoritative recovery.

Preparation locks the exact current registration through a bounded request;
revoke and token rotation serialize with that admitted request. A lost DB
connection can end that lock before an in-flight network request ends, so
neither session deletion nor revoke promises recall of an already admitted
request. Token generation and registration time guard invalid-token cleanup.
`410 Unregistered` uses Apple's invalidation timestamp; confirmed
`BadDeviceToken`/`DeviceTokenNotForTopic` use the request start time, only for the
explicitly configured environment/topic. Provider authorization failures do not
delete device tokens. No sandbox/production fallback is attempted.

APNs `200` is recorded as `accepted`, **not** as proof of OS presentation.
Requests use HTTP/2, ES256 authentication, `alert`, priority `10`, expiration
`0`, and a stable notification/collapse ID. No `content-available` or silent
background execution is provided.

## Operator configuration

Apply the reviewed releases through the normal backend installation/deployment
process. Existing migrations are not rewritten. The presence lookup index is
a separate concurrent-index release to avoid blocking message writers.

Use Node 24.14.0 and the repository's pinned pnpm installation. The worker uses
the existing root `pg` dependency and Node's built-in HTTP/2/crypto modules:

```sh
node services/push/src/main.mjs
```

Explicitly provide these environment variables through the deployment secret
mechanism; none has a credential or deployment default:

| Variable | Meaning |
| --- | --- |
| `GUGU_PUSH_ENABLED` | Must equal `1` |
| `GUGU_PUSH_DATABASE_URL` | Dedicated operator-provisioned database login |
| `GUGU_APNS_ENVIRONMENT` | `sandbox` or `production` |
| `GUGU_APNS_TOPIC` | `app.gugu.chat` |
| `GUGU_APNS_TEAM_ID` | Signing team's identifier |
| `GUGU_APNS_KEY_ID` | Explicitly supplied APNs key identifier |
| `GUGU_APNS_PRIVATE_KEY_PATH` | Explicit read-only mount of the supplied `.p8` |

The migration creates the non-login `gugu_push` role. Provision a dedicated
login with membership in that role and no unrelated privileges; the worker
explicitly uses `SET ROLE gugu_push`. The role has only the transport RPCs and
cannot read token tables, messages or task state directly. Do not use the
database owner, the file service login or a production credential for tests.

The provider reads only the configured key path. Never discover old signing
keys, commit a key, or include one in evidence. Logs contain only notification
IDs/outcomes; failures do not dump database or HTTP/2 request objects. The
worker has no public HTTP endpoint. Supervise it as a separate opt-in process
with secret mounts and bounded shutdown; no deployment is performed by this PR.

## Verification boundaries

`pnpm test:push` runs synthetic keys/tokens against real **loopback HTTP/2** and
injected providers. These tests do not contact APNs. The normal integration
suite runs `mobilePush.test.ts` against an installed disposable loopback
foundation to exercise ownership, revocation, canonical notifications and
concurrent reservations. Never use a shared or production database for it.

Staging acceptance additionally needs the reviewed migration, supervised worker,
explicit supplied key/team/topic/environment and a matching signed physical
device. Record provider acceptance separately from actual visible delivery,
foreground suppression, logout/account-switch behavior, tap reconciliation and
expired-token cleanup. Local notifications and fixtures do not satisfy that
acceptance. Production promotion is a separate authorized operation.

Protocol references: [APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
[responses](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns),
[token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).
