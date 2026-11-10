-- The retired Gugu Cloud Agent's group checks are removed.
--
-- chat.is_cloud_agent_user recognised a cloud agent by agent_profiles.agent_type = 'gugu-cloud' or a 'cloud:' device id,
-- and three group doors refused one: create_gugu_group, group_add_denial ('cloud_agent') and request_group_invitation_as.
-- Creating such an agent is refused since its retirement (trigger identity.reject_retired_cloud_agent, kept), and
-- production holds none of either marker, so the checks guard nothing and every new reader had to copy them. The three
-- functions are restated without the check; the helper is dropped.
--
-- Locks: replacing and dropping functions locks no table. Rollback: ops/rollback-retired-cloud-agent-checks.sql.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION chat.create_gugu_group(p_chat_id text, p_name text, p_owner_user_id text, p_initial_members jsonb, p_default_agent_type text DEFAULT NULL::text, p_group_prompt text DEFAULT NULL::text)
 RETURNS chat.chats
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'identity', 'public', 'pg_catalog'
AS $function$
DECLARE
    caller_user_id TEXT;
    inserted       chat.chats;
    m              JSONB;
    member_user_id TEXT;
    member_role    TEXT;
    inserted_member_count INT := 0;
    inserted_member_rows  INT := 0;
    member_denial  TEXT;
BEGIN
    caller_user_id := (SELECT auth.uid()::text);
    IF caller_user_id IS NULL OR caller_user_id <> p_owner_user_id THEN
        RAISE EXCEPTION 'caller % cannot create group on behalf of %',
                        caller_user_id, p_owner_user_id;
    END IF;

    IF p_chat_id IS NULL OR p_chat_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', HINT = 'chat_id_not_uuid',
            MESSAGE = 'chat id must be a UUID in 8-4-4-4-12 hexadecimal form';
    END IF;

    IF p_initial_members IS NULL OR jsonb_typeof(p_initial_members) <> 'array' THEN
        RAISE EXCEPTION 'p_initial_members must be a jsonb array';
    END IF;

    SET CONSTRAINTS ALL DEFERRED;

    INSERT INTO chat.chats (
        id, kind, name, status, creator_user_id,
        group_prompt, default_agent_type
    ) VALUES (
        p_chat_id, 'group', p_name, 'active', p_owner_user_id,
        p_group_prompt, p_default_agent_type
    ) RETURNING * INTO inserted;

    INSERT INTO chat.chat_members (chat_id, user_id, role)
    VALUES (p_chat_id, p_owner_user_id, 'owner');

    FOR m IN SELECT * FROM jsonb_array_elements(p_initial_members) LOOP
        member_user_id := m ->> 'user_id';
        member_role    := COALESCE(m ->> 'role', 'member');
        IF member_user_id IS NULL OR member_user_id = p_owner_user_id THEN
            CONTINUE;
        END IF;
        -- 群只有一个 owner(= 创建者);初始成员只能是 member/admin。
        IF member_role NOT IN ('member', 'admin') THEN
            RAISE EXCEPTION 'initial member % cannot have role %', member_user_id, member_role;
        END IF;
        -- 与其余入口同一道「能否加此人」(调用者就是 owner:拦的是上限、身份存在、别人名下的 agent ——
        -- 别人的 agent 要走 agent 群邀请,由它的主人接受)。
        IF NOT chat.group_related(p_owner_user_id, member_user_id) THEN
            RAISE EXCEPTION 'initial_member_requires_invitation';
        END IF;
        member_denial := chat.group_add_denial(p_chat_id, member_user_id, p_owner_user_id);
        IF member_denial IS NOT NULL THEN
            RAISE EXCEPTION 'cannot add % to group %: %', member_user_id, p_chat_id, member_denial;
        END IF;
        INSERT INTO chat.chat_members (chat_id, user_id, role)
        VALUES (p_chat_id, member_user_id, member_role)
        ON CONFLICT (chat_id, user_id) DO NOTHING;
        GET DIAGNOSTICS inserted_member_rows = ROW_COUNT;
        inserted_member_count := inserted_member_count + inserted_member_rows;
    END LOOP;


    RETURN inserted;
END;
$function$;

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

CREATE OR REPLACE FUNCTION chat.request_group_invitation_as(p_chat_id text, p_invitee_user_id text, p_message text, p_as_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id); v_group chat.chats%ROWTYPE;
    v_target identity.users%ROWTYPE; v_decider TEXT; v_invitation TEXT; v_denial TEXT;
BEGIN
    IF NULLIF(btrim(p_message),'') IS NULL THEN RAISE EXCEPTION 'invitation_message_required'; END IF;
    SELECT * INTO v_target FROM identity.users WHERE id = p_invitee_user_id;
    IF NOT FOUND OR (v_target.type = 'agent' AND v_target.owner_user_id <> auth.uid()::text
                     AND NOT COALESCE(v_target.agent_public,false)) THEN RAISE EXCEPTION 'invitee_not_visible'; END IF;
    -- Direct related membership uses the very same add-agent door as the picker.
    IF v_target.type = 'agent' AND chat.group_related(v_actor,v_target.id) THEN
        RETURN chat.add_group_agent(p_chat_id,v_target.id,p_message,v_actor);
    END IF;
    IF chat.group_related(v_actor,v_target.id) THEN
        PERFORM 1 FROM chat.chats WHERE id = p_chat_id FOR UPDATE;
        v_denial := chat.group_add_denial(p_chat_id,v_target.id,v_actor);
        IF v_denial IS NOT NULL THEN RAISE EXCEPTION '%',v_denial; END IF;
        IF chat.is_chat_member(p_chat_id,v_target.id) THEN
            RETURN jsonb_build_object('status','already_member','chat_id',p_chat_id,'invitee_user_id',v_target.id);
        END IF;
        PERFORM chat.insert_group_member(p_chat_id,v_target.id);
        RETURN jsonb_build_object('status','joined','chat_id',p_chat_id,'invitee_user_id',v_target.id);
    END IF;
    v_group := chat.require_group_inviter(p_chat_id,v_actor);
    IF chat.is_chat_member(p_chat_id,v_target.id) THEN
        RETURN jsonb_build_object('status','already_member','chat_id',p_chat_id,'invitee_user_id',v_target.id); END IF;
    v_decider := CASE WHEN v_target.type = 'agent' THEN v_target.owner_user_id ELSE v_target.id END;
    IF v_decider IS NULL THEN RAISE EXCEPTION 'invitee_has_no_decider'; END IF;
    SELECT id INTO v_invitation FROM chat.group_invitations
    WHERE chat_id = p_chat_id AND invitee_user_id = v_target.id AND status = 'pending';
    IF v_invitation IS NULL THEN
        INSERT INTO chat.group_invitations(chat_id,inviter_user_id,inviter_account_user_id,invitee_user_id,decision_user_id,message)
        VALUES (p_chat_id,v_actor,auth.uid()::text,v_target.id,v_decider,btrim(p_message)) RETURNING id INTO v_invitation;
    END IF;
    RETURN jsonb_build_object('status','pending','invitation_id',v_invitation,'chat_id',p_chat_id,
                             'invitee_user_id',v_target.id,'decision_user_id',v_decider);
END;
$function$;

REVOKE ALL ON FUNCTION chat.create_gugu_group(text,text,text,jsonb,text,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.create_gugu_group(text,text,text,jsonb,text,text) TO authenticated;
REVOKE ALL ON FUNCTION chat.group_add_denial(text,text,text,boolean,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.group_add_denial(text,text,text,boolean,boolean) TO service_role;
REVOKE ALL ON FUNCTION chat.request_group_invitation_as(text,text,text,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.request_group_invitation_as(text,text,text,text) TO authenticated;

DROP FUNCTION chat.is_cloud_agent_user(text);

NOTIFY pgrst, 'reload schema';
