-- gugu:transaction off
-- Build without blocking ordinary table writers; the installer verifies validity.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_erasure_redactions ON chat.messages USING gin (deleted_for_user_ids) WHERE deleted_for_user_ids<>'[]'::jsonb AND deleted_for_user_ids<>'{}'::jsonb;
