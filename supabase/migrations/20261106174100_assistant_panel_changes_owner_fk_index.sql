-- gugu:transaction off
-- Assistant-leading history indexes do not cover an owner-only foreign-key lookup.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_panel_changes_owner_user_id ON identity.assistant_panel_changes USING btree (owner_user_id);
