# Managed file transfer budgets

This release adds the budget boundary to the existing attachments service. It does not implement project-local resolution, encrypted temporary transfers, idle-file expiry, or the separate public-media migration. Deploy it with a client that supplies the upload size, actor and group scope. Older unscoped upload requests fail closed: an upload that declares no size gets `426 client_outdated`, whose message asks the person to update Gugu.

## Guarantees and limits

| Rule | Enforcement | Evidence |
| --- | --- | --- |
| Global monthly download budget | Reserve the object's verified length before signing; one transaction checks global, account and source-group headroom. UTC months. Pending capabilities remain held across month boundaries. | `fileTransferBudget.test.ts`, `fileTransferConcurrency.test.ts` |
| Account/group budgets | The authenticated human account pays for its Agents. Topics use the source group. Failed reservations leave no partial debit. | Same integration suites, `topicSourceResources.test.ts` |
| Global/account/group storage | Count physical inventory, referenced objects and pending upload capacity before issuing a permit. Forwarding and publication also check receiving scope. | Same integration suites |
| Short-lived downloads | The existing CDN Type A / Storage signer issues a 60-second capability after reservation. CDN authentication lifetime must be declared correctly; a request-rate limit is optional. | `fileTransferCore.test.ts`, `attachmentStorageConfig.test.ts` |
| Bound uploads and one registration | Unpredictable uploader-scoped keys, provider-enforced maximum and lifetime, immutable source, streamed SHA-256, one receipt and original scope. Retain staging and its capacity until trusted terminal cleanup. | `attachmentsOss.test.ts`, `attachmentSupabaseStorage7628.test.ts`, budget integration |
| Trusted reconciliation | Service-only import; provider request ID deduplicates events. Match the signed download ID to the exact stored object; changed duplicate identities abort the entire batch. Client ACKs cannot refund a reservation. | `fileTransferLogs.test.ts`, `fileTransferLogCli.test.ts`, budget integration |

A signed URL is a replayable bearer capability. Sixty seconds limits **new request admission**, not the duration of an accepted response. A request may continue after expiry, and parallel replays can spend more bytes than the single pre-reservation. A deployment may operate without per-request throttling; this replay amplification risk is explicitly accepted. Optional rate limiting is not a total-byte cap, and the reserved length is not an exact cloud spending ceiling. Actual replay bytes can exceed the reservation; trusted observations debit them in full and stop later signing. Cached responses must pass the same URL authentication. Keep a separate provider bandwidth/monthly cap and billing alert as operational protection.

No permanent file is evicted to satisfy a quota. This release contains no LRU. A later temporary-transfer provider may evict only its own temporary objects.

## Origin fallback for image previews

An OSS download advertises `origin_available` without pre-signing an origin URL. After a CDN connection failure, the client can repeat `file-download` with `origin: true`, the same reference and actor, and the current `download_id` as `request_id`. The existing authorization and reservation checks still run before signing.

For an eligible managed image, that explicit fallback response reuses `thumb_url` for an OSS V4 URL to the same object with the existing fixed thumbnail transformation. No caller-selected object key or processing expression is accepted. Both original and thumbnail signatures retain the reservation's attribution, optional traffic limit and original deadline of at most 60 seconds; `expires_at` is their earliest actual expiry. Non-images, images outside the existing processing limits and encrypted temporary objects receive no origin thumbnail.

Clients must not persist signed URLs. If an older backend supplies no origin `thumb_url`, the failed thumbnail preview must remain an explicit failure rather than silently fetching the full original. Preview bytes may retain their existing cache policy independently of these short-lived capabilities.

## Deployment settings

Download admission calculates usage directly from the original reservation and observation ledgers. It locks the existing global limits row for signature-rate checks, quota checks and the reservation insert near the end of the transaction; the lock remains held through the already locked metadata updates and RPC commit. A shared row is necessary for the installation-wide hard download budget: locking different accounts or groups independently would let them overbook the same global headroom. Observations and settlement enter the same fence before changing usage. There is no copied usage total or reconciliation path.

Downloads do not acquire the installation-wide storage/inventory/GC advisory lock. Reference resolution runs before quota admission; garbage collection uses the existing per-blob shared-lock fence, expiry coordinates on the individual storage reference, and read-once transfers lock their own generation. Only retries of the same request ID share a download advisory lock. Usage and its UTC-month treatment, immutable request IDs, and signature-rate limits retain their existing ledger semantics.

`chat.file_transfer_limits` is service-only. Insert one `scope='global', scope_id='*'` JSON object. There are deliberately no deployment quota values in the migration. Account/group rows override the corresponding keys in the global object; unspecified keys inherit. Use parameterized SQL through a protected operator connection.

| JSON key | Meaning |
| --- | --- |
| `storage_global_bytes`, `storage_account_bytes`, `storage_group_bytes` | Physical storage and held upload allowance, in bytes |
| `download_global_bytes`, `download_account_bytes`, `download_group_bytes` | Monthly egress reservations/observations, in bytes |
| `file_max_bytes` | Public upload permit ceiling |
| `upload_permit_seconds` | Must equal the selected provider's enforceable policy lifetime |
| `download_link_bits_per_second` (optional) | Omit for no declared request-rate limit. If present, use 819200–838860800 bit/s; direct OSS signatures bind it. CDN/Storage edge throttles are independently provisioned and are not installed or proved by this value. |
| `sign_window_seconds`, `sign_account_count`, `sign_group_count` | New download-signature rate window and count limits |
| `inventory_ready` | Initially absent/false; enable only after a complete trusted physical inventory and scope audit |
| `paused` | Stop new upload/download reservations immediately; already issued bearer capabilities remain usable within their provider rules |

Numeric settings are nonnegative safe integers. A zero quota disables that allowance. Missing required settings refuse issuance. Reducing a limit below current usage does not delete files; it prevents new reservations. Update `updated_at` with the configuration change and retain the operator change record. Never write a service credential into SQL examples, request URLs or logs.

OSS/CDN uses the existing `OSS_*`, `CDN_DOMAIN` and `CDN_AUTH_KEY_PRIMARY` configuration, and requires `CDN_AUTH_TTL_SECONDS` with them: an OSS configuration without it is refused as `not_configured` on every attachments request, like any other missing OSS variable. Set it to the edge's actual Type A authentication lifetime. CDN signing does not require a rate declaration or compare it to a permit; `CDN_REQUEST_LIMIT_BITS_PER_SECOND` is no longer consumed. The signer reuses the existing crypto and chooses a timestamp whose **timestamp + edge TTL** expires in 60 seconds. An environment value declares configuration; it does not install an edge policy or prove enforcement. Verify both normal and cached responses against the real provider before enabling production signing. OSS upload admission requires a bucket that has **never enabled versioning**: forbid-overwrite alone does not bound historical versions.

The community Supabase provider has different capabilities: signed uploads have a fixed 7200-second lifetime and no per-object size policy. Admission reads the actual finite bucket ceiling, reserves that ceiling rather than the declared small size, and requires it to fit the configured file allowance. The community adapter streams the SHA-256, so memory stays bounded, and promotes by a server-side copy pinned to the hashed object version. Its CPU stays inside the Edge worker, so the platform CPU limit bounds the largest file ([self-hosting.md](self-hosting.md)). With OSS, the file service hashes staged bytes from a request the function signs ([files-service.md](files-service.md)). Configure `upload_permit_seconds=7200` and `file_max_bytes` to cover that bucket ceiling. Downloads use the same 60-second Storage capability without requiring `SUPABASE_STORAGE_REQUEST_LIMIT_BITS_PER_SECOND`. `GUGU_PUBLIC_SUPABASE_URL` may identify its public gateway. Supabase signing alone supplies no request throttle. A gateway or cache must still authenticate newly admitted requests after expiry; cache-hit and cache-miss expiry must be validated independently. Adding an actual provider rate policy later does not introduce another resolver or signer.

## Inventory and activation

1. Stop managed writes and complete an authoritative inventory of every billed provider/prefix, including abandoned staging and objects without a database reference. Do not treat metadata-only backfill as physical inventory.
2. Export canonical JSONL records `{ "bucket_id": "oss", "object_name": "logical/key", "size_bytes": 123 }` from the trusted inventory. Strip the configured physical prefix. Unknown length is an error; a real zero-byte object is distinct. For the community native provider, new managed blobs retain the logical database bucket `oss` while their physical bytes live in the configured attachments bucket; inventory must use that same logical mapping. Historical workspace objects retain `workspace`.
3. Load credentials in the process environment and stream the protected export to `node scripts/import-file-transfer-logs.mjs inventory`. Set `GUGU_FILE_TRANSFER_IMPORT_URL` to the HTTPS `/attachments/storage-inventory` route and `SUPABASE_SERVICE_ROLE_KEY` in the environment. Loopback HTTP is allowed for a disposable fixture.
4. Reconcile object counts/bytes and source-group/account attribution, including old workspace versions and private task attachments. Orphans still consume the global allowance. Unknown account ownership must be resolved before claiming complete account attribution.
5. Set all deployment limits and only then enable `inventory_ready`. The import route never sets it. Reconcile in-flight staging against held reservations before reopening writes so that the same staging object is not counted twice.

Inventory upserts are repeatable and do not resurrect objects already marked deleting/gone. They do not infer physical absence from a partial listing or release capacity. Reference backfill preserves existing blob IDs, versions and exact ACLs. Old workspace Storage access is restricted to the same managed service: raw authenticated reads/writes/deletes cannot bypass budgets. Public legacy media remains a separate deployment boundary until its private-object cutover; an already public URL cannot be secured by quota signing alone.

## Provider traffic reconciliation

Use authenticated, protected exports from the configured provider account; never ingest logs supplied by a reader. The import route accepts only the service credential. Keep exports private: raw request URIs may contain bearer signatures. The parser transmits only request ID, managed download UUID, logical object, completion timestamp and response-body bytes, and prints aggregate counts only.

| Source | Required official export fields |
| --- | --- |
| CDN realtime SLS JSON | `method`, `domain`, `uri`, `uri_param`, `uuid`, `body_bytes_sent`, `unixtime` |
| OSS SLS JSON | `http_method`, `host`, `request_uri`, `request_id`, `response_body_length`, `__time__`, `sync_request` |

For OSS, export `url_decode(request_uri) AS request_uri` because SLS stores that field URL-encoded. Preserve the URI's own object encoding; do not repeatedly decode paths. CDN authentication's signed `rand` is the managed download UUID without hyphens. The OSS adapter recognizes `gugu-download-id` for a future authenticated direct-OSS provider; this release's managed OSS reads use CDN. Do not enable an adapter whose attribution identifier is absent or not covered by the provider's signed authorization.

Set `GUGU_FILE_LOG_DOMAIN` to the exact source domain and `GUGU_FILE_LOG_OBJECT_PREFIX` to its physical prefix, then run `node scripts/import-file-transfer-logs.mjs cdn` or `oss` with JSONL on stdin. The endpoint is `/attachments/usage-import`. Batches contain at most 512 events. Replaying overlapping exports is safe. A changed event ID payload or wrong object fails the batch atomically. A failed run may have committed earlier batches; restart from the same trusted export.

HEAD requests are excluded. OSS CDN-origin requests (`sync_request='cdn'`) are excluded from the user's download ledger to avoid charging the same transfer twice; reconcile origin charges separately. Response-body bytes do not equal every provider billing item: headers, CDN billing adjustments, origin traffic, requests and storage belong in the provider invoice comparison. Do not describe this ledger as a hard currency cap.

If logs are late or incomplete, keep outstanding reservations and pause issuance before unsafe headroom accumulates. Do not refund on expiry, one successful log record, a client completion message, or a partial range. After the provider's complete delivery window is independently verified, an operator may call service-only `chat.file_transfer_settle(download_id)` for an expired capability with observations. That call is an operational assertion of finality, not a log-completeness detector. Later observations are still accepted and charged in their observed UTC month. Downloads with no final evidence remain conservatively held.

## Staging and cleanup

Uploads reserve twice the enforceable maximum while immutable staging and the final object coexist. Successful registration charges the actual final bytes and retains the remaining staging hold. Reusing an issued upload UUID cannot move actor/group/maximum or mint a fresh lifetime. Committing is idempotent and cannot create a second registration.

The existing blob GC remains the single final-object deletion path. It confirms physical deletion before releasing inventory capacity. The idle-expiry extension records that change atomically inside `file_blob_gc_finish`. Do not release an in-progress deletion's capacity.

The service-only `attachments/gc` route reconciles staging through `file_managed_upload_closed`. Its selector matches reservation ID, uploader, subject and staging key. Both registered uploads and abandoned uploads can qualify. Registration receipts, message references, final objects and their actual-byte charges remain available.

After cleanup, a repeated finish can answer an existing ready declaration while its original seven-day receipt is valid. It checks the declared key and uploader, the requested upload key and reservation identity, and the registered final blob. A successor must be the recorded source of that exact declaration in `file_staging_publication_sources`. The durable upload ledger survives expiry of a successor's one-hour receipt. Separate sends of identical bytes can share a final blob. Reading the existing result preserves each message, its charges and its retention. Once the original receipt expires or is swept, these keys can no longer confirm the declaration.

### Establishing the closure boundary

By default both physical providers retain the reservation. To enable cleanup, a storage operator records one verified issuance window under `upload_closure` in the global transfer settings. Store the supporting evidence in a protected operations record. The settings contain its short nonsecret reference. Historical deployments sharing logical keys require an independently established mapping to the same origin, bucket and prefix for the entire issuance window, including retries. Keep each window on its verified namespace throughout execution.

| Field | Meaning |
| --- | --- |
| `namespace` | OSS uses an object with `provider` = `oss`, `region`, `bucket`, and physical `prefix` (empty string at bucket root). Community Storage uses `provider` = `supabase`, `project` equal to the active public Supabase URL (internal URL when no public URL is configured), and `bucket`. |
| `issued_from`, `issued_before` | UTC timestamps. The original reservation must start at or after the first timestamp, and its **extended** expiry must precede the second. Extend a window only with evidence of continuous physical ownership. |
| `evidence` | An immutable operations reference of 1–80 letters, digits, underscores, periods, colons or hyphens. Its record identifies the namespace, coverage, writer inventory and completion guarantee. |
| `terminal_sha256` | SHA-256 of the independently verified terminal evidence document for this exact namespace and window. Retain it with the report. |
| `drained_through` | A provider-confirmed cutoff covering **every** write and replay derived from permits expiring before that instant, including writers that signed again or arrived later. This can also be demonstrated by excluding new writers and draining admitted operations on a dedicated origin. |
| `upload_inflight_seconds` | Alternative to a drain cutoff. Use the sum of three independently sourced upper bounds **from database permit expiry**: the latest Edge dispatch or re-signing, the actual signature admission lifetime from that signing, and accepted upload completion including transit, body transfer and provider-side commit. Record the source for each duration and its coverage of single uploads, parts, Complete and document snapshot writes. Leave any range missing a bound in the report. |
| `periodic` | Set to JSON `true` only after periodic collection is approved for the window. A report and an explicit batch can operate with this setting absent. |

The OSS form deadline governs admission. A signed UploadPart uses a dated V4 authorization header. The policy deadline, request clock tolerance and socket idle timeout do not establish when an accepted operation finishes. An abort can leave a concurrently uploading part. The collector therefore requires terminal evidence before acting, then checks the exact key and checks for remaining multipart sessions by prefix. Bucket versioning must remain disabled throughout cleanup. [OSS form policy](https://help.aliyun.com/zh/oss/user-guide/0006-00000213), [OSS abort semantics](https://www.alibabacloud.com/help/en/oss/developer-reference/abort-multipart-upload), [OSS multipart listing](https://www.alibabacloud.com/help/en/oss/developer-reference/listmultipartuploads)

Supabase Storage can issue a new signed upload on a retry. Its token lifetime runs from signing. Storage can also return HTTP 400 with an object-specific 404 error, so confirmation uses origin HEAD and typed object metadata. A missing bucket, denied request, generic 404 or unavailable origin leaves the hold intact. Neither adapter ships with a documented universal in-flight upper bound. [Supabase signed upload lifetime](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl), [Storage error codes](https://supabase.com/docs/guides/storage/debugging/error-codes)

### Operating a bounded batch

The staging worker shares one lease and one queue between published uploads and expired uploads without a registration. Each run claims at most five keys in total. Published uploads require their existing publication marker. Operations may import independently verified per-key evidence using the [committed staging controls](committed-staging-cleanup.md). Final-object GC has its own queue and control.

1. Run `ops/report-managed-upload-closure.sql` with psql variables `account` and `namespace`. The repeatable-read report covers all periods. It groups held bytes by proof, publication and recorded multipart ID.
2. Read the service-only `POST /functions/v1/attachments/staging-cleanup` with `{"mode":"report","ids":[...],"limit":500}`. The response contains exact candidate identities, held bytes and the evidence reference. Keep IDs and credentials in the protected operations record. Retain all uncovered holds.
3. Choose up to five candidates. Pass their IDs, account, namespace, a new run UUID and evidence reference to `ops/backup-managed-upload-closure.sql`. The backup captures the matching ledger and staging queue state and checks every submitted ID. Keep periodic window cleanup disabled. Read `staging-cleanup-status` and coordinate an exclusive window with other operators. Arm `staging-cleanup-configure` with `enabled:true`, `single_batch:true` and these exact staging keys. Use the same run UUID and evidence reference in `{"mode":"apply","ids":[...],"run":"...","evidence":"..."}` at the report endpoint. A paused or busy worker returns HTTP 409. Verify claimed, deleted, failed and unconfirmed counts against the backed-up IDs and stored receipts. A retry after a lost response first reconciles those same IDs before rearming the worker.
4. Repeat with another backed-up batch. Compare the decrease in held bytes with the unique reservations settled in the same snapshot. Verify existing actual-byte charges and open the final file as its recipient.
5. Before enabling periodic operation, verify the deployed `file-staging-cleanup-kick` cron, Vault dispatch and staging control. The kick can dispatch a covered window when `periodic:true`, including when no prior staging job was queued. Enable continuous mode only after reviewing the physical coverage and removing the explicit one-batch restriction. Check staging status and retained amounts after the first dispatch.

To restore, disable the staging control and window proof, wait for any admitted worker to finish, then run `ops/restore-managed-upload-closure.sql` with the backup run UUID. It restores matching ledger flags and queue state, including pre-existing publication evidence. Physical staging deletion is irreversible. Reconcile usage and open the registered final file as its recipient before further cleanup.

## Operational rollout and validation

Ship the client-only request preparation first: every upload sends size, actor, explicit chat/null and a request UUID through the same existing helper. The previous HTTP entry accepts these additive fields without a schema or RPC upgrade. Verify both release channels before enabling this enforcing service. Publishing a new client does not prove every installed client upgraded: inactive old clients remain unobservable and will fail after the explicit protocol cutover. The affected path includes managed chat/file, placement/replacement, delegated sends, private task handoff and mobile Agent uploads; unrelated direct media uploads are separate.

Keep the enforcing release staged until compatible clients, trusted inventory, quota configuration, readable bucket versioning and verified 60-second authentication are ready. Per-link throttling is optional, not an activation gate. Record the cutover time, supported minimum versions and observed old-protocol activity. A legacy empty-body request counter must be measured at the existing service boundary before claiming an active cohort has migrated; HTTP 400 totals alone do not identify a protocol or count devices. No client heartbeat or second transport path is needed. There is no bounded failure window for clients that never update.

Do not mutate the foundation or an installed migration ledger. Missing configuration or provider capability must fail visibly. Pause first if rolling back; do not restore an unbudgeted signer while live issued capabilities or held storage remain unaccounted for.

Prove real concurrent last-byte admission for all three download scopes and upload storage; identical retries charge once. Prove full storage refuses before a provider permit, unauthorized/repeated commits cannot publish bytes, one account's exhaustion leaves another account usable with shared headroom, and wrong/duplicate provider events cannot refund or partially apply. Existing protection changes are listed in [the test migration audit](file-transfer-test-migration.md).

Isolated PostgreSQL/HTTP and signing fixtures do not prove live OSS or CDN enforcement. A real dedicated test bucket/domain must prove size, overwrite rejection, expiry, cached authentication, parallel replay behavior, any optional request throttle, Range, genuine log ingestion and invoice comparison. Keep those cells pending until that environment exists. A MinIO protocol result is not an OSS result.

## Optional throttling policy change

The selected rollout keeps 60-second authentication, pre-reserved verified bytes, ACLs, signing-count limits and trusted reconciliation. It removes mandatory per-request throttling uniformly for every deployment, rather than adding an environment exception. This accepts concurrent replay amplification: the reservation is not a byte-hard or currency-hard cap. Provider budget alarms and usage caps remain operational protection. Configure a path-scoped or separate-domain CDN limit later without changing the single download entry point. Declare the optional rate only when the corresponding provider capability is actually provisioned; a number cannot create it.

No database migration is needed: the SQL quota core never required the rate key. Existing installations may keep a valid optional value; new installations may omit it. The direct OSS adapter still signs a provided rate in the same SDK request, and still refuses malformed optional rates or attempts to extend the original reservation.
