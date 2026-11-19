# V2 account-closure admission policy

`GET /functions/v1/account-deletion/v2/status` requires the original current login's bearer token and the ordinary public API key. There is no request body, operation ID, receipt or device generation. Auth verifies the bearer; the service-only SQL policy rechecks its user, original session and current email digest. The read does not register an operation, send email, prepare a device or delete data.

Successful response:

```json
{"policy":{"protocol_version":2,"available":false,"deletion":"immediate","credit_treatment":"forfeit_remaining","consent_version":"immediate-forfeit-v1","device_preparation_required":true}}
```

`available` is true only when both the operation gate and device-preparation gate are enabled, the existing dedicated-account restriction admits this caller, and its committed Auth identity is an eligible personal principal. No fixture identity or privileged gate values are returned. The default remains false. An absent classification prerequisite or failed dependency returns an unavailable error, not an available or zero-balance fallback. Account balances continue through the existing authenticated official billing API; this community endpoint does not read or expose billing data.

Failures contain only `{"error":"<fixed_category>"}`. Missing or stale authentication is 401 `unauthorized`; unavailable dependencies are 503 `unavailable`. Wrong HTTP methods are 405 `method_not_allowed`, unknown V2 paths are 404 `not_found`. The response is never cacheable. This status authorizes no subsequent side effect: server-side admission and execution recheck eligibility.

The existing V2 POST operations and field names are unchanged. Native custody atomically captures the original owner/session, a nonempty UTF-8 `local_operation_id` (at most 256 bytes) and a freshly generated 32-byte hexadecimal `receipt_token` before stopping engines, preparing a device or performing network effects. Neither the receipt nor privileged credentials go to the renderer. Every request retains this exact operation/receipt binding; the server stores only domain-separated digests.

- `register`: operation/receipt plus `consent_version`.
- `challenge`: the same binding, consent and positive integer `generation`. Replaying one generation does not grant another email send; an unknown send outcome remains unknown.
- `prepare_device`: binding plus `device_id` and UUID `native_generation`; returns a UUID `server_generation` in `preparation`.
- `read_preparation` / `cancel_preparation`: binding plus the exact native/server generation pair.
- `confirm`: binding, consent, generation, UUID `confirmation_id`, both preparation generations, `code` and `acknowledge_forfeit:true`. An uncertain response is recovered with `result`, not an automatic new confirmation or destructive retry.
- `cancel`: binding plus native generation and optional server generation. Before preparation, omit server generation; a prepared operation requires the original matching pair. Only authoritative pre-confirmation closure can authorize native release, subject to its own custody checks.
- `result`: original binding only; works without a live bearer after Auth deletion and with both gates closed. If this operation already has a preparation record, also returns `preparation:{native_generation,server_generation,prepared:boolean,cancelled:boolean}` for its stored prepared/released state. This recovers a lost prepare response without repeating preparation. No record means no preparation property, not permission to release a local seal. Native accepts only its already persisted native generation, durably stores the returned server generation, then uses the original cancellation path. This read cannot send email, verify a code, prepare a device or dispatch deletion.

Operation responses remain `{"operation":{...},"preparation":{...}}` with optional preparation. Operation states are `open`, `confirming`, `processing`, `deleted`, `closed_before_confirm`; revision and challenge generation are monotonic. `can_retry` remains false. Processing/unknown is not success. A trusted native receiver validates operation, generation, owner and target before persisting the authoritative result and starting scoped local cleanup. A failed policy fetch or a newly closed gate hides new admission but does not discard an already captured operation or block receipt recovery and safe cancellation.

Cancellation authority is exactly `operation.state === 'closed_before_confirm'` together with `operation.can_release_preparation === true` (inside `operation`, never at the response root). HTTP preserves this server value. A prepared cancellation must also contain `preparation.cancelled === true` and the exact original `preparation.native_generation` / `preparation.server_generation`. An unprepared cancellation instead carries the original native generation and an explicit null server generation. Representative ACKs (other operation fields omitted):

```json
{"operation":{"state":"closed_before_confirm","can_release_preparation":true},"preparation":{"cancelled":true,"native_generation":"<original UUID>","server_generation":"<original UUID>"}}
{"operation":{"state":"closed_before_confirm","can_release_preparation":true},"preparation":{"cancelled":true,"native_generation":"<original UUID>","server_generation":null}}
```

A 422, `open`, `preparation.cancelled` alone or a missing field never releases native custody. After the server has rejected the matching verification, invalidated its old lease and proved there is no active verification/execution, it clears the active-confirmation fence so the original owner may explicitly cancel. Rejected intents and rate/attempt limits remain. An unknown or still-verifying/processing attempt retains the fence and must recover its original result; a delayed old lease cannot become verified after rejection or cancellation.

A definitive failed-verification response is HTTP 422 with `error:'verification_failed'` and the original `operation` receipt. Native must match its `operation_id`, `state:'open'`, and `operation.confirmation.{confirmation_id,challenge_generation,state:'rejected'}` against the captured confirmation before atomically recording that confirmation as rejected and clearing its unknown-confirm intent. Rejection writeback refusal, missing/mismatched receipts or still-verifying state instead produce 503 `unavailable`. A bare 422 is not definitive evidence. Even a matched rejected receipt retains the seal until the separate authoritative cancel ACK above.

Receipt-only `result` returns the same `operation.confirmation` summary (`confirmation_id`, `challenge_generation`, `state`, `error_code`). A lost 422 is recovered by matching that original confirmation summary from result, without another code verification or confirmation submission. An absent/different summary, or `open` alone, remains unknown.

If native capture has succeeded but registration never reached the server, receipt-result 404 is not a release ACK. The original live owner/SID can explicitly cancel with the original binding, native generation and no server generation even with both gates closed. Under the same account/operation fences, the server atomically creates a `closed_before_confirm` tombstone and persists that native generation. A delayed registration can only read the same closed operation; it cannot reopen or dispatch email. Another active operation is not replaced. Wrong capabilities, another SID or a changed generation cannot overwrite the tombstone. Result recovery of that unprepared cancellation returns the same explicit-null-server ACK above, covering a lost cancel response without registration replay.

Source of the existing wire contract: `supabase/functions/_shared/account-deletion-operation-core.ts`; its SQL state machine and cancellation wrapper are forward releases `20261116233000` / `20261116233100` / `20261118153500`. Policy/admission is introduced by `20261119143000`. Clients must not use legacy status, legacy confirm/retry, direct end-user RPC calls, or a renderer assertion as deletion authority.
