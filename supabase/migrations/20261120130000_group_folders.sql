-- A group is the only container: folders on a device are an optional attribute of a group (project/group unification).
--
-- Until now a "project" was a group plus two records: chat.project_groups marked the group, and every device published
-- identity.device_projects rows (one local project, its root and attached folders, bound to the group by chat_id). The
-- marker carried rules of its own: only the owner and the owner's agents could join, large idle cloud files were never
-- expired, the group could not be a help group, and an id could be bound before its group existed.
--
-- From this release:
--   · identity.chat_folders is the one record: one row per folder a device binds to a group (device, folder, group, path,
--     position). Only the binding account reads its rows; a path never reaches other members.
--   · Any group may hold folders and invite anyone: the owner-only rule, the help-group restriction and the
--     is_project_group key of group_info_as are gone.
--   · Idle expiry of cloud objects applies to every group. The references the old exemption kept alive restart their idle
--     interval at this release (the re-registration idiom of 20261027033000: last_download_at NULL, retention now), so none
--     is deleted the moment the exemption goes.
--   · A binding names a group that exists and that the binding account is an active member of. Reserved ids (a binding
--     before its group) are no longer recorded; existing bindings to a missing group are dropped here and counted.
--   · File versions are unchanged. host_project_id stays the holding device's own key: a folder id for clients from the
--     next release, the local project id for earlier ones. A version is held while its device binds, in its chat, a folder
--     with that id, or a root folder that came from that project (chat.device_holds). A version whose project root was
--     detached is no longer held: its relative path is relative to that root.
--   · Released clients keep working through boundary adapters over chat_folders: publish_device_projects(_v2),
--     list_my_projects, is_my_project, set_device_project_removed, the project.set_removed command and a read-only view
--     identity.device_projects with the old row shape. The legacy_* columns exist only for them. All of it, and the
--     backup table identity.device_projects_s1_backup, goes in the cleanup release once those clients are retired.
--
-- Locks: identity.device_projects is renamed (ACCESS EXCLUSIVE on a table of a few hundred rows, written only by the
-- publish RPCs replaced here); chat.project_groups is dropped. No other existing table gets a column, trigger or key.
-- Rollback: ops/rollback-group-folders.sql.
SET LOCAL lock_timeout = '5s';

CREATE TABLE identity.chat_folders (
    device_id text NOT NULL REFERENCES identity.gugu_devices (device_id) ON DELETE CASCADE,
    user_id uuid NOT NULL,
    -- The device's own id of the folder (its workspace id); the key file versions held in it carry.
    folder_id text NOT NULL,
    chat_id text NOT NULL REFERENCES chat.chats (id) ON DELETE CASCADE,
    path text NOT NULL,
    -- Order of the group's folders on this device (the first is where a new task starts by default).
    position integer NOT NULL,
    attached_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    -- Offline unbinding: the device applies a queued command, then republishes.
    removal_requested_at timestamp with time zone,
    removal_command_id uuid REFERENCES identity.gugu_device_commands (id) ON DELETE SET NULL,
    -- Released clients only (removed with their adapters): the local project a folder came from, its name and root path,
    -- and whether the folder was that project's root.
    legacy_project_id text,
    legacy_name text,
    legacy_root_path text,
    legacy_root boolean NOT NULL DEFAULT false,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, folder_id),
    CONSTRAINT chat_folders_folder_id CHECK (folder_id <> '' AND folder_id <> 'device-store'),
    CONSTRAINT chat_folders_path CHECK (path <> ''),
    CONSTRAINT chat_folders_legacy CHECK (legacy_project_id IS NOT NULL OR NOT legacy_root)
);
CREATE INDEX chat_folders_user_idx ON identity.chat_folders (user_id);
CREATE INDEX chat_folders_chat_idx ON identity.chat_folders (chat_id, device_id);
CREATE INDEX chat_folders_legacy_idx ON identity.chat_folders (device_id, legacy_project_id) WHERE legacy_project_id IS NOT NULL;

ALTER TABLE identity.chat_folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_folders_owner_select ON identity.chat_folders
    FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
REVOKE ALL ON TABLE identity.chat_folders FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE identity.chat_folders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE identity.chat_folders TO service_role;

-- Released clients only (removed with their adapters): a released client publishes a project bound to a group id before
-- the first agent creates that group, then sends files into the group as soon as it exists. The bindings that named a
-- chat that did not exist yet wait here, unread by clients, until that device publishes a file into that group as an
-- active member (identity.adopt_pending_chat_folders) or republishes after the group exists.
CREATE TABLE identity.chat_folders_pending (
    device_id text NOT NULL REFERENCES identity.gugu_devices (device_id) ON DELETE CASCADE,
    user_id uuid NOT NULL,
    chat_id text NOT NULL,
    -- The folder rows publish_device_projects_v2 would record once the group exists (its own row shape).
    folders jsonb NOT NULL CHECK (jsonb_typeof(folders) = 'array'),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, chat_id)
);
ALTER TABLE identity.chat_folders_pending ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE identity.chat_folders_pending FROM PUBLIC, anon, authenticated, service_role;

-- Does this device still hold, in this chat, the folder a version names (p_ref = its host_project_id).
CREATE FUNCTION chat.device_holds(p_device text, p_ref text, p_chat text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT p_device IS NOT NULL AND p_ref IS NOT NULL AND (p_ref = 'device-store' OR EXISTS (
        SELECT 1 FROM identity.chat_folders f
         WHERE f.device_id = p_device AND f.chat_id = p_chat
           AND (f.folder_id = p_ref OR f.legacy_root AND f.legacy_project_id = p_ref)))
$$;
REVOKE ALL ON FUNCTION chat.device_holds(text, text, text) FROM PUBLIC, anon, authenticated, service_role;

-- ===== Backfill from identity.device_projects =====
DO $$
DECLARE v_folders bigint; v_kept bigint; v_no_chat bigint; v_missing_chat bigint; v_not_member bigint;
    v_rootless bigint; v_pending_lost bigint;
BEGIN
    SELECT count(*) INTO v_folders FROM identity.device_projects dp, jsonb_array_elements(dp.folders);
    IF EXISTS (SELECT 1 FROM identity.device_projects dp, jsonb_array_elements(dp.folders) f
                GROUP BY dp.device_id, f.value->>'workspace_id' HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'A device lists one folder under two projects; resolve before this release';
    END IF;

    INSERT INTO identity.chat_folders (device_id, user_id, folder_id, chat_id, path, position, attached_at, created_at,
           removal_requested_at, removal_command_id, legacy_project_id, legacy_name, legacy_root_path, legacy_root)
    SELECT dp.device_id, dp.user_id, f.value->>'workspace_id', dp.chat_id, f.value->>'path',
           row_number() OVER (PARTITION BY dp.device_id, dp.chat_id
                              ORDER BY dp.group_representative DESC, dp.created_at, dp.local_project_id, f.ordinality)::integer,
           (f.value->>'attached_at')::timestamp with time zone, dp.created_at,
           dp.removal_requested_at, dp.removal_command_id, dp.local_project_id, dp.name, dp.root_path,
           f.value->>'kind' = 'root'
      FROM identity.device_projects dp
      CROSS JOIN LATERAL jsonb_array_elements(dp.folders) WITH ORDINALITY f
      JOIN chat.chats c ON c.id = dp.chat_id AND c.kind = 'group'
     WHERE EXISTS (SELECT 1 FROM chat.active_members m WHERE m.chat_id = c.id AND m.user_id = dp.user_id::text);
    GET DIAGNOSTICS v_kept = ROW_COUNT;
    -- Bindings to a group that does not exist yet wait as pending, as a released client's next publish would leave them.
    INSERT INTO identity.chat_folders_pending (device_id, user_id, chat_id, folders)
    SELECT dp.device_id, min(dp.user_id::text)::uuid, dp.chat_id,
           jsonb_agg(jsonb_build_object('folder_id', f.value->>'workspace_id', 'path', f.value->>'path',
               'attached_at', f.value->'attached_at', 'created_at', dp.created_at, 'legacy_project_id', dp.local_project_id,
               'legacy_name', dp.name, 'legacy_root_path', dp.root_path, 'legacy_root', f.value->>'kind' = 'root')
               ORDER BY dp.group_representative DESC, dp.created_at, dp.local_project_id, f.ordinality)
      FROM identity.device_projects dp
      CROSS JOIN LATERAL jsonb_array_elements(dp.folders) WITH ORDINALITY f
     WHERE dp.chat_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = dp.chat_id)
     GROUP BY dp.device_id, dp.chat_id;
    UPDATE identity.chat_folders_pending p SET folders = (SELECT jsonb_agg(r.value || jsonb_build_object('position', r.ordinality))
                                                            FROM jsonb_array_elements(p.folders) WITH ORDINALITY r);

    SELECT count(*) FILTER (WHERE dp.chat_id IS NULL),
           count(*) FILTER (WHERE dp.chat_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = dp.chat_id)),
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = dp.chat_id)
               AND NOT EXISTS (SELECT 1 FROM chat.chats c JOIN chat.active_members m ON m.chat_id = c.id
                                WHERE c.id = dp.chat_id AND c.kind = 'group' AND m.user_id = dp.user_id::text)),
           count(*) FILTER (WHERE dp.removal_requested_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM identity.chat_folders f
                                WHERE f.device_id = dp.device_id AND f.legacy_project_id = dp.local_project_id))
      INTO v_no_chat, v_missing_chat, v_not_member, v_pending_lost
      FROM identity.device_projects dp;
    -- Bound versions whose project root is no longer listed: no longer held (their paths are relative to that root).
    SELECT count(*) INTO v_rootless FROM chat.workspace_item_versions v
     WHERE v.host_project_id IS NOT NULL AND v.host_project_id <> 'device-store'
       AND EXISTS (SELECT 1 FROM identity.device_projects dp WHERE dp.device_id = v.host_device_id AND dp.local_project_id = v.host_project_id
                     AND dp.chat_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM identity.chat_folders f WHERE f.device_id = v.host_device_id
                         AND f.legacy_project_id = v.host_project_id AND f.legacy_root);

    RAISE NOTICE 'group folders backfill: % folders listed, % kept; projects skipped: % without a group, % naming a group that does not exist yet (kept pending), % in a group the device owner is not an active member of; % bound versions lose a detached root',
        v_folders, v_kept, v_no_chat, v_missing_chat, v_not_member, v_rootless;
    -- Every listed folder is either kept or belongs to a skipped project.
    IF v_kept <> (SELECT count(*) FROM identity.device_projects dp, jsonb_array_elements(dp.folders) f
                   WHERE EXISTS (SELECT 1 FROM chat.chats c JOIN chat.active_members m ON m.chat_id = c.id
                                  WHERE c.id = dp.chat_id AND c.kind = 'group' AND m.user_id = dp.user_id::text)) THEN
        RAISE EXCEPTION 'group folders backfill lost folders';
    END IF;
    IF v_pending_lost > 0 THEN
        RAISE EXCEPTION 'group folders backfill: % pending offline removals would be lost', v_pending_lost;
    END IF;
END $$;

-- ===== Anchored patches of existing functions (each anchor must occur exactly once in the effective definition) =====

-- chat.group_add_denial
DO $patch$
DECLARE f regprocedure := 'chat.group_add_denial(text,text,text,boolean,boolean)'::regprocedure; d text; a text; acl aclitem[]; r text;
BEGIN
    -- The effective definition and grants at install time, not a copy taken from an earlier release.
    SELECT pg_get_functiondef(p.oid), p.proacl INTO d, acl FROM pg_proc p WHERE p.oid = f;
    a := $anchor$    -- 项目群只有项目的主人和主人的 agent(gugu-dev#181)。是不是项目群读 chat.project_groups(20261109210000),
    -- ❌ 从群名、群人数之类去猜。已经在群里的人不动(上一行)。
    IF v_chat.kind = 'group' AND chat.is_project_group(p_chat_id)
       AND NOT chat.is_project_owner(p_chat_id, p_user_id)
       AND NOT (v_target.owner_user_id IS NOT NULL AND chat.is_project_owner(p_chat_id, v_target.owner_user_id)) THEN
        RETURN 'project_group_owner_only';
    END IF;
    SELECT * INTO v_actor FROM identity.users WHERE id = p_actor_user_id;
$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.group_add_denial(text,text,text,boolean,boolean): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$    SELECT * INTO v_actor FROM identity.users WHERE id = p_actor_user_id;
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
    a := $anchor$        'is_project_group', v_group.kind = 'group' AND chat.is_project_group(p_chat_id),
        'id', v_group.id,$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.group_info_as(text,text): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$        'id', v_group.id,$patched$);
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
    OR chat.is_project_group(c.help_group_id)
    OR NOT support_help.live_human($anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'support_help.valid_configuration(uuid,bigint): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$
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
    a := $anchor$
              AND NOT chat.is_project_group(ref.chat_id))
          AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_reservations d$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_transfer_expire(integer): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$)
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
    a := $anchor$chat.is_project_group(u.chat_id)$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_managed_upload_registered(text,text,jsonb): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$EXISTS(SELECT 1 FROM identity.chat_folders f WHERE f.chat_id=u.chat_id AND f.user_id::text=u.account_id)$patched$);
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
    a := $anchor$'project',chat.is_project_group(m.chat_id),$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_storage_overview_as(): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$'has_folders',EXISTS(SELECT 1 FROM identity.chat_folders f WHERE f.chat_id=m.chat_id AND f.user_id::text=me),
                'project',EXISTS(SELECT 1 FROM identity.chat_folders f WHERE f.chat_id=m.chat_id AND f.user_id::text=me),$patched$);
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
    a := $anchor$            -- Gone with its device, or with its project's binding to this chat (a device store needs none).
            SELECT * INTO holder FROM identity.gugu_devices WHERE device_id=d.host_device_id;
            IF NOT FOUND OR d.host_project_id<>'device-store' AND NOT EXISTS(SELECT 1 FROM identity.device_projects dp
                WHERE dp.device_id=d.host_device_id AND dp.local_project_id=d.host_project_id AND dp.chat_id=w.chat_id) THEN$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_resolve_availability_base(jsonb,text): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$            -- Gone with its device, or with its folder's binding to this chat (a device store needs none).
            SELECT * INTO holder FROM identity.gugu_devices WHERE device_id=d.host_device_id;
            IF NOT FOUND OR NOT chat.device_holds(d.host_device_id,d.host_project_id,w.chat_id) THEN$patched$);
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
    a := $anchor$            d.device_id,dp.local_project_id AS bound_project,$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_availability_batch(uuid[],integer[],uuid[],text[]): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$            d.device_id,chat.device_holds(v.host_device_id,v.host_project_id,w.chat_id) AS bound,$patched$);
    a := $anchor$        LEFT JOIN identity.device_projects dp ON dp.device_id=v.host_device_id AND dp.local_project_id=v.host_project_id AND dp.chat_id=w.chat_id
        LEFT JOIN chat.chats c ON c.id=COALESCE(w.chat_id,r.chat_id)$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_availability_batch(uuid[],integer[],uuid[],text[]): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$        LEFT JOIN chat.chats c ON c.id=COALESCE(w.chat_id,r.chat_id)$patched$);
    a := $anchor$                AND (s.host_project_id='device-store' OR s.bound_project IS NOT NULL) THEN 'available'$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_availability_batch(uuid[],integer[],uuid[],text[]): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$                AND s.bound THEN 'available'$patched$);
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
    a := $anchor$    -- Clients released before this one name no project: the device's own project bound to the chat.
    IF project IS NULL THEN
        SELECT dp.local_project_id INTO project FROM identity.device_projects dp
         WHERE dp.device_id=p_device AND dp.chat_id=g AND dp.user_id=auth.uid()
         ORDER BY dp.group_representative DESC,dp.created_at,dp.local_project_id LIMIT 1;
    END IF;
    IF project IS NULL OR project<>'device-store' AND NOT EXISTS(SELECT 1 FROM identity.device_projects dp
        WHERE dp.device_id=p_device AND dp.local_project_id=project AND dp.chat_id=g AND dp.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'This device keeps no project for this chat' USING HINT='file_transfer_denied';$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid,integer,integer): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$    -- A released client may send into a group its device bound before the group existed (identity.chat_folders_pending).
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
        RAISE EXCEPTION 'This device keeps no folder for this chat' USING HINT='file_transfer_denied';$patched$);
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
    a := $anchor$    IF NOT EXISTS(SELECT 1 FROM identity.device_projects dp JOIN identity.gugu_devices d ON d.device_id=dp.device_id
        WHERE dp.device_id=p_device AND dp.local_project_id=p_project AND dp.chat_id=g AND dp.user_id=auth.uid() AND d.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'This device keeps no project for this chat' USING HINT='file_transfer_denied';$anchor$;
    IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
        RAISE EXCEPTION 'chat.file_project_policy_as(text,text,text,boolean,boolean,text): patch anchor does not occur exactly once: %', left(a, 120);
    END IF;
    d := replace(d, a, $patched$    IF p_project='device-store' OR NOT chat.device_holds(p_device,p_project,g)
       OR NOT EXISTS(SELECT 1 FROM identity.gugu_devices d WHERE d.device_id=p_device AND d.user_id=auth.uid()) THEN
        RAISE EXCEPTION 'This device keeps no folder for this chat' USING HINT='file_transfer_denied';$patched$);
    EXECUTE d;
    -- Replacing can close a function (installation event trigger); restore exactly the API grants it had.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
    FOR r IN SELECT DISTINCT g.rolname FROM aclexplode(acl) x JOIN pg_roles g ON g.oid = x.grantee
              WHERE x.privilege_type = 'EXECUTE' AND g.rolname IN ('anon', 'authenticated', 'service_role') LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', f, r);
    END LOOP;
END $patch$;

-- ===== Binding folders (clients from the next release) =====

-- Replace the folders this device binds to groups with p_folders:
--   [{ "folder_id", "chat_id", "path", "attached_at" | null }], in the order the device shows them.
-- A folder binds only a group that exists and that the caller is an active member of; the others are answered in
-- rejected (folder ids) and not recorded. Rows with an offline removal in flight are kept until the device applies it
-- (p_applied_removals: { folder_id: command id }). Returns { changed, rejected }; the account revision advances only on a
-- change, with the same device_changed event released clients follow.
CREATE FUNCTION identity.publish_chat_folders(p_device_id text, p_folders jsonb, p_applied_removals jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := auth.uid(); v_changed boolean := false; v_rows integer; v_folder jsonb; v_rejected jsonb; v_bound jsonb;
BEGIN
    IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NULLIF(p_device_id, '') IS NULL THEN RAISE EXCEPTION 'Device is required'; END IF;
    -- Serializes two publishes from one device; NO KEY keeps it from blocking inserts that reference the device.
    PERFORM 1 FROM identity.gugu_devices WHERE device_id = p_device_id AND user_id = v_me FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Device is not owned by current user'; END IF;
    IF p_folders IS NULL OR jsonb_typeof(p_folders) <> 'array' THEN RAISE EXCEPTION 'Folders must be an array'; END IF;
    IF jsonb_array_length(p_folders) > 1000 THEN RAISE EXCEPTION 'A device publishes at most 1000 folders'; END IF;
    IF p_applied_removals IS NULL OR jsonb_typeof(p_applied_removals) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(p_applied_removals)) > 1000
       OR EXISTS (SELECT 1 FROM jsonb_each(p_applied_removals) e WHERE jsonb_typeof(e.value) <> 'string') THEN
        RAISE EXCEPTION 'Applied removals must be a folder to command map';
    END IF;
    FOR v_folder IN SELECT value FROM jsonb_array_elements(p_folders) LOOP
        IF jsonb_typeof(v_folder) <> 'object'
           OR jsonb_typeof(v_folder -> 'folder_id') IS DISTINCT FROM 'string' OR v_folder ->> 'folder_id' IN ('', 'device-store')
           OR jsonb_typeof(v_folder -> 'chat_id') IS DISTINCT FROM 'string' OR v_folder ->> 'chat_id' = ''
           OR jsonb_typeof(v_folder -> 'path') IS DISTINCT FROM 'string' OR v_folder ->> 'path' = ''
           OR (v_folder ? 'attached_at' AND jsonb_typeof(v_folder -> 'attached_at') NOT IN ('string', 'null')) THEN
            RAISE EXCEPTION 'Invalid folder %', left(v_folder::text, 200);
        END IF;
        BEGIN PERFORM (v_folder ->> 'attached_at')::timestamp with time zone;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'Invalid folder %', left(v_folder::text, 200);
        END;
    END LOOP;
    IF (SELECT count(DISTINCT value ->> 'folder_id') FROM jsonb_array_elements(p_folders)) <> jsonb_array_length(p_folders) THEN
        RAISE EXCEPTION 'Each folder is published once';
    END IF;

    -- The folders this account may bind (each with its position in its group), and the rest.
    SELECT COALESCE(jsonb_agg(x.folder ORDER BY x.ord) FILTER (WHERE x.ok), '[]'::jsonb),
           COALESCE(jsonb_agg(x.folder ->> 'folder_id' ORDER BY x.ord) FILTER (WHERE NOT x.ok), '[]'::jsonb)
      INTO v_bound, v_rejected
      FROM (SELECT f.value || jsonb_build_object('position', row_number() OVER (PARTITION BY f.value ->> 'chat_id', b.ok ORDER BY f.ordinality)) AS folder,
                   f.ordinality AS ord, b.ok
              FROM jsonb_array_elements(p_folders) WITH ORDINALITY f
             CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM chat.chats c JOIN chat.active_members m ON m.chat_id = c.id
                    WHERE c.id = f.value ->> 'chat_id' AND c.kind = 'group' AND m.user_id = v_me::text) AS ok) b) x;

    UPDATE identity.chat_folders d SET removal_requested_at = NULL, removal_command_id = NULL, updated_at = now()
      FROM identity.gugu_device_commands c
     WHERE d.device_id = p_device_id AND d.user_id = v_me AND d.removal_requested_at IS NOT NULL
       AND c.id = d.removal_command_id AND c.user_id = v_me AND c.status = 'done'
       AND c.type = 'project.set_removed' AND c.payload ->> 'removed' = 'true'
       AND p_applied_removals ->> d.folder_id = c.id::text
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_folders) p WHERE p.value ->> 'folder_id' = d.folder_id);
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_changed := v_rows > 0;

    DELETE FROM identity.chat_folders d
     WHERE d.device_id = p_device_id AND d.removal_requested_at IS NULL AND d.removal_command_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_bound) p WHERE p.value ->> 'folder_id' = d.folder_id AND p.value ->> 'chat_id' = d.chat_id);
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_changed := v_changed OR v_rows > 0;

    -- A folder that came from a released client's project keeps its legacy_* columns: versions published then name it.
    INSERT INTO identity.chat_folders AS d (device_id, user_id, folder_id, chat_id, path, position, attached_at, created_at)
    SELECT p_device_id, v_me, p.value ->> 'folder_id', p.value ->> 'chat_id', p.value ->> 'path',
           (p.value ->> 'position')::integer, (p.value ->> 'attached_at')::timestamptz, now()
      FROM jsonb_array_elements(v_bound) p
    ON CONFLICT (device_id, folder_id) DO UPDATE
       SET path = EXCLUDED.path, position = EXCLUDED.position, attached_at = EXCLUDED.attached_at, updated_at = now()
     WHERE d.removal_requested_at IS NULL AND d.removal_command_id IS NULL AND d.chat_id = EXCLUDED.chat_id
       AND (d.path, d.position, d.attached_at) IS DISTINCT FROM (EXCLUDED.path, EXCLUDED.position, EXCLUDED.attached_at);
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_changed := v_changed OR v_rows > 0;

    IF v_changed THEN
        PERFORM chat.publish_user_revision(v_me::text, 'device_changed', jsonb_build_object('device_id', p_device_id, 'kind', 'projects'), false);
    END IF;
    RETURN jsonb_build_object('changed', v_changed, 'rejected', v_rejected);
END $$;
REVOKE ALL ON FUNCTION identity.publish_chat_folders(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION identity.publish_chat_folders(text, jsonb, jsonb) TO authenticated;

-- The caller's folders by group, most recently active group first: [{ chat_id, name, status, avatar_url,
-- last_message_at, folders: [{ device_id, folder_id, path, position, attached_at, removal_requested_at }] }].
CREATE FUNCTION identity.my_chat_folders() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE me uuid := auth.uid();
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(g.row ORDER BY g.active_at DESC, g.chat_id)
          FROM (SELECT c.id AS chat_id, COALESCE(c.last_message_at, c.created_at) AS active_at,
                       jsonb_build_object('chat_id', c.id, 'name', c.name, 'status', c.status, 'avatar_url', c.avatar_url,
                           'last_message_at', c.last_message_at,
                           'folders', jsonb_agg(jsonb_build_object('device_id', f.device_id, 'folder_id', f.folder_id,
                               'path', f.path, 'position', f.position, 'attached_at', f.attached_at,
                               'removal_requested_at', f.removal_requested_at) ORDER BY f.device_id, f.position, f.folder_id)) AS row
                  FROM identity.chat_folders f JOIN chat.chats c ON c.id = f.chat_id
                 WHERE f.user_id = me
                 GROUP BY c.id) g), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION identity.my_chat_folders() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION identity.my_chat_folders() TO authenticated;

-- Unbind (or undo unbinding) the folders a key names on one of the caller's devices, through the device command queue so
-- an offline device applies it when it comes back. p_key is a folder id, or a released client's local project id (all
-- folders that came from it). The command keeps its released name and payload shape (project.set_removed, project_id,
-- folders): devices of earlier releases apply it.
CREATE FUNCTION identity.set_chat_folder_removed(p_device_id text, p_key text, p_removed boolean, p_expected_command_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := auth.uid(); v_before uuid; v_requested timestamptz; v_previous identity.gugu_device_commands%ROWTYPE;
    v_command uuid; v_folders jsonb;
BEGIN
    IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NULLIF(p_device_id, '') IS NULL OR NULLIF(p_key, '') IS NULL OR p_removed IS NULL THEN
        RAISE EXCEPTION 'Device, folder and removal choice are required';
    END IF;
    SELECT f.removal_command_id INTO v_before FROM identity.chat_folders f
     WHERE f.user_id = v_me AND f.device_id = p_device_id AND (f.folder_id = p_key OR f.legacy_project_id = p_key)
     ORDER BY f.position LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Folder not found on this account'; END IF;
    -- Same global order as account cleanup: command before device, then folders.
    IF v_before IS NOT NULL THEN
        SELECT * INTO v_previous FROM identity.gugu_device_commands WHERE id = v_before AND user_id = v_me FOR UPDATE;
    END IF;
    PERFORM 1 FROM identity.gugu_devices WHERE device_id = p_device_id AND user_id = v_me FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Device is not owned by current user'; END IF;
    PERFORM 1 FROM identity.chat_folders f
     WHERE f.user_id = v_me AND f.device_id = p_device_id AND (f.folder_id = p_key OR f.legacy_project_id = p_key) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Folder not found on this account'; END IF;
    IF EXISTS (SELECT 1 FROM identity.chat_folders f WHERE f.user_id = v_me AND f.device_id = p_device_id
                  AND (f.folder_id = p_key OR f.legacy_project_id = p_key) AND f.removal_command_id IS DISTINCT FROM v_before) THEN
        RAISE EXCEPTION 'Folder changed while removal was being requested; try again';
    END IF;
    SELECT max(f.removal_requested_at),
           jsonb_agg(jsonb_build_object('workspace_id', f.folder_id,
               'kind', CASE WHEN f.legacy_project_id IS NULL OR f.legacy_root THEN 'root' ELSE 'attached' END,
               'path', f.path, 'attached_at', f.attached_at) ORDER BY f.position, f.folder_id)
      INTO v_requested, v_folders
      FROM identity.chat_folders f WHERE f.user_id = v_me AND f.device_id = p_device_id AND (f.folder_id = p_key OR f.legacy_project_id = p_key);
    IF NOT p_removed THEN
        IF v_requested IS NULL AND v_before IS NULL THEN RETURN NULL; END IF;
        IF p_expected_command_id IS NULL THEN RAISE EXCEPTION 'Undo requires the removal command'; END IF;
        IF v_requested IS NULL AND v_previous.payload->>'undo_of' = p_expected_command_id::text THEN
            IF v_previous.status IN ('pending', 'running', 'done') THEN RETURN v_before; END IF;
        ELSIF v_requested IS NULL OR v_before IS DISTINCT FROM p_expected_command_id THEN
            RAISE EXCEPTION 'A newer folder request superseded this undo';
        END IF;
    ELSIF v_requested IS NOT NULL AND v_previous.status IN ('pending', 'running', 'done') THEN
        RETURN v_before;
    END IF;
    -- Cancel only unclaimed work. A running removal settles before its queued undo.
    UPDATE identity.gugu_device_commands SET status = 'error', error = 'Superseded by the owner', completed_at = now()
     WHERE id = v_before AND user_id = v_me AND status = 'pending';
    INSERT INTO identity.gugu_device_commands (user_id, device_id, type, payload)
    VALUES (v_me, p_device_id, 'project.set_removed', jsonb_build_object(
        'project_id', p_key, 'removed', p_removed, 'folders', v_folders,
        'undo_of', CASE WHEN NOT p_removed THEN p_expected_command_id ELSE NULL END
    )) RETURNING id INTO v_command;
    UPDATE identity.chat_folders f SET
        removal_requested_at = CASE WHEN p_removed THEN COALESCE(f.removal_requested_at, now()) ELSE NULL END,
        removal_command_id = v_command, updated_at = now()
     WHERE f.user_id = v_me AND f.device_id = p_device_id AND (f.folder_id = p_key OR f.legacy_project_id = p_key);
    PERFORM chat.publish_user_revision(v_me::text, 'device_changed', jsonb_build_object('device_id', p_device_id, 'kind', 'projects'), false);
    RETURN v_command;
END $$;
REVOKE ALL ON FUNCTION identity.set_chat_folder_removed(text, text, boolean, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION identity.set_chat_folder_removed(text, text, boolean, uuid) TO authenticated;

-- A settled removal command clears its claim on the folders it named (they stay until the device republishes).
CREATE OR REPLACE FUNCTION identity.settle_device_project_removal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.type = 'project.set_removed' AND NEW.status IN ('done', 'error') AND NEW.status IS DISTINCT FROM OLD.status THEN
        UPDATE identity.chat_folders SET
            removal_command_id = CASE WHEN NEW.status = 'done' AND removal_requested_at IS NULL THEN NULL ELSE removal_command_id END,
            updated_at = now()
         WHERE device_id = NEW.device_id AND user_id = NEW.user_id AND removal_command_id = NEW.id;
        IF FOUND THEN
            PERFORM chat.publish_user_revision(NEW.user_id::text, 'device_changed',
                jsonb_build_object('device_id', NEW.device_id, 'kind', 'projects'), false);
        END IF;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION identity.settle_device_project_removal() FROM PUBLIC, anon, authenticated, service_role;

-- ===== Released clients: boundary adapters over chat_folders (removed in the cleanup release) =====

ALTER TABLE identity.device_projects RENAME TO device_projects_s1_backup;
REVOKE ALL ON TABLE identity.device_projects_s1_backup FROM PUBLIC, anon, authenticated, service_role;
DROP POLICY device_projects_owner_select ON identity.device_projects_s1_backup;

-- The old row shape, one row per (device, local project): a released client's project, or a folder of a newer client.
CREATE VIEW identity.device_projects WITH (security_invoker = true) AS
SELECT f.device_id, f.user_id, COALESCE(f.legacy_project_id, f.folder_id) AS local_project_id,
       COALESCE(min(f.legacy_name), min(regexp_replace(f.path, '^.*/', ''))) AS name,
       COALESCE(min(f.legacy_root_path), min(f.path)) AS root_path,
       min(f.created_at) AS created_at, f.chat_id,
       jsonb_agg(jsonb_build_object('workspace_id', f.folder_id,
           'kind', CASE WHEN f.legacy_project_id IS NULL OR f.legacy_root THEN 'root' ELSE 'attached' END,
           'path', f.path, 'attached_at', f.attached_at) ORDER BY f.legacy_root DESC, f.position, f.folder_id) AS folders,
       max(f.removal_requested_at) AS removal_requested_at
  FROM identity.chat_folders f
 GROUP BY f.device_id, f.user_id, COALESCE(f.legacy_project_id, f.folder_id), f.chat_id;
REVOKE ALL ON TABLE identity.device_projects FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE identity.device_projects TO authenticated;

-- Released clients only: record the bindings a device made to this group before it existed, once the group exists and
-- the device's owner is an active member of it. Returns whether anything was recorded.
CREATE FUNCTION identity.adopt_pending_chat_folders(p_device_id text, p_chat_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_pending identity.chat_folders_pending%ROWTYPE; v_rows integer;
BEGIN
    SELECT * INTO v_pending FROM identity.chat_folders_pending WHERE device_id = p_device_id AND chat_id = p_chat_id FOR UPDATE;
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM chat.chats c JOIN chat.active_members m ON m.chat_id = c.id
                                 WHERE c.id = p_chat_id AND c.kind = 'group' AND m.user_id = v_pending.user_id::text) THEN
        RETURN false;
    END IF;
    INSERT INTO identity.chat_folders (device_id, user_id, folder_id, chat_id, path, position, attached_at, created_at,
           legacy_project_id, legacy_name, legacy_root_path, legacy_root)
    SELECT p_device_id, v_pending.user_id, w.value ->> 'folder_id', p_chat_id, w.value ->> 'path', (w.value ->> 'position')::integer,
           (w.value ->> 'attached_at')::timestamptz, (w.value ->> 'created_at')::timestamptz, w.value ->> 'legacy_project_id',
           w.value ->> 'legacy_name', w.value ->> 'legacy_root_path', (w.value ->> 'legacy_root')::boolean
      FROM jsonb_array_elements(v_pending.folders) w
    ON CONFLICT (device_id, folder_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    DELETE FROM identity.chat_folders_pending WHERE device_id = p_device_id AND chat_id = p_chat_id;
    IF v_rows > 0 THEN
        PERFORM chat.publish_user_revision(v_pending.user_id::text, 'device_changed', jsonb_build_object('device_id', p_device_id, 'kind', 'projects'), false);
    END IF;
    RETURN v_rows > 0;
END $$;
REVOKE ALL ON FUNCTION identity.adopt_pending_chat_folders(text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION identity.publish_device_projects_v2(p_device_id text, p_projects jsonb, p_applied_removals jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := auth.uid(); v_changed boolean := false; v_rows integer; v_project jsonb; v_folder jsonb; v_rejected jsonb;
    v_rows_wanted jsonb; v_pending jsonb;
BEGIN
    IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
    IF NULLIF(p_device_id, '') IS NULL THEN RAISE EXCEPTION 'Device is required'; END IF;
    PERFORM 1 FROM identity.gugu_devices WHERE device_id = p_device_id AND user_id = v_me FOR NO KEY UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Device is not owned by current user'; END IF;
    IF p_projects IS NULL OR jsonb_typeof(p_projects) <> 'array' THEN RAISE EXCEPTION 'Projects must be an array'; END IF;
    IF jsonb_array_length(p_projects) > 1000 THEN RAISE EXCEPTION 'A device publishes at most 1000 projects'; END IF;
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
        BEGIN PERFORM (v_project ->> 'created_at')::timestamp with time zone;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'Invalid project %', left(v_project::text, 200);
        END;
        IF jsonb_array_length(v_project -> 'folders') > 1000 THEN RAISE EXCEPTION 'A project publishes at most 1000 folders'; END IF;
        FOR v_folder IN SELECT value FROM jsonb_array_elements(v_project -> 'folders') LOOP
            IF jsonb_typeof(v_folder) <> 'object'
               OR jsonb_typeof(v_folder -> 'workspace_id') IS DISTINCT FROM 'string' OR v_folder ->> 'workspace_id' IN ('', 'device-store')
               OR (v_folder ->> 'kind') IS DISTINCT FROM 'root' AND (v_folder ->> 'kind') IS DISTINCT FROM 'attached'
               OR jsonb_typeof(v_folder -> 'path') IS DISTINCT FROM 'string' OR v_folder ->> 'path' = ''
               OR (v_folder ? 'attached_at' AND jsonb_typeof(v_folder -> 'attached_at') NOT IN ('string', 'null')) THEN
                RAISE EXCEPTION 'Invalid folder %', left(v_folder::text, 200);
            END IF;
        END LOOP;
    END LOOP;
    IF (SELECT count(DISTINCT value ->> 'local_project_id') FROM jsonb_array_elements(p_projects)) <> jsonb_array_length(p_projects) THEN
        RAISE EXCEPTION 'Each project is published once';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_projects) p, jsonb_array_elements(p.value -> 'folders') f
                GROUP BY f.value ->> 'workspace_id' HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Each folder is published once';
    END IF;

    -- The folder rows this publish asks for: every folder of a project whose group exists and has the caller as an
    -- active member, in the old order (representative project first, then by creation).
    SELECT COALESCE(jsonb_agg(x.wanted), '[]'::jsonb) FROM (SELECT jsonb_build_object(
               'folder_id', f.value ->> 'workspace_id', 'chat_id', p.value ->> 'chat_id', 'path', f.value ->> 'path',
               'attached_at', f.value -> 'attached_at', 'created_at', p.value ->> 'created_at',
               'legacy_project_id', p.value ->> 'local_project_id', 'legacy_name', p.value ->> 'name',
               'legacy_root_path', p.value ->> 'root_path', 'legacy_root', f.value ->> 'kind' = 'root',
               'position', row_number() OVER (PARTITION BY p.value ->> 'chat_id'
                   ORDER BY COALESCE((p.value -> 'group_representative')::boolean, false) DESC,
                            (p.value ->> 'created_at')::timestamptz, p.value ->> 'local_project_id', f.ordinality)) AS wanted
      FROM jsonb_array_elements(p_projects) p
     CROSS JOIN LATERAL jsonb_array_elements(p.value -> 'folders') WITH ORDINALITY f
     WHERE EXISTS (SELECT 1 FROM chat.chats c JOIN chat.active_members m ON m.chat_id = c.id
                    WHERE c.id = p.value ->> 'chat_id' AND c.kind = 'group' AND m.user_id = v_me::text)) x
      INTO v_rows_wanted;
    -- The same rows for groups that do not exist yet: kept pending (see identity.chat_folders_pending).
    SELECT COALESCE(jsonb_object_agg(x.chat_id, x.folders), '{}'::jsonb) INTO v_pending FROM (
        SELECT y.chat_id, jsonb_agg(y.row ORDER BY y.position) AS folders FROM (
            SELECT p.value ->> 'chat_id' AS chat_id,
                   row_number() OVER (PARTITION BY p.value ->> 'chat_id'
                       ORDER BY COALESCE((p.value -> 'group_representative')::boolean, false) DESC,
                                (p.value ->> 'created_at')::timestamptz, p.value ->> 'local_project_id', f.ordinality) AS position,
                   jsonb_build_object('folder_id', f.value ->> 'workspace_id', 'path', f.value ->> 'path',
                       'attached_at', f.value -> 'attached_at', 'created_at', p.value ->> 'created_at',
                       'legacy_project_id', p.value ->> 'local_project_id', 'legacy_name', p.value ->> 'name',
                       'legacy_root_path', p.value ->> 'root_path', 'legacy_root', f.value ->> 'kind' = 'root') AS row
              FROM jsonb_array_elements(p_projects) p
             CROSS JOIN LATERAL jsonb_array_elements(p.value -> 'folders') WITH ORDINALITY f
             WHERE NULLIF(p.value ->> 'chat_id', '') IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = p.value ->> 'chat_id')) y
         GROUP BY y.chat_id) x;
    -- row_number is computed inside each group's folders: add it to each row.
    SELECT COALESCE(jsonb_object_agg(e.key, (SELECT jsonb_agg(r.value || jsonb_build_object('position', r.ordinality)) FROM jsonb_array_elements(e.value) WITH ORDINALITY r)), '{}'::jsonb)
      INTO v_pending FROM jsonb_each(v_pending) e;

    UPDATE identity.chat_folders d SET removal_requested_at = NULL, removal_command_id = NULL, updated_at = now()
      FROM identity.gugu_device_commands c
     WHERE d.device_id = p_device_id AND d.user_id = v_me AND d.removal_requested_at IS NOT NULL
       AND c.id = d.removal_command_id AND c.user_id = v_me AND c.status = 'done'
       AND c.type = 'project.set_removed' AND c.payload->>'removed' = 'true'
       AND p_applied_removals ->> COALESCE(d.legacy_project_id, d.folder_id) = c.id::text
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_projects) p WHERE p.value ->> 'local_project_id' = COALESCE(d.legacy_project_id, d.folder_id));
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_changed := v_rows > 0;

    DELETE FROM identity.chat_folders d
     WHERE d.device_id = p_device_id AND d.removal_requested_at IS NULL AND d.removal_command_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows_wanted) w
                        WHERE w.value ->> 'folder_id' = d.folder_id AND w.value ->> 'chat_id' = d.chat_id
                          AND w.value ->> 'legacy_project_id' = d.legacy_project_id);
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_changed := v_changed OR v_rows > 0;

    INSERT INTO identity.chat_folders AS d (device_id, user_id, folder_id, chat_id, path, position, attached_at, created_at,
           legacy_project_id, legacy_name, legacy_root_path, legacy_root)
    SELECT p_device_id, v_me, w.value ->> 'folder_id', w.value ->> 'chat_id', w.value ->> 'path', (w.value ->> 'position')::integer,
           (w.value ->> 'attached_at')::timestamptz, (w.value ->> 'created_at')::timestamptz, w.value ->> 'legacy_project_id',
           w.value ->> 'legacy_name', w.value ->> 'legacy_root_path', (w.value ->> 'legacy_root')::boolean
      FROM jsonb_array_elements(v_rows_wanted) w
    ON CONFLICT (device_id, folder_id) DO UPDATE
       SET chat_id = EXCLUDED.chat_id, path = EXCLUDED.path, position = EXCLUDED.position, attached_at = EXCLUDED.attached_at,
           created_at = EXCLUDED.created_at, legacy_project_id = EXCLUDED.legacy_project_id, legacy_name = EXCLUDED.legacy_name,
           legacy_root_path = EXCLUDED.legacy_root_path, legacy_root = EXCLUDED.legacy_root, updated_at = now()
     WHERE d.removal_requested_at IS NULL AND d.removal_command_id IS NULL
       AND (d.chat_id, d.path, d.position, d.attached_at, d.created_at, d.legacy_project_id, d.legacy_name, d.legacy_root_path, d.legacy_root)
           IS DISTINCT FROM (EXCLUDED.chat_id, EXCLUDED.path, EXCLUDED.position, EXCLUDED.attached_at, EXCLUDED.created_at,
                             EXCLUDED.legacy_project_id, EXCLUDED.legacy_name, EXCLUDED.legacy_root_path, EXCLUDED.legacy_root);
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_changed := v_changed OR v_rows > 0;

    DELETE FROM identity.chat_folders_pending d WHERE d.device_id = p_device_id AND NOT v_pending ? d.chat_id;
    INSERT INTO identity.chat_folders_pending AS d (device_id, user_id, chat_id, folders)
    SELECT p_device_id, v_me, e.key, e.value FROM jsonb_each(v_pending) e
    ON CONFLICT (device_id, chat_id) DO UPDATE SET folders = EXCLUDED.folders, updated_at = now()
     WHERE d.folders IS DISTINCT FROM EXCLUDED.folders;

    IF v_changed THEN
        PERFORM chat.publish_user_revision(v_me::text, 'device_changed', jsonb_build_object('device_id', p_device_id, 'kind', 'projects'), false);
    END IF;
    -- Rejected: an existing chat this account may not bind (not a group, or not an active member). A binding to a chat
    -- that does not exist yet is skipped, not rejected: a released client publishes before it creates the group, would
    -- drop a rejected binding, and republishes the whole set later (at most every 15 minutes), when it lands.
    SELECT COALESCE(jsonb_agg(p.value ->> 'local_project_id' ORDER BY p.value ->> 'local_project_id'), '[]'::jsonb) INTO v_rejected
      FROM jsonb_array_elements(p_projects) p
     WHERE EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = p.value ->> 'chat_id')
       AND NOT EXISTS (SELECT 1 FROM chat.chats c JOIN chat.active_members m ON m.chat_id = c.id
                        WHERE c.id = p.value ->> 'chat_id' AND c.kind = 'group' AND m.user_id = v_me::text);
    RETURN jsonb_build_object('changed', v_changed, 'rejected', v_rejected);
END $$;
REVOKE ALL ON FUNCTION identity.publish_device_projects_v2(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION identity.publish_device_projects_v2(text, jsonb, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION identity.list_my_projects() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE me text := auth.uid()::text;
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    -- A released client's "projects": the groups the caller binds folders to, in the old binding shape.
    RETURN COALESCE((
        SELECT jsonb_agg(p.row ORDER BY p.active_at DESC)
          FROM (SELECT jsonb_build_object(
                    'chat_id', c.id, 'name', c.name, 'status', c.status, 'avatar_url', c.avatar_url,
                    'created_at', c.created_at, 'last_message_at', c.last_message_at,
                    'bindings', (SELECT jsonb_agg(jsonb_build_object(
                            'device_id', dp.device_id, 'local_project_id', dp.local_project_id, 'name', dp.name,
                            'root_path', dp.root_path, 'folders', dp.folders, 'created_at', dp.created_at,
                            'removal_requested_at', dp.removal_requested_at) ORDER BY dp.created_at)
                        FROM identity.device_projects dp WHERE dp.chat_id = c.id AND dp.user_id::text = me)
                ) AS row, COALESCE(c.last_message_at, c.created_at) AS active_at
                  FROM chat.chats c
                 WHERE c.kind = 'group' AND EXISTS (SELECT 1 FROM identity.chat_folders f WHERE f.chat_id = c.id AND f.user_id::text = me)) p
    ), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION identity.list_my_projects() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION identity.list_my_projects() TO authenticated;

CREATE OR REPLACE FUNCTION identity.is_my_project(p_chat_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE me uuid := auth.uid();
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    -- A released client asks before publishing a file into a chat its machine binds no folder to: does the caller keep
    -- files on their own machines in this group (a folder of theirs is bound to it on some device).
    RETURN EXISTS (SELECT 1 FROM identity.chat_folders f WHERE f.chat_id = p_chat_id AND f.user_id = me);
END $$;
REVOKE ALL ON FUNCTION identity.is_my_project(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION identity.is_my_project(text) TO authenticated;

CREATE OR REPLACE FUNCTION identity.set_device_project_removed(p_device_id text, p_project_id text, p_removed boolean, p_expected_command_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT identity.set_chat_folder_removed(p_device_id, p_project_id, p_removed, p_expected_command_id);
$$;
REVOKE ALL ON FUNCTION identity.set_device_project_removed(text, text, boolean, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION identity.set_device_project_removed(text, text, boolean, uuid) TO authenticated;

-- ===== The project marker goes =====
DROP FUNCTION chat.may_bind_project_group(text, text);
DROP FUNCTION chat.is_project_owner(text, text);
DROP FUNCTION chat.is_project_group(text);

-- Q2: references the idle exemption kept alive restart their interval now (none is due the moment it goes).
DO $$
DECLARE v_rows bigint;
BEGIN
    UPDATE chat.file_transfer_storage_refs ref SET last_download_at = NULL, retention_started_at = now()
     WHERE ref.chat_id IN (SELECT g.chat_id FROM chat.project_groups g)
       AND ref.expired_at IS NULL AND ref.expires_at IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RAISE NOTICE 'group folders: % cloud references in former project groups restart their idle interval', v_rows;
END $$;
-- Kept, unread, for ops/rollback-group-folders.sql; dropped in the cleanup release.
ALTER TABLE chat.project_groups RENAME TO project_groups_s1_backup;
REVOKE ALL ON TABLE chat.project_groups_s1_backup FROM PUBLIC, anon, authenticated, service_role;

-- Nothing may still read the removed names.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                  AND p.prosrc ~ 'chat\.project_groups|is_project_group|is_project_owner|may_bind_project_group|_s1_backup') THEN
        RAISE EXCEPTION 'A function still reads a removed project object';
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
