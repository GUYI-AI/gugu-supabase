# Foreign-key indexes for account erasure

Refs [#200](https://github.com/GUYI-AI/gugu-supabase/issues/200).

Account erasure deletes the human identity and relies on existing foreign keys
to remove owned identities and dependent rows, or clear historical authors.
This change adds indexes only. It does not replace `identity.erase_human_account`,
change foreign keys, edit historical releases, alter permissions, or measure
end-to-end account-deletion latency.

## Indexes

Each release contains one `CREATE INDEX CONCURRENTLY IF NOT EXISTS` statement
with the existing `-- gugu:transaction off` directive. The installer checks that
the index is ready and valid before recording the release. Four independent
versions avoid holding a table write lock for an ordinary index build. Invalid
indexes left by an interrupted build require the installer's documented
inspection/drop/retry procedure; `IF NOT EXISTS` alone does not repair them.

| Version | Table | B-tree index | Keys | Predicate |
| --- | --- | --- | --- | --- |
| `20261106174000` | `chat.message_agent_wakes` | `idx_message_agent_wakes_agent_user_id` | `agent_user_id` | none |
| `20261106174100` | `identity.assistant_panel_changes` | `idx_assistant_panel_changes_owner_user_id` | `owner_user_id` | none |
| `20261106174200` | `chat.workspace_item_versions` | `workspace_item_versions_made_by_idx` | `made_by` | `made_by IS NOT NULL` |
| `20261106174300` | `identity.users` | `idx_users_owner_user_id` | `owner_user_id` | `owner_user_id IS NOT NULL` |

A strict text equality lookup implies that the compared column is non-NULL.
The last two predicates therefore cover the foreign-key lookup, including rows
whose author will be set to NULL. A predicate on a different property, such as
`type = 'agent'` or `revoked_at IS NULL`, is not implied by owner equality.
See PostgreSQL's [partial-index rules](https://www.postgresql.org/docs/17/indexes-partial.html).

## Existing coverage and bounded scope

The wakes primary key starts with `message_id`; panel history indexes start with
`assistant_user_id`; the versions primary key starts with `item_id`. None
provides the missing leading column. The two existing users owner indexes have
agent-type predicates absent from the foreign-key lookup. They remain in place
for their narrower agent queries. None of the new definitions duplicates an
existing equality-usable leading key for these four relationships.

The source review also checked the existing non-NULL indexes on
`identity.users.agent_config_id`, `avatar`, and `device_id`,
`chat.workspace_item_versions.blob_id`, and
`identity.assistant_panel_items.body_item_id`: their predicates are usable for
the corresponding strict equality lookups, so no duplicate indexes are added.
`identity.agent_model_selections.owner_user_id` and account-revision user keys
already have leading coverage.

Other source-level candidates, including `assistant_panel_items.owner_user_id`,
`message_reactions.user_id`, and the non-leading user references in
`message_agent_sends`, do not have the issue's table-size/plan evidence. No live
deployment was queried for this change. These candidates need a separate
size/selectivity and equality-plan review before expanding the index set; this
is not a claim that all community foreign keys are now covered.

## Verification boundaries

Local verification uses a disposable PostgreSQL 16 subset with the target table
definitions and foreign keys. It checks direct CASCADE and SET NULL semantics,
not the installed foundation, platform hooks, RLS, or the complete erase function.
The full PostgreSQL 17 foundation is verified by PR CI; it is not considered
passed until that CI succeeds.

`tests/integration/service/accountErasureForeignKeys.test.ts` runs against the
installed community foundation and releases. It checks index key/predicate and
validity metadata, then deletes an Auth user with two owned agents, one already
removed. It checks wake/panel cascades, preservation of history content with
NULL authors, and unrelated peer rows. Fixtures roll back after each test.

Local PostgreSQL 16.14 subset verification completed successfully.
The fixture used synthetic rows, not deployment data; its row counts match the issue estimates, while its selectivity is
synthetic. After explicit ANALYZE, with enable_seqscan=on, random_page_cost=4
and plan_cache_mode=auto, plain EXPLAIN produced:

| Relation | Rows | Before | After |
| --- | ---: | --- | --- |
| chat.message_agent_wakes | 195,717 | Seq Scan | Bitmap Heap Scan / idx_message_agent_wakes_agent_user_id |
| identity.assistant_panel_changes | 28,375 | Seq Scan | Bitmap Heap Scan / idx_assistant_panel_changes_owner_user_id |
| chat.workspace_item_versions | 20,914 | Seq Scan | Bitmap Heap Scan / workspace_item_versions_made_by_idx |
| identity.users | 27,886 | Seq Scan | Bitmap Heap Scan / idx_users_owner_user_id |

All four new indexes were valid and ready. Plain EXPLAIN of the corresponding
DELETE/UPDATE predicates used those indexes too. The two prepared nullable-key
lookups each naturally selected one generic plan after five custom plans; the
generic equality still used the partial index. No planner settings were forced.

Direct foreign-key assertions passed for two owned agents (one removed), wake
and panel CASCADE, retained version bodies with NULL authors, and unaffected
peer rows. 

The subset server shut down and its temporary cluster was deleted. Full
PostgreSQL 17 foundation verification remains pending PR CI. No end-to-end
account-deletion latency was measured.

Existing evidence: [community plan and assertion excerpts](evidence/account-erasure-pg16.txt).
The [community-only subset SQL](../tests/fixtures/accountErasureFkSubset.sql) is reproducible only
on a fresh disposable loopback database. It defines isolated test schemas and
is not a migration or a substitute for the full foundation test.
