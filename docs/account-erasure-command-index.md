# Indexed account-erasure command references

Account erasure must finish within the Auth HTTP deadline without weakening historical reference cleanup. A normal account can reach that deadline while command JSON predicates repeatedly scan unrelated history. The canceled command statement identifies where execution stopped; it is not a complete profile of the transaction.

The new pure, immutable projection includes exactly the existing JSON-reference branches: agent ID; sender ID only for `agent.deliver`/`agent.wake`; reply author ID; and `jsonb_array_elements_text` recipient values. It deliberately retains legacy non-string recipient conversion semantics. Owner UUID matching remains a separate condition and can use the existing owner index.

One GIN expression index covers this small reference array. Message text, result bodies and unrelated command JSON are excluded. No message-table index is added. The helper reads no tables; all existing roles with table INSERT/UPDATE privileges may execute it to evaluate index expressions, with a catalog test covering every writer (including service/trigger roles). The account-erasure function remains closed to API roles.

All command statements use the indexed projection while retaining their original mutation predicates and payload transformations. Each statement keeps its own snapshot; no cached candidate-ID array can omit a command that becomes visible between statements. The existing chat → command → identity/device lock order and sorted command locking remain unchanged.

The single forward release `071502` is independent of team identity. Its ordinary index creation, pure projection/permissions and guarded erasure replacement commit atomically. An unexpected predecessor rolls the transaction back, including the index. The draft's separate `071503`/`071504` files were never deployed and have been folded into this release.

Release review chose ordinary creation after both scale simulations met the agreed limits: build at most one second and longest concurrent writer at most one second. On 15,000 generated command rows the build took 79.057 ms and the longest writer 77.997 ms; on 156,000 rows, 831.122 ms and 829.222 ms. Concurrent creation took 78.344/942.710 ms, with longest writers 1.472/8.121 ms and no observed lock samples. These are synthetic loopback measurements, not a staging clone or production timing, and leave a finite write-lock window. Actual shared deployment duration remains a CD acceptance item.

Before shared rollout, verify readiness/replay, insert and payload-update WAL/latency, the four command plans and both message-reference filters. Exercise the real Auth hard-delete path with ordinary account relationships; target under three seconds for the agreed fixture. Synthetic Auth measurements do not replace retrying the preserved shared fixture after the reviewed deployment.

The current failed fixture is preserved for diagnosis. These changes have not been deployed. Email delivery, client entry points, financial anonymization and broader residual-reference cleanup remain separate release gates.
