-- Identity workflow state only. No billing balance, cap or price is stored here.
ALTER TABLE team_private.members ADD COLUMN planned_principal_id uuid UNIQUE;
ALTER TABLE team_private.members ADD COLUMN display_name text;

-- Public invitation destination is installation data, never a caller redirect.
-- A missing value closes invitation creation without blocking unrelated CD.
CREATE TABLE team_private.delivery_configuration (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    site_origin text CHECK(site_origin IS NULL OR site_origin ~ '^https://[^/?#[:space:]@]+/?$')
);
INSERT INTO team_private.delivery_configuration(singleton) VALUES(true);
ALTER TABLE team_private.delivery_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_private.delivery_configuration OWNER TO postgres;

CREATE TABLE team_private.email_challenges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email_normalized text NOT NULL,
    purpose text NOT NULL CHECK(purpose IN ('create','sign_in','accept_invitation','change_email')),
    team_id uuid REFERENCES team_private.teams,
    invitation_id uuid,
    target_member_id uuid REFERENCES team_private.members,
    administrator_id uuid,
    expected_revision bigint,
    state text NOT NULL DEFAULT 'sending' CHECK(state IN ('sending','challenge','verifying','verified','failed','consumed')),
    attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
    lease_token uuid,
    receipt_digest text UNIQUE CHECK(receipt_digest IS NULL OR receipt_digest ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes'
);
CREATE INDEX team_challenge_rate ON team_private.email_challenges(email_normalized,created_at DESC);
CREATE TABLE team_private.invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES team_private.teams,
    member_id uuid NOT NULL REFERENCES team_private.members,
    created_by_member_id uuid NOT NULL REFERENCES team_private.members,
    email_normalized text NOT NULL,
    seed uuid NOT NULL DEFAULT gen_random_uuid(),
    token_digest text UNIQUE,
    state text NOT NULL DEFAULT 'invited' CHECK(state IN ('invited','accepted','revoked')),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '7 days',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE team_private.email_challenges ADD CONSTRAINT team_challenge_invitation
    FOREIGN KEY(invitation_id) REFERENCES team_private.invitations;
CREATE TABLE team_private.member_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_member_id uuid REFERENCES team_private.members,
    subject_email_digest text,
    action text NOT NULL,
    idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
    request_digest text NOT NULL,
    team_id uuid REFERENCES team_private.teams,
    target_member_id uuid REFERENCES team_private.members,
    recipient_member_id uuid REFERENCES team_private.members,
    state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete')),
    auth_sessions_revoked boolean NOT NULL DEFAULT false,
    auth_banned boolean NOT NULL DEFAULT false,
    model_authorization_revoked boolean NOT NULL DEFAULT false,
    source_auth_session_id uuid,
    handoff_complete boolean NOT NULL DEFAULT false,
    result jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE NULLS NOT DISTINCT(actor_member_id,subject_email_digest,action,idempotency_key)
);
-- Custody is distinct from private history visibility. Changing the recipient
-- never grants chat membership or changes an agent's legacy owner authority.
CREATE TABLE team_private.asset_custody (
    kind text NOT NULL CHECK(kind IN ('agent','chat','file')),
    resource_id text NOT NULL,
    team_id uuid NOT NULL REFERENCES team_private.teams,
    origin_member_id uuid NOT NULL REFERENCES team_private.members,
    custodian_member_id uuid NOT NULL REFERENCES team_private.members,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(kind,resource_id)
);
CREATE INDEX team_custody_member ON team_private.asset_custody(team_id,custodian_member_id);
ALTER TABLE team_private.email_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_private.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_private.member_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_private.asset_custody ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_private.email_challenges OWNER TO postgres;
ALTER TABLE team_private.invitations OWNER TO postgres;
ALTER TABLE team_private.member_operations OWNER TO postgres;
ALTER TABLE team_private.asset_custody OWNER TO postgres;
REVOKE ALL ON ALL TABLES IN SCHEMA team_private FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION team_private.refuse(p_code text,p_status integer DEFAULT 403) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'team_request_refused' USING ERRCODE='P0001',HINT=p_code,DETAIL=p_status::text; END $$;
REVOKE ALL ON FUNCTION team_private.refuse(text,integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION team_private.caller(p_actor uuid,p_session uuid) RETURNS team_private.members
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE m team_private.members%ROWTYPE; context jsonb;
BEGIN
    IF p_actor IS NULL OR p_session IS NULL OR NOT EXISTS(SELECT 1 FROM auth.sessions s
        WHERE s.id=p_session AND s.user_id=p_actor AND (s.not_after IS NULL OR s.not_after>now())) THEN
        PERFORM team_private.refuse('unauthenticated',401);
    END IF;
    context:=identity.team_context_for(p_actor,NULL);
    IF context->>'kind'<>'team' THEN PERFORM team_private.refuse('team_identity_required'); END IF;
    SELECT * INTO STRICT m FROM team_private.members WHERE principal_user_id=p_actor;
    RETURN m;
END $$;
ALTER FUNCTION team_private.caller(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION team_private.caller(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION team_private.member_json(p_member team_private.members) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
    SELECT jsonb_build_object('id',p_member.id,'identity_id',p_member.principal_user_id,
        'role',p_member.role,'state',p_member.state,'revision',p_member.revision)
$$;
REVOKE ALL ON FUNCTION team_private.member_json(team_private.members) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION team_private.principal_plan(p_member team_private.members) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT jsonb_build_object('principal_id',p_member.planned_principal_id,'member_id',p_member.id,
        'team_id',p_member.team_id,'alias','team-'||replace(p_member.id::text,'-','')||'@team.gugu.invalid',
        'name',COALESCE(p_member.display_name,'Team member'),'region',t.region)
    FROM team_private.teams t WHERE t.id=p_member.team_id
$$;
REVOKE ALL ON FUNCTION team_private.principal_plan(team_private.members) FROM PUBLIC,anon,authenticated,service_role;
