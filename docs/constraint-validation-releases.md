# Archived-agent device CHECK upgrade

The archived-device removal release replaces `identity.users.users_agent_device_required`
with `CHECK (type <> 'agent' OR device_id IS NOT NULL OR removed_at IS NOT NULL)`.
This preserves the live-agent device requirement while allowing archived identities to
retain history after their execution device is removed.

Before any known persistent installation received this release, its CHECK replacement
was changed to `NOT VALID`. The original validated `ADD CHECK` would scan every identity
while holding `ACCESS EXCLUSIVE` until the outer installation transaction committed.
There is no accepted historical digest for the original archived-device release: a
database that recorded it must stop for an explicit upgrade decision rather than have
its ledger rewritten. This does not change the separate, reviewed #151 digest exception.

`DROP CONSTRAINT` and `ADD CONSTRAINT ... NOT VALID` still require `ACCESS EXCLUSIVE`.
They run atomically, without a table scan, and give up if acquiring a lock takes more
than one second. The previous lock timeout is restored. The strong lock remains until
the surrounding ordinary community/official transaction commits, so that transaction
must finish promptly; `NOT VALID` does not mean lock-free.

The new CHECK enforces subsequent inserts and updates immediately. Existing rows met
the stricter predecessor (`type <> 'agent' OR device_id IS NOT NULL`), so they also meet
the replacement. No unguarded-write interval is exposed by the atomic replacement.

`20261103050000_validate_archived_agent_device_check.sql` runs after that COMMIT as one
standalone `ALTER TABLE ... VALIDATE CONSTRAINT` request. Validation scans existing
rows with `SHARE UPDATE EXCLUSIVE`, compatible with normal reads and writes. Sending
the validation and another SQL statement in the same simple-query request would
implicitly wrap them in a transaction, so the installer accepts only the exact single
validation statement. It verifies `pg_constraint.convalidated` before recording the
release. The official installer must also recognize constraint-validation metadata,
defer it past its outer COMMIT, and hold the session installation lock across both phases.
Directive detection and comment removal normalize CR and CRLF to LF first, matching
PostgreSQL line-comment boundaries; a second statement after a CR is rejected.

The existing #154 concurrent workspace index release and an installed #151 digest are
left untouched. A deployment with the 109-entry predecessor ledger installs only the
missing archived-device release and its validation. A production source that has not
received #151/#154 must also install their reviewed function/index split; it does not
run the old ordinary index build.

## Failure, retry and rollback

A failed CHECK replacement rolls back its ordinary transaction. A failed standalone
validation leaves that ordinary transaction committed and the CHECK enforced as
`NOT VALID`; it leaves no validation ledger row. Inspect the constraint and the failure,
then rerun the same source after resolving it. A successful validation whose ledger
write was interrupted can be retried safely. Do not delete or edit ledger rows.

```sql
SELECT convalidated, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'identity.users'::regclass
  AND conname = 'users_agent_device_required';
```

If an explicit constraint rollback is required, use a short transaction:

```sql
BEGIN;
SET LOCAL lock_timeout = '1s';
ALTER TABLE identity.users DROP CONSTRAINT users_agent_device_required;
COMMIT;
```

Dropping the CHECK removes its live-agent device enforcement too. It does not undo
archived identity detachment or restore the stricter predecessor: detached archived
rows may no longer satisfy that predecessor. A rollback source must still recognize
the installed release versions. Stopping/cancelling validation alone preserves the
enforced CHECK and is sufficient if the scan itself must be halted.

Lock behavior is documented in PostgreSQL's [ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html)
and [explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html) references.
