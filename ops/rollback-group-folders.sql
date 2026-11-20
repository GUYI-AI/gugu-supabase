-- Roll back 20261120130000_group_folders: the parent release's project tables and function definitions.
-- Run as the database owner in one transaction. Bindings made after the release reach the restored device_projects when
-- each device republishes (at most every 15 minutes); clients that publish only through publish_chat_folders (released
-- after this migration) must not be in use when this runs. The Q2 idle-interval restart is not undone (it only extends).
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP VIEW identity.device_projects;
ALTER TABLE identity.device_projects_s1_backup RENAME TO device_projects;
CREATE POLICY device_projects_owner_select ON identity.device_projects FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
GRANT SELECT ON TABLE identity.device_projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE identity.device_projects TO service_role;
ALTER TABLE chat.project_groups_s1_backup RENAME TO project_groups;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE chat.project_groups TO service_role;
INSERT INTO chat.project_groups (chat_id) SELECT DISTINCT chat_id FROM identity.chat_folders ON CONFLICT (chat_id) DO NOTHING;

-- chat.is_project_group
CREATE OR REPLACE FUNCTION chat.is_project_group(p_chat_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT EXISTS (SELECT 1 FROM chat.project_groups g WHERE g.chat_id = p_chat_id);
$function$
;
REVOKE ALL ON FUNCTION chat.is_project_group(text) FROM PUBLIC,anon,authenticated,service_role;

-- chat.is_project_owner
CREATE OR REPLACE FUNCTION chat.is_project_owner(p_chat_id text, p_user_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT p_user_id IS NOT NULL AND (
        EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = p_chat_id AND c.creator_user_id = p_user_id)
        OR EXISTS (SELECT 1 FROM chat.active_members m WHERE m.chat_id = p_chat_id AND m.user_id = p_user_id AND m.role = 'owner'));
$function$
;
REVOKE ALL ON FUNCTION chat.is_project_owner(text,text) FROM PUBLIC,anon,authenticated,service_role;

-- chat.may_bind_project_group
CREATE OR REPLACE FUNCTION chat.may_bind_project_group(p_chat_id text, p_user_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT NULLIF(p_chat_id, '') IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = p_chat_id) OR chat.is_project_owner(p_chat_id, p_user_id));
$function$
;
REVOKE ALL ON FUNCTION chat.may_bind_project_group(text,text) FROM PUBLIC,anon,authenticated,service_role;

-- identity.publish_device_projects_v2
CREATE OR REPLACE FUNCTION identity.publish_device_projects_v2(p_device_id text, p_projects jsonb, p_applied_removals jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_me uuid := auth.uid();
    v_changed boolean := false;
    v_rejected jsonb;
    v_rows integer;
    v_project jsonb;
    v_folder jsonb;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NULLIF(p_device_id, '') IS NULL THEN
        RAISE EXCEPTION 'Device is required';
    END IF;
    -- The row lock serializes two publishes from the same device. NO KEY keeps it from blocking the
    -- FOR KEY SHARE that inserts into tables referencing the device take.
    PERFORM 1 FROM identity.gugu_devices WHERE device_id = p_device_id AND user_id = v_me FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Device is not owned by current user';
    END IF;

    IF p_projects IS NULL OR jsonb_typeof(p_projects) <> 'array' THEN
        RAISE EXCEPTION 'Projects must be an array';
    END IF;
    IF jsonb_array_length(p_projects) > 1000 THEN
        RAISE EXCEPTION 'A device publishes at most 1000 projects';
    END IF;
    IF p_applied_removals IS NULL OR jsonb_typeof(p_applied_removals) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(p_applied_removals)) > 1000
       OR EXISTS (SELECT 1 FROM jsonb_each(p_applied_removals) e WHERE jsonb_typeof(e.value) <> 'string') THEN
        RAISE EXCEPTION 'Applied removals must be a project to command map';
    END IF;
    FOR v_project IN SELECT value FROM jsonb_array_elements(p_projects) LOOP
        IF jsonb_typeof(v_project) <> 'object'
           OR jsonb_typeof(v_project -> 'local_project_id') IS DISTINCT FROM 'string' OR v_project ->> 'local_project_id' = ''
           OR jsonb_typeof(v_project -> 'name') IS DISTINCT FROM 'string'
           OR jsonb_typeof(v_project -> 'root_path') IS DISTINCT FROM 'string' OR v_project ->> 'root_path' = ''
           OR (v_project ? 'chat_id' AND jsonb_typeof(v_project -> 'chat_id') NOT IN ('string', 'null'))
           OR (v_project ? 'group_representative' AND jsonb_typeof(v_project -> 'group_representative') <> 'boolean')
           OR jsonb_typeof(v_project -> 'folders') IS DISTINCT FROM 'array'
           OR jsonb_typeof(v_project -> 'created_at') IS DISTINCT FROM 'string' THEN
            RAISE EXCEPTION 'Invalid project %', left(v_project::text, 200);
        END IF;
        BEGIN
            PERFORM (v_project ->> 'created_at')::timestamp with time zone;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
            RAISE EXCEPTION 'Invalid project %', left(v_project::text, 200);
        END;
        IF jsonb_array_length(v_project -> 'folders') > 1000 THEN
            RAISE EXCEPTION 'A project publishes at most 1000 folders';
        END IF;
        FOR v_folder IN SELECT value FROM jsonb_array_elements(v_project -> 'folders') LOOP
            IF jsonb_typeof(v_folder) <> 'object'
               OR jsonb_typeof(v_folder -> 'workspace_id') IS DISTINCT FROM 'string' OR v_folder ->> 'workspace_id' = ''
               OR (v_folder ->> 'kind') IS DISTINCT FROM 'root' AND (v_folder ->> 'kind') IS DISTINCT FROM 'attached'
               OR jsonb_typeof(v_folder -> 'path') IS DISTINCT FROM 'string' OR v_folder ->> 'path' = ''
               OR (v_folder ? 'attached_at' AND jsonb_typeof(v_folder -> 'attached_at') NOT IN ('string', 'null')) THEN
                RAISE EXCEPTION 'Invalid folder %', left(v_folder::text, 200);
            END IF;
        END LOOP;
    END LOOP;
    IF (SELECT count(DISTINCT value ->> 'local_project_id') FROM jsonb_array_elements(p_projects))
       <> jsonb_array_length(p_projects) THEN
        RAISE EXCEPTION 'Each project is published once';
    END IF;

    UPDATE identity.device_projects d SET removal_requested_at = NULL, removal_command_id = NULL, updated_at = now()
    FROM identity.gugu_device_commands c
    WHERE d.device_id = p_device_id AND d.user_id = v_me AND d.removal_requested_at IS NOT NULL
      AND c.id = d.removal_command_id AND c.user_id = v_me AND c.status = 'done'
      AND c.type = 'project.set_removed' AND c.payload->>'removed' = 'true'
      AND p_applied_removals->>d.local_project_id = c.id::text
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_projects) p WHERE p.value->>'local_project_id' = d.local_project_id);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := v_rows > 0;

    DELETE FROM identity.device_projects d
     WHERE d.device_id = p_device_id
       AND d.removal_requested_at IS NULL AND d.removal_command_id IS NULL
       AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(p_projects) p WHERE p.value ->> 'local_project_id' = d.local_project_id
       );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := v_changed OR v_rows > 0;

    -- Folders are stored with exactly the four keys, so a row compares equal when nothing a reader sees changed.
    INSERT INTO identity.device_projects AS d
           (device_id, user_id, local_project_id, name, root_path, created_at, chat_id, group_representative, folders)
    SELECT p_device_id, v_me, p.value ->> 'local_project_id', p.value ->> 'name', p.value ->> 'root_path',
           (p.value ->> 'created_at')::timestamp with time zone,
           -- Someone else's group is not this account's to bind: the row is kept, without the group (20261109210000).
           -- ❌ refusing the whole publish: a client that already holds such a binding would never sync any project again.
           CASE WHEN chat.may_bind_project_group(p.value ->> 'chat_id', v_me::text) THEN p.value ->> 'chat_id' END,
           COALESCE((p.value -> 'group_representative')::boolean, false),
           (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'workspace_id', f.value ->> 'workspace_id',
                       'kind', f.value ->> 'kind',
                       'path', f.value ->> 'path',
                       'attached_at', f.value -> 'attached_at'
                   ) ORDER BY f.ordinality), '[]'::jsonb)
              FROM jsonb_array_elements(p.value -> 'folders') WITH ORDINALITY f)
      FROM jsonb_array_elements(p_projects) p
    ON CONFLICT (device_id, local_project_id) DO UPDATE
       SET name = EXCLUDED.name,
           root_path = EXCLUDED.root_path,
           created_at = EXCLUDED.created_at,
           chat_id = EXCLUDED.chat_id,
           group_representative = EXCLUDED.group_representative,
           folders = EXCLUDED.folders,
           updated_at = now()
     WHERE d.removal_requested_at IS NULL AND d.removal_command_id IS NULL
       AND (d.name, d.root_path, d.created_at, d.chat_id, d.group_representative, d.folders) IS DISTINCT FROM
           (EXCLUDED.name, EXCLUDED.root_path, EXCLUDED.created_at, EXCLUDED.chat_id, EXCLUDED.group_representative,
            EXCLUDED.folders);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_changed := v_changed OR v_rows > 0;

    -- A project bound to a group is that group's project: record it (20261109210000). Only ids this account may bind
    -- (the same test that kept or dropped the row's group above).
    INSERT INTO chat.project_groups (chat_id)
    SELECT DISTINCT p.value ->> 'chat_id' FROM jsonb_array_elements(p_projects) p
     WHERE chat.may_bind_project_group(p.value ->> 'chat_id', v_me::text)
    ON CONFLICT (chat_id) DO NOTHING;

    IF v_changed THEN
        PERFORM chat.publish_user_revision(v_me::text, 'device_changed', jsonb_build_object('device_id', p_device_id, 'kind', 'projects'), false);
    END IF;
    -- Rows whose group this account may not bind (someone else's group): kept without the group, reported here so the
    -- publishing machine can show the binding as not made instead of believing it.
    SELECT COALESCE(jsonb_agg(DISTINCT p.value ->> 'local_project_id'), '[]'::jsonb) INTO v_rejected
      FROM jsonb_array_elements(p_projects) p
     WHERE NULLIF(p.value ->> 'chat_id', '') IS NOT NULL
       AND NOT chat.may_bind_project_group(p.value ->> 'chat_id', v_me::text);
    RETURN jsonb_build_object('changed', v_changed, 'rejected', v_rejected);
END;
$function$
;
REVOKE ALL ON FUNCTION identity.publish_device_projects_v2(text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION identity.publish_device_projects_v2(text,jsonb,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION identity.publish_device_projects_v2(text,jsonb,jsonb) TO service_role;

-- identity.list_my_projects
CREATE OR REPLACE FUNCTION identity.list_my_projects()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE me text := auth.uid()::text;
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(p.row ORDER BY p.active_at DESC)
        FROM (
            SELECT jsonb_build_object(
                'chat_id', c.id, 'name', c.name, 'status', c.status, 'avatar_url', c.avatar_url,
                'created_at', c.created_at, 'last_message_at', c.last_message_at,
                'bindings', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                        'device_id', dp.device_id, 'local_project_id', dp.local_project_id, 'name', dp.name,
                        'root_path', dp.root_path, 'folders', dp.folders, 'created_at', dp.created_at,
                        'removal_requested_at', dp.removal_requested_at) ORDER BY dp.created_at)
                    FROM identity.device_projects dp WHERE dp.chat_id = c.id AND dp.user_id::text = me), '[]'::jsonb)
            ) AS row, COALESCE(c.last_message_at, c.created_at) AS active_at
            FROM chat.project_groups g JOIN chat.chats c ON c.id = g.chat_id
            WHERE c.kind = 'group' AND chat.is_project_owner(c.id, me)
            UNION ALL
            -- Reserved: recorded, no group yet, bound by one of the caller's devices.
            SELECT jsonb_build_object(
                'chat_id', g.chat_id, 'name', b.bindings -> 0 ->> 'name', 'status', 'active', 'avatar_url', NULL,
                'created_at', b.first_at, 'last_message_at', NULL, 'bindings', b.bindings
            ), b.first_at
            FROM chat.project_groups g
            CROSS JOIN LATERAL (
                SELECT jsonb_agg(jsonb_build_object(
                           'device_id', dp.device_id, 'local_project_id', dp.local_project_id, 'name', dp.name,
                           'root_path', dp.root_path, 'folders', dp.folders, 'created_at', dp.created_at,
                           'removal_requested_at', dp.removal_requested_at) ORDER BY dp.created_at) AS bindings,
                       min(dp.created_at) AS first_at
                FROM identity.device_projects dp WHERE dp.chat_id = g.chat_id AND dp.user_id::text = me
            ) b
            WHERE b.bindings IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = g.chat_id)
        ) p
    ), '[]'::jsonb);
END;
$function$
;
REVOKE ALL ON FUNCTION identity.list_my_projects() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION identity.list_my_projects() TO authenticated;

-- identity.is_my_project
CREATE OR REPLACE FUNCTION identity.is_my_project(p_chat_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE me text := auth.uid()::text;
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    RETURN EXISTS (SELECT 1 FROM chat.project_groups g WHERE g.chat_id = p_chat_id)
       AND CASE WHEN EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = p_chat_id)
                THEN EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = p_chat_id AND c.kind = 'group') AND chat.is_project_owner(p_chat_id, me)
                ELSE EXISTS (SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id = p_chat_id AND dp.user_id::text = me)
           END;
END;
$function$
;
REVOKE ALL ON FUNCTION identity.is_my_project(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION identity.is_my_project(text) TO authenticated;

-- identity.set_device_project_removed
CREATE OR REPLACE FUNCTION identity.set_device_project_removed(p_device_id text, p_project_id text, p_removed boolean, p_expected_command_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_me uuid := auth.uid();
    v_before uuid;
    v_project identity.device_projects%ROWTYPE;
    v_previous identity.gugu_device_commands%ROWTYPE;
    v_command uuid;
BEGIN
    IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NULLIF(p_device_id, '') IS NULL OR NULLIF(p_project_id, '') IS NULL OR p_removed IS NULL THEN
        RAISE EXCEPTION 'Device, project and removal choice are required';
    END IF;
    SELECT removal_command_id INTO v_before FROM identity.device_projects
    WHERE user_id = v_me AND device_id = p_device_id AND local_project_id = p_project_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Project not found on this account'; END IF;
    -- Same global order as account cleanup: command before device, then project.
    IF v_before IS NOT NULL THEN
        SELECT * INTO v_previous FROM identity.gugu_device_commands
        WHERE id = v_before AND user_id = v_me FOR UPDATE;
    END IF;
    PERFORM 1 FROM identity.gugu_devices
    WHERE device_id = p_device_id AND user_id = v_me FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Device is not owned by current user'; END IF;
    SELECT * INTO v_project FROM identity.device_projects
    WHERE user_id = v_me AND device_id = p_device_id AND local_project_id = p_project_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Project not found on this account'; END IF;
    IF v_project.removal_command_id IS DISTINCT FROM v_before THEN
        RAISE EXCEPTION 'Project changed while removal was being requested; try again';
    END IF;
    IF NOT p_removed THEN
        IF v_project.removal_requested_at IS NULL AND v_before IS NULL THEN RETURN NULL; END IF;
        IF p_expected_command_id IS NULL THEN RAISE EXCEPTION 'Undo requires the removal command'; END IF;
        IF v_project.removal_requested_at IS NULL AND v_previous.payload->>'undo_of' = p_expected_command_id::text THEN
            IF v_previous.status IN ('pending', 'running', 'done') THEN RETURN v_before; END IF;
        ELSIF v_project.removal_requested_at IS NULL OR v_before IS DISTINCT FROM p_expected_command_id THEN
            RAISE EXCEPTION 'A newer project request superseded this undo';
        END IF;
    ELSIF v_project.removal_requested_at IS NOT NULL AND v_previous.status IN ('pending', 'running', 'done') THEN
        RETURN v_before;
    END IF;
    -- Cancel only unclaimed work. A running removal settles before its queued undo.
    UPDATE identity.gugu_device_commands SET status = 'error', error = 'Superseded by the owner', completed_at = now()
    WHERE id = v_before AND user_id = v_me AND status = 'pending';
    INSERT INTO identity.gugu_device_commands (user_id, device_id, type, payload)
    VALUES (v_me, p_device_id, 'project.set_removed', jsonb_build_object(
        'project_id', p_project_id, 'removed', p_removed, 'folders', v_project.folders,
        'undo_of', CASE WHEN NOT p_removed THEN p_expected_command_id ELSE NULL END
    )) RETURNING id INTO v_command;
    UPDATE identity.device_projects SET
        removal_requested_at = CASE WHEN p_removed THEN COALESCE(removal_requested_at, now()) ELSE NULL END,
        removal_command_id = v_command, updated_at = now()
    WHERE device_id = p_device_id AND local_project_id = p_project_id AND user_id = v_me;
    PERFORM chat.publish_user_revision(v_me::text, 'device_changed',
        jsonb_build_object('device_id', p_device_id, 'kind', 'projects'), false);
    RETURN v_command;
END;
$function$
;
REVOKE ALL ON FUNCTION identity.set_device_project_removed(text,text,boolean,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION identity.set_device_project_removed(text,text,boolean,uuid) TO authenticated;

-- identity.settle_device_project_removal
CREATE OR REPLACE FUNCTION identity.settle_device_project_removal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    IF NEW.type = 'project.set_removed' AND NEW.status IN ('done', 'error') AND NEW.status IS DISTINCT FROM OLD.status THEN
        UPDATE identity.device_projects SET
            removal_command_id = CASE WHEN NEW.status = 'done' AND removal_requested_at IS NULL THEN NULL ELSE removal_command_id END,
            updated_at = now()
        WHERE device_id = NEW.device_id AND user_id = NEW.user_id
          AND local_project_id = NEW.payload->>'project_id' AND removal_command_id = NEW.id;
        IF FOUND THEN
            PERFORM chat.publish_user_revision(NEW.user_id::text, 'device_changed',
                jsonb_build_object('device_id', NEW.device_id, 'kind', 'projects'), false);
        END IF;
    END IF;
    RETURN NEW;
END;
$function$
;
REVOKE ALL ON FUNCTION identity.settle_device_project_removal() FROM PUBLIC,anon,authenticated,service_role;

-- chat.group_add_denial
DO $patch$
DECLARE f regprocedure := 'chat.group_add_denial(text,text,text,boolean,boolean)'::regprocedure; d text; a text; acl aclitem[]; r text;
BEGIN
    -- The effective definition and grants at install time, not a copy taken from an earlier release.
    SELECT pg_get_functiondef(p.oid), p.proacl INTO d, acl FROM pg_proc p WHERE p.oid = f;
    a := $anchor$    SELECT * INTO v_actor FROM identity.users WHERE id = p_actor_user_id;
$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.group_add_denial(text,text,text,boolean,boolean): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$    -- 项目群只有项目的主人和主人的 agent(gugu-dev#181)。是不是项目群读 chat.project_groups(20261109210000),
    -- ❌ 从群名、群人数之类去猜。已经在群里的人不动(上一行)。
    IF v_chat.kind = 'group' AND chat.is_project_group(p_chat_id)
       AND NOT chat.is_project_owner(p_chat_id, p_user_id)
       AND NOT (v_target.owner_user_id IS NOT NULL AND chat.is_project_owner(p_chat_id, v_target.owner_user_id)) THEN
        RETURN 'project_group_owner_only';
    END IF;
    SELECT * INTO v_actor FROM identity.users WHERE id = p_actor_user_id;
$patched$);
    EXECUTE d;
    -- Replacing can close a function (installation event trigger); restore exactly the API grants it had.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    FOR r IN SELECT DISTINCT g.rolname FROM aclexplode(acl) x JOIN pg_roles g ON g.oid = x.grantee
              WHERE x.privilege_type = 'EXECUTE' AND g.rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, r);
    END LOOP;
END $patch$;

-- chat.group_info_as
DO $patch$
DECLARE f regprocedure := 'chat.group_info_as(text,text)'::regprocedure; d text; a text; acl aclitem[]; r text;
BEGIN
    -- The effective definition and grants at install time, not a copy taken from an earlier release.
    SELECT pg_get_functiondef(p.oid), p.proacl INTO d, acl FROM pg_proc p WHERE p.oid = f;
    a := $anchor$        'id', v_group.id,$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.group_info_as(text,text): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$        'is_project_group', v_group.kind = 'group' AND chat.is_project_group(p_chat_id),
        'id', v_group.id,$patched$);
    EXECUTE d;
    -- Replacing can close a function (installation event trigger); restore exactly the API grants it had.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    FOR r IN SELECT DISTINCT g.rolname FROM aclexplode(acl) x JOIN pg_roles g ON g.oid = x.grantee
              WHERE x.privilege_type = 'EXECUTE' AND g.rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, r);
    END LOOP;
END $patch$;

-- support_help.valid_configuration
DO $patch$
DECLARE f regprocedure := 'support_help.valid_configuration(uuid,bigint)'::regprocedure; d text; a text; acl aclitem[]; r text;
BEGIN
    -- The effective definition and grants at install time, not a copy taken from an earlier release.
    SELECT pg_get_functiondef(p.oid), p.proacl INTO d, acl FROM pg_proc p WHERE p.oid = f;
    a := $anchor$
    OR NOT support_help.live_human($anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'support_help.valid_configuration(uuid,bigint): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$
    OR chat.is_project_group(c.help_group_id)
    OR NOT support_help.live_human($patched$);
    EXECUTE d;
    -- Replacing can close a function (installation event trigger); restore exactly the API grants it had.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    FOR r IN SELECT DISTINCT g.rolname FROM aclexplode(acl) x JOIN pg_roles g ON g.oid = x.grantee
              WHERE x.privilege_type = 'EXECUTE' AND g.rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, r);
    END LOOP;
END $patch$;

-- chat.file_transfer_expire
DO $patch$
DECLARE f regprocedure := 'chat.file_transfer_expire(integer)'::regprocedure; d text; a text; acl aclitem[]; r text;
BEGIN
    -- The effective definition and grants at install time, not a copy taken from an earlier release.
    SELECT pg_get_functiondef(p.oid), p.proacl INTO d, acl FROM pg_proc p WHERE p.oid = f;
    a := $anchor$)
          AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_reservations d$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_transfer_expire(integer): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$
              AND NOT chat.is_project_group(ref.chat_id))
          AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_reservations d$patched$);
    EXECUTE d;
    -- Replacing can close a function (installation event trigger); restore exactly the API grants it had.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    FOR r IN SELECT DISTINCT g.rolname FROM aclexplode(acl) x JOIN pg_roles g ON g.oid = x.grantee
              WHERE x.privilege_type = 'EXECUTE' AND g.rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, r);
    END LOOP;
END $patch$;

-- chat.file_managed_upload_registered
DO $patch$
DECLARE f regprocedure := 'chat.file_managed_upload_registered(text,text,jsonb)'::regprocedure; d text; a text; acl aclitem[]; r text;
BEGIN
    -- The effective definition and grants at install time, not a copy taken from an earlier release.
    SELECT pg_get_functiondef(p.oid), p.proacl INTO d, acl FROM pg_proc p WHERE p.oid = f;
    a := $anchor$EXISTS(SELECT 1 FROM identity.chat_folders f WHERE f.chat_id=u.chat_id AND f.user_id::text=u.account_id)$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_managed_upload_registered(text,text,jsonb): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$chat.is_project_group(u.chat_id)$patched$);
    EXECUTE d;
    -- Replacing can close a function (installation event trigger); restore exactly the API grants it had.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    FOR r IN SELECT DISTINCT g.rolname FROM aclexplode(acl) x JOIN pg_roles g ON g.oid = x.grantee
              WHERE x.privilege_type = 'EXECUTE' AND g.rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, r);
    END LOOP;
END $patch$;

-- chat.file_storage_overview_as
DO $patch$
DECLARE f regprocedure := 'chat.file_storage_overview_as()'::regprocedure; d text; a text; acl aclitem[]; r text;
BEGIN
    -- The effective definition and grants at install time, not a copy taken from an earlier release.
    SELECT pg_get_functiondef(p.oid), p.proacl INTO d, acl FROM pg_proc p WHERE p.oid = f;
    a := $anchor$'has_folders',EXISTS(SELECT 1 FROM identity.chat_folders f WHERE f.chat_id=m.chat_id AND f.user_id::text=me),
                'project',EXISTS(SELECT 1 FROM identity.chat_folders f WHERE f.chat_id=m.chat_id AND f.user_id::text=me),$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_storage_overview_as(): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$'project',chat.is_project_group(m.chat_id),$patched$);
    EXECUTE d;
    -- Replacing can close a function (installation event trigger); restore exactly the API grants it had.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    FOR r IN SELECT DISTINCT g.rolname FROM aclexplode(acl) x JOIN pg_roles g ON g.oid = x.grantee
              WHERE x.privilege_type = 'EXECUTE' AND g.rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, r);
    END LOOP;
END $patch$;

-- chat.file_resolve_availability_base
DO $patch$
DECLARE f regprocedure := 'chat.file_resolve_availability_base(jsonb,text)'::regprocedure; d text; a text; acl aclitem[]; r text;
BEGIN
    -- The effective definition and grants at install time, not a copy taken from an earlier release.
    SELECT pg_get_functiondef(p.oid), p.proacl INTO d, acl FROM pg_proc p WHERE p.oid = f;
    a := $anchor$            -- Gone with its device, or with its folder's binding to this chat (a device store needs none).
            SELECT * INTO holder FROM identity.gugu_devices WHERE device_id=d.host_device_id;
            IF NOT FOUND OR NOT chat.device_holds(d.host_device_id,d.host_project_id,w.chat_id) THEN$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_resolve_availability_base(jsonb,text): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$            -- Gone with its device, or with its project's binding to this chat (a device store needs none).
            SELECT * INTO holder FROM identity.gugu_devices WHERE device_id=d.host_device_id;
            IF NOT FOUND OR d.host_project_id<>'device-store' AND NOT EXISTS(SELECT 1 FROM identity.device_projects dp
                WHERE dp.device_id=d.host_device_id AND dp.local_project_id=d.host_project_id AND dp.chat_id=w.chat_id) THEN$patched$);
    EXECUTE d;
    -- Replacing can close a function (installation event trigger); restore exactly the API grants it had.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    FOR r IN SELECT DISTINCT g.rolname FROM aclexplode(acl) x JOIN pg_roles g ON g.oid = x.grantee
              WHERE x.privilege_type = 'EXECUTE' AND g.rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, r);
    END LOOP;
END $patch$;

-- chat.file_availability_batch
DO $patch$
DECLARE f regprocedure := 'chat.file_availability_batch(uuid[],integer[],uuid[],text[])'::regprocedure; d text; a text; acl aclitem[]; r text;
BEGIN
    -- The effective definition and grants at install time, not a copy taken from an earlier release.
    SELECT pg_get_functiondef(p.oid), p.proacl INTO d, acl FROM pg_proc p WHERE p.oid = f;
    a := $anchor$            d.device_id,chat.device_holds(v.host_device_id,v.host_project_id,w.chat_id) AS bound,$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_availability_batch(uuid[],integer[],uuid[],text[]): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$            d.device_id,dp.local_project_id AS bound_project,$patched$);
    a := $anchor$        LEFT JOIN chat.chats c ON c.id=COALESCE(w.chat_id,r.chat_id)$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_availability_batch(uuid[],integer[],uuid[],text[]): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$        LEFT JOIN identity.device_projects dp ON dp.device_id=v.host_device_id AND dp.local_project_id=v.host_project_id AND dp.chat_id=w.chat_id
        LEFT JOIN chat.chats c ON c.id=COALESCE(w.chat_id,r.chat_id)$patched$);
    a := $anchor$                AND s.bound THEN 'available'$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_availability_batch(uuid[],integer[],uuid[],text[]): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$                AND (s.host_project_id='device-store' OR s.bound_project IS NOT NULL) THEN 'available'$patched$);
    EXECUTE d;
    -- Replacing can close a function (installation event trigger); restore exactly the API grants it had.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    FOR r IN SELECT DISTINCT g.rolname FROM aclexplode(acl) x JOIN pg_roles g ON g.oid = x.grantee
              WHERE x.privilege_type = 'EXECUTE' AND g.rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, r);
    END LOOP;
END $patch$;

-- file_private.publish_revision
DO $patch$
DECLARE f regprocedure := 'file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid,integer,integer)'::regprocedure; d text; a text; acl aclitem[]; r text;
BEGIN
    -- The effective definition and grants at install time, not a copy taken from an earlier release.
    SELECT pg_get_functiondef(p.oid), p.proacl INTO d, acl FROM pg_proc p WHERE p.oid = f;
    a := $anchor$    -- A released client may send into a group its device bound before the group existed (identity.chat_folders_pending).
    IF NOT EXISTS(SELECT 1 FROM identity.chat_folders f WHERE f.device_id=p_device AND f.chat_id=g) THEN
        PERFORM identity.adopt_pending_chat_folders(p_device,g);
    END IF;
    -- Clients released before this one name no folder: the device's first folder bound to the chat.
    IF project IS NULL THEN
        SELECT CASE WHEN f.legacy_root THEN f.legacy_project_id ELSE f.folder_id END INTO project FROM identity.chat_folders f
         WHERE f.device_id=p_device AND f.chat_id=g AND f.user_id=auth.uid()
         ORDER BY f.position,f.folder_id LIMIT 1;
    END IF;
    IF project IS NULL OR NOT chat.device_holds(p_device,project,g) THEN
        RAISE EXCEPTION 'This device keeps no folder for this chat' USING HINT='file_transfer_denied';$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid,integer,integer): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$    -- Clients released before this one name no project: the device's own project bound to the chat.
    IF project IS NULL THEN
        SELECT dp.local_project_id INTO project FROM identity.device_projects dp
         WHERE dp.device_id=p_device AND dp.chat_id=g AND dp.user_id=auth.uid()
         ORDER BY dp.group_representative DESC,dp.created_at,dp.local_project_id LIMIT 1;
    END IF;
    IF project IS NULL OR project<>'device-store' AND NOT EXISTS(SELECT 1 FROM identity.device_projects dp
        WHERE dp.device_id=p_device AND dp.local_project_id=project AND dp.chat_id=g AND dp.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'This device keeps no project for this chat' USING HINT='file_transfer_denied';$patched$);
    EXECUTE d;
    -- Replacing can close a function (installation event trigger); restore exactly the API grants it had.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    FOR r IN SELECT DISTINCT g.rolname FROM aclexplode(acl) x JOIN pg_roles g ON g.oid = x.grantee
              WHERE x.privilege_type = 'EXECUTE' AND g.rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, r);
    END LOOP;
END $patch$;

-- chat.file_project_policy_as
DO $patch$
DECLARE f regprocedure := 'chat.file_project_policy_as(text,text,text,boolean,boolean,text)'::regprocedure; d text; a text; acl aclitem[]; r text;
BEGIN
    -- The effective definition and grants at install time, not a copy taken from an earlier release.
    SELECT pg_get_functiondef(p.oid), p.proacl INTO d, acl FROM pg_proc p WHERE p.oid = f;
    a := $anchor$    IF p_project='device-store' OR NOT chat.device_holds(p_device,p_project,g)
       OR NOT EXISTS(SELECT 1 FROM identity.gugu_devices d WHERE d.device_id=p_device AND d.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'This device keeps no folder for this chat' USING HINT='file_transfer_denied';$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_project_policy_as(text,text,text,boolean,boolean,text): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$    IF NOT EXISTS(SELECT 1 FROM identity.device_projects dp JOIN identity.gugu_devices d ON d.device_id=dp.device_id
        WHERE dp.device_id=p_device AND dp.local_project_id=p_project AND dp.chat_id=g AND dp.user_id=auth.uid() AND d.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'This device keeps no project for this chat' USING HINT='file_transfer_denied';$patched$);
    EXECUTE d;
    -- Replacing can close a function (installation event trigger); restore exactly the API grants it had.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    FOR r IN SELECT DISTINCT g.rolname FROM aclexplode(acl) x JOIN pg_roles g ON g.oid = x.grantee
              WHERE x.privilege_type = 'EXECUTE' AND g.rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, r);
    END LOOP;
END $patch$;


DROP FUNCTION identity.adopt_pending_chat_folders(text, text);
DROP TABLE identity.chat_folders_pending;
DROP FUNCTION identity.publish_chat_folders(text, jsonb, jsonb);
DROP FUNCTION identity.my_chat_folders();
DROP FUNCTION identity.set_chat_folder_removed(text, text, boolean, uuid);
DROP FUNCTION chat.device_holds(text, text, text);
DROP TABLE identity.chat_folders;
NOTIFY pgrst, 'reload schema';
COMMIT;
