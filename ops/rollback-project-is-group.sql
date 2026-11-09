-- Roll back 20261109210000_project_is_group: the four readers derive "is a project group" from device rows again,
-- the triggers, list_my_projects and chat.chats.is_project go. Projects that exist only through the column (no device
-- row binds them any more) become ordinary groups again, as before the release. Run on the release's own schema only.
BEGIN;
SET LOCAL lock_timeout = '5s';

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
    -- 项目群只有项目的主人和主人的 agent(gugu-dev#181):设备上报的项目记着它绑的群(identity.device_projects.chat_id)。
    -- 这是那条记录本身的事实,❌ 从群名、群人数之类去猜哪个群是项目群。已经在群里的人不动(上一行)。
    IF v_chat.kind = 'group' AND EXISTS (SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id = p_chat_id)
       AND NOT EXISTS (SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id = p_chat_id
                       AND dp.user_id::text IN (p_user_id, v_target.owner_user_id)) THEN
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
        'is_project_group', v_group.kind = 'group' AND EXISTS (
            SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id = p_chat_id),
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
            SELECT jsonb_build_object('chat_id',m.chat_id,'name',c.name,'project',EXISTS(SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id=m.chat_id),
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
    OR EXISTS(SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id=c.help_group_id)
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

-- The installation event trigger closes replaced functions; restate the grants each one had.
GRANT EXECUTE ON FUNCTION chat.group_add_denial(text, text, text, boolean, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION chat.group_info_as(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.file_storage_overview_as() TO authenticated;

DROP FUNCTION identity.list_my_projects();
DROP TRIGGER chats_mark_reserved_project_group ON chat.chats;
DROP FUNCTION chat.mark_reserved_project_group();
DROP TRIGGER device_projects_mark_project_group ON identity.device_projects;
DROP FUNCTION identity.mark_project_group();
DROP FUNCTION chat.is_project_owner(text, text);
ALTER TABLE chat.chats DROP COLUMN is_project;
COMMIT;
