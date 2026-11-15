# Restricted background audit redaction

Refs #302. Release `100400` installs only the closed registration/context contract. The later helper adapters and Auth caller/scheduler are required before this becomes a working asynchronous flow. It neither exposes a new API nor enables a worker.

An account-erasure transaction registers its exact lifecycle identity set and the trusted optional Auth email. Missing or partial lifecycle context is refused. Repeating the same registration in the same source transaction returns the original job; changing its criteria is refused. Registration and account deletion commit or roll back together once the later caller is installed. API roles cannot read the email criteria, manipulate tables, enqueue jobs or assert a worker context.

The job stores transient `delete_user_ids` and normalized `auth_email`, its source subject/transaction, deletion/target/escalation times, a lease, attempts and a typed phase/cursor. Auth and file-header pages use a UUID cursor; file items use `(operation_id,change_no)`. The separate context contains only the current transaction, backend PID, job ID and matching private lease. A helper locks the job and checks this context and the live lease at both ends of a batch. No caller-supplied GUC authorizes redaction.

Completion has two rounds. Round one targets 24 hours and writes only a `redacted` proof after actual Auth/file residual counts are zero. The job and its criteria remain restricted for a second scan on day seven. Only another actual zero result closes the job and removes its transient identity/email criteria. A nonzero second result requires manual review; failures and expired leases must remain retryable rather than disappearing. The internal escalation timestamp uses 15 calendar days as a conservative earlier bound; the externally approved maximum remains 15 working days, without inventing a holiday calendar.

The helpers bound scanned rows, not only affected rows. A skip-locked page cannot advance its cursor or establish completion. The worker must inspect actual residual fields daily for jobs older than 24 hours, including those waiting for the second scan; counting pending jobs is insufficient. The scheduler and these checks are separate forthcoming changes, not features established by this migration.

Redaction is limited to registered identities. An explicit different actor/target user ID protects a new account even when its email is reused; actor and target scopes are independent. Do not redact every email-only audit record or create a long-lived email-fingerprint registry. Two scans provide bounded late-record handling; rare later records remain an explicitly accepted limitation. The success page must not claim every record has been deleted.

The independent 180-day Auth retention job remains unchanged. Registration fields are for redaction only, not lookup or analytics. Receipts contain operation/round/timing/zero counts rather than identity criteria.
