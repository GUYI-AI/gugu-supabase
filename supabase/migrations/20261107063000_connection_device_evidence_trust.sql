-- Device identity is independent from owner-writable device/topic rows. Only a
-- separately reviewed trusted pairing/deployment process may populate this root.
-- No API role can enroll, replace, revoke or read these keys by installing this.
CREATE TABLE identity.connection_device_evidence_keys (
    key_id uuid PRIMARY KEY,
    owner_user_id text NOT NULL REFERENCES identity.connection_heads(owner_user_id) ON DELETE CASCADE,
    -- Preserve trust audit when an owner removes a device. Issue/consume require
    -- the current device row and ownership separately; no old device API is blocked.
    device_id text NOT NULL,
    public_key text NOT NULL CHECK (public_key ~ '^MCowBQYDK2VwAyEA[A-Za-z0-9_-]{43}$'),
    enrollment_reference text NOT NULL CHECK (length(enrollment_reference) BETWEEN 1 AND 128),
    enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz,
    UNIQUE(owner_user_id,device_id,key_id)
);
CREATE UNIQUE INDEX connection_device_evidence_active_key
    ON identity.connection_device_evidence_keys(owner_user_id,device_id) WHERE revoked_at IS NULL;
CREATE TABLE identity.connection_evidence_challenges (
    challenge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id text NOT NULL,
    operation_id uuid NOT NULL REFERENCES identity.connection_attempts(operation_id) ON DELETE CASCADE,
    attempt_id uuid NOT NULL REFERENCES identity.connection_attempts(attempt_id) ON DELETE CASCADE,
    device_id text NOT NULL,
    key_id uuid NOT NULL,
    action text NOT NULL CHECK(action IN ('read','fence')),
    nonce text NOT NULL UNIQUE CHECK(nonce ~ '^[0-9a-f]{64}$'),
    challenge jsonb NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    reply_digest text CHECK(reply_digest IS NULL OR reply_digest ~ '^[0-9a-f]{64}$'),
    FOREIGN KEY(owner_user_id,device_id,key_id)
      REFERENCES identity.connection_device_evidence_keys(owner_user_id,device_id,key_id),
    CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '60 seconds'),
    CHECK((consumed_at IS NULL)=(reply_digest IS NULL))
);
ALTER TABLE identity.connection_device_evidence_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.connection_evidence_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.connection_device_evidence_keys,identity.connection_evidence_challenges
    FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.connection_evidence_challenge_issue(p_owner text,p_operation_id uuid,p_action text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a identity.connection_attempts%ROWTYPE; k identity.connection_device_evidence_keys%ROWTYPE;
    id uuid:=gen_random_uuid(); nonce text; issued timestamptz:=clock_timestamp(); expiry timestamptz; challenge jsonb;
BEGIN
    PERFORM 1 FROM identity.connection_heads WHERE owner_user_id=p_owner FOR UPDATE;
    SELECT * INTO a FROM identity.connection_attempts WHERE operation_id=p_operation_id AND owner_user_id=p_owner FOR UPDATE;
    IF NOT FOUND OR a.executor_kind<>'runtime' OR a.prepared_at IS NULL OR p_action IS NULL OR p_action NOT IN('read','fence')
      OR EXISTS(SELECT 1 FROM identity.connection_resolutions WHERE operation_id=p_operation_id) THEN
        RAISE EXCEPTION 'Connection evidence challenge is unavailable' USING ERRCODE='42501'; END IF;
    SELECT * INTO k FROM identity.connection_device_evidence_keys WHERE owner_user_id=p_owner AND device_id=a.device_id AND revoked_at IS NULL FOR SHARE;
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM identity.gugu_devices WHERE device_id=a.device_id AND user_id::text=p_owner) THEN
        RAISE EXCEPTION 'Connection evidence device is not enrolled' USING ERRCODE='42501'; END IF;
    -- Two independent random UUIDs supply a unique, unguessable request nonce.
    nonce:=encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text,'UTF8')),'hex');
    expiry:=issued+interval '60 seconds';
    challenge:=jsonb_build_object('version',1,'challengeId',id,'nonce',nonce,'keyId',k.key_id,
        'ownerId',p_owner,'deviceId',a.device_id,'operationId',p_operation_id,'attemptId',a.attempt_id,
        'action',p_action,'expiresAt',to_char(expiry AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    INSERT INTO identity.connection_evidence_challenges(challenge_id,owner_user_id,operation_id,attempt_id,device_id,key_id,action,nonce,challenge,issued_at,expires_at)
      VALUES(id,p_owner,p_operation_id,a.attempt_id,a.device_id,k.key_id,p_action,nonce,challenge,issued,expiry);
    RETURN jsonb_build_object('challenge',challenge,'publicKey',k.public_key);
END;
$$;
CREATE FUNCTION identity.connection_evidence_challenge_read(p_challenge_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
    SELECT jsonb_build_object('challenge',c.challenge,'publicKey',k.public_key)
      FROM identity.connection_evidence_challenges c JOIN identity.connection_device_evidence_keys k
        ON k.key_id=c.key_id AND k.owner_user_id=c.owner_user_id AND k.device_id=c.device_id AND k.revoked_at IS NULL
      WHERE c.challenge_id=p_challenge_id
$$;
-- This function is called only by the privileged verifier after Ed25519
-- verification against the independently read trusted key. It also binds and
-- consumes the exact service-issued challenge in the same outcome transaction.
-- A topic sender cannot call it or submit an unsigned observation as evidence.
CREATE FUNCTION identity.connection_evidence_challenge_consume(p_owner text,p_operation_id uuid,p_reply jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a identity.connection_attempts%ROWTYPE; c identity.connection_evidence_challenges%ROWTYPE; digest text;
BEGIN
    PERFORM 1 FROM identity.connection_heads WHERE owner_user_id=p_owner FOR UPDATE;
    SELECT * INTO a FROM identity.connection_attempts WHERE owner_user_id=p_owner AND operation_id=p_operation_id FOR UPDATE;
    IF NOT FOUND OR p_reply->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p_reply->'challenge') IS DISTINCT FROM 'object'
      OR jsonb_typeof(p_reply->'proof') IS DISTINCT FROM 'object' OR p_reply->>'signature' IS NULL
      OR p_reply->>'signature' !~ '^[A-Za-z0-9_-]{86}$' OR octet_length(p_reply::text)>2097152
      OR (SELECT count(*) FROM jsonb_object_keys(p_reply))<>4 THEN
        RAISE EXCEPTION 'Connection evidence reply is unavailable' USING ERRCODE='42501'; END IF;
    SELECT * INTO c FROM identity.connection_evidence_challenges WHERE challenge_id=(p_reply->'challenge'->>'challengeId')::uuid FOR UPDATE;
    IF NOT FOUND OR c.owner_user_id<>p_owner OR c.operation_id<>p_operation_id OR c.attempt_id<>a.attempt_id
      OR c.device_id IS DISTINCT FROM a.device_id OR c.challenge IS DISTINCT FROM p_reply->'challenge'
      OR p_reply->'proof'->'attempt' IS DISTINCT FROM identity.connection_attempt_context(p_owner,p_operation_id)
      OR NOT EXISTS(SELECT 1 FROM identity.connection_device_evidence_keys k WHERE k.key_id=c.key_id AND k.owner_user_id=p_owner
        AND k.device_id=a.device_id AND k.revoked_at IS NULL)
      OR NOT EXISTS(SELECT 1 FROM identity.gugu_devices WHERE device_id=a.device_id AND user_id::text=p_owner) THEN
        RAISE EXCEPTION 'Connection evidence challenge differs' USING ERRCODE='42501'; END IF;
    digest:=encode(sha256(convert_to(p_reply::text,'UTF8')),'hex');
    IF c.consumed_at IS NOT NULL THEN
        IF c.reply_digest IS DISTINCT FROM digest THEN RAISE EXCEPTION 'Connection evidence challenge was reused' USING ERRCODE='42501'; END IF;
        RETURN p_reply->'proof';
    END IF;
    IF clock_timestamp()>=c.expires_at THEN RAISE EXCEPTION 'Connection evidence challenge expired' USING ERRCODE='42501'; END IF;
    UPDATE identity.connection_evidence_challenges SET consumed_at=clock_timestamp(),reply_digest=digest WHERE challenge_id=c.challenge_id;
    RETURN p_reply->'proof';
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_evidence_challenge_issue(text,uuid,text),
    identity.connection_evidence_challenge_read(uuid),identity.connection_evidence_challenge_consume(text,uuid,jsonb)
    FROM PUBLIC,anon,authenticated,service_role;
