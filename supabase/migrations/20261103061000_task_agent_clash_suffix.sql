-- Give all new task identities stable clash metadata through the existing allocator.
DO $serials$
DECLARE
    definition text;
    previous text;
    acl aclitem[];
    permission record;
    old_allocation text := $old$
        IF p_name_mode = 'serial' OR NULLIF(btrim(p_name_serial_base), '') IS NOT NULL OR EXISTS (
            SELECT 1 FROM identity.users u
            WHERE u.type = 'agent' AND u.owner_user_id = v_owner AND u.display_name = v_name
        ) THEN
            v_serial := CASE WHEN p_name_mode = 'explicit' AND NULLIF(btrim(p_name_serial_base), '') IS NOT NULL
                THEN 1 ELSE COALESCE(v_parts[2]::INTEGER, CASE WHEN p_name_mode = 'serial' THEN 1 ELSE 2 END) END;
            -- 原子占号:起号 = GREATEST(这个前缀用过的最大号 + 1, 候选号)。
            INSERT INTO identity.agent_name_serials AS s (owner_user_id, base, high_water)
            VALUES (v_owner, v_base, v_serial)
            ON CONFLICT (owner_user_id, base) DO UPDATE
                SET high_water = GREATEST(s.high_water + 1, EXCLUDED.high_water), updated_at = now()
            RETURNING s.high_water INTO v_serial;
            IF p_name_mode = 'serial' OR NULLIF(btrim(p_name_serial_base), '') IS NULL THEN
                -- Only the new explicit task API permits duplicate chosen names.
                WHILE EXISTS (
                    SELECT 1 FROM identity.users u
                    WHERE u.type = 'agent' AND u.owner_user_id = v_owner AND u.display_name = v_base || ' ' || v_serial
                ) LOOP
                    v_serial := v_serial + 1;
                END LOOP;
                v_name := v_base || ' ' || v_serial;
            END IF;
        END IF;
$old$;
    new_allocation text := $new$
        -- Every new task identity uses the same counter. Keep legacy collision naming.
        SELECT EXISTS (
            SELECT 1 FROM identity.users u
            WHERE u.type = 'agent' AND u.owner_user_id = v_owner AND u.display_name = v_name
        ) INTO v_name_clash;
        v_serial := CASE WHEN p_name_mode = 'explicit' AND (NULLIF(btrim(p_name_serial_base), '') IS NOT NULL OR NOT v_name_clash)
            THEN 1 ELSE COALESCE(v_parts[2]::INTEGER, CASE WHEN p_name_mode = 'serial' THEN 1 ELSE 2 END) END;
        IF p_name_mode = 'explicit' AND NULLIF(btrim(p_name_serial_base), '') IS NULL
            AND NOT v_name_clash AND v_parts[2]::integer > 0 THEN
            -- An old host already issued this numbered name offline. Attest that number;
            -- the existing users trigger records it without consuming another counter value.
            v_serial := v_parts[2]::integer;
        ELSE
            -- 原子占号:起号 = GREATEST(这个前缀用过的最大号 + 1, 候选号)。
            INSERT INTO identity.agent_name_serials AS s (owner_user_id, base, high_water)
            VALUES (v_owner, v_base, v_serial)
            ON CONFLICT (owner_user_id, base) DO UPDATE
                SET high_water = GREATEST(s.high_water + 1, EXCLUDED.high_water), updated_at = now()
            RETURNING s.high_water INTO v_serial;
        END IF;
        IF p_name_mode = 'serial' OR (NULLIF(btrim(p_name_serial_base), '') IS NULL AND v_name_clash) THEN
            -- Only the new explicit task API permits duplicate chosen names.
            WHILE EXISTS (
                SELECT 1 FROM identity.users u
                WHERE u.type = 'agent' AND u.owner_user_id = v_owner AND u.display_name = v_base || ' ' || v_serial
            ) LOOP
                v_serial := v_serial + 1;
            END LOOP;
            v_name := v_base || ' ' || v_serial;
        END IF;
$new$;
    old_update text := $old_update$UPDATE identity.users SET name_serial = v_serial WHERE id = v_minted.id::text
            AND (p_name_mode = 'serial' OR NULLIF(btrim(p_name_serial_base), '') IS NOT NULL);$old_update$;
BEGIN
    SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl, acldefault('f', p.proowner))
      INTO previous, acl FROM pg_proc p
      WHERE p.oid = 'identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text,text)'::regprocedure;
    old_allocation := btrim(old_allocation, E'\n');
    new_allocation := btrim(new_allocation, E'\n');
    IF (length(previous) - length(replace(previous, old_allocation, ''))) <> length(old_allocation)
      OR position(E'    v_serial     INTEGER;\n' in previous) = 0
      OR (length(previous) - length(replace(previous, old_update, ''))) <> length(old_update) THEN
        RAISE EXCEPTION 'Unexpected task name serial predecessor';
    END IF;
    definition := replace(previous, old_allocation, new_allocation);
    definition := replace(definition, E'    v_serial     INTEGER;\n', E'    v_serial     INTEGER;\n    v_name_clash BOOLEAN;\n');
    definition := replace(definition, old_update,
      'UPDATE identity.users SET name_serial = v_serial WHERE id = v_minted.id::text;');
    EXECUTE definition;
    IF position(new_allocation in pg_get_functiondef('identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text,text)'::regprocedure)) = 0
      OR position('UPDATE identity.users SET name_serial = v_serial WHERE id = v_minted.id::text;' in definition) = 0 THEN
        RAISE EXCEPTION 'Task name serial rewrite did not apply';
    END IF;
    -- The installation DDL guard revokes execution on replacement; preserve the ACL.
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
      FROM aclexplode(acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION identity.provision_taskpage_agent(uuid,text,text,text,text,text,text,text,text,text) TO %s%s',
        CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
END $serials$;

-- Append only: keep the live directory's old columns, invoker policy and grants.
CREATE OR REPLACE VIEW identity.active_users WITH (security_invoker = true) AS
  SELECT id, type, display_name, avatar, bio, mycel_id, owner_user_id,
    agent_config_id, created_at, updated_at, device_id, local_path, prompt_path,
    desired_status, agent_public, gugu_number, category, inherit_memory,
    special_focus, onboarded_at, is_official, session_archived_at,
    session_lifecycle_revision, session_lifecycle_operation_id, removed_at, name_serial
  FROM identity.users WHERE identity.user_is_live(id);
REVOKE ALL ON identity.active_users FROM PUBLIC, anon;
GRANT SELECT ON identity.active_users TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
