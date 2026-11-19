-- Exact disk bytes remain readable in the device row. Only entering/leaving
-- the existing 1 GiB server warning is an account-visible change.
SET LOCAL lock_timeout = '5s';

DROP TRIGGER gugu_devices_publish_account_revision_on_visible_update ON identity.gugu_devices;
CREATE TRIGGER gugu_devices_publish_account_revision_on_visible_update
AFTER UPDATE ON identity.gugu_devices
FOR EACH ROW WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.label IS DISTINCT FROM NEW.label
    OR OLD.hostname IS DISTINCT FROM NEW.hostname
    OR OLD.platform IS DISTINCT FROM NEW.platform
    OR OLD.tier IS DISTINCT FROM NEW.tier
    OR OLD.machine_id IS DISTINCT FROM NEW.machine_id
    OR (CASE WHEN jsonb_typeof(OLD.capabilities) = 'object' THEN OLD.capabilities - 'server_disk' ELSE OLD.capabilities END)
       IS DISTINCT FROM
       (CASE WHEN jsonb_typeof(NEW.capabilities) = 'object' THEN NEW.capabilities - 'server_disk' ELSE NEW.capabilities END)
    OR (OLD.capabilities @? '$ ? (
          @.host_kind == "server"
          && @.server_disk.type() == "object"
          && @.server_disk.free_bytes.type() == "number" && @.server_disk.total_bytes.type() == "number"
          && @.server_disk.free_bytes >= 0 && @.server_disk.total_bytes > 0
          && @.server_disk.free_bytes <= @.server_disk.total_bytes
          && @.server_disk.free_bytes < 1073741824)')
       IS DISTINCT FROM
       (NEW.capabilities @? '$ ? (
          @.host_kind == "server"
          && @.server_disk.type() == "object"
          && @.server_disk.free_bytes.type() == "number" && @.server_disk.total_bytes.type() == "number"
          && @.server_disk.free_bytes >= 0 && @.server_disk.total_bytes > 0
          && @.server_disk.free_bytes <= @.server_disk.total_bytes
          && @.server_disk.free_bytes < 1073741824)')
    OR OLD.session_digest IS DISTINCT FROM NEW.session_digest
)
EXECUTE FUNCTION identity.publish_device_revision();
