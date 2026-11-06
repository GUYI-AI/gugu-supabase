-- A runtime instance registers on start and deletes its own row only on a clean stop;
-- crashes, kills, lost networks and expired sessions leave the row behind forever.
-- Every reader judges liveness by a 90-second heartbeat window, so a missing row and a
-- stale row mean the same thing. The device-lease sweep now deletes rows whose heartbeat
-- is past a one-hour grace, and removing a device deletes its instance rows.
-- Rebuild only these installed functions, retaining owners, attributes and exact ACLs.
DO $reap_runtime_instances$
DECLARE r record; definition text; previous text; permission record;
BEGIN
  FOR r IN SELECT p.oid, p.proname, p.oid::regprocedure AS signature,
      COALESCE(p.proacl, acldefault('f', p.proowner)) AS acl
    FROM pg_proc p WHERE p.oid IN (
      'identity.sweep_device_leases(integer)'::regprocedure,
      'identity.remove_device(text,boolean)'::regprocedure)
  LOOP
    definition := pg_get_functiondef(r.oid); previous := definition;
    CASE r.proname
      WHEN 'sweep_device_leases' THEN
        IF strpos(definition, '    v_flipped INTEGER := 0;') = 0
          OR strpos(definition, '    GET DIAGNOSTICS v_flipped = ROW_COUNT;') = 0 THEN
          RAISE EXCEPTION 'Unexpected sweep_device_leases predecessor';
        END IF;
        definition := replace(definition, '    v_flipped INTEGER := 0;',
          '    v_flipped INTEGER := 0;' || chr(10) || '    v_reaped INTEGER := 0;');
        definition := replace(definition, '    GET DIAGNOSTICS v_flipped = ROW_COUNT;', $reap$    GET DIAGNOSTICS v_flipped = ROW_COUNT;

    -- Bounded like the flip above: a backlog drains over several runs.
    DELETE FROM identity.runtime_instances r
     USING (SELECT instance_id FROM identity.runtime_instances
             WHERE last_heartbeat_at < now() - interval '1 hour'
             LIMIT p_limit
             FOR UPDATE SKIP LOCKED) stale
     WHERE r.instance_id = stale.instance_id;

    GET DIAGNOSTICS v_reaped = ROW_COUNT;

    IF v_reaped >= p_limit THEN
        RAISE WARNING 'sweep_device_leases hit its runtime instance bound (% rows); the remainder waits for the next run', p_limit;
    END IF;$reap$);
      WHEN 'remove_device' THEN
        IF strpos(definition, '    DELETE FROM identity.gugu_devices') = 0 THEN
          RAISE EXCEPTION 'Unexpected remove_device predecessor';
        END IF;
        definition := replace(definition, '    DELETE FROM identity.gugu_devices', $remove$    DELETE FROM identity.runtime_instances
     WHERE device_id = p_device_id
       AND owner_user_id = v_me;

    DELETE FROM identity.gugu_devices$remove$);
    END CASE;
    IF definition = previous THEN
      RAISE EXCEPTION 'Unexpected runtime instance reap predecessor: %', r.signature;
    END IF;
    EXECUTE definition;
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
      FROM aclexplode(r.acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', r.signature,
        CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END $reap_runtime_instances$;
