-- Identity mail admission only; SMTP configuration and credentials stay outside SQL.
ALTER TABLE team_private.delivery_configuration ADD COLUMN mail_policy jsonb NOT NULL DEFAULT
  '{"max_pending":100,"short_seconds":900,"daily_seconds":86400,"team_short":20,"team_daily":100,"inviter_short":10,"inviter_daily":50,"recipient_cooldown_seconds":60,"recipient_daily":3,"global_short":50,"global_daily":300,"invitation_global_percent":60,"ip_short":20,"ip_daily":100}'::jsonb;

CREATE FUNCTION team_private.valid_mail_policy(p_policy jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE field text;
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy)<>'object' THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['max_pending','short_seconds','daily_seconds','team_short','team_daily',
    'inviter_short','inviter_daily','recipient_cooldown_seconds','recipient_daily','global_short','global_daily','invitation_global_percent','ip_short','ip_daily'] LOOP
    IF jsonb_typeof(p_policy->field) IS DISTINCT FROM 'number'
      OR (p_policy->>field)!~'^[0-9]{1,7}$' THEN RETURN false; END IF;
    IF (p_policy->>field)::bigint NOT BETWEEN 1 AND 1000000 THEN RETURN false; END IF;
  END LOOP;
  RETURN (p_policy->>'invitation_global_percent')::integer<100
    AND (p_policy->>'short_seconds')::integer<=(p_policy->>'daily_seconds')::integer
    AND (p_policy->>'recipient_cooldown_seconds')::integer<=(p_policy->>'daily_seconds')::integer;
END $$;
ALTER TABLE team_private.delivery_configuration ADD CONSTRAINT team_mail_policy_valid
  CHECK(team_private.valid_mail_policy(mail_policy));

CREATE FUNCTION team_private.mail_policy() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE policy jsonb;
BEGIN
  SELECT mail_policy INTO policy FROM team_private.delivery_configuration WHERE singleton;
  IF NOT team_private.valid_mail_policy(policy) THEN PERFORM team_private.refuse('dependency_unavailable',503); END IF;
  RETURN policy;
END $$;

CREATE TABLE team_private.mail_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_key text NOT NULL UNIQUE,
  invitation_id uuid UNIQUE REFERENCES team_private.invitations ON DELETE CASCADE,
  challenge_id uuid UNIQUE REFERENCES team_private.email_challenges ON DELETE CASCADE,
  team_id uuid REFERENCES team_private.teams ON DELETE CASCADE,
  inviter_member_id uuid REFERENCES team_private.members ON DELETE SET NULL,
  recipient_digest text NOT NULL CHECK(recipient_digest~'^[a-f0-9]{64}$'),
  ip_digest text CHECK(ip_digest IS NULL OR ip_digest~'^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','failed','unknown')),
  reason_code text CHECK(reason_code IS NULL OR reason_code IN
    ('smtp_accepted','smtp_rejected','smtp_result_unknown','identity_unavailable','code_accepted','code_result_unknown','lease_expired')),
  lease_token uuid,
  lease_expires_at timestamptz,
  admitted_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(num_nonnulls(invitation_id,challenge_id)=1)
);
ALTER TABLE team_private.mail_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_private.mail_deliveries OWNER TO postgres;
REVOKE ALL ON team_private.mail_deliveries FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX team_mail_global_rate ON team_private.mail_deliveries(admitted_at) WHERE admitted_at IS NOT NULL;
CREATE INDEX team_mail_team_rate ON team_private.mail_deliveries(team_id,admitted_at) WHERE admitted_at IS NOT NULL;
CREATE INDEX team_mail_inviter_rate ON team_private.mail_deliveries(inviter_member_id,admitted_at) WHERE admitted_at IS NOT NULL;
CREATE INDEX team_mail_recipient_rate ON team_private.mail_deliveries(recipient_digest,admitted_at) WHERE admitted_at IS NOT NULL;
CREATE INDEX team_mail_ip_rate ON team_private.mail_deliveries(ip_digest,admitted_at) WHERE admitted_at IS NOT NULL;

-- Preserve the exact service RPC signature and all established workflow paths.
-- The private implementation cannot be invoked directly by an API role.
ALTER FUNCTION public.team_member_workflow(text,uuid,uuid,jsonb) SET SCHEMA team_private;
ALTER FUNCTION team_private.team_member_workflow(text,uuid,uuid,jsonb) RENAME TO member_workflow_before_mail_admission;
REVOKE ALL ON FUNCTION team_private.member_workflow_before_mail_admission(text,uuid,uuid,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.team_member_workflow(p_action text,p_actor uuid,p_session uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor team_private.members%ROWTYPE; policy jsonb;
BEGIN
  IF p_action='invite' THEN
    actor:=team_private.caller(p_actor,p_session);
    PERFORM pg_advisory_xact_lock(hashtextextended('team-members:'||actor.team_id::text,0));
    actor:=team_private.caller(p_actor,p_session);
    IF actor.role NOT IN ('superadmin','admin') THEN PERFORM team_private.refuse('forbidden',403); END IF;
    -- A lost response must still replay when the team is now at its limit.
    IF NOT EXISTS(SELECT 1 FROM team_private.member_operations WHERE actor_member_id=actor.id
      AND action='invite' AND subject_email_digest IS NULL AND idempotency_key=p_input->>'idempotency_key') THEN
      policy:=team_private.mail_policy();
      IF (SELECT count(*) FROM team_private.invitations WHERE team_id=actor.team_id AND state='invited'
        AND expires_at>clock_timestamp())>=(policy->>'max_pending')::integer THEN
        PERFORM team_private.refuse('invitation_limit_reached',429);
      END IF;
    END IF;
  END IF;
  RETURN team_private.member_workflow_before_mail_admission(p_action,p_actor,p_session,p_input);
END $$;
ALTER FUNCTION public.team_member_workflow(text,uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.team_member_workflow(text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.team_member_workflow(text,uuid,uuid,jsonb) TO service_role;

CREATE FUNCTION public.team_mail_delivery(p_action text,p_input jsonb,p_actor uuid DEFAULT NULL,
  p_session uuid DEFAULT NULL,p_client_ip inet DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor team_private.members%ROWTYPE; invitation team_private.invitations%ROWTYPE;
  challenge team_private.email_challenges%ROWTYPE; delivery team_private.mail_deliveries%ROWTYPE;
  address text; recipient text; tid uuid; inviter uuid; key text; policy jsonb;
  stamp timestamptz:=clock_timestamp(); short_from timestamptz; daily_from timestamptz;
  count_short bigint; count_daily bigint; invitation_short bigint; invitation_daily bigint;
  latest timestamptz; claimed boolean:=false; outcome text; existing_state text;
BEGIN
  IF p_action='finish' THEN
    -- A legitimate in-flight send must be recorded even if its caller has since
    -- been disabled. Only the private, single-use lease can finish that send.
    SELECT * INTO delivery FROM team_private.mail_deliveries WHERE id=(p_input->>'delivery_id')::uuid FOR UPDATE;
    IF delivery.id IS NULL OR delivery.state<>'sending' OR delivery.lease_token IS DISTINCT FROM (p_input->>'lease_token')::uuid THEN
      PERFORM team_private.refuse('version_conflict',409);
    END IF;
    outcome:=p_input->>'state';
    IF outcome IS NULL OR outcome NOT IN ('accepted','failed','unknown') OR p_input->>'reason_code' IS NULL OR p_input->>'reason_code' NOT IN
      ('smtp_accepted','smtp_rejected','smtp_result_unknown','identity_unavailable','code_accepted','code_result_unknown') THEN
      PERFORM team_private.refuse('invalid_request',400);
    END IF;
    IF outcome='accepted' AND
      (delivery.invitation_id IS NOT NULL AND p_input->>'reason_code'<>'smtp_accepted'
        OR delivery.challenge_id IS NOT NULL AND p_input->>'reason_code'<>'code_accepted')
      OR outcome='unknown' AND p_input->>'reason_code' NOT IN ('smtp_result_unknown','code_result_unknown')
      OR outcome='failed' AND p_input->>'reason_code' NOT IN ('smtp_rejected','identity_unavailable') THEN
      PERFORM team_private.refuse('invalid_request',400);
    END IF;
    UPDATE team_private.mail_deliveries SET state=outcome,reason_code=p_input->>'reason_code',
      finished_at=stamp,lease_token=NULL,lease_expires_at=NULL WHERE id=delivery.id RETURNING * INTO delivery;
    RETURN jsonb_build_object('delivery_id',delivery.id,'state',delivery.state,'reason_code',delivery.reason_code,'claimed',false);
  END IF;
  IF p_action NOT IN ('prepare','claim') THEN PERFORM team_private.refuse('invalid_request',400); END IF;
  IF p_input->>'kind'='invitation' THEN
    actor:=team_private.caller(p_actor,p_session);
    SELECT * INTO invitation FROM team_private.invitations WHERE id=(p_input->>'invitation_id')::uuid FOR UPDATE;
    IF invitation.id IS NULL OR actor.role NOT IN ('superadmin','admin') OR invitation.team_id<>actor.team_id
      OR invitation.created_by_member_id<>actor.id THEN PERFORM team_private.refuse('forbidden',403); END IF;
    SELECT state INTO existing_state FROM team_private.mail_deliveries WHERE invitation_id=invitation.id;
    IF (invitation.state<>'invited' OR invitation.expires_at<=stamp OR invitation.token_digest IS NULL)
      AND COALESCE(existing_state,'pending')='pending' THEN
      PERFORM team_private.refuse('invitation_invalid',404);
    END IF;
    address:=invitation.email_normalized; tid:=invitation.team_id; inviter:=actor.id;
    key:='team-invitation-v1:'||invitation.id::text;
  ELSIF p_input->>'kind'='code' THEN
    SELECT * INTO challenge FROM team_private.email_challenges WHERE id=(p_input->>'challenge_id')::uuid FOR UPDATE;
    IF challenge.id IS NULL OR challenge.expires_at<=stamp OR challenge.state NOT IN ('sending','challenge') THEN
      PERFORM team_private.refuse('verification_expired',401);
    END IF;
    address:=challenge.email_normalized;
    IF challenge.purpose='change_email' THEN
      actor:=team_private.caller(p_actor,p_session);
      IF challenge.administrator_id IS DISTINCT FROM actor.id OR challenge.team_id IS DISTINCT FROM actor.team_id THEN
        PERFORM team_private.refuse('forbidden',403);
      END IF;
      tid:=actor.team_id; inviter:=actor.id;
    ELSIF challenge.invitation_id IS NOT NULL THEN
      SELECT * INTO invitation FROM team_private.invitations WHERE id=challenge.invitation_id FOR UPDATE;
      IF invitation.state IS DISTINCT FROM 'invited' OR invitation.expires_at<=stamp
        OR invitation.email_normalized IS DISTINCT FROM address THEN PERFORM team_private.refuse('invitation_invalid',404); END IF;
      tid:=invitation.team_id; inviter:=invitation.created_by_member_id;
    END IF;
    -- Public sign-in/create challenges cannot select a rate scope by passing a
    -- team UUID. Only a checked invitation or live administrator supplies it.
    key:='team-email-code-v1:'||challenge.id::text;
  ELSE PERFORM team_private.refuse('invalid_request',400);
  END IF;
  recipient:=encode(sha256(convert_to(address,'UTF8')),'hex');
  INSERT INTO team_private.mail_deliveries(delivery_key,invitation_id,challenge_id,team_id,inviter_member_id,recipient_digest)
    VALUES(key,CASE WHEN p_input->>'kind'='invitation' THEN invitation.id END,
      CASE WHEN p_input->>'kind'='code' THEN challenge.id END,tid,inviter,recipient) ON CONFLICT(delivery_key) DO NOTHING;
  SELECT * INTO STRICT delivery FROM team_private.mail_deliveries WHERE delivery_key=key FOR UPDATE;
  IF ROW(delivery.recipient_digest,delivery.team_id,delivery.inviter_member_id) IS DISTINCT FROM ROW(recipient,tid,inviter) THEN
    PERFORM team_private.refuse('version_conflict',409);
  END IF;
  IF delivery.state='sending' AND delivery.lease_expires_at<=stamp THEN
    UPDATE team_private.mail_deliveries SET state='unknown',reason_code='lease_expired',finished_at=stamp,
      lease_token=NULL,lease_expires_at=NULL WHERE id=delivery.id RETURNING * INTO delivery;
  END IF;
  IF p_action='claim' AND delivery.state='pending' THEN
    -- The global bucket is deliberately always present, including when ingress
    -- cannot attest an IP. One lock makes every admission dimension atomic.
    PERFORM pg_advisory_xact_lock(hashtextextended('team-mail-admission',0));
    policy:=team_private.mail_policy(); stamp:=clock_timestamp();
    IF invitation.id IS NOT NULL AND invitation.expires_at<=stamp
      OR challenge.id IS NOT NULL AND challenge.expires_at<=stamp THEN
      PERFORM team_private.refuse('verification_expired',401);
    END IF;
    short_from:=stamp-make_interval(secs=>(policy->>'short_seconds')::integer);
    daily_from:=stamp-make_interval(secs=>(policy->>'daily_seconds')::integer);
    SELECT count(*) FILTER(WHERE admitted_at>short_from),count(*),
      count(*) FILTER(WHERE invitation_id IS NOT NULL AND admitted_at>short_from),
      count(*) FILTER(WHERE invitation_id IS NOT NULL)
      INTO count_short,count_daily,invitation_short,invitation_daily
      FROM team_private.mail_deliveries WHERE admitted_at>daily_from;
    IF count_short>=(policy->>'global_short')::integer OR count_daily>=(policy->>'global_daily')::integer THEN
      PERFORM team_private.refuse('rate_limited',429);
    END IF;
    IF delivery.invitation_id IS NOT NULL THEN
      -- Invitations cannot consume the OTP reservation of the global bucket.
      IF invitation_short>=floor((policy->>'global_short')::numeric*(policy->>'invitation_global_percent')::numeric/100)
        OR invitation_daily>=floor((policy->>'global_daily')::numeric*(policy->>'invitation_global_percent')::numeric/100) THEN
        PERFORM team_private.refuse('rate_limited',429);
      END IF;
      SELECT count(*),max(admitted_at) INTO count_daily,latest FROM team_private.mail_deliveries
        WHERE recipient_digest=recipient AND invitation_id IS NOT NULL AND admitted_at>daily_from;
      IF count_daily>=(policy->>'recipient_daily')::integer OR latest>stamp-make_interval(secs=>(policy->>'recipient_cooldown_seconds')::integer) THEN
        PERFORM team_private.refuse('rate_limited',429);
      END IF;
    ELSE
      -- Keep the established OTP recipient bucket independent from invitations:
      -- 60-second cooldown and three attempts per rolling 15 minutes.
      SELECT count(*),max(admitted_at) INTO count_short,latest FROM team_private.mail_deliveries
        WHERE recipient_digest=recipient AND challenge_id IS NOT NULL AND admitted_at>stamp-interval '15 minutes';
      IF count_short>=3 OR latest>stamp-interval '60 seconds' THEN PERFORM team_private.refuse('rate_limited',429); END IF;
    END IF;
    IF tid IS NOT NULL THEN
      SELECT count(*) FILTER(WHERE admitted_at>short_from),count(*) INTO count_short,count_daily
        FROM team_private.mail_deliveries WHERE team_id=tid AND admitted_at>daily_from;
      IF count_short>=(policy->>'team_short')::integer OR count_daily>=(policy->>'team_daily')::integer THEN
        PERFORM team_private.refuse('rate_limited',429);
      END IF;
    END IF;
    IF inviter IS NOT NULL THEN
      SELECT count(*) FILTER(WHERE admitted_at>short_from),count(*) INTO count_short,count_daily
        FROM team_private.mail_deliveries WHERE inviter_member_id=inviter AND admitted_at>daily_from;
      IF count_short>=(policy->>'inviter_short')::integer OR count_daily>=(policy->>'inviter_daily')::integer THEN
        PERFORM team_private.refuse('rate_limited',429);
      END IF;
    END IF;
    IF p_client_ip IS NOT NULL THEN
      delivery.ip_digest:=encode(sha256(convert_to(host(p_client_ip),'UTF8')),'hex');
      SELECT count(*) FILTER(WHERE admitted_at>short_from),count(*) INTO count_short,count_daily
        FROM team_private.mail_deliveries WHERE ip_digest=delivery.ip_digest AND admitted_at>daily_from;
      IF count_short>=(policy->>'ip_short')::integer OR count_daily>=(policy->>'ip_daily')::integer THEN
        PERFORM team_private.refuse('rate_limited',429);
      END IF;
    END IF;
    UPDATE team_private.mail_deliveries SET state='sending',lease_token=gen_random_uuid(),
      lease_expires_at=stamp+interval '60 seconds',admitted_at=stamp,ip_digest=delivery.ip_digest
      WHERE id=delivery.id RETURNING * INTO delivery;
    claimed:=true;
  END IF;
  RETURN jsonb_build_object('delivery_id',delivery.id,'delivery_key',delivery.delivery_key,
    'state',delivery.state,'reason_code',delivery.reason_code,'claimed',claimed,
    'lease_token',CASE WHEN claimed THEN delivery.lease_token END,'recipient_email',address,
    'team_name',(SELECT name FROM team_private.teams WHERE id=tid),
    'expires_at',COALESCE(invitation.expires_at,challenge.expires_at));
END $$;
ALTER FUNCTION public.team_mail_delivery(text,jsonb,uuid,uuid,inet) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.team_mail_delivery(text,jsonb,uuid,uuid,inet) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.team_mail_delivery(text,jsonb,uuid,uuid,inet) TO service_role;

ALTER FUNCTION team_private.valid_mail_policy(jsonb) OWNER TO postgres;
ALTER FUNCTION team_private.mail_policy() OWNER TO postgres;
REVOKE ALL ON FUNCTION team_private.valid_mail_policy(jsonb),team_private.mail_policy() FROM PUBLIC,anon,authenticated,service_role;
