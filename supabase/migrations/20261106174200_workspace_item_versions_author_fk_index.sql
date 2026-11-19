-- gugu:transaction off
-- Equality implies made_by IS NOT NULL, including the foreign key's SET NULL lookup.
CREATE INDEX CONCURRENTLY IF NOT EXISTS workspace_item_versions_made_by_idx ON chat.workspace_item_versions USING btree (made_by) WHERE made_by IS NOT NULL;
