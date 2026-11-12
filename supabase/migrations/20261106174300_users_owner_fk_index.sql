-- gugu:transaction off
-- The foreign-key cascade has no type predicate. Keep the agent-specific indexes
-- for their narrower queries; exclude only NULL owners from this lookup index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_owner_user_id ON identity.users USING btree (owner_user_id) WHERE owner_user_id IS NOT NULL;
