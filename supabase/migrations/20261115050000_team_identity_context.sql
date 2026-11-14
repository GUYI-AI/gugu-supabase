-- Organization identity only. Shared credits, caps, prices and payments belong
-- to the official billing layer; no financial table is introduced here.
CREATE SCHEMA team_private;
REVOKE ALL ON SCHEMA team_private FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE team_private.teams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100 AND name=btrim(name)),
    region text NOT NULL CHECK(region IN ('cn','hk')),
    state text NOT NULL DEFAULT 'provisioning' CHECK(state IN ('provisioning','active','suspended')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE team_private.members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES team_private.teams ON DELETE RESTRICT,
    principal_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
    email_normalized text NOT NULL CHECK(email_normalized=lower(btrim(email_normalized))
        AND length(email_normalized) BETWEEN 3 AND 254 AND position('@' IN email_normalized)>1),
    role text NOT NULL DEFAULT 'member' CHECK(role IN ('superadmin','admin','member')),
    state text NOT NULL DEFAULT 'invited' CHECK(state IN ('invited','provisioning','active','disabled')),
    revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(team_id,email_normalized),
    CHECK(state<>'active' OR principal_user_id IS NOT NULL)
);
CREATE UNIQUE INDEX team_single_highest_administrator ON team_private.members(team_id) WHERE role='superadmin';
CREATE INDEX team_members_directory ON team_private.members(team_id,state,id);
ALTER TABLE team_private.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_private.members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA team_private FROM PUBLIC,anon,authenticated,service_role;

-- A member has a separate Auth principal. Personal erasure must not reach the
-- organization's assets through that principal's ordinary owner cascades.
CREATE FUNCTION team_private.prevent_principal_erasure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM team_private.members WHERE principal_user_id=OLD.id) THEN
        RAISE EXCEPTION 'team_identity_erasure_requires_team_workflow' USING ERRCODE='55000';
    END IF;
    RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION team_private.prevent_principal_erasure() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER team_identity_erasure_guard BEFORE DELETE ON auth.users
    FOR EACH ROW EXECUTE FUNCTION team_private.prevent_principal_erasure();

-- The caller is a trusted server after Auth /user verification. No user-facing
-- role can name another actor or read the private membership tables directly.
CREATE FUNCTION identity.team_context_for(p_actor_user_id uuid,p_team_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE principal record; membership team_private.members%ROWTYPE; organization team_private.teams%ROWTYPE;
BEGIN
    SELECT u.id,u.deleted_at,u.banned_until,u.email_confirmed_at,u.raw_app_meta_data->>'gugu_account_kind' AS account_kind
      INTO principal FROM auth.users u WHERE u.id=p_actor_user_id;
    IF NOT FOUND OR principal.deleted_at IS NOT NULL OR principal.email_confirmed_at IS NULL THEN
        RAISE EXCEPTION 'team_context_unauthenticated' USING ERRCODE='42501',HINT='unauthenticated';
    END IF;
    IF principal.banned_until>now() THEN
        RAISE EXCEPTION 'team_membership_disabled' USING ERRCODE='42501',HINT='membership_disabled';
    END IF;
    SELECT * INTO membership FROM team_private.members WHERE principal_user_id=p_actor_user_id;
    IF NOT FOUND THEN
        IF (principal.account_kind IS NOT NULL AND principal.account_kind<>'personal') OR p_team_id IS NOT NULL THEN
            RAISE EXCEPTION 'team_context_required' USING ERRCODE='42501',HINT='team_identity_required';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM identity.users WHERE id=p_actor_user_id::text AND type='human' AND removed_at IS NULL) THEN
            RAISE EXCEPTION 'team_context_unauthenticated' USING ERRCODE='42501',HINT='unauthenticated';
        END IF;
        RETURN jsonb_build_object('kind','personal','team_id',NULL,'member_id',NULL,
            'member_identity_id',p_actor_user_id,'role',NULL,'state','active','membership_revision',NULL,'region',NULL);
    END IF;
    IF principal.account_kind IS DISTINCT FROM 'team_member' OR p_team_id IS NOT NULL AND p_team_id<>membership.team_id THEN
        RAISE EXCEPTION 'team_context_mismatch' USING ERRCODE='42501',HINT='forbidden';
    END IF;
    SELECT * INTO STRICT organization FROM team_private.teams WHERE id=membership.team_id;
    IF membership.state<>'active' OR organization.state<>'active'
       OR NOT EXISTS(SELECT 1 FROM identity.users WHERE id=p_actor_user_id::text AND type='human' AND removed_at IS NULL) THEN
        RAISE EXCEPTION 'team_membership_disabled' USING ERRCODE='42501',HINT='membership_disabled';
    END IF;
    RETURN jsonb_build_object('kind','team','team_id',membership.team_id,'member_id',membership.id,
        'member_identity_id',p_actor_user_id,'role',membership.role,'state',membership.state,
        'membership_revision',membership.revision,'region',organization.region);
END $$;
REVOKE ALL ON FUNCTION identity.team_context_for(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.team_context_for(uuid,uuid) TO service_role;

CREATE FUNCTION identity.team_billing_members_for(p_actor_user_id uuid,p_team_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE context jsonb;
BEGIN
    IF p_team_id IS NULL THEN RAISE EXCEPTION 'team_context_required' USING ERRCODE='42501',HINT='team_identity_required'; END IF;
    context:=identity.team_context_for(p_actor_user_id,p_team_id);
    IF context->>'kind'<>'team' OR context->>'role' NOT IN ('superadmin','admin') THEN
        RAISE EXCEPTION 'team_administrator_required' USING ERRCODE='42501',HINT='forbidden';
    END IF;
    RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('member_id',m.id,
        'member_identity_id',m.principal_user_id,'state',m.state) ORDER BY m.created_at,m.id)
        FROM team_private.members m WHERE m.team_id=p_team_id),'[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION identity.team_billing_members_for(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.team_billing_members_for(uuid,uuid) TO service_role;
