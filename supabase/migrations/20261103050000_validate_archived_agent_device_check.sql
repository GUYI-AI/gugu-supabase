-- gugu:transaction off
-- The replacement CHECK already enforces all new writes. Scan existing rows only
-- after the transaction that took ACCESS EXCLUSIVE has committed.
ALTER TABLE identity.users VALIDATE CONSTRAINT users_agent_device_required;
