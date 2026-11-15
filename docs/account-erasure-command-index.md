# Indexed account-erasure command references

Account erasure must finish within the Auth HTTP deadline without weakening historical reference cleanup. A normal account can reach that deadline while command JSON predicates repeatedly scan unrelated history. The canceled command statement identifies where execution stopped; it is not a complete profile of the transaction.

The new pure, immutable projection includes exactly the existing JSON-reference branches: agent ID; sender ID only for `agent.deliver`/`agent.wake`; reply author ID; and `jsonb_array_elements_text` recipient values. It deliberately retains legacy non-string recipient conversion semantics. Owner UUID matching remains a separate condition and can use the existing owner index.

One GIN expression index covers this small reference array. Message text, result bodies and unrelated command JSON are excluded. No message-table index is added. The helper reads no tables; legitimate writers may execute it to evaluate index expressions. The account-erasure function remains closed to API roles.

All command statements use the indexed projection while retaining their original mutation predicates and payload transformations. Each statement keeps its own snapshot; no cached candidate-ID array can omit a command that becomes visible between statements. The existing chat → command → identity/device lock order and sorted command locking remain unchanged.

The releases are forward-only and independent of team identity:

- `071502`: pure projection and explicit permissions.
- `071503`: exactly one `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, headed `-- gugu:transaction off`.
- `071504`: guarded replacement of the command block in the existing erasure function. An unexpected predecessor aborts installation.

Before shared rollout, an isolated clone must compare concurrent and ordinary index creation time and write-blocking intervals, verify index readiness/replay, measure insert/status-update WAL and latency, and exercise the real Auth hard-delete path with ordinary account relationships. Target under three seconds for the agreed fixture; report actual results and background load rather than extrapolating from an empty account. The default migration uses concurrent creation; changing that choice requires release review.

The current failed fixture is preserved for diagnosis. These changes have not been deployed. Email delivery, client entry points, financial anonymization and broader residual-reference cleanup remain separate release gates.
