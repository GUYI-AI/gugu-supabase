# Account erasure component benchmark

Run manually with Docker and Python 3:

```sh
python3 tests/performance/accountErasureScope.py
```

The fixture contains only synthetic rows (765,886 messages and 154,740 device
commands). It compares reference predicates and 5,000-row writes before and
after the three narrow indexes, with `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)`.
It uses an owned, labelled, network-isolated container with one CPU and 1 GiB;
cleanup stops/removes only that container and its anonymous volumes.

These component plans do **not** prove total account-deletion latency or the
correctness of all erasure triggers. Full installation and integration tests,
including historical recipients after membership removal, remain required.
Absolute times and WAL depend on the host/cache. Compare repeated controlled
samples before accepting write overhead; a single run is diagnostic evidence.
