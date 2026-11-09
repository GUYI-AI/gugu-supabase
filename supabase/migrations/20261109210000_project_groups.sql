-- A project is its project group, and the account records which groups are projects (project/device decoupling).
--
-- Whether a group was a project group was derived: some device had published a project bound to it
-- (identity.device_projects.chat_id). So a project existed only while at least one machine listed a folder for it, and
-- every reader re-derived the fact from device rows. The account had no list of its projects of its own.
--
-- chat.project_groups now records it, one row per project group (the id may name a group that does not exist yet: the
-- client reserves a project group's id before creating it):
--   · publish_device_projects marks every group its projects are bound to, if the publishing account owns the group or no
--     group has that id yet. Clients that predate this release publish the same way, so they are covered;
--   · nothing unmarks it when a device stops listing the project. A project with no folder on any machine is still a
--     project; deleting a project is archiving or dissolving its group (a dissolved group's row no longer joins a chat).
-- Name and archive state stay the group's own (chat.chats.name / status); nothing is copied.
-- The readers that derived "is a project group" from device rows read chat.is_project_group instead: group_add_denial,
-- group_info_as, file_storage_overview_as, support_help.valid_configuration.
-- identity.list_my_projects() returns the caller's projects with the folders each of the caller's devices holds.
--
-- Locks: this release takes no lock on an existing table stronger than ACCESS SHARE (the backfill reads
-- identity.device_projects). It adds no column, trigger or foreign key to chat.chats, identity.device_projects or
-- identity.gugu_devices; replacing functions locks no table. So it cannot form a lock cycle with a concurrent transaction
-- that writes chat or device rows and then reads other tables while an installer holds those.
SET LOCAL lock_timeout = '5s';

CREATE TABLE chat.project_groups (
    chat_id text PRIMARY KEY,
    marked_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE chat.project_groups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE chat.project_groups FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE chat.project_groups TO service_role;

-- Backfill exactly today's derivation: every id a device row binds a project to.
INSERT INTO chat.project_groups (chat_id)
SELECT DISTINCT dp.chat_id FROM identity.device_projects dp WHERE NULLIF(dp.chat_id, '') IS NOT NULL;

CREATE FUNCTION chat.is_project_group(p_chat_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM chat.project_groups g WHERE g.chat_id = p_chat_id);
$$;
REVOKE ALL ON FUNCTION chat.is_project_group(text) FROM PUBLIC, anon, authenticated;

-- The project's owner: the group's creator or owner, or an account whose device binds a project to it (the owner
-- condition group_add_denial applied before this release).
CREATE FUNCTION chat.is_project_owner(p_chat_id text, p_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT p_user_id IS NOT NULL AND (
        EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = p_chat_id AND c.creator_user_id = p_user_id)
        OR EXISTS (SELECT 1 FROM chat.active_members m WHERE m.chat_id = p_chat_id AND m.user_id = p_user_id AND m.role = 'owner')
        OR EXISTS (SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id = p_chat_id AND dp.user_id::text = p_user_id));
$$;
REVOKE ALL ON FUNCTION chat.is_project_owner(text, text) FROM PUBLIC, anon, authenticated;

-- The caller's projects: project groups the caller owns, newest activity first, each with the folders the caller's
-- devices hold for it (none is a valid answer). Name and status are the group's.
CREATE FUNCTION identity.list_my_projects() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE me text := auth.uid()::text;
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'chat_id', c.id, 'name', c.name, 'status', c.status, 'avatar_url', c.avatar_url,
            'created_at', c.created_at, 'last_message_at', c.last_message_at,
            'bindings', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'device_id', dp.device_id, 'local_project_id', dp.local_project_id, 'name', dp.name,
                    'root_path', dp.root_path, 'folders', dp.folders, 'created_at', dp.created_at,
                    'removal_requested_at', dp.removal_requested_at) ORDER BY dp.created_at)
                FROM identity.device_projects dp WHERE dp.chat_id = c.id AND dp.user_id::text = me), '[]'::jsonb)
        ) ORDER BY COALESCE(c.last_message_at, c.created_at) DESC)
        FROM chat.project_groups g JOIN chat.chats c ON c.id = g.chat_id
        WHERE c.kind = 'group' AND chat.is_project_owner(c.id, me)
    ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION identity.list_my_projects() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.list_my_projects() TO authenticated;

-- The readers below are their effective definitions on the parent release (pg_get_functiondef), with only the
-- project-group test changed (publish_device_projects: one statement added).
CREATE OR REPLACE FUNCTION chat.group_add_denial(p_chat_id text, p_user_id text, p_actor_user_id text, p_take_seat boolean DEFAULT true, p_owner_consented boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_chat chat.chats%ROWTYPE; v_target identity.users%ROWTYPE; v_actor identity.users%ROWTYPE;
    v_role TEXT; v_count INTEGER; v_related BOOLEAN;
BEGIN
  IF NOT identity.user_is_live(p_actor_user_id) THEN RETURN 'actor_not_member'; END IF;
  IF NOT identity.user_is_live(p_user_id) THEN RETURN 'user_removed'; END IF;
    IF p_actor_user_id IS NULL THEN RETURN 'not_authenticated'; END IF;
    SELECT * INTO v_chat FROM chat.chats WHERE id = p_chat_id;
    IF NOT FOUND OR v_chat.kind NOT IN ('group','topic') THEN RETURN 'not_a_group'; END IF;
    IF v_chat.status = 'archived' THEN RETURN 'group_archived'; END IF;
    SELECT * INTO v_target FROM identity.users WHERE id = p_user_id;
    IF NOT FOUND THEN RETURN 'user_not_found'; END IF;
    IF chat.is_cloud_agent_user(p_user_id) THEN RETURN 'cloud_agent'; END IF;
    IF chat.is_chat_member(p_chat_id, p_user_id) THEN RETURN NULL; END IF;
    IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id = p_user_id AND u.session_archived_at IS NOT NULL) THEN RETURN 'agent_archived'; END IF;
    -- 项目群只有项目的主人和主人的 agent(gugu-dev#181)。是不是项目群读 chat.project_groups(20261109210000),
    -- ❌ 从群名、群人数之类去猜。已经在群里的人不动(上一行)。
    IF v_chat.kind = 'group' AND chat.is_project_group(p_chat_id)
       AND NOT chat.is_project_owner(p_chat_id, p_user_id)
       AND NOT (v_target.owner_user_id IS NOT NULL AND chat.is_project_owner(p_chat_id, v_target.owner_user_id)) THEN
        RETURN 'project_group_owner_only';
    END IF;
    SELECT * INTO v_actor FROM identity.users WHERE id = p_actor_user_id;
    IF NOT FOUND THEN RETURN 'actor_not_member'; END IF;
    IF v_chat.kind = 'topic' THEN
        IF NOT chat.is_chat_member(v_chat.source_chat_id, p_actor_user_id) THEN RETURN 'actor_not_member'; END IF;
        IF NOT chat.is_chat_member(v_chat.source_chat_id, p_user_id) THEN RETURN 'not_in_source_line'; END IF;
        RETURN NULL;
    END IF;
    SELECT role INTO v_role FROM chat.active_members WHERE chat_id = p_chat_id AND user_id = p_actor_user_id;
    v_related := chat.group_related(p_actor_user_id, p_user_id);
    IF v_role IS NULL THEN
        IF p_user_id = p_actor_user_id AND v_chat.creator_user_id = p_actor_user_id
           AND NOT EXISTS (SELECT 1 FROM chat.active_members WHERE chat_id = p_chat_id) THEN
            v_role := 'owner'; -- the creator's initial seat
        ELSIF v_actor.type = 'agent' AND v_target.type = 'agent' AND v_related
           AND chat.is_chat_member(p_chat_id, v_actor.owner_user_id) THEN
            v_role := 'member'; -- enrollment consent is not the owner's admin role
        ELSE RETURN 'actor_not_member'; END IF;
    END IF;
    IF v_target.type = 'agent' AND NOT v_related AND NOT COALESCE(p_owner_consented,false) THEN
        RETURN 'agent_not_owned'; END IF;
    IF v_role NOT IN ('owner','admin') THEN
        IF v_target.type = 'agent' AND v_chat.agent_join_approval THEN RETURN 'agent_join_requires_manager';
        ELSIF v_target.type <> 'agent' AND NOT v_related AND NOT v_chat.allow_member_invite THEN
            RETURN 'member_invite_disabled'; END IF;
    END IF;
    IF p_take_seat THEN
        SELECT count(*) INTO v_count FROM chat.active_members m JOIN identity.users u ON u.id = m.user_id WHERE m.chat_id = p_chat_id AND u.session_archived_at IS NULL;
        IF v_count >= v_chat.max_members THEN RETURN 'member_limit_reached'; END IF;
    END IF;
    RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION chat.group_info_as(p_chat_id text, p_as_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id); v_group chat.chats%ROWTYPE; v_authority RECORD;
BEGIN
    SELECT * INTO v_group FROM chat.chats WHERE id = p_chat_id AND kind IN ('group', 'topic');
    IF NOT FOUND OR NOT (
        chat.is_chat_member(p_chat_id, v_actor) OR chat.is_chat_member(p_chat_id, auth.uid()::text)
        OR (v_group.kind = 'topic' AND (chat.is_chat_member(v_group.source_chat_id, v_actor)
            OR chat.is_chat_member(v_group.source_chat_id, auth.uid()::text)))
    ) THEN RAISE EXCEPTION 'group_not_visible' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v_authority FROM chat.management_authority(p_chat_id, v_actor);
    RETURN jsonb_build_object(
        'is_project_group', v_group.kind = 'group' AND chat.is_project_group(p_chat_id),
        'id', v_group.id, 'public_id', v_group.public_id, 'creator_user_id', v_group.creator_user_id,
        'name', v_group.name, 'status', v_group.status, 'group_prompt', v_group.group_prompt,
        'default_agent_type', v_group.default_agent_type, 'join_token', v_group.join_token,
        'description', v_group.description, 'max_members', v_group.max_members,
        'allow_member_invite', v_group.allow_member_invite, 'invite_link_enabled', v_group.invite_link_enabled,
        'agent_join_approval', v_group.agent_join_approval, 'join_mode', v_group.join_mode,
        'hide_history', v_group.hide_history, 'avatar_url', v_group.avatar_url,
        'is_discoverable', v_group.is_discoverable, 'agent_flood_threshold', v_group.agent_flood_threshold,
        'agent_flood_threshold_effective', chat.agent_flood_threshold_for(p_chat_id),
        'my_role', v_authority.my_role, 'can_manage', COALESCE(v_authority.can_manage, false),
        'can_archive_topic', v_group.kind = 'topic' AND COALESCE(v_authority.can_manage, false),
        'can_dissolve', v_group.kind = 'group' AND COALESCE(v_authority.my_role = 'owner', false)
    );
END;
$function$;

CREATE OR REPLACE FUNCTION chat.file_storage_overview_as()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE me text:=auth.uid()::text; result jsonb;
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING HINT='file_transfer_denied'; END IF;
    WITH mine AS (
        SELECT ref.storage_id,ref.chat_id,ref.expires_at,o.size_bytes,o.blob_id,
            CASE WHEN b.content_type LIKE 'image/%' THEN 'image' WHEN ref.expires_at IS NOT NULL THEN 'temporary' ELSE 'kept' END AS class
        FROM chat.file_transfer_storage_refs ref JOIN chat.file_transfer_storage o ON o.id=ref.storage_id JOIN chat.file_blobs b ON b.id=o.blob_id
        WHERE ref.account_id=me AND ref.expired_at IS NULL AND o.state='ready'
    ), devices AS (SELECT device_id,label FROM identity.gugu_devices WHERE user_id::text=me)
    SELECT jsonb_build_object(
        'total_bytes',COALESCE((SELECT sum(size_bytes) FROM (SELECT DISTINCT ON (storage_id) storage_id,size_bytes FROM mine) d),0),
        'count',(SELECT count(*) FROM mine),
        'expiring_7d_bytes',COALESCE((SELECT sum(size_bytes) FROM mine WHERE expires_at<=now()+interval '7 days'),0),
        -- The idle-expiry policy chat.file_transfer_expire applies (larger than large_file_bytes, unopened for
        -- large_file_idle_seconds, project chats exempt); null when the deployment sets no such policy.
        'expiry',(SELECT CASE WHEN l.settings ?& ARRAY['large_file_bytes','large_file_idle_seconds'] THEN jsonb_build_object(
            'large_file_bytes',chat.file_transfer_parameter(l.settings,'large_file_bytes'),
            'idle_seconds',chat.file_transfer_parameter(l.settings,'large_file_idle_seconds')) END
            FROM chat.file_transfer_limits l WHERE l.scope='global' AND l.scope_id='*'),
        'classes',(SELECT jsonb_object_agg(c.class,jsonb_build_object('bytes',COALESCE(s.bytes,0),'count',COALESCE(s.n,0)))
            FROM (VALUES('image'),('temporary'),('kept')) c(class)
            LEFT JOIN (SELECT class,sum(size_bytes) bytes,count(*) n FROM mine GROUP BY class) s ON s.class=c.class),
        'groups',COALESCE((SELECT jsonb_agg(g ORDER BY (g->>'bytes')::bigint DESC) FROM (
            SELECT jsonb_build_object('chat_id',m.chat_id,'name',c.name,'project',chat.is_project_group(m.chat_id),
                'bytes',sum(m.size_bytes),'count',count(*)) g
            FROM mine m JOIN chat.chats c ON c.id=m.chat_id GROUP BY m.chat_id,c.name) gs),'[]'::jsonb),
        'expiring',COALESCE((SELECT jsonb_agg(e ORDER BY e->>'expires_at') FROM (
            SELECT jsonb_build_object('chat_id',m.chat_id,'expires_at',m.expires_at,'bytes',m.size_bytes,'class',m.class,
                'item_id',w.id,'file_name',w.filename) e
            FROM mine m LEFT JOIN LATERAL (SELECT i.id,i.filename FROM chat.workspace_items i WHERE i.chat_id=m.chat_id AND i.blob_id=m.blob_id LIMIT 1) w ON true
            WHERE m.expires_at IS NOT NULL ORDER BY m.expires_at LIMIT 20) es),'[]'::jsonb),
        'machines',COALESCE((SELECT jsonb_agg(jsonb_build_object('device_id',d.device_id,'label',d.label,'files',s.files,'bytes',s.bytes,
                'temporary_copy_bytes',s.copies))
            FROM devices d JOIN LATERAL (
                SELECT count(*) files,COALESCE(sum(r.size_bytes),0) bytes,
                    COALESCE((SELECT sum(t.ciphertext_bytes) FROM chat.file_temporary_transfers t
                        WHERE t.host_device_id=d.device_id AND t.state IN ('uploading','ready')),0) copies
                FROM chat.workspace_item_versions r JOIN chat.workspace_items w ON w.id=r.item_id AND w.version=r.n
                WHERE r.host_device_id=d.device_id) s ON true),'[]'::jsonb)
    ) INTO result;
    RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION support_help.valid_configuration(p_id uuid, p_version bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE c support_help.configuration%ROWTYPE; v_agent text;
BEGIN
  SELECT * INTO c FROM support_help.configuration WHERE id=p_id;
  IF NOT FOUND OR c.version=0 THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM chat.chats g WHERE g.id=c.help_group_id AND g.kind='group' AND g.source_chat_id IS NULL)
    OR chat.is_project_group(c.help_group_id)
    OR NOT support_help.live_human(c.duty_human_user_id)
    OR NOT EXISTS(SELECT 1 FROM chat.active_members m WHERE m.user_id=c.duty_human_user_id AND m.chat_id=c.help_group_id)
    THEN RETURN false; END IF;
  FOREACH v_agent IN ARRAY c.assistant_agent_ids LOOP
    IF NOT EXISTS(SELECT 1 FROM identity.users u JOIN chat.active_members m ON m.user_id=u.id
      WHERE u.id=v_agent AND u.type='agent' AND u.removed_at IS NULL AND u.session_archived_at IS NULL
        AND u.owner_user_id=c.duty_human_user_id AND m.chat_id=c.help_group_id)
      OR NOT support_help.agent_isolation_verified(v_agent,c.id,p_version) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END; $function$;

CREATE OR REPLACE FUNCTION identity.publish_device_projects(p_device_id text, p_projects jsonb, p_applied_removals jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_me uuid := auth.uid();
    v_changed boolean := false;
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
           (p.value ->> 'created_at')::timestamp with time zone, p.value ->> 'chat_id',
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

    -- A project bound to a group is that group's project: mark it (20261109210000). Only a group this account owns,
    -- or an id no group has yet (reserved before the group exists). Marking never changes what this returns.
    INSERT INTO chat.project_groups (chat_id)
    SELECT DISTINCT p.value ->> 'chat_id' FROM jsonb_array_elements(p_projects) p
     WHERE NULLIF(p.value ->> 'chat_id', '') IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = p.value ->> 'chat_id')
            OR EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = p.value ->> 'chat_id' AND c.creator_user_id = v_me::text)
            OR EXISTS (SELECT 1 FROM chat.active_members m
                        WHERE m.chat_id = p.value ->> 'chat_id' AND m.user_id = v_me::text AND m.role = 'owner'))
    ON CONFLICT (chat_id) DO NOTHING;

    IF v_changed THEN
        PERFORM chat.publish_user_revision(v_me::text, 'device_changed', jsonb_build_object('device_id', p_device_id, 'kind', 'projects'), false);
    END IF;
    RETURN v_changed;
END;
$function$;

-- The installation event trigger closes replaced functions; restate the grants each one had.
GRANT EXECUTE ON FUNCTION chat.group_add_denial(text, text, text, boolean, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION chat.group_info_as(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.file_storage_overview_as() TO authenticated;
GRANT EXECUTE ON FUNCTION identity.publish_device_projects(text, jsonb, jsonb) TO authenticated, service_role;
