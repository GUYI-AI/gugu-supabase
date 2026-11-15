# Registered audit redaction batches

Release `20261115100500` consumes the closed registration/context capability from
`20261115100400`. Install the independent file and Auth audit releases first.
The separate account-erasure worker owns registration, scheduling, retries,
progress commits, alerts and the two completion receipts. This release does not
modify the Auth deletion entry or run cleanup inside account deletion.

The worker locks a durable job, establishes its exact current transaction/PID/
lease context, and calls the registered helpers with only `job_id` and a limit.
Both ends of processing call `identity.assert_registered_audit_context`; expired
leases, wrong phases and a second round before its seventh-day gate refuse.
API roles have no execution capability or access to identity criteria.

Auth and file headers page by their existing UUID primary keys. File details
page by `(operation_id,change_no)`. The default scan limit is 100, hard maximum
1000. A page is selected before row locks are attempted, so the limit bounds
candidates examined rather than matching writes. Locked rows are skipped; if
any candidate is skipped, `blocked=true`, `exhausted=false`, and the returned
cursor remains at its original boundary. The worker must not advance past it.
Already processed rows are safe to revisit after a retry or lost response.

`scanned`, `locked`, and `changed` are bounded progress counts. `exhausted` only
describes the current page. The separate residual functions check the complete
Auth and both file audit tables without cursor filtering or skipped locks. An
empty batch never authorizes deleting a registration or declaring completion.
Neither batch nor residual helpers clear temporary identity/email criteria.

Redaction preserves security IDs, action/time/IP fields and opaque provider
UUIDs. An explicitly different actor or target ID protects that identity even
when its email address matches a deleted account. Target fields with an erased
target ID remain independent of their administrator actor. Unattributed fields
under a different known actor are conservatively protected. Only registered
identity/email criteria are used; there is no global email redaction, new email
index, retained matching digest or change to the 180-day rolling retention.

The approved lifecycle has a first scan within 24 hours and a second scan on
day seven. Only the worker may record the first result as **redacted**, and only
after the second scan plus both real residual counts of zero may it record
**closed** and delete the registration's email and IDs. Registration is solely
for redaction. Failures retain the task for bounded retry and alerting; the
daily check inspects actual overdue residuals. Accept rare late-arriving
records after closure. New events belonging to a different new account ID are
not modified. Fifteen working days is a hard maximum, not the normal target.

Passing these helpers' tests does not prove the separate worker, mail delivery,
daily alert delivery or the real Auth account-deletion path meets its three-
second budget. Those require complete-tree acceptance.
