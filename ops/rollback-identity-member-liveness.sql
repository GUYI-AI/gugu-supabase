-- Restore the predecessor views before removing only derived cache objects.
-- Keep source identities, seats, their authorization policies and installer ledger.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE identity.users IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE VIEW chat.active_members WITH (security_invoker = true) AS
  SELECT m.* FROM chat.chat_members m WHERE identity.user_is_live(m.user_id);
CREATE OR REPLACE VIEW identity.active_users WITH (security_invoker = true) AS
  SELECT id, type, display_name, avatar, bio, mycel_id, owner_user_id,
    agent_config_id, created_at, updated_at, device_id, local_path, prompt_path,
    desired_status, agent_public, gugu_number, category, inherit_memory,
    special_focus, onboarded_at, is_official, session_archived_at,
    session_lifecycle_revision, session_lifecycle_operation_id, removed_at, name_serial
  FROM identity.users WHERE identity.user_is_live(id);

DROP TRIGGER users_00_member_liveness_insert ON identity.users;
DROP TRIGGER users_00_member_liveness_remove ON identity.users;
DROP FUNCTION identity.sync_member_liveness();
DROP TABLE identity.member_liveness;
NOTIFY pgrst, 'reload schema';
COMMIT;
