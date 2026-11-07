-- gugu:transaction off
-- The primary key starts with message_id; account erasure cascades by agent_user_id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_message_agent_wakes_agent_user_id ON chat.message_agent_wakes USING btree (agent_user_id);
