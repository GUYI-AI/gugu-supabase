# Private device preparation dependency and Android bridge contract

This is an unwired, default-closed source increment. It depends on the shared
operation core; it does not implement or edit that core, its HTTP routes,
confirmation intents, native receipt generation or account deletion.

## Fixed dependency order

| Layer | Source / requirement |
| --- | --- |
| Unknown outcome | Account-deletion outcome reconciliation, checked source `76390aa6f1e30c7244872a71d87735180aefd5a6` |
| Shared operation core | Forward migration `20261116233000`; operations.id UUID, original user_id/session_id, state, confirm_started_at; owned separately |
| Device increment | `20261116233100`; installation refuses if the operation table is absent |
| Android/desktop consumers | Same original owner/SID/local operation; no permanent remove_device in preparation |

The operation core acquires account-deletion account lock -> operation row ->
needed request/confirmation rows before calling device helpers. The shared core
first holds original Auth user/session KEY SHARE NOWAIT locks to avoid reversing
an Auth-FK wait chain; busy is not cancellation. Child-row contention is also
bounded by that core. Device helpers
recheck and lock the parent, then their child and the canonical device. They
accept no renderer boolean, caller-selected owner, writable GUC or cancellation
assertion as authority. A device trigger never acquires the upper operation lock.

## Closed SQL interfaces

All functions below return JSONB, are postgres-owned with fixed search_path, and
have no EXECUTE grant to PUBLIC/anon/authenticated/service_role. The shared
postgres-owned operation RPC is their only intended caller.

- `account_deletion_private.device_preparation_prepare(operation_id uuid, device_id text, native_generation uuid)`
- `account_deletion_private.device_preparation_read(operation_id uuid, native_generation uuid, server_generation uuid)`
- `account_deletion_private.device_preparation_cancel(operation_id uuid, native_generation uuid, server_generation uuid)`

Prepare/read return exactly the authority relevant to the common core:
`{prepared:true,native_generation,server_generation}`. Prepare requires an open,
unconfirmed operation, live original SID and the same recorded device/SID. It
returns the same generations on replay. Read rechecks original authorization and
withdrawn capabilities, including SID not_after. The private switch defaults to
false; disabling it refuses both prepare and read while retaining existing seals.
There is no API to enable it in this increment.

Cancel requires the parent already be atomically `closed_before_confirm` with
confirm_started_at NULL and matching generations. It returns
`{cancelled:true,native_generation,server_generation}` and never sets online,
restores capabilities or starts an executor. Gate closure, TTL, child challenge
expiry, a missing response, 401/409 and a currently present account do not cancel.

Preparation retains the device PK, owner, Agent bindings and business content.
It withdraws published capabilities and deletes only same-owner ephemeral
runtime_instances. Foreign-owner liveness attached to the canonical device is a
refusal, not permission to delete or stop that owner. Device writes/deletes,
reserve-only registration and runtime heartbeat writes are fenced. Runtime
writers take a device SHARE lock with NOWAIT; a contended device fails rather
than waiting in an instance-row -> device cycle. This contention behavior and
final Auth transaction ordering require real installed-schema concurrency tests.

## Android consumer contract (implementation not included here)

The native protected operation is captured before any stop or network effect,
including receipt, original SID, installation/owner and localOperationId. Browser
journal is an index. Generation is native authority, not request_id or a client
revision. Android prepare must accept the full scope rather than only ownerId.

1. `prepare(scope)` validates the captured original owner/SID, stores a same-scope
   generation, seals admission, disables settings and drains both native hosts
   plus action/heartbeat publication outside the auth lock.
2. After cloud prepare is acknowledged, explicitly bind the protected receipt to
   that native generation and the returned server generation. Android's current
   empty-generation pre-capture must not defer binding until erase.
3. `acknowledgeWithdrawn(scope, deviceId, nativeGeneration, serverGeneration)`
   rechecks the canonical native binding and that all owned work is stopped. It
   accepts the verified shared-operation transport result, not an arbitrary
   renderer `{prepared:true}`. This replaces removal-based retirement.
4. Cancel persists cancel-pending, obtains an authoritative whole-operation
   closed-before-confirm result, releases the cloud seal, then the same native
   seal. Receipt/index removal comes after durable cancellation checkpoints.
5. Processing/unconfirmed retains the seal; deleted starts native erasure and
   finalization. Cancel leaves settings off. Switching to B never grants access
   to A's secret or permission to stop/erase B.

No native bridge/UI implementation or startup is claimed. The final HTTP adapter
must preserve user confirmation, OTP and operation/intent idempotency owned by
the common core. Account/financial eligibility remains a separate dependency.

## Verification boundaries

Installed-schema tests accompany this increment but require the exact shared
operation migration. Do not substitute a fabricated operation schema. Pending
checks include two-connection READ COMMITTED/RR heartbeat races, final Auth HTTP
success and late-stage rollback, all remaining runtime admission write paths,
Android native binding/restart/cancellation and the original-owner negative
control. SQL source review and syntax checks cannot replace those results.
