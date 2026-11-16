# Recoverable deletion operations (V2 candidate)

Refs #318. This is an unwired, closed-by-default protocol layered on the fixed
reconciliation dependency in #317. Installing it does not enable access, send
mail, create an account, or connect a Settings entry. The native operation store
and reversible device-preparation migration are separate dependencies.

## Result custody and binding

Before any network request or local preparation, native custody generates and
durably stores a 32-byte random result capability, the existing opaque local
operation ID, original owner and original Auth SID. A browser journal is only an
index. Losing the HTTP response can recover the request ID using the original
operation and capability; losing native keys cannot fabricate recovery.

The HTTP core hashes the exact UTF-8 operation ID and receipt with distinct V2
domains. The private database stores only digests. Only the verified Auth caller
selects an owner, email and SID; body fields cannot choose them. Mutations require
that original live SID, including not_after. Result recovery needs the capability
and does not require the deleted login. It grants no OTP, confirmation or DELETE.

New tables have RLS and no API table privileges. The only public RPC is
service_role-only; private preparation helpers have no ordinary API grants.
The operation_access singleton defaults enabled=false. Unknown access state
fails closed. Accepted finish/result paths remain available for reconciliation;
authenticated pre-confirm cancellation also remains available under its original
owner/SID and whole-operation closure checks when the admission gate is disabled.

## Explicit intents

The HTTP core accepts POST routes register, challenge, confirm, result and the
three preparation actions. It is exported as a module, with no deployed Edge
entry or browser/native final UI integration in this candidate.

- Every request carries local_operation_id and receipt_token. Neither enters a
  URL, diagnostic, screenshot or journal. Raw receipts are never minted or
  returned by this handler.
- Register binds immutable owner/SID/email/consent to one operation. Challenge
  carries a positive generation and the fixed immediate-forfeit-v1 consent.
  Only the first committed begin receives an internal send lease. Replay returns
  the original request and expiry, without another OTP request.
- Explicit resend increments the same operation's generation. It preserves the
  existing per-user send limits. A sending/verification/deletion outcome that is
  still unknown cannot be superseded by expiry or a new generation.
- Confirm additionally carries confirmation_id, code, acknowledge_forfeit=true,
  and matching native_generation/server_generation UUIDs. The first intent must
  pass preparation and the original official OTP flow. A duplicate intent only
  reads its original outcome; it does not verify the replay body's code again.
  A fresh human retry after a known code rejection needs a new confirmation ID.
  OTP, ordinary OTP hashes, JWTs and refresh tokens are never stored in intents.
- A non-absent DELETE remains processing. No shortcut retry exists. Recovery
  never automatically replays confirmation or substitutes for consent/code.
- The result includes parent state, request state and the last safe confirmation
  state. A child failed/expired response is not whole-operation cancellation.

The legacy RPC cannot admit/verify a caller that has moved to V2, or operate a V2
child. Its unknown finish/result paths remain usable for legacy reconciliation.
The actual V2 implementation reuses the installed, privately captured #317 core,
not an unchecked legacy public endpoint.

## Preparation and closure

The device migration owns the three private helper signatures:

```
device_preparation_prepare(uuid operation_id, text device_id, uuid native_generation)
device_preparation_read(uuid operation_id, uuid native_generation, uuid server_generation)
device_preparation_cancel(uuid operation_id, uuid native_generation, uuid server_generation)
```

Read/prepare must acknowledge prepared=true and the exact two generations.
Missing helpers, disabled preparation or malformed acknowledgements refuse
confirmation. The helper also checks the real parent and device authority.

Only state=open with confirm_started_at IS NULL may atomically become
closed_before_confirm. The same transaction calls the cancellation helper;
only cancelled=true with both matching generations sets
can_release_preparation=true. Once confirmation has started, even a later wrong
code does not erase that boundary. Confirming/processing never cancel, and the
native controller cannot use a child expiry or a boolean supplied by a renderer
as cancellation proof. Cloud closure precedes same-generation native unsealing;
partial local cancellation preserves its protected checkpoint and secrets.

Account advisory admission precedes identity key-share NOWAIT guards, then the
operation parent, request/confirmation rows, and a preparation helper's device
row. Identity and request contention returns operation_busy without waiting in a
reverse Auth-FK order. The handler returns a fixed error and does not interpret
it as rollback or permission to repeat DELETE. All network and native drain
effects occur outside database/auth locks. Concurrent Auth deletion/logout,
old-snapshot writers and device guards still need combined two-connection tests.

## Persistence and evidence boundaries

The native authority must atomically preserve discoverable operation metadata
and the capability before submission; it must not rely on a separate ordinary
journal write. Persist server-deleted before erasing. After native completion,
restarting between receipt removal and journal cleanup resumes the protected
completion checkpoint instead of requiring the removed receipt. This candidate
does not implement that native storage change or claim that it has been tested.

No new retention duration is selected. Auth deletion clears the new original
identity links in the same transaction; operation digests and outcome metadata
follow the existing result-lifetime contract. Payment/refund eligibility and
other account-erasure dependencies are unchanged and not inferred here.

## Source validation and deployment

Deterministic unit fixtures exercise the actual unwired handler with injected
dependencies. Installed-schema fixtures target only a disposable loopback
database, use transaction-local synthetic preparation helpers, and roll back.
Those helpers validate the common protocol contract, not device heartbeats,
native process exit, actual Auth mail transport or physical key security.
The author has not installed a database or run shared-account requests.

First install #317's fixed reconciliation migration, then this migration, then
the device preparation dependency, in the globally approved forward order.
Keep both gates closed until the combined source/permissions/concurrency and
native persistence checks pass. No migration, email or production activation is
authorized by this document. A new endpoint must not fall back to V1 when its
V2 operation or preparation dependency is missing.
