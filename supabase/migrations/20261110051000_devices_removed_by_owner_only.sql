-- A device row is deleted only by its owner's remove_device; every device row names its machine.
--
-- identity.cleanup_legacy_gugu_devices, which each client calls once per owner at startup, deleted device rows two ways
-- that bypass identity.remove_device:
--   · rows without a machine_id whose hostname equals the caller's: a one-time move to machine ids, repeated every run,
--     that also deleted the row of a second machine with the same hostname still running an old client;
--   · every row unseen for 30 days with no agent and no custom label ("stale reclaim", #663). That deleted the device's
--     project folders (identity.device_projects cascades), so a laptop off for a holiday lost its folders on every
--     other device and its file versions resolved as missing; a server host was dropped without remove_device's
--     tombstone. Routing it through remove_device would not help: removing a device removes its folders too.
-- The function deletes nothing any more. A device is removed when its owner removes it (remove_device); the device list
-- shows when each was last seen. Released clients call it on every device tick, so it stays, with the same signature
-- and grant, answering 0: drop it once the oldest supported client no longer calls it.
--
-- Every client registers a machine id (desktop hardware id, server installation id, phone install id). The rows that
-- have none predate machine ids; each gets 'legacy:' || device_id, which no client sends, so a current client on that
-- machine still registers by its own id (the upsert on device_id overwrites it) and the row's agents keep their device.
-- From now on an API registration must name a machine, and no API write may clear it: the check sits in the existing
-- BEFORE INSERT OR UPDATE trigger function
-- identity.gugu_devices_enforce_machine_limit, and the limit reads machine_id without falling back to device_id.
-- Trusted roles (service_role members: operations, server RPCs, fixtures) are exempt as that function already exempts
-- them.
--
-- Locks: no column, constraint or trigger is added to identity.gugu_devices (a SET NOT NULL would take ACCESS EXCLUSIVE
-- and scan the table); replacing functions locks no table; the fill takes ROW EXCLUSIVE on
-- identity.gugu_devices, as a heartbeat does. Rollback: ops/rollback-devices-removed-by-owner-only.sql.
SET LOCAL lock_timeout = '5s';

UPDATE identity.gugu_devices
   SET machine_id = 'legacy:' || device_id
 WHERE NULLIF(machine_id, '') IS NULL;

CREATE OR REPLACE FUNCTION identity.gugu_devices_enforce_machine_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'identity', 'public', 'pg_catalog'
AS $function$
DECLARE
  v_refusal JSONB;
BEGIN
  IF pg_has_role(current_user, 'service_role', 'MEMBER') THEN
    RETURN NEW;
  END IF;
  -- Every device names its machine (20261110051000): desktop hardware id, server installation id, phone install id.
  -- Checked when a row is written with a machine id (registration, or a change of it); a heartbeat changes nothing here.
  IF (TG_OP = 'INSERT' OR NEW.machine_id IS DISTINCT FROM OLD.machine_id) AND NULLIF(NEW.machine_id, '') IS NULL THEN
    RAISE EXCEPTION 'DEVICE_MACHINE_REQUIRED: a device registers its machine_id' USING ERRCODE = '23502';
  END IF;
  IF COALESCE(NEW.capabilities ->> 'host_kind', '') <> 'server' THEN
    RETURN NEW;
  END IF;
  -- A heartbeat from an archived server occupies a slot again. Metadata edits
  -- and the lease sweeper do not add activity and must remain possible.
  IF TG_OP = 'UPDATE' AND OLD.capabilities ->> 'host_kind' = 'server'
     AND NEW.status <> 'online' AND NEW.last_seen_at IS NOT DISTINCT FROM OLD.last_seen_at THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM identity.gugu_devices d WHERE d.device_id = NEW.device_id) THEN
    RETURN NEW;
  END IF;
  -- 同一个账号并发加两台:串行判,❌ 两边都看见「还差一台」一起放进来。
  PERFORM pg_advisory_xact_lock(hashtextextended('gugu-machine-limit:' || NEW.user_id::text, 0));
  v_refusal := identity.gugu_machine_limit_refusal(NEW.user_id, NEW.machine_id, NULL);
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'DEVICE_LIMIT_REACHED: %', v_refusal::text USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION identity.gugu_devices_enforce_machine_limit() FROM PUBLIC, anon, authenticated, service_role;

-- Released clients (cleanupLegacyDeviceRows) still call this every device tick; drop it once the oldest supported
-- client no longer does. It deletes nothing: devices are removed only by remove_device.
CREATE OR REPLACE FUNCTION identity.cleanup_legacy_gugu_devices(p_keep_device_id text, p_hostname text)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
    SELECT 0;
$function$;
REVOKE ALL ON FUNCTION identity.cleanup_legacy_gugu_devices(text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION identity.cleanup_legacy_gugu_devices(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
