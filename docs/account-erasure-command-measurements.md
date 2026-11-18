# Command erasure: synthetic scale measurements

These are generated loopback workloads, not a copy of a shared database. The host was busy: initial one-minute load 20.74, later 18.36; a separate warmed-write run started at 47.19 and ended at 43.57. Absolute times are observations, not service guarantees. No shared data, credentials or production identifiers were exported.

Historical commands and messages were bulk-generated with replica-role triggers suppressed only during fixture construction. Measured INSERT/payload UPDATE and real Auth HTTP deletion used normal origin triggers and constraints. Commands contain identity references plus generated text; mean payload storage size was 1,156 bytes. This is not a model of the full production data distribution.

## Build choice

An independent connection continuously updated a command payload while another built the index; a third sampled writer lock waits every 5 ms. Longest writer latency includes its entire statement, so bounds that observed write stall. No writer errors occurred.

| Generated commands | Ordinary build ms | Longest writer ms | Lock samples | Concurrent build ms | Longest writer ms | Lock samples |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 15,000 | 79.057 | 77.997 | 10/11 | 78.344 | 1.472 | 0/14 |
| 156,000 | 831.122 | 829.222 | 114/115 | 942.710 | 8.121 | 0/159 |

Release review's rule was ordinary build and longest writer both at most 1,000 ms at the larger scale. Both met it. The draft therefore uses one ordinary transaction for projection, index and erasure replacement. The actual shared installation time remains to be attached from the deployment receipt. A future production estimate based on shared staging time multiplied by the row-count ratio must be labeled an estimate; fixed overhead and different load prevent treating that ratio as a guaranteed upper bound.

## Write cost

Each statement affects **500 rows**, not one row. Times are EXPLAIN ANALYZE execution times, including trigger execution. WAL is the statement's EXPLAIN WAL byte count, not the cluster's LSN delta. Transactions rolled back after each measurement; generated history and existing indexes were retained. These are batched single-connection throughput observations, not a peak-load test.

| Scale / operation | No GIN median ms / 500 | With GIN median ms / 500 | Added microseconds / row | Time increase | No GIN WAL bytes / 500 | With GIN WAL bytes / 500 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 15k INSERT, three rounds | 19.682 | 21.248 | 3.132 | 7.96% | 1,028,180 | 1,142,426 |
| 15k payload UPDATE, three rounds | 8.916 | 13.004 | 8.176 | 45.85% | 1,033,428 | 1,154,689 |
| 156k warmed INSERT | 18.463 | 20.967 | 5.008 | 13.56% | 1,037,018 | 1,148,735 |
| 156k warmed payload UPDATE | 10.039 | 12.699 | 5.320 | 26.50% | 1,032,726 | 1,150,375 |

The warmed run used two warmup batches then the median of three measured batches per configuration. Its INSERT throughput was approximately 27,081 → 23,847 rows/s; payload UPDATE 49,806 → 39,373 rows/s. WAL increased approximately 223/235 bytes per inserted/updated row (10.77%/11.39%). INSERT full-page-image medians differed, 4 versus 1; UPDATE had zero in both configurations. This is a WAL observation, not a byte-exact isolated index charge. The original 156k series showed checkpoint/FPI noise (INSERT WAL appeared lower with the index), so it was not used to claim a WAL saving. Original median latencies were 21.488 → 34.380 ms INSERT and 11.702 → 20.481 ms UPDATE; all original measurements are retained in the private evidence.

The index adds work whenever payload changes and can prevent HOT updates. It is one narrow reference projection on the command table, not a GIN on messages or full command content. Measured write cost must be considered alongside the Auth deadline requirement.

## Plans and Auth path

No planner switches forced index usage. On both scales, the command pre-lock and DELETE used **BitmapOr(existing user_created B-tree, new reference GIN)**; both reference UPDATEs used the new GIN. Empty-candidate command execution times were 0.015–0.034 ms at 15k and 0.021–0.032 ms at 156k. The installed-schema tests separately verify nonempty deletion/anonymization and preservation of unrelated commands.

| Scale | Generated messages | Recipient-filter UPDATE ms | Hidden-marker UPDATE ms | Real Auth HTTP delete ms | Auth + identity absent |
| --- | ---: | ---: | ---: | ---: | --- |
| 15k commands | 22,000 | 3.020 | 1.795 | 58.751 | yes |
| 156k commands | 765,799 | 116.057 | 87.916 | 264.033 | yes |

Both message filters still sequentially scan historical messages; at the larger simulated scale together they took 203.973 ms. They are the remaining size-dependent work, not removed by this change. The synthetic deleted user had six actual Auth sessions, group and DM memberships with a surviving peer, two group messages, and a surviving peer command quoting the deleted author. It does not reproduce every shared fixture relationship or all large-user cascades. Shared Auth HTTP deletion of the preserved failing fixture remains mandatory after deployment; target under three seconds, with measured result attached before rollout approval.
