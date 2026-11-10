-- Roll back 20261110051000_devices_removed_by_owner_only: identity.cleanup_legacy_gugu_devices deletes again (the hostname
-- delete of machine-less rows and the 30-day stale reclaim), an API write may again omit machine_id, and the rows that
-- release filled with 'legacy:' || device_id get their NULL back. The bodies below are the definitions it replaced.
BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE identity.gugu_devices SET machine_id = NULL WHERE machine_id = 'legacy:' || device_id;

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
  v_refusal := identity.gugu_machine_limit_refusal(NEW.user_id, COALESCE(NULLIF(NEW.machine_id, ''), NEW.device_id), NULL);
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'DEVICE_LIMIT_REACHED: %', v_refusal::text USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$

;
REVOKE ALL ON FUNCTION identity.gugu_devices_enforce_machine_limit() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION identity.cleanup_legacy_gugu_devices(p_keep_device_id text, p_hostname text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'identity', 'public'
AS $function$
DECLARE
    v_user_id UUID := auth.uid();
    v_deleted INTEGER := 0;
    v_stale   INTEGER := 0;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'cleanup_legacy_gugu_devices requires an authenticated user';
    END IF;

    DELETE FROM identity.gugu_devices d
    WHERE d.user_id = v_user_id
      AND d.device_id <> p_keep_device_id
      AND d.machine_id IS NULL
      AND d.hostname = p_hostname
      AND d.last_seen_at < now() - interval '2 minutes'
      AND NOT EXISTS (
          SELECT 1
          FROM identity.users u
          WHERE u.device_id = d.device_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM identity.gugu_device_commands c
          WHERE c.device_id = d.device_id
      );

    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    -- #663 stale reclaim：30 天无心跳 + 无 agent 绑定 + 未改名 + 无近期在途命令 → 删（跨 hostname）。
    DELETE FROM identity.gugu_devices d
    WHERE d.user_id = v_user_id
      AND d.device_id <> p_keep_device_id
      AND d.last_seen_at < now() - interval '30 days'
      AND d.label_customized_at IS NULL
      AND NOT EXISTS (
          SELECT 1
          FROM identity.users u
          WHERE u.device_id = d.device_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM identity.gugu_device_commands c
          WHERE c.user_id = v_user_id
            AND c.device_id = d.device_id
            AND c.status IN ('pending', 'running')
            AND c.created_at > now() - interval '30 days'
      );

    GET DIAGNOSTICS v_stale = ROW_COUNT;
    RETURN v_deleted + v_stale;
END;
$function$

;
REVOKE ALL ON FUNCTION identity.cleanup_legacy_gugu_devices(text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION identity.cleanup_legacy_gugu_devices(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
