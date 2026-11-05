-- Archived identities retain history, but no longer require an execution device.
-- Replace the CHECK atomically without scanning while holding ACCESS EXCLUSIVE.
-- The separate validation release must run after the installer's outer COMMIT.
DO $device_check$
DECLARE previous_lock_timeout text := current_setting('lock_timeout');
BEGIN
  PERFORM set_config('lock_timeout', '1s', true);
  ALTER TABLE identity.users DROP CONSTRAINT users_agent_device_required;
  ALTER TABLE identity.users ADD CONSTRAINT users_agent_device_required
    CHECK (type <> 'agent' OR device_id IS NOT NULL OR removed_at IS NOT NULL) NOT VALID;
  PERFORM set_config('lock_timeout', previous_lock_timeout, true);
END $device_check$;

-- Start with the installed definitions, including any earlier release rewrites.
-- CREATE OR REPLACE preserves owners and signatures. The DDL event trigger
-- revokes API grants, so restore exactly the preceding effective ACLs.
DO $remove_archived_device_agents$
DECLARE r record; definition text; previous text; permission record;
BEGIN
  FOR r IN SELECT p.oid, p.proname, p.oid::regprocedure AS signature,
      COALESCE(p.proacl, acldefault('f', p.proowner)) AS acl
    FROM pg_proc p WHERE p.oid IN (
      'identity.remove_device(text,boolean)'::regprocedure,
      'identity.users_block_device_id_change()'::regprocedure,
      'identity.guard_removed_identity()'::regprocedure,
      'identity.assistant_panel_home_changed()'::regprocedure)
  LOOP
    definition := pg_get_functiondef(r.oid); previous := definition;
    CASE r.proname
      WHEN 'remove_device' THEN
        IF strpos(definition, 'AND owner_user_id = v_me::text;') = 0
          OR strpos(definition, '    DELETE FROM identity.gugu_devices') = 0 THEN
          RAISE EXCEPTION 'Unexpected remove_device predecessor';
        END IF;
        definition := replace(definition, 'AND owner_user_id = v_me::text;',
          'AND owner_user_id = v_me::text AND removed_at IS NULL;');
        definition := replace(definition, '    DELETE FROM identity.gugu_devices', $detach$
    PERFORM set_config('identity.device_removal_device_id', p_device_id, true);
    UPDATE identity.users SET device_id = NULL
      WHERE device_id = p_device_id AND type = 'agent'
        AND owner_user_id = v_me::text AND removed_at IS NOT NULL;
    PERFORM set_config('identity.device_removal_device_id', '', true);

    IF EXISTS (SELECT 1 FROM identity.users WHERE device_id = p_device_id) THEN
        RAISE EXCEPTION 'DEVICE_HAS_REFERENCES: device still referenced by users';
    END IF;

    DELETE FROM identity.gugu_devices$detach$);
      WHEN 'users_block_device_id_change' THEN
        definition := replace(definition,
          '    IF OLD.device_id IS DISTINCT FROM NEW.device_id', $guard$
    IF OLD.type = 'agent' AND OLD.removed_at IS NOT NULL
       AND OLD.device_id = NULLIF(current_setting('identity.device_removal_device_id', true), '')
       AND NEW.device_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF OLD.device_id IS DISTINCT FROM NEW.device_id$guard$);
      WHEN 'guard_removed_identity' THEN
        definition := replace(definition, 'BEGIN', 'DECLARE v_detach_columns text[];' || chr(10) || 'BEGIN');
        definition := replace(definition,
          '  IF OLD.removed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN', $guard$
  IF OLD.type = 'agent' AND OLD.removed_at IS NOT NULL
     AND OLD.device_id = NULLIF(current_setting('identity.device_removal_device_id', true), '')
     AND NEW.device_id IS NULL THEN
    -- BEFORE triggers see NULL for generated columns; compare their sources.
    SELECT ARRAY['device_id'] || COALESCE(array_agg(a.attname::text), ARRAY[]::text[])
      INTO v_detach_columns FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = TG_RELID AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated <> '';
    IF to_jsonb(NEW) - v_detach_columns = to_jsonb(OLD) - v_detach_columns THEN
      RETURN NEW;
    END IF;
  END IF;
  IF OLD.removed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN$guard$);
      WHEN 'assistant_panel_home_changed' THEN
        -- A detached home is JSON null, not a NULL payload (which is forbidden).
        definition := replace(definition,
          'jsonb_set(payload,''{deviceId}'',to_jsonb(NEW.device_id))',
          'jsonb_set(payload,''{deviceId}'',COALESCE(to_jsonb(NEW.device_id),''null''::jsonb))');
    END CASE;
    IF definition = previous THEN
      RAISE EXCEPTION 'Unexpected device removal predecessor: %', r.signature;
    END IF;
    EXECUTE definition;
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
      FROM aclexplode(r.acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', r.signature,
        CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END $remove_archived_device_agents$;
