-- gugu:transaction off
CREATE INDEX CONCURRENTLY IF NOT EXISTS gugu_device_commands_erasure_refs_idx ON identity.gugu_device_commands USING gin (identity.command_erasure_references_v1(type,payload));
