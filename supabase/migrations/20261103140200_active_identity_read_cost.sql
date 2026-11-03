-- Preserve invoker/RLS semantics, including the file reader's restricted access
-- to users. Liveness changes once per identity; it need not be recomputed for
-- every scanned membership row.
SET LOCAL lock_timeout = '5s';
LOCK TABLE identity.users, chat.chat_members IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE chat.chat_members ADD COLUMN user_removed_at timestamptz;

CREATE FUNCTION chat.set_member_user_removed_at() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- Serialize admission against identity removal. FOR KEY SHARE would allow a
  -- concurrent non-key removed_at UPDATE and could leave a newly admitted seat live.
  SELECT u.removed_at INTO NEW.user_removed_at FROM identity.users u
    WHERE u.id=NEW.user_id FOR SHARE;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.set_member_user_removed_at() FROM PUBLIC, anon, authenticated, service_role, gugu_files;
CREATE TRIGGER chat_members_00_user_removed_at
  BEFORE INSERT OR UPDATE OF user_id, user_removed_at ON chat.chat_members
  FOR EACH ROW EXECUTE FUNCTION chat.set_member_user_removed_at();

CREATE FUNCTION identity.sync_removed_identity_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE chat.chat_members m SET user_removed_at=NEW.removed_at
    WHERE m.user_id=NEW.id AND m.user_removed_at IS DISTINCT FROM NEW.removed_at;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.sync_removed_identity_members() FROM PUBLIC, anon, authenticated, service_role, gugu_files;
CREATE TRIGGER users_sync_removed_identity_members AFTER UPDATE OF removed_at ON identity.users
  FOR EACH ROW WHEN (OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL)
  EXECUTE FUNCTION identity.sync_removed_identity_members();

-- Cache maintenance is not a membership change. Keep the installed producer
-- functions and ACLs; only their UPDATE triggers skip a cache-only write.
DROP TRIGGER chat_members_broadcast_trg ON chat.chat_members;
CREATE TRIGGER chat_members_broadcast_trg AFTER INSERT OR DELETE ON chat.chat_members
  FOR EACH ROW EXECUTE FUNCTION chat.chat_members_broadcast();
CREATE TRIGGER chat_members_broadcast_trg_update AFTER UPDATE ON chat.chat_members
  FOR EACH ROW WHEN (OLD.user_removed_at IS NOT DISTINCT FROM NEW.user_removed_at
    OR (to_jsonb(OLD) - 'user_removed_at') IS DISTINCT FROM (to_jsonb(NEW) - 'user_removed_at'))
  EXECUTE FUNCTION chat.chat_members_broadcast();

DROP TRIGGER chat_members_publish_account_revision ON chat.chat_members;
CREATE TRIGGER chat_members_publish_account_revision AFTER INSERT OR DELETE ON chat.chat_members
  FOR EACH ROW EXECUTE FUNCTION chat.publish_membership_revision();
CREATE TRIGGER chat_members_publish_account_revision_update AFTER UPDATE ON chat.chat_members
  FOR EACH ROW WHEN (OLD.user_removed_at IS NOT DISTINCT FROM NEW.user_removed_at
    OR (to_jsonb(OLD) - 'user_removed_at') IS DISTINCT FROM (to_jsonb(NEW) - 'user_removed_at'))
  EXECUTE FUNCTION chat.publish_membership_revision();

UPDATE chat.chat_members m SET user_removed_at=u.removed_at
  FROM identity.users u WHERE u.id=m.user_id AND m.user_removed_at IS DISTINCT FROM u.removed_at;

-- Keep the published column order and shape; the cache column stays internal.
CREATE OR REPLACE VIEW chat.active_members WITH (security_invoker=true) AS
  SELECT m.chat_id,m.user_id,m.role,m.last_read_seq,m.version,m.joined_at,m.updated_at,
    m.is_pinned,m.contract,m.triggers,m.notification_level,m.listen_mode,m.hide_history_before,
    m.is_marked_unread,m.inbox_published_at,m.join_context_shown_at,m.joined_ingest_seq,
    m.conversation_deleted_at
  FROM chat.chat_members m WHERE m.user_removed_at IS NULL;

CREATE OR REPLACE VIEW identity.active_users WITH (security_invoker=true) AS
  SELECT id,type,display_name,avatar,bio,mycel_id,owner_user_id,agent_config_id,created_at,updated_at,
    device_id,local_path,prompt_path,desired_status,agent_public,gugu_number,category,inherit_memory,
    special_focus,onboarded_at,is_official,session_archived_at,session_lifecycle_revision,
    session_lifecycle_operation_id,removed_at
  FROM identity.users WHERE removed_at IS NULL;
-- active_friendships, user_is_live and all eight dependent policies retain
-- their installed definitions and privileges.
