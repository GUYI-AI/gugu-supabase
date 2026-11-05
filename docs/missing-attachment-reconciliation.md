# Missing attachment inventory

`file-resolve` (including each entry of a batch) and `file-download` return HTTP 200 with
`{"status":"missing","code":"object_not_found","sha256":null}` when an authorized managed
object is marked `gone` in `chat.file_transfer_storage`. A stored digest is preserved when
available. Unauthorized references keep their existing `gone` response. Missing objects do
not receive a signed capability or reserve download quota. Unmarked objects, HTTP 500/503,
timeouts and authorization errors are never classified as missing.

The marker is trusted inventory data. Supabase Storage's file backend can return metadata
from HEAD/info even when its physical file is absent; GET can then return a generic 500.
Neither response proves absence. Do not modify or patch the Storage dependency for this path.

## One-time reconciliation

Run `scripts/reconcile-missing-attachments.mjs` on the storage host with read access to the
physical file backend and an administrative database connection in the private
`GUGU_MISSING_DATABASE_URL` environment variable. Never put credentials on the command line.
This tool is for the local file backend, whose configured root, storage bucket, tenant and
version separator must match the deployed provider. It does not infer an S3/OSS layout.

First choose an existing, known-good Storage object as a control. Its database version,
physical device, inode and size are checked again before a scan/apply finishes. A missing
mount/control, permission error, I/O error or changed object aborts the operation. Only a
physical `ENOENT` can enter a manifest; a directory or failed HTTP request cannot.

```sh
node scripts/reconcile-missing-attachments.mjs scan \
  --root /mounted-storage --storage-bucket configured-bucket --tenant configured-tenant \
  --separator / --buckets chat-media,workspace --control <known-good-object-uuid> \
  --manifest /private/missing-manifest.json
# For a rehearsal, additionally pass --owner <your-own-test-user-uuid>.

# Review the exact private manifest and its printed digest before applying it.
node scripts/reconcile-missing-attachments.mjs apply \
  --manifest /private/missing-manifest.json --digest <reviewed-manifest-digest> \
  --backup /private/missing-before.json

node scripts/reconcile-missing-attachments.mjs rollback \
  --backup /private/missing-before.json --digest <printed-backup-digest>
```

The scan is read-only. Apply rechecks the metadata/version and physical absence while holding
the existing quota transaction lock. It updates only `chat.file_transfer_storage.state` to
`gone`, or inserts a `gone` inventory row for an untracked historical object. An immutable,
mode-0600 backup records both the prior and expected result before any mutation. Storage
tables, messages, attachment references and accounting events are not changed.

Rollback restores prior states and removes inventory rows created by this operation only
when they have acquired no references or reservation history. Changed ledger rows are
refused rather than overwritten. Retain the backup, digest and successful commit receipt;
a backup left by a failed transaction is not evidence that the operation committed.

An operator must review the closed list and deployment's storage mapping before production
use. Follow the installation's normal human authorization process. Prove the migration and
rollback on a disposable local database and rehearse only with owned staging fixtures first.
Deploy merged backend code through the normal deployment pipeline before marking real data.
Do not change installed release files or apply DDL directly to shared installations.
