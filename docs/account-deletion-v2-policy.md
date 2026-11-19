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
- `result`: original binding only; works without a live bearer after Auth deletion. It cannot send email, verify a code, prepare a device or dispatch deletion.

Operation responses remain `{"operation":{...},"preparation":{...}}` with optional preparation. Operation states are `open`, `confirming`, `processing`, `deleted`, `closed_before_confirm`; revision and challenge generation are monotonic. `can_retry` remains false. Processing/unknown is not success. A trusted native receiver validates operation, generation, owner and target before persisting the authoritative result and starting scoped local cleanup. A failed policy fetch or a newly closed gate hides new admission but does not discard an already captured operation or block receipt recovery and safe cancellation.

Source of the existing wire contract: `supabase/functions/_shared/account-deletion-operation-core.ts`; its SQL state machine and cancellation wrapper are forward releases `20261116233000` / `20261116233100` / `20261118153500`. Policy/admission is introduced by `20261119132300`. Clients must not use legacy status, legacy confirm/retry, direct end-user RPC calls, or a renderer assertion as deletion authority.
