# Concurrent workspace marker index

The workspace listing release originally included ordinary `CREATE INDEX`, which blocks writes while building. Its function body and grants are unchanged by this split; only the index statement moves to `20261103040000_workspace_pending_marks_concurrent.sql`.

The earlier release is the single explicit exception to release immutability. The installer accepts its original digest `5f0c4abef6cd6475d042b6fd1170d91d618edc2f8ec680cbf26eb1ce8ba62253` and the reviewed function-only digest `579cee5b88b834bcfe392d4c3b6058866b5efe35a2313e4f3107454ab4e313b2`. No ledger row is rewritten. Unknown digests and unknown newer versions still fail before changes.

- An installation that has not received the earlier release runs its function-only body in a transaction, then creates the index concurrently.
- An installation with the original release keeps its existing digest and skips its body. The new concurrent release uses `IF NOT EXISTS`, verifies the existing index is valid and ready, then records its own digest.
- Both end with the same function, grants, index and new release version. Only the earlier release digest reflects which reviewed body actually ran.

`-- gugu:transaction off` accepts exactly one `CREATE INDEX CONCURRENTLY IF NOT EXISTS` statement. The installer sends it separately from the ledger transaction and checks `pg_index.indisvalid` and `indisready` before and after. An official wrapper must use the matching installer that defers these statements until the ordinary community/official transaction has committed. The complete operation is therefore no longer one atomic transaction: an index failure preserves the committed ordinary changes and leaves its index release unrecorded.

## Failure and retry

Inspect the index before retrying:

```sql
SELECT c.oid::regclass, i.indisvalid, i.indisready, pg_get_indexdef(c.oid)
FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
WHERE c.oid=to_regclass('chat.workspace_items_pending_marks_idx');
```

A cancelled or failed concurrent build can leave an INVALID index. `IF NOT EXISTS` alone would silently keep it, so installation fails with an explicit instruction instead. After confirming no index build is active (`pg_stat_progress_create_index`), remove the invalid index outside a transaction:

```sql
DROP INDEX CONCURRENTLY chat.workspace_items_pending_marks_idx;
```

Then rerun the matching deployment. A successful index whose ledger write was interrupted is valid and can be reused on retry. Do not delete or edit ledger rows. A rollback of application code must retain source that knows the new release; deploying an older source is rejected. Dropping the valid index concurrently is an explicit performance rollback, independent of reverting the unchanged listing function.

PostgreSQL explains the transaction restriction and invalid-index behavior in [CREATE INDEX](https://www.postgresql.org/docs/17/sql-createindex.html).
