-- gugu:transaction off
-- Build without blocking ordinary table writers; the installer verifies validity.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_device_commands_erasure_references ON identity.gugu_device_commands USING gin (account_erasure_private.command_reference_user_ids(payload));
