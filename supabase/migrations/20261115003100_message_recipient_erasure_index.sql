-- gugu:transaction off
-- Build without blocking ordinary table writers; the installer verifies validity.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_erasure_recipients ON chat.messages USING gin (to_user_ids) WHERE cardinality(to_user_ids)>0;
