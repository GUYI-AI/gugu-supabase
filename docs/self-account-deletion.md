# Self-service account deletion

`account-deletion` is a community identity Edge function. It verifies the current
login and a new email OTP, then calls Auth Admin hard deletion. Existing Auth
triggers own erasure, shared-data attribution, agents, projects and groups. The
feature is disabled until an operator configures an approved product policy.

## Client contract

All requests use JSON and responses have `Cache-Control: no-store`. User routes
require the current user's Bearer token. Body fields never select a target user,
email, deletion mode or delay. Callers use the policy version returned by status.

| Method/path suffix | Body | Result |
| --- | --- | --- |
| GET `/status` | none | Server policy and the caller's active request |
| POST `/challenge` | `policy_version` | 201: request, one-time returned `receipt_token`, expiration; sends OTP to the current confirmed email |
| POST `/confirm` | `request_id`, `receipt_token`, `policy_version`, `code` | 200 only when deletion is read back; 202 for pending/unknown; 503 on definite deletion failure |
| POST `/retry` | `request_id`, `receipt_token` | Reuses an already verified request within its original authorization window; never re-verifies a consumed OTP |
| POST `/cancel` | `request_id` | Authenticated cancellation of an owned pending request before its due time |
| POST `/result` | `request_id`, `receipt_token` | Minimal result capability for a lost response after deletion has removed the original session |
| POST `/process-due` | none | Server-only, at most five claims and one active consumer; returns only counts |

The full prefix is `/functions/v1/account-deletion`. Store the receipt as a secret;
do not put it or an OTP in a URL, analytics or logs. Results omit account identity,
email, verification sessions and internal leases. A caller that loses its session
after successful deletion can still read its receipt result. A 202 response is not
proof of deletion: inspect `request.state`, and poll/retry only as indicated.

Errors include `unauthorized` (401), `invalid_request` (400), `invalid_proof` (403),
`not_found` (404), state/policy conflicts (409), `expired` (410), verification
failure (422), rate limiting (429) and unavailable dependencies (503). Failures
never expose raw SQL/Auth errors or imply that an account was erased.

## Fresh verification

The Edge verifies the original token through Auth `/user`; the private RPC also
checks its live `auth.sessions` row. A code is sent using official Auth `/otp`
with `create_user=false`, then consumed using `/verify` with type `email`. The
verified user and email must equal the original caller and challenge. The temporary
verification session is signed out locally and never returned to the client.

The workflow expires five minutes after the new send begins, independently of
the installation's global OTP expiry. It serializes attempts and bounds sends to
one/minute and three/15 minutes per user, verification to five/request and ten/15
minutes per user. A changed email, session or policy requires a fresh challenge.
Reauthentication nonces are not used: the installed Auth contract consumes them
inside password changes, which this operation must not perform.

## Policy and pending mode

Only an operator can configure `account_deletion_private.policy`. Set an explicit
mode, delay, approved `credit_treatment_key` and a new policy version before
enabling. No product choice is inferred from defaults. Test-only activation can
be restricted to one synthetic account; its deletion clears the allowlist FK and
leaves the feature closed to all other accounts.

In pending mode, login and existing search visibility remain unchanged until
hard deletion. Logging in does not cancel. Cancellation is explicit and closes
at the due time; a row lock serializes it with final consumption. Existing erasure
does not run partially during the pending period. These semantics must be included
in the selected product design before enabling the feature.

The credit key is a policy contract, not a financial action. This PR does not
refund, transfer, convert or spend credits. A policy requiring another financial
action must have that official implementation validated before activation. The
existing client can show its balance with its own authenticated JWT using the
official `billing.user_credits` view, selecting `balance_credits,credit_unit_version`
with `x-gugu-credit-unit-version: 2`. Community installations without official
billing must present that feature as unavailable, never invent a zero balance.
No service-role financial-table read is added.

## Due execution and failures

Schedule `node scripts/account-deletion-worker.mjs` once/minute on a protected
server using its existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` environment.
Never place credentials in cron text or arguments. The script reports booleans
and counts only. Pending mode refuses new confirmations unless the consumer has
contacted the workflow within two minutes. No Vault or `pg_net` secret is needed.

The consumer uses a global lease, one row per claim, a bounded batch/runtime,
`SKIP LOCKED` and retry backoff. It calls the same Auth Admin hard-delete path as
immediate mode. Turning off new requests does not abandon already scheduled work.
Worker outages leave pending requests visible and overdue; deferred/error counts
need operator attention rather than being presented as deletion success.

Auth performs the actual deletion and triggers in one transaction. A trigger
failure rolls that transaction back. Workflow proof/attempt state is durable and
separate. An uncertain HTTP outcome stays in progress; readback and the Auth FK
reconcile a committed deletion without an overlapping retry. An expired immediate
authorization cannot authorize a later fresh deletion.

New workflow/audit identity links are Auth foreign keys cleared at hard deletion;
email digest and authorization/session metadata are cleared too. No original-user
to accounting-tombstone mapping is created. Receipts remain hashed capabilities.
Do not log codes, tokens, raw Auth replies or identity-bearing SQL diagnostics.

## Validation and deployment

Run the targeted unit/integration tests on a disposable loopback installation.
`GUGU_TEST_EMAIL_OTP=1` enables that checkout's own mail catcher and OTP template;
it does not send real email. `node scripts/test-account-deletion-http.mjs` exercises
the exact handler over loopback HTTP against real Auth, email and installed
triggers, including pending cancellation, due execution and rollback/retry.
It reports only counts/booleans/times and is not a deployed Edge smoke test.

Use forward releases and the normal backend deployment path. Real Auth HTTP
deletion must be tested with the installed trigger owners and financial privileges;
a successful SQL deletion by a stronger role is not a substitute. Shared branch
validation needs explicit approval and an isolated test-account allowlist. Do not
change a deployment pin or activate an undecided product policy during development.
