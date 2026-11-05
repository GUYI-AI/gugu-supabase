-- Keep one derived fact per identity. Removal must not write membership rows:
-- ordinary member writers may already own a row before locking revision heads.
SET LOCAL lock_timeout = '5s';
LOCK TABLE identity.users IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE identity.member_liveness (
  user_id text PRIMARY KEY REFERENCES identity.users(id) ON DELETE CASCADE,
  is_live boolean NOT NULL
);
REVOKE ALL ON identity.member_liveness FROM PUBLIC, anon, authenticated, service_role, gugu_files;
ALTER TABLE identity.member_liveness ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION identity.sync_member_liveness() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO identity.member_liveness(user_id, is_live)
    VALUES (NEW.id, NEW.removed_at IS NULL)
    ON CONFLICT (user_id) DO UPDATE SET is_live = EXCLUDED.is_live;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.sync_member_liveness() FROM PUBLIC, anon, authenticated, service_role, gugu_files;
-- Run before existing identity event producers can read active_members.
CREATE TRIGGER users_00_member_liveness_insert AFTER INSERT ON identity.users
  FOR EACH ROW EXECUTE FUNCTION identity.sync_member_liveness();
CREATE TRIGGER users_00_member_liveness_remove AFTER UPDATE OF removed_at ON identity.users
  FOR EACH ROW WHEN (OLD.removed_at IS DISTINCT FROM NEW.removed_at)
  EXECUTE FUNCTION identity.sync_member_liveness();

INSERT INTO identity.member_liveness(user_id, is_live)
  SELECT id, removed_at IS NULL FROM identity.users;

-- This is an invoker read through the existing physical-member RLS gate.
-- A supplied identity id, including the caller's own id, grants no visibility
-- unless that role can already read a member row for it. No API role can write it.
CREATE POLICY member_liveness_visible_member ON identity.member_liveness
  FOR SELECT TO authenticated, service_role, gugu_files
  USING (EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.user_id = member_liveness.user_id));
GRANT SELECT ON identity.member_liveness TO authenticated, service_role, gugu_files;

-- m.* retains the installed column order, including personal deletion state.
CREATE OR REPLACE VIEW chat.active_members WITH (security_invoker = true) AS
  SELECT m.* FROM chat.chat_members m
    JOIN identity.member_liveness live ON live.user_id = m.user_id
  WHERE live.is_live;

CREATE OR REPLACE VIEW identity.active_users WITH (security_invoker = true) AS
  SELECT id, type, display_name, avatar, bio, mycel_id, owner_user_id,
    agent_config_id, created_at, updated_at, device_id, local_path, prompt_path,
    desired_status, agent_public, gugu_number, category, inherit_memory,
    special_focus, onboarded_at, is_official, session_archived_at,
    session_lifecycle_revision, session_lifecycle_operation_id, removed_at, name_serial
  FROM identity.users WHERE removed_at IS NULL;

NOTIFY pgrst, 'reload schema';
