-- Additive evidence protocol. Original operation/admission receipts remain
-- immutable. No worker, authority transition, legacy entry point or API write
-- permission is activated by installing this release.
-- Only newly issued tickets participate in the evidence protocol. Existing
-- in-flight tickets remain activation inventory; never invent their history.
ALTER TABLE identity.connection_recreation_intents ADD COLUMN evidence_protocol boolean NOT NULL DEFAULT false;
-- Each new ticket selects the explicit server capability; legacy tickets remain legacy.
ALTER TABLE identity.connection_recreation_intents ALTER COLUMN evidence_protocol SET DEFAULT false;
ALTER TABLE identity.connection_recreation_intents ADD COLUMN intent_generation bigint GENERATED ALWAYS AS IDENTITY UNIQUE;

CREATE TABLE identity.connection_attempts (
    attempt_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id uuid NOT NULL UNIQUE,
    owner_user_id text NOT NULL REFERENCES identity.connection_heads(owner_user_id) ON DELETE CASCADE,
    scope_key text NOT NULL,
    resource_key text,
    device_id text,
    provider_id text NOT NULL,
    account_id text,
    operation text NOT NULL CHECK (operation IN ('save','remove','enable','disable')),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    operation_revision bigint,
    admission_id uuid REFERENCES identity.connection_admissions(admission_id),
    recreation_id uuid REFERENCES identity.connection_recreation_intents(recreation_id),
    authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
    credential_generation uuid NOT NULL DEFAULT gen_random_uuid(),
    executor_kind text NOT NULL CHECK (executor_kind IN ('platform','runtime')),
    runtime_instance_id text,
    prepared_at timestamptz,
    initial_head_revision bigint NOT NULL,
    started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    deadline_at timestamptz NOT NULL DEFAULT statement_timestamp() + interval '10 minutes',
    fenced_at timestamptz,
    fence_kind text CHECK (fence_kind IN ('platform-transaction','native-transaction','unprepared-intent')),
    fence_digest text CHECK (fence_digest IS NULL OR fence_digest ~ '^[0-9a-f]{64}$'),
    CHECK ((scope_key='platform' AND device_id IS NULL AND executor_kind='platform' AND runtime_instance_id IS NULL)
        OR (device_id IS NOT NULL AND scope_key='device:' || device_id AND executor_kind='runtime' AND (runtime_instance_id IS NOT NULL OR prepared_at IS NULL))),
    CHECK ((fenced_at IS NULL AND fence_kind IS NULL AND fence_digest IS NULL)
        OR (fenced_at IS NOT NULL AND fence_kind IS NOT NULL AND fence_digest IS NOT NULL)),
    CHECK (deadline_at > started_at AND deadline_at <= started_at + interval '10 minutes')
);
CREATE INDEX connection_attempts_due ON identity.connection_attempts(deadline_at,operation_id);
CREATE TABLE identity.connection_effect_evidence (
    operation_id uuid PRIMARY KEY REFERENCES identity.connection_attempts(operation_id) ON DELETE CASCADE,
    attempt_id uuid NOT NULL REFERENCES identity.connection_attempts(attempt_id) ON DELETE CASCADE,
    owner_user_id text NOT NULL REFERENCES identity.connection_heads(owner_user_id) ON DELETE CASCADE,
    credential_generation uuid NOT NULL,
    provider_id text NOT NULL,
    account_id text NOT NULL,
    evidence_kind text NOT NULL CHECK (evidence_kind IN ('platform-transaction','native-transaction')),
    outcome text NOT NULL CHECK (outcome IN ('applied','failed')),
    evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
    public_request jsonb CHECK (public_request IS NULL OR jsonb_typeof(public_request)='object' AND octet_length(public_request::text)<=1572864),
    public_request_hash text CHECK (public_request_hash IS NULL OR public_request_hash ~ '^[0-9a-f]{64}$'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE identity.connection_resolutions (
    operation_id uuid PRIMARY KEY REFERENCES identity.connection_attempts(operation_id) ON DELETE CASCADE,
    attempt_id uuid NOT NULL REFERENCES identity.connection_attempts(attempt_id) ON DELETE CASCADE,
    owner_user_id text NOT NULL REFERENCES identity.connection_heads(owner_user_id) ON DELETE CASCADE,
    request_hash text NOT NULL,
    operation_revision bigint,
    admission_id uuid,
    outcome text NOT NULL CHECK (outcome IN ('applied','failed')),
    error_code text CHECK (error_code IS NULL OR error_code='CONNECTION_CONFIRMATION_FAILED'),
    resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((outcome='applied' AND error_code IS NULL) OR (outcome='failed' AND error_code IS NOT NULL))
);
ALTER TABLE identity.connection_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.connection_effect_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.connection_resolutions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.connection_attempts,identity.connection_effect_evidence,identity.connection_resolutions
    FROM PUBLIC,anon,authenticated,service_role;

-- Register the original protocol-2 authorization BEFORE returning its ticket.
-- Until prepare binds a runtime, no credential generation is disclosed to a
-- device. A lost ticket/prepare response therefore remains a durable candidate.
CREATE FUNCTION identity.connection_attempt_initialize(p_owner text,p_operation_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE i identity.connection_recreation_intents%ROWTYPE; h identity.connection_heads%ROWTYPE;
BEGIN
    SELECT * INTO h FROM identity.connection_heads WHERE owner_user_id=p_owner FOR UPDATE;
    SELECT * INTO i FROM identity.connection_recreation_intents WHERE owner_user_id=p_owner AND operation_id=p_operation_id;
    IF NOT FOUND OR NOT i.evidence_protocol THEN RETURN; END IF;
    INSERT INTO identity.connection_attempts(operation_id,owner_user_id,scope_key,resource_key,device_id,provider_id,account_id,
        operation,request_hash,recreation_id,authority_epoch,executor_kind,initial_head_revision)
      VALUES(i.operation_id,p_owner,i.scope_key,i.resource_key,i.device_id,
        COALESCE(i.provider_id,identity.connection_account_key(i.resource_key)->>0),identity.connection_account_key(i.resource_key)->>1,
        'save',encode(sha256(convert_to(jsonb_build_array(i.operation_id,i.recreation_id,p_owner,i.scope_key,i.resource_key,
          i.device_id,i.provider_id,i.expected_item_revision,i.expected_head_revision)::text,'UTF8')),'hex'),
        i.recreation_id,h.authority_epoch,CASE WHEN i.device_id IS NULL THEN 'platform' ELSE 'runtime' END,h.revision)
      ON CONFLICT(operation_id) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_attempt_initialize(text,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Trusted custody adapters call this inside their effect protocol. The owner
-- argument is never a client-selected identity; wrappers must derive it from
-- the validated JWT or an authenticated device response. All writers stay closed.
CREATE FUNCTION identity.connection_attempt_begin(p_owner text,p_operation_id uuid,p_epoch bigint,p_runtime_instance_id text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE c identity.connection_operations%ROWTYPE; i identity.connection_recreation_intents%ROWTYPE;
    a identity.connection_attempts%ROWTYPE; h identity.connection_heads%ROWTYPE;
    v_scope text; v_key text; v_device text; v_provider text; v_account text; v_operation text; v_hash text;
BEGIN
    PERFORM 1 FROM identity.connection_heads WHERE owner_user_id=p_owner FOR UPDATE;
    SELECT * INTO a FROM identity.connection_attempts WHERE operation_id=p_operation_id;
    IF FOUND THEN
        IF a.owner_user_id IS DISTINCT FROM p_owner OR a.authority_epoch IS DISTINCT FROM p_epoch
            OR a.prepared_at IS NOT NULL AND a.runtime_instance_id IS DISTINCT FROM p_runtime_instance_id THEN
            RAISE EXCEPTION 'Connection attempt is unavailable' USING ERRCODE='42501'; END IF;
        IF a.prepared_at IS NULL THEN
            IF a.device_id IS NOT NULL AND identity.connection_runtime(p_owner,p_runtime_instance_id) IS DISTINCT FROM a.device_id
                OR a.device_id IS NULL AND p_runtime_instance_id IS NOT NULL THEN
                RAISE EXCEPTION 'Connection attempt device is unavailable' USING ERRCODE='42501'; END IF;
            UPDATE identity.connection_attempts SET runtime_instance_id=p_runtime_instance_id,prepared_at=clock_timestamp()
              WHERE attempt_id=a.attempt_id;
        END IF;
        RETURN a.attempt_id;
    END IF;
    SELECT * INTO h FROM identity.connection_heads WHERE owner_user_id=p_owner;
    IF h.owner_user_id IS NULL OR h.authority_mode<>'owner' OR h.authority_phase<>'stable' OR h.authority_epoch IS DISTINCT FROM p_epoch OR h.verification_protocol<>2 THEN
        RAISE EXCEPTION 'Connection authority changed' USING ERRCODE='PT409'; END IF;
    SELECT * INTO c FROM identity.connection_operations WHERE operation_id=p_operation_id AND owner_user_id=p_owner;
    IF FOUND THEN
        IF c.operation NOT IN ('save','remove','enable','disable') OR c.status='superseded' THEN
            RAISE EXCEPTION 'Connection attempt cannot execute' USING ERRCODE='PT409'; END IF;
        v_scope:=c.scope_key; v_key:=c.resource_key; v_device:=c.device_id; v_operation:=c.operation; v_hash:=c.request_hash;
        v_provider:=COALESCE(c.payload->'before'->>'providerId',c.payload->'data'->>'providerId');
        v_account:=COALESCE(c.payload->'before'->>'accountId',c.payload->'data'->>'accountId');
        IF c.last_admission_id IS NULL OR NOT EXISTS (SELECT 1 FROM identity.connection_admissions d
            WHERE d.admission_id=c.last_admission_id AND d.operation_id=c.operation_id AND d.owner_user_id=p_owner
              AND d.request_hash=c.request_hash AND d.operation_revision=c.revision
              AND d.runtime_instance_id IS NOT DISTINCT FROM p_runtime_instance_id) THEN
            RAISE EXCEPTION 'Connection admission is unavailable' USING ERRCODE='42501'; END IF;
    ELSE
        SELECT * INTO i FROM identity.connection_recreation_intents WHERE operation_id=p_operation_id AND owner_user_id=p_owner;
        IF NOT FOUND OR NOT i.evidence_protocol OR i.consumed_at IS NOT NULL OR i.expires_at<=clock_timestamp() THEN
            RAISE EXCEPTION 'Connection authorization is unavailable' USING ERRCODE='42501'; END IF;
        v_scope:=i.scope_key; v_key:=i.resource_key; v_device:=i.device_id; v_provider:=COALESCE(i.provider_id,identity.connection_account_key(i.resource_key)->>0);
        v_account:=identity.connection_account_key(i.resource_key)->>1; v_operation:='save';
        v_hash:=encode(sha256(convert_to(jsonb_build_array(i.operation_id,i.recreation_id,p_owner,i.scope_key,i.resource_key,
            i.device_id,i.provider_id,i.expected_item_revision,i.expected_head_revision)::text,'UTF8')),'hex');
    END IF;
    IF v_provider IS NULL OR v_provider !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' THEN
        RAISE EXCEPTION 'Connection provider is invalid' USING ERRCODE='22023'; END IF;
    IF v_device IS NOT NULL AND identity.connection_runtime(p_owner,p_runtime_instance_id) IS DISTINCT FROM v_device
        OR v_device IS NULL AND p_runtime_instance_id IS NOT NULL THEN
        RAISE EXCEPTION 'Connection attempt device is unavailable' USING ERRCODE='42501'; END IF;
    INSERT INTO identity.connection_attempts(operation_id,owner_user_id,scope_key,resource_key,device_id,provider_id,account_id,
        operation,request_hash,operation_revision,admission_id,recreation_id,authority_epoch,executor_kind,runtime_instance_id,prepared_at,initial_head_revision)
      VALUES(p_operation_id,p_owner,v_scope,v_key,v_device,v_provider,v_account,v_operation,v_hash,c.revision,c.last_admission_id,i.recreation_id,
        p_epoch,CASE WHEN v_device IS NULL THEN 'platform' ELSE 'runtime' END,p_runtime_instance_id,clock_timestamp(),h.revision) RETURNING * INTO a;
    RETURN a.attempt_id;
END;
$$;

-- Must remain in the SAME transaction/lock as the actual effect commit, not
-- a client-visible check-then-write permission. No heartbeat proves a fence.
CREATE FUNCTION identity.connection_attempt_write_fence(p_owner text,p_operation_id uuid,p_attempt_id uuid,p_epoch bigint)
RETURNS identity.connection_attempts LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a identity.connection_attempts%ROWTYPE; h identity.connection_heads%ROWTYPE; c identity.connection_operations%ROWTYPE;
BEGIN
    SELECT * INTO h FROM identity.connection_heads WHERE owner_user_id=p_owner FOR UPDATE;
    SELECT * INTO a FROM identity.connection_attempts WHERE owner_user_id=p_owner AND operation_id=p_operation_id AND attempt_id=p_attempt_id FOR UPDATE;
    IF NOT FOUND OR a.prepared_at IS NULL OR a.fenced_at IS NOT NULL OR a.authority_epoch IS DISTINCT FROM p_epoch OR h.authority_epoch IS DISTINCT FROM p_epoch
        OR h.authority_mode<>'owner' OR h.authority_phase<>'stable' OR clock_timestamp()>=a.deadline_at THEN
        RAISE EXCEPTION 'Connection attempt is fenced' USING ERRCODE='PT409'; END IF;
    IF a.device_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM identity.gugu_devices WHERE device_id=a.device_id AND user_id::text=p_owner) THEN
        RAISE EXCEPTION 'Connection device ownership changed' USING ERRCODE='42501'; END IF;
    IF EXISTS (SELECT 1 FROM identity.connection_resolutions WHERE operation_id=p_operation_id) THEN
        RAISE EXCEPTION 'Connection attempt is settled' USING ERRCODE='PT409'; END IF;
    IF a.operation_revision IS NOT NULL THEN
        SELECT * INTO c FROM identity.connection_operations WHERE owner_user_id=p_owner AND operation_id=p_operation_id;
        IF c.request_hash IS DISTINCT FROM a.request_hash OR c.revision IS DISTINCT FROM a.operation_revision
            OR c.last_admission_id IS DISTINCT FROM a.admission_id OR c.status='superseded'
            OR NOT EXISTS (SELECT 1 FROM identity.connection_items WHERE owner_user_id=p_owner AND scope_key=a.scope_key
                AND resource_key=a.resource_key AND revision=a.operation_revision) THEN
            RAISE EXCEPTION 'Connection attempt was superseded' USING ERRCODE='PT409'; END IF;
    ELSE
        IF NOT EXISTS (SELECT 1 FROM identity.connection_recreation_intents i WHERE i.recreation_id=a.recreation_id
            AND i.owner_user_id=p_owner AND i.operation_id=p_operation_id AND i.consumed_at IS NULL AND i.expires_at>clock_timestamp()
            AND (i.expected_head_revision IS NULL OR i.expected_head_revision=h.revision)
            AND (i.resource_key IS NULL OR COALESCE((SELECT revision FROM identity.connection_items
                WHERE owner_user_id=p_owner AND scope_key=i.scope_key AND resource_key=i.resource_key),0)=i.expected_item_revision)) THEN
            RAISE EXCEPTION 'Connection authorization changed' USING ERRCODE='PT409'; END IF;
    END IF;
    RETURN a;
END;
$$;

-- Only a trusted custody transaction or authenticated native evidence adapter
-- may append evidence. Raw client claims and account snapshots are not proofs.
CREATE FUNCTION identity.connection_record_effect(p_owner text,p_operation_id uuid,p_attempt_id uuid,p_generation uuid,
    p_provider text,p_account text,p_outcome text,p_kind text,p_digest text,p_public_request jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a identity.connection_attempts%ROWTYPE; e identity.connection_effect_evidence%ROWTYPE; c identity.connection_operations%ROWTYPE; publication_hash text;
BEGIN
    PERFORM 1 FROM identity.connection_heads WHERE owner_user_id=p_owner FOR UPDATE;
    SELECT * INTO a FROM identity.connection_attempts WHERE owner_user_id=p_owner AND operation_id=p_operation_id AND attempt_id=p_attempt_id FOR UPDATE;
    IF NOT FOUND OR p_generation IS DISTINCT FROM a.credential_generation OR p_provider IS DISTINCT FROM a.provider_id
        OR a.account_id IS NOT NULL AND a.account_id IS DISTINCT FROM p_account
        OR p_account IS NULL OR length(p_account) NOT BETWEEN 1 AND 512 OR p_outcome IS NULL OR p_outcome NOT IN ('applied','failed')
        OR p_kind IS DISTINCT FROM (CASE WHEN a.executor_kind='platform' THEN 'platform-transaction' ELSE 'native-transaction' END)
        OR a.device_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM identity.gugu_devices WHERE device_id=a.device_id AND user_id::text=p_owner)
        OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Connection effect evidence is unavailable' USING ERRCODE='42501'; END IF;
    IF a.recreation_id IS NOT NULL THEN
        IF p_public_request IS NULL OR p_public_request->>'operationId' IS DISTINCT FROM p_operation_id::text
            OR p_public_request->>'scopeKey' IS DISTINCT FROM a.scope_key
            OR p_public_request->>'deviceId' IS DISTINCT FROM a.device_id
            OR p_public_request->>'recreationId' IS DISTINCT FROM a.recreation_id::text
            OR p_public_request->'data'->>'providerId' IS DISTINCT FROM p_provider
            OR p_public_request->'data'->>'accountId' IS DISTINCT FROM p_account THEN
            RAISE EXCEPTION 'Connection original publication differs' USING ERRCODE='PT409'; END IF;
        publication_hash:=identity.connection_public_request_hash(p_owner,p_public_request,a.executor_kind='runtime');
    ELSIF p_public_request IS NOT NULL THEN
        RAISE EXCEPTION 'Connection effect has no authorization publication' USING ERRCODE='22023';
    END IF;
    IF a.operation_revision IS NULL THEN
        SELECT * INTO c FROM identity.connection_operations WHERE owner_user_id=p_owner AND operation_id=p_operation_id;
        IF FOUND THEN
            IF c.scope_key IS DISTINCT FROM a.scope_key OR c.device_id IS DISTINCT FROM a.device_id OR c.operation<>'save'
                OR c.request_hash IS DISTINCT FROM publication_hash
                OR identity.connection_account_key(c.resource_key) IS DISTINCT FROM jsonb_build_array(p_provider,p_account) THEN
                RAISE EXCEPTION 'Connection authorization publication differs' USING ERRCODE='PT409'; END IF;
            UPDATE identity.connection_attempts SET resource_key=c.resource_key,request_hash=c.request_hash,
                operation_revision=c.revision,admission_id=c.last_admission_id WHERE attempt_id=p_attempt_id;
        END IF;
    END IF;
    SELECT * INTO e FROM identity.connection_effect_evidence WHERE operation_id=p_operation_id;
    IF FOUND THEN
        IF e.attempt_id IS DISTINCT FROM p_attempt_id OR e.credential_generation IS DISTINCT FROM p_generation
            OR e.provider_id IS DISTINCT FROM p_provider OR e.account_id IS DISTINCT FROM p_account
            OR e.outcome IS DISTINCT FROM p_outcome OR e.evidence_kind IS DISTINCT FROM p_kind OR e.evidence_digest IS DISTINCT FROM p_digest
            OR e.public_request IS DISTINCT FROM p_public_request OR e.public_request_hash IS DISTINCT FROM publication_hash THEN
            RAISE EXCEPTION 'Connection effect evidence is immutable' USING ERRCODE='PT409'; END IF;
        RETURN;
    END IF;
    IF a.fenced_at IS NOT NULL OR EXISTS (SELECT 1 FROM identity.connection_resolutions WHERE operation_id=p_operation_id) THEN
        RAISE EXCEPTION 'Connection effect evidence arrived after fencing' USING ERRCODE='PT409'; END IF;
    INSERT INTO identity.connection_effect_evidence(operation_id,attempt_id,owner_user_id,credential_generation,provider_id,account_id,evidence_kind,outcome,evidence_digest,public_request,public_request_hash)
      VALUES(p_operation_id,p_attempt_id,p_owner,p_generation,p_provider,p_account,p_kind,p_outcome,p_digest,p_public_request,publication_hash);
    UPDATE identity.connection_attempts SET account_id=p_account WHERE attempt_id=p_attempt_id;
END;
$$;

-- The native verifier may only invoke this after observing the same durable
-- SQLite transaction fence used by credential/default/delete writers. It must
-- authenticate the original device; this function is never an owner API.
CREATE FUNCTION identity.connection_record_native_fence(p_owner text,p_operation_id uuid,p_attempt_id uuid,p_device text,p_generation uuid,p_digest text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a identity.connection_attempts%ROWTYPE;
BEGIN
    PERFORM 1 FROM identity.connection_heads WHERE owner_user_id=p_owner FOR UPDATE;
    SELECT * INTO a FROM identity.connection_attempts WHERE owner_user_id=p_owner AND operation_id=p_operation_id AND attempt_id=p_attempt_id FOR UPDATE;
    IF NOT FOUND OR a.executor_kind<>'runtime' OR a.device_id IS DISTINCT FROM p_device OR a.credential_generation IS DISTINCT FROM p_generation
        OR NOT EXISTS (SELECT 1 FROM identity.gugu_devices WHERE device_id=p_device AND user_id::text=p_owner)
        OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Connection native fence is unavailable' USING ERRCODE='42501'; END IF;
    IF a.fenced_at IS NOT NULL THEN
        IF a.fence_kind<>'native-transaction' OR a.fence_digest<>p_digest THEN
            RAISE EXCEPTION 'Connection native fence differs' USING ERRCODE='PT409'; END IF;
        RETURN;
    END IF;
    UPDATE identity.connection_attempts SET fenced_at=clock_timestamp(),fence_kind='native-transaction',fence_digest=p_digest WHERE attempt_id=p_attempt_id;
END;
$$;

CREATE FUNCTION identity.connection_resolve_attempt(p_owner text,p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE a identity.connection_attempts%ROWTYPE; e identity.connection_effect_evidence%ROWTYPE; r identity.connection_resolutions%ROWTYPE; applied boolean; head_revision bigint;
BEGIN
    PERFORM 1 FROM identity.connection_heads WHERE owner_user_id=p_owner FOR UPDATE;
    SELECT * INTO a FROM identity.connection_attempts WHERE owner_user_id=p_owner AND operation_id=p_operation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Connection attempt is unavailable' USING ERRCODE='42501'; END IF;
    SELECT * INTO r FROM identity.connection_resolutions WHERE operation_id=p_operation_id;
    IF FOUND THEN RETURN jsonb_build_object('outcome',r.outcome,'resolvedAt',r.resolved_at,'errorCode',r.error_code); END IF;
    SELECT * INTO e FROM identity.connection_effect_evidence WHERE operation_id=p_operation_id AND attempt_id=a.attempt_id
        AND credential_generation=a.credential_generation AND owner_user_id=p_owner;
    applied:=e.outcome='applied' OR EXISTS(SELECT 1 FROM identity.connection_admissions d
        WHERE d.admission_id=a.admission_id AND d.operation_id=a.operation_id AND d.owner_user_id=p_owner
          AND d.request_hash=a.request_hash AND d.operation_revision=a.operation_revision
          AND d.status='applied' AND d.receipt->>'status'='applied');
    applied:=COALESCE(applied,false);
    IF NOT applied AND e.operation_id IS NULL AND clock_timestamp()<a.deadline_at AND a.fenced_at IS NULL THEN RETURN NULL; END IF;
    IF NOT applied AND a.fenced_at IS NULL THEN
        IF a.executor_kind<>'platform' AND NOT (a.recreation_id IS NOT NULL AND a.prepared_at IS NULL) THEN RETURN NULL; END IF;
        -- Platform custody writers take this same owner/attempt row lock and
        -- check the fence in their actual credential transaction. The separate
        -- cloud adapter must be installed before this capability is activated.
        UPDATE identity.connection_attempts SET fenced_at=clock_timestamp(),fence_kind=CASE WHEN a.executor_kind='runtime' THEN 'unprepared-intent' ELSE 'platform-transaction' END,
            fence_digest=encode(sha256(convert_to(jsonb_build_array(a.attempt_id,a.credential_generation,'fenced')::text,'UTF8')),'hex')
          WHERE attempt_id=a.attempt_id RETURNING * INTO a;
    END IF;
    IF NOT applied AND a.fenced_at IS NULL THEN RETURN NULL; END IF;
    INSERT INTO identity.connection_resolutions(operation_id,attempt_id,owner_user_id,request_hash,operation_revision,admission_id,outcome,error_code)
      VALUES(p_operation_id,a.attempt_id,p_owner,COALESCE(e.public_request_hash,a.request_hash),a.operation_revision,a.admission_id,
        CASE WHEN applied THEN 'applied' ELSE 'failed' END,
        CASE WHEN applied THEN NULL ELSE 'CONNECTION_CONFIRMATION_FAILED' END) RETURNING * INTO r;
    IF r.outcome='failed' AND a.recreation_id IS NOT NULL THEN
        -- Closing the original ticket also fences its late metadata completion.
        -- Ordinary observations remain blocked by the failed-generation guard
        -- below; only a new explicit authorization can establish a new binding.
        UPDATE identity.connection_recreation_intents SET consumed_at=COALESCE(consumed_at,clock_timestamp())
          WHERE recreation_id=a.recreation_id AND operation_id=p_operation_id AND owner_user_id=p_owner;
    END IF;
    UPDATE identity.connection_heads SET revision=revision+1,updated_at=clock_timestamp()
      WHERE owner_user_id=p_owner RETURNING revision INTO head_revision;
    PERFORM chat.send_user_event(jsonb_build_object('revision',head_revision::text,'scopeKey',a.scope_key,'resourceKey',a.resource_key),
        'connection_changed','gugu:user:' || p_owner || ':events',true);
    RETURN jsonb_build_object('outcome',r.outcome,'resolvedAt',r.resolved_at,'errorCode',r.error_code);
END;
$$;

CREATE FUNCTION identity.connection_operation_status(p_operation_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id text:=identity.connection_owner(); c identity.connection_operations%ROWTYPE;
    a identity.connection_attempts%ROWTYPE; r identity.connection_resolutions%ROWTYPE; v_state text; v_outcome text;
BEGIN
    SELECT * INTO c FROM identity.connection_operations WHERE operation_id=p_operation_id AND owner_user_id=owner_id;
    SELECT * INTO a FROM identity.connection_attempts WHERE operation_id=p_operation_id AND owner_user_id=owner_id;
    -- No row and a foreign row have the exact same public result. No admission,
    -- credential generation, request hash, evidence, or journal detail escapes.
    IF c.operation_id IS NULL AND a.operation_id IS NULL THEN RETURN NULL; END IF;
    IF c.operation_id IS NOT NULL AND (c.operation NOT IN ('save','remove','enable','disable')
        OR c.status='applied' AND c.last_admission_id IS NULL AND a.operation_id IS NULL) THEN
        -- Ordinary metadata observation is not proof of an authorization effect.
        RETURN NULL;
    END IF;
    SELECT * INTO r FROM identity.connection_resolutions WHERE operation_id=p_operation_id AND owner_user_id=owner_id;
    v_outcome:=COALESCE(r.outcome,CASE WHEN c.status='applied' AND (
        EXISTS (SELECT 1 FROM identity.connection_admissions d WHERE d.admission_id=c.last_admission_id
            AND d.operation_id=c.operation_id AND d.owner_user_id=owner_id AND d.request_hash=c.request_hash
            AND d.operation_revision=c.revision AND d.status='applied' AND d.receipt->>'status'='applied')
        OR EXISTS (SELECT 1 FROM identity.connection_effect_evidence e WHERE e.operation_id=c.operation_id
            AND e.owner_user_id=owner_id AND e.attempt_id=a.attempt_id AND e.credential_generation=a.credential_generation
            AND e.outcome='applied' AND a.request_hash=c.request_hash AND a.operation_revision=c.revision)) THEN 'applied'
        WHEN c.status='failed' AND c.terminal_at IS NOT NULL AND c.error_code IS DISTINCT FROM 'CONNECTION_OUTCOME_UNKNOWN' THEN 'failed' END);
    v_state:=CASE v_outcome WHEN 'applied' THEN 'succeeded' WHEN 'failed' THEN 'failed' ELSE 'confirming' END;
    RETURN jsonb_build_object('version',1,'operationId',p_operation_id,'scopeKey',COALESCE(c.scope_key,a.scope_key),
        'resourceKey',COALESCE(c.resource_key,a.resource_key),'deviceId',COALESCE(c.device_id,a.device_id),
        'revision',c.revision::text,'operation',COALESCE(c.operation,a.operation),
        'original',jsonb_build_object('status',COALESCE(c.status,'pending'),'errorCode',CASE
            WHEN c.error_code='CONNECTION_OUTCOME_UNKNOWN' THEN c.error_code WHEN c.error_code IS NOT NULL THEN 'CONNECTION_FAILED' END,
            'terminal',COALESCE(c.terminal_at IS NOT NULL,false)),
        'resolution',CASE WHEN r.operation_id IS NULL THEN NULL ELSE jsonb_build_object('outcome',r.outcome,'resolvedAt',r.resolved_at,'errorCode',r.error_code) END,
        'effective',jsonb_build_object('state',v_state,'connectionState',CASE WHEN v_state='succeeded' THEN
            CASE WHEN COALESCE(c.operation,a.operation)='remove' THEN 'disconnected' ELSE 'connected' END
            WHEN v_state='failed' THEN 'failed' ELSE 'confirming' END,'blocksNewOperations',v_state='confirming'),
        'confirmation',jsonb_build_object('state',CASE WHEN v_state<>'confirming' THEN 'resolved' ELSE 'pending' END,'deadlineAt',a.deadline_at));
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_attempt_begin(text,uuid,bigint,text),
    identity.connection_attempt_write_fence(text,uuid,uuid,bigint),
    identity.connection_record_effect(text,uuid,uuid,uuid,text,text,text,text,text,jsonb),
    identity.connection_record_native_fence(text,uuid,uuid,text,uuid,text),identity.connection_resolve_attempt(text,uuid),
    identity.connection_operation_status(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Only the native owner task barrier consults the separate settled outcome.
-- The original per-operation admission and ACK are deliberately unchanged.
CREATE OR REPLACE FUNCTION identity.connection_admit(p_runtime_instance_id text,p_expected_revision bigint,p_operation_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.connection_owner(); device text; current_revision bigint; change identity.connection_operations%ROWTYPE;
    result jsonb; epoch bigint;
BEGIN
    PERFORM identity.connection_owner_lock(owner_id);
    device := identity.connection_runtime(owner_id,p_runtime_instance_id);
    IF p_operation_id IS NOT NULL THEN
        result:=identity.connection_admit_operation(owner_id,p_operation_id,p_expected_revision,'runtime',device,p_runtime_instance_id);
        IF result->'admitted'='true'::jsonb AND (SELECT verification_protocol=2 FROM identity.connection_heads WHERE owner_user_id=owner_id) THEN
            SELECT authority_epoch INTO epoch FROM identity.connection_heads WHERE owner_user_id=owner_id;
            PERFORM identity.connection_attempt_begin(owner_id,p_operation_id,epoch,p_runtime_instance_id);
        END IF;
        RETURN result;
    END IF;
    SELECT revision INTO current_revision FROM identity.connection_heads WHERE owner_user_id=owner_id;
    IF p_expected_revision IS DISTINCT FROM current_revision THEN RAISE EXCEPTION 'Connection changed before task admission' USING ERRCODE='PT409'; END IF;
    SELECT * INTO change FROM identity.connection_operations WHERE owner_user_id=owner_id AND status IN ('pending','failed')
      AND (terminal_at IS NULL OR error_code='CONNECTION_OUTCOME_UNKNOWN')
      AND NOT EXISTS (SELECT 1 FROM identity.connection_resolutions r WHERE r.operation_id=connection_operations.operation_id
        AND r.owner_user_id=owner_id AND r.request_hash=connection_operations.request_hash
        AND r.operation_revision=connection_operations.revision
        AND r.admission_id IS NOT DISTINCT FROM connection_operations.last_admission_id)
      ORDER BY (error_code='CONNECTION_OUTCOME_UNKNOWN') DESC NULLS LAST,revision LIMIT 1;
    IF FOUND THEN RETURN jsonb_build_object('admitted',false,'revision',current_revision::text,'operationId',change.operation_id,
        'domain','integrations','resourceKey',change.resource_key,'errorCode',change.error_code); END IF;
    RETURN jsonb_build_object('admitted',true,'revision',current_revision::text);
END;
$$;

CREATE OR REPLACE FUNCTION identity.connection_operation_projection(p_operation identity.connection_operations,p_payload boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
    SELECT jsonb_build_object('operationId',p_operation.operation_id,'requestHash',p_operation.request_hash,
        'scopeKey',p_operation.scope_key,'resourceKey',p_operation.resource_key,'deviceId',p_operation.device_id,
        'revision',p_operation.revision::text,'expectedItemRevision',p_operation.expected_item_revision::text,
        'operation',p_operation.operation,'status',CASE WHEN a.status = 'started' THEN 'started' ELSE p_operation.status END,
        'errorCode',p_operation.error_code,'terminal',p_operation.terminal_at IS NOT NULL,
        'admissionId',p_operation.last_admission_id,'startedAt',a.started_at)
        || CASE WHEN p_payload THEN jsonb_build_object('payload',p_operation.payload) ELSE '{}'::jsonb END
        || COALESCE((SELECT jsonb_build_object('resolution',r.public->'resolution','effective',r.public->'effective',
            'confirmation',r.public->'confirmation','original',r.public->'original')
            FROM (SELECT identity.connection_operation_status(p_operation.operation_id) AS public) r WHERE r.public IS NOT NULL),'{}'::jsonb)
    FROM (SELECT 1) singleton LEFT JOIN identity.connection_admissions a ON a.admission_id = p_operation.last_admission_id
$$;

REVOKE ALL ON FUNCTION identity.connection_admit(text,bigint,uuid),identity.connection_operation_projection(identity.connection_operations,boolean) FROM PUBLIC,anon,authenticated,service_role;

-- A failed/fenced authorization cannot be revived by a delayed background
-- observation. A new explicit authorization establishes a different generation.
CREATE OR REPLACE FUNCTION identity.connection_commit(p_operation_id uuid,p_scope_key text,p_resource_key text,
    p_expected_revision bigint,p_operation text,p_data jsonb,p_document text DEFAULT NULL,
    p_device_id text DEFAULT NULL,p_runtime_instance_id text DEFAULT NULL,p_recreation_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
<<connection_commit_body>>
DECLARE
    owner_id text := identity.connection_owner(); target_key text := p_resource_key; expected_revision bigint := p_expected_revision;
    prior identity.connection_items%ROWTYPE; existing identity.connection_operations%ROWTYPE;
    intent identity.connection_recreation_intents%ROWTYPE; candidate identity.connection_items%ROWTYPE;
    request_hash text; new_revision bigint; actor_device text; catalog boolean; marker boolean; matches integer := 0;
    document text; public_metadata jsonb; parsed jsonb; data jsonb := p_data; payload jsonb;
    provider text; account text; key_identity jsonb; outcome text; owner_metadata_intent boolean := false;
BEGIN
    PERFORM identity.connection_scope(owner_id,p_scope_key,p_device_id);
    IF p_operation_id IS NULL OR p_data IS NULL OR p_operation IS NULL
        OR p_operation NOT IN ('save','remove','enable','disable','prepared','error')
        OR p_document IS NOT NULL AND octet_length(p_document) > 1048576 THEN
        RAISE EXCEPTION 'Connection operation is invalid' USING ERRCODE = '22023';
    END IF;
    request_hash := encode(sha256(convert_to(jsonb_build_array(owner_id,p_scope_key,p_resource_key,p_expected_revision,
        p_operation,p_data,p_document,p_device_id,p_runtime_instance_id IS NOT NULL,p_recreation_id)::text,'UTF8')),'hex');
    PERFORM identity.connection_owner_lock(owner_id);
    IF EXISTS (SELECT 1 FROM identity.connection_recreation_intents i WHERE i.operation_id=p_operation_id
        AND (i.owner_user_id<>owner_id OR p_recreation_id IS DISTINCT FROM i.recreation_id)) THEN
        RAISE EXCEPTION 'Connection original authorization identity differs' USING ERRCODE='42501'; END IF;
    PERFORM identity.connection_claim_operation(owner_id,p_operation_id,'single',request_hash);
    SELECT * INTO existing FROM identity.connection_operations WHERE operation_id = p_operation_id;
    IF FOUND THEN
        IF existing.owner_user_id <> owner_id THEN RAISE EXCEPTION 'Connection operation is unavailable' USING ERRCODE = '42501'; END IF;
        IF existing.request_hash <> request_hash THEN RAISE EXCEPTION 'Connection operation identity was reused' USING ERRCODE = 'PT409'; END IF;
        RETURN jsonb_build_object('operationId',existing.operation_id,'scopeKey',existing.scope_key,'resourceKey',existing.resource_key,
            'revision',existing.revision::text,'status',existing.status);
    END IF;
    IF p_runtime_instance_id IS NOT NULL THEN
        -- This only projects an already proved credential commit. An expired
        -- original runtime is not permission to execute another effect.
        IF p_recreation_id IS NOT NULL AND identity.connection_verified_authorization(owner_id,p_operation_id,p_scope_key,p_data->>'providerId',p_data->>'accountId')
            AND EXISTS(SELECT 1 FROM identity.connection_attempts a WHERE a.owner_user_id=owner_id AND a.operation_id=p_operation_id
                AND a.runtime_instance_id=p_runtime_instance_id AND a.device_id=p_device_id) THEN
            actor_device:=p_device_id;
        ELSE actor_device := identity.connection_runtime(owner_id,p_runtime_instance_id,true); END IF;
        IF p_scope_key <> 'platform' AND actor_device IS DISTINCT FROM p_device_id THEN
            RAISE EXCEPTION 'Connection publisher cannot publish another device' USING ERRCODE = '42501';
        END IF;
    END IF;
    IF p_recreation_id IS NOT NULL THEN
        SELECT * INTO intent FROM identity.connection_recreation_intents WHERE recreation_id = p_recreation_id;
        IF NOT FOUND OR intent.owner_user_id <> owner_id OR intent.operation_id <> p_operation_id
            OR intent.scope_key <> p_scope_key OR intent.device_id IS DISTINCT FROM p_device_id
            OR intent.consumed_at IS NOT NULL OR intent.expires_at <= clock_timestamp()
                AND NOT identity.connection_verified_authorization(owner_id,p_operation_id,p_scope_key,p_data->>'providerId',p_data->>'accountId') THEN
            RAISE EXCEPTION 'Connection recreation intent is unavailable' USING ERRCODE = 'PT409';
        END IF;
        IF intent.expected_head_revision IS NOT NULL AND intent.expected_head_revision IS DISTINCT FROM
            (SELECT revision FROM identity.connection_heads WHERE owner_user_id = owner_id)
            AND NOT identity.connection_verified_authorization(owner_id,p_operation_id,p_scope_key,p_data->>'providerId',p_data->>'accountId') THEN
            RAISE EXCEPTION 'Connection changed during provider authorization' USING ERRCODE = 'PT409';
        END IF;
    END IF;
    IF p_recreation_id IS NOT NULL AND intent.evidence_protocol AND NOT EXISTS (
        SELECT 1 FROM identity.connection_attempts a JOIN identity.connection_effect_evidence e USING(operation_id)
        WHERE a.operation_id=p_operation_id AND a.owner_user_id=owner_id AND a.recreation_id=p_recreation_id
            AND a.scope_key=p_scope_key AND e.attempt_id=a.attempt_id AND e.credential_generation=a.credential_generation
            AND e.provider_id=p_data->>'providerId' AND e.account_id=p_data->>'accountId' AND e.outcome='applied' AND e.public_request_hash=connection_commit_body.request_hash
            AND (a.fenced_at IS NULL OR e.recorded_at<=a.fenced_at)
            AND NOT EXISTS (SELECT 1 FROM identity.connection_resolutions r WHERE r.operation_id=p_operation_id AND r.outcome='failed')) THEN
        RAISE EXCEPTION 'Connection authorization has no bound effect evidence' USING ERRCODE='PT409';
    END IF;
    IF target_key IS NULL THEN
        IF p_operation <> 'save' OR p_expected_revision IS NOT NULL OR p_recreation_id IS NULL
            OR intent.resource_key IS NOT NULL OR intent.provider_id IS DISTINCT FROM p_data->>'providerId'
            OR jsonb_typeof(p_data->'accountId') IS DISTINCT FROM 'string' OR length(p_data->>'accountId') NOT BETWEEN 1 AND 512 THEN
            RAISE EXCEPTION 'Connection provider resolution is invalid' USING ERRCODE = '22023';
        END IF;
        FOR candidate IN SELECT * FROM identity.connection_items WHERE owner_user_id = owner_id AND scope_key = p_scope_key LOOP
            key_identity := identity.connection_account_key(candidate.resource_key);
            IF (candidate.provider_id = intent.provider_id AND candidate.account_id = p_data->>'accountId')
                OR key_identity = jsonb_build_array(intent.provider_id,p_data->>'accountId') THEN
                matches := matches + 1; target_key := candidate.resource_key; expected_revision := candidate.revision;
            END IF;
        END LOOP;
        IF matches > 1 THEN RAISE EXCEPTION 'Connection account mapping is ambiguous' USING ERRCODE = '55000'; END IF;
        IF matches = 0 THEN target_key := jsonb_build_array(intent.provider_id,p_data->>'accountId')::text; expected_revision := 0; END IF;
    END IF;
    IF target_key IS NULL OR length(target_key) NOT BETWEEN 1 AND 512 OR expected_revision IS NULL OR expected_revision < 0 THEN
        RAISE EXCEPTION 'Connection resource revision is invalid' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO prior FROM identity.connection_items WHERE owner_user_id = owner_id AND scope_key = p_scope_key AND resource_key = target_key;
    IF COALESCE(prior.revision,0) <> expected_revision THEN RAISE EXCEPTION 'Connection resource changed' USING ERRCODE = 'PT409'; END IF;
    IF p_recreation_id IS NOT NULL AND intent.resource_key IS NOT NULL AND
        (intent.resource_key <> target_key OR intent.expected_item_revision <> expected_revision) THEN
        RAISE EXCEPTION 'Connection recreation resource changed' USING ERRCODE = 'PT409';
    END IF;
    marker := target_key = '__collection__' OR starts_with(target_key,'__collection__:');
    catalog := starts_with(target_key,'catalog:');
    IF p_operation='save' AND p_recreation_id IS NULL AND NOT marker AND NOT catalog
        AND EXISTS (SELECT 1 FROM identity.connection_attempts a JOIN identity.connection_resolutions r USING(operation_id)
            WHERE a.owner_user_id=owner_id AND a.scope_key=p_scope_key AND a.provider_id=p_data->>'providerId'
                AND (a.account_id IS NULL OR a.account_id=p_data->>'accountId') AND a.operation='save'
                AND a.recreation_id IS NOT NULL AND r.outcome='failed'
                AND NOT EXISTS (SELECT 1 FROM identity.connection_attempts newer JOIN identity.connection_effect_evidence e USING(operation_id)
                    WHERE newer.owner_user_id=owner_id AND newer.scope_key=p_scope_key AND newer.provider_id=a.provider_id
                        AND newer.account_id=p_data->>'accountId' AND newer.recreation_id IS NOT NULL
                        AND newer.started_at>a.started_at AND e.outcome='applied'
                        AND NOT EXISTS (SELECT 1 FROM identity.connection_resolutions failed
                            WHERE failed.operation_id=newer.operation_id AND failed.outcome='failed'))) THEN
        RAISE EXCEPTION 'Connection observation belongs to an unsettled credential generation' USING ERRCODE='PT409';
    END IF;
    owner_metadata_intent := p_operation='save' AND p_scope_key<>'platform' AND p_runtime_instance_id IS NULL
        AND p_document IS NULL AND p_recreation_id IS NULL AND prior.owner_user_id IS NOT NULL AND prior.deleted_at IS NULL
        AND p_data->'isDefault'='true'::jsonb AND p_data->>'providerId'=prior.provider_id AND p_data->>'accountId'=prior.account_id
        AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k NOT IN ('providerId','accountId','isDefault'));
    owner_metadata_intent := COALESCE(owner_metadata_intent,false);
    IF p_recreation_id IS NULL AND p_operation='save' AND NOT marker AND NOT catalog AND NOT owner_metadata_intent
        AND EXISTS (SELECT 1 FROM (SELECT consumed_at FROM identity.connection_recreation_intents
            WHERE owner_user_id=owner_id AND scope_key=p_scope_key AND provider_id=p_data->>'providerId'
            ORDER BY intent_generation DESC LIMIT 1) latest WHERE consumed_at IS NULL) THEN
        RAISE EXCEPTION 'Connection authorization requires explicit reconciliation' USING ERRCODE='PT409';
    END IF;
    IF prior.deleted_at IS NOT NULL AND NOT marker AND NOT catalog AND p_operation NOT IN ('save','remove') THEN
        RAISE EXCEPTION 'Connection state changes cannot clear a revocation' USING ERRCODE = 'PT409';
    END IF;
    IF marker IS DISTINCT FROM (p_operation IN ('prepared','error')) AND p_operation <> 'remove' THEN
        RAISE EXCEPTION 'Connection operation does not match its resource' USING ERRCODE = '22023';
    END IF;
    IF p_scope_key <> 'platform' AND p_operation IN ('save','prepared','error') AND p_runtime_instance_id IS NULL AND NOT owner_metadata_intent THEN
        RAISE EXCEPTION 'Device connection publication requires its current runtime' USING ERRCODE = '42501';
    END IF;
    IF p_operation IN ('save','prepared','error') THEN
        IF owner_metadata_intent THEN data := prior.data || jsonb_build_object('isDefault',true); END IF;
        PERFORM identity.assistant_panel_validate('integrations',target_key,data);
        IF prior.deleted_at IS NOT NULL AND NOT marker AND NOT catalog AND p_recreation_id IS NULL THEN
            RAISE EXCEPTION 'Connection observation cannot clear a revocation' USING ERRCODE = 'PT409';
        END IF;
        document := COALESCE(p_document,prior.body_document);
        IF NOT marker THEN
            IF document IS NULL OR prior.deleted_at IS NOT NULL AND p_document IS NULL THEN
                RAISE EXCEPTION 'Connection publication requires complete public content' USING ERRCODE = '22023';
            END IF;
            parsed := document::jsonb;
            IF jsonb_typeof(parsed) IS DISTINCT FROM 'object' OR parsed->'version' IS DISTINCT FROM '1'::jsonb THEN
                RAISE EXCEPTION 'Connection public content is invalid' USING ERRCODE = '22023';
            END IF;
            provider := p_data->>'providerId'; account := p_data->>'accountId';
            IF catalog THEN
                IF target_key IS DISTINCT FROM 'catalog:' || provider OR parsed->'en'->>'id' IS DISTINCT FROM provider
                    OR parsed->'zh-CN'->>'id' IS DISTINCT FROM provider THEN
                    RAISE EXCEPTION 'Connection catalog identity differs' USING ERRCODE = '22023';
                END IF;
            ELSE
                IF jsonb_typeof(p_data->'providerId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_data->'accountId') IS DISTINCT FROM 'string'
                    OR parsed->>'providerId' IS DISTINCT FROM provider OR parsed->>'accountId' IS DISTINCT FROM account
                    OR identity.connection_account_key(target_key) IS DISTINCT FROM jsonb_build_array(provider,account)
                    OR EXISTS (SELECT 1 FROM jsonb_each(parsed) v WHERE v.key NOT IN
                        ('version','providerId','accountId','isDefault','connectedAt','updatedAt','host','login','avatarUrl','credentialSource','displayName')
                        OR jsonb_typeof(v.value) IN ('object','array')) THEN
                    RAISE EXCEPTION 'Connection account public content differs' USING ERRCODE = '22023';
                END IF;
                public_metadata := parsed;
            END IF;
        ELSIF p_document IS NOT NULL THEN RAISE EXCEPTION 'Connection collection cannot contain a document' USING ERRCODE = '22023';
        END IF;
    ELSE
        IF prior.owner_user_id IS NULL THEN RAISE EXCEPTION 'Connection resource is unavailable' USING ERRCODE = 'PT409'; END IF;
        key_identity := identity.connection_account_key(target_key);
        provider := COALESCE(prior.provider_id,key_identity->>0); account := COALESCE(prior.account_id,key_identity->>1);
        data := prior.data;
        document := prior.body_document; public_metadata := prior.public_metadata;
        IF p_operation = 'remove' THEN
            document := NULL; public_metadata := NULL;
            data := jsonb_strip_nulls(jsonb_build_object('providerId',provider,'accountId',account,'configured',false));
        ELSE data := jsonb_set(data,'{enabled}',to_jsonb(p_operation = 'enable')); END IF;
    END IF;
    new_revision := nextval(pg_get_serial_sequence('identity.assistant_panel_changes','revision'));
    outcome := CASE WHEN owner_metadata_intent OR p_runtime_instance_id IS NULL AND p_operation IN ('remove','enable','disable') THEN 'pending' ELSE 'applied' END;
    UPDATE identity.connection_operations SET status='superseded'
      WHERE owner_user_id=owner_id AND scope_key=p_scope_key AND resource_key=target_key AND status IN ('pending','failed');
    INSERT INTO identity.connection_items(owner_user_id,scope_key,resource_key,device_id,provider_id,account_id,revision,data,
        public_metadata,body_document,body_sha256,deleted_at,observed_at)
    VALUES(owner_id,p_scope_key,target_key,CASE WHEN p_scope_key = 'platform' THEN NULL ELSE p_device_id END,provider,account,
        new_revision,data,public_metadata,document,CASE WHEN document IS NULL THEN NULL ELSE encode(sha256(convert_to(document,'UTF8')),'hex') END,
        CASE WHEN p_operation = 'remove' THEN clock_timestamp() END,CASE WHEN p_runtime_instance_id IS NOT NULL THEN clock_timestamp() END)
    ON CONFLICT(owner_user_id,scope_key,resource_key) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,
        provider_id=EXCLUDED.provider_id,account_id=EXCLUDED.account_id,public_metadata=EXCLUDED.public_metadata,
        body_document=EXCLUDED.body_document,body_sha256=EXCLUDED.body_sha256,deleted_at=EXCLUDED.deleted_at,
        stale_at=NULL,observed_at=EXCLUDED.observed_at,updated_at=clock_timestamp();
    payload := jsonb_build_object('data',data,'deviceId',p_device_id,'before',jsonb_strip_nulls(jsonb_build_object(
        'providerId',provider,'accountId',account)),'deleted',p_operation = 'remove');
    INSERT INTO identity.connection_operations(operation_id,owner_user_id,scope_key,resource_key,device_id,revision,expected_item_revision,
        operation,source,request_hash,payload,status,applied_at)
    VALUES(p_operation_id,owner_id,p_scope_key,target_key,CASE WHEN p_scope_key = 'platform' THEN NULL ELSE p_device_id END,new_revision,expected_revision,
        p_operation,CASE WHEN p_runtime_instance_id IS NULL THEN 'panel' ELSE 'runtime' END,request_hash,payload,outcome,
        CASE WHEN outcome = 'applied' THEN clock_timestamp() END);
    UPDATE identity.connection_heads SET revision=new_revision,updated_at=clock_timestamp() WHERE owner_user_id = owner_id;
    IF (SELECT count(*) FROM identity.connection_items WHERE owner_user_id = owner_id) > 2000
        OR (SELECT COALESCE(sum(octet_length(body_document)),0) FROM identity.connection_items WHERE owner_user_id = owner_id) > 8388608 THEN
        RAISE EXCEPTION 'Connection publication exceeds the complete inventory limit' USING ERRCODE = '54000';
    END IF;
    IF p_recreation_id IS NOT NULL THEN UPDATE identity.connection_recreation_intents SET consumed_at=clock_timestamp() WHERE recreation_id=p_recreation_id; END IF;
    -- This is a best-effort private hint, not a new durable account-revision
    -- event. Missing hints are repaired by snapshot/pending reconciliation.
    PERFORM chat.send_user_event(jsonb_build_object('revision',new_revision::text,'scopeKey',p_scope_key,'resourceKey',target_key),
        'connection_changed','gugu:user:' || owner_id || ':events',true);
    RETURN jsonb_build_object('operationId',p_operation_id,'scopeKey',p_scope_key,'resourceKey',target_key,'revision',new_revision::text,'status',outcome);
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_account_key(text),
    identity.connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Private native custody identity, never returned by the public status reader.
-- Authorization tickets retain the initial context even after publication binds
-- its resolved account/resource and operation revision.
CREATE FUNCTION identity.connection_attempt_context(p_owner text,p_operation_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
    SELECT jsonb_build_object('operationId',a.operation_id,'attemptId',a.attempt_id,'attemptOrder',a.attempt_order::text,'ownerId',a.owner_user_id,
        'deviceId',a.device_id,'scopeKey',a.scope_key,
        'resourceKey',CASE WHEN a.recreation_id IS NULL THEN a.resource_key ELSE i.resource_key END,
        'providerId',a.provider_id,'accountId',CASE WHEN a.recreation_id IS NULL THEN a.account_id ELSE identity.connection_account_key(i.resource_key)->>1 END,
        'credentialGeneration',a.credential_generation,'authorityEpoch',a.authority_epoch::text,
        'requestHash',CASE WHEN a.recreation_id IS NULL THEN a.request_hash ELSE
            encode(sha256(convert_to(jsonb_build_array(i.operation_id,i.recreation_id,p_owner,i.scope_key,i.resource_key,
                i.device_id,i.provider_id,i.expected_item_revision,i.expected_head_revision)::text,'UTF8')),'hex') END,
        'operationRevision',CASE WHEN a.recreation_id IS NULL THEN a.operation_revision::text END,
        'admissionId',a.admission_id,'recreationId',a.recreation_id,'expectedItemRevision',i.expected_item_revision::text,
        'expectedHeadRevision',CASE WHEN a.recreation_id IS NOT NULL THEN a.initial_head_revision::text END,
        'deadlineAt',floor(extract(epoch FROM a.deadline_at)*1000),
        'effectKind',CASE WHEN a.operation='remove' THEN 'remove' WHEN a.recreation_id IS NOT NULL THEN 'authorize' ELSE 'default' END)
    FROM identity.connection_attempts a LEFT JOIN identity.connection_recreation_intents i ON i.recreation_id=a.recreation_id
    WHERE a.owner_user_id=p_owner AND a.operation_id=p_operation_id
$$;

CREATE FUNCTION identity.connection_attempt_prepare(p_operation_id uuid,p_epoch bigint,p_runtime_instance_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id text:=identity.connection_owner(); device text; context jsonb; attempt uuid;
BEGIN
    device:=identity.connection_runtime(owner_id,p_runtime_instance_id);
    attempt:=identity.connection_attempt_begin(owner_id,p_operation_id,p_epoch,p_runtime_instance_id);
    PERFORM identity.connection_attempt_write_fence(owner_id,p_operation_id,attempt,p_epoch);
    context:=identity.connection_attempt_context(owner_id,p_operation_id);
    IF context->>'deviceId' IS DISTINCT FROM device OR context->>'scopeKey' IS DISTINCT FROM 'device:' || device THEN
        RAISE EXCEPTION 'Connection native attempt is unavailable' USING ERRCODE='42501'; END IF;
    RETURN context;
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_attempt_context(text,uuid),identity.connection_attempt_prepare(uuid,bigint,text)
    FROM PUBLIC,anon,authenticated,service_role;

-- Recovery may publish the original proved authorization after unrelated
-- owner-head changes, but never after a newer target write or provider intent.
-- No fresh intent/UUID, current-account snapshot, or client success claim is
-- substituted for the original atomically-bound effect evidence.
CREATE FUNCTION identity.connection_verified_authorization(p_owner text,p_operation_id uuid,p_scope text,p_provider text,p_account text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
    SELECT EXISTS (SELECT 1 FROM identity.connection_attempts a
      JOIN identity.connection_recreation_intents i ON i.recreation_id=a.recreation_id
      JOIN identity.connection_effect_evidence e ON e.operation_id=a.operation_id AND e.attempt_id=a.attempt_id
        AND e.credential_generation=a.credential_generation AND e.owner_user_id=a.owner_user_id
      WHERE a.owner_user_id=p_owner AND a.operation_id=p_operation_id AND a.scope_key=p_scope AND a.provider_id=p_provider
        AND e.account_id=p_account AND e.outcome='applied'
        AND (a.fenced_at IS NULL OR e.recorded_at<=a.fenced_at)
        AND i.evidence_protocol AND i.consumed_at IS NULL
        AND (i.resource_key IS NULL AND i.expected_head_revision IS NOT NULL
            OR i.resource_key IS NOT NULL AND COALESCE((SELECT revision FROM identity.connection_items
                WHERE owner_user_id=p_owner AND scope_key=p_scope AND resource_key=i.resource_key),0)=i.expected_item_revision)
        AND NOT EXISTS (SELECT 1 FROM identity.connection_resolutions WHERE operation_id=p_operation_id)
        AND NOT EXISTS (SELECT 1 FROM identity.connection_items item WHERE item.owner_user_id=p_owner AND item.scope_key=p_scope
            AND (item.provider_id=p_provider AND item.account_id=p_account
                OR identity.connection_account_key(item.resource_key)=jsonb_build_array(p_provider,p_account))
            AND item.revision>COALESCE(i.expected_head_revision,i.expected_item_revision))
        AND NOT EXISTS (SELECT 1 FROM identity.connection_recreation_intents newer WHERE newer.owner_user_id=p_owner
            AND newer.scope_key=p_scope AND COALESCE(newer.provider_id,identity.connection_account_key(newer.resource_key)->>0)=p_provider
            AND newer.intent_generation>i.intent_generation))
$$;
REVOKE ALL ON FUNCTION identity.connection_verified_authorization(text,uuid,text,text,text)
    FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON SEQUENCE identity.connection_recreation_intents_intent_generation_seq FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.connection_uuid_lock(p_operation uuid) RETURNS void
LANGUAGE sql SET search_path=pg_catalog AS $$
    SELECT pg_advisory_xact_lock(hashtextextended('gugu:connection-operation:' || p_operation::text,0))
$$;
CREATE OR REPLACE FUNCTION identity.connection_claim_operation(p_owner text,p_operation uuid,p_kind text,p_hash text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE prior identity.connection_operation_identities%ROWTYPE; legacy_owner text; legacy_kind text; legacy_hash text;
BEGIN
    IF p_operation IS NULL OR p_kind IS NULL OR p_kind NOT IN ('single','batch') OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Connection operation identity is invalid' USING ERRCODE='22023'; END IF;
    PERFORM identity.connection_uuid_lock(p_operation);
    IF EXISTS (SELECT 1 FROM identity.connection_recreation_intents WHERE operation_id=p_operation AND owner_user_id<>p_owner)
        OR EXISTS (SELECT 1 FROM identity.connection_attempts WHERE operation_id=p_operation AND owner_user_id<>p_owner) THEN
        RAISE EXCEPTION 'Connection operation is unavailable' USING ERRCODE='42501'; END IF;
    SELECT * INTO prior FROM identity.connection_operation_identities WHERE operation_id=p_operation;
    IF NOT FOUND THEN
        SELECT owner_user_id,'single',request_hash INTO legacy_owner,legacy_kind,legacy_hash FROM identity.connection_operations WHERE operation_id=p_operation;
        IF NOT FOUND THEN
            SELECT owner_user_id,'batch',request_hash INTO legacy_owner,legacy_kind,legacy_hash FROM identity.connection_batches WHERE operation_id=p_operation;
        END IF;
        INSERT INTO identity.connection_operation_identities(operation_id,owner_user_id,operation_kind,request_hash)
          VALUES(p_operation,COALESCE(legacy_owner,p_owner),COALESCE(legacy_kind,p_kind),COALESCE(legacy_hash,p_hash)) ON CONFLICT DO NOTHING;
        -- The global primary key also serializes two different owners racing on
        -- the same UUID, even though they hold different owner-head locks.
        SELECT * INTO prior FROM identity.connection_operation_identities WHERE operation_id=p_operation;
    END IF;
    IF prior.owner_user_id IS DISTINCT FROM p_owner THEN
        RAISE EXCEPTION 'Connection operation is unavailable' USING ERRCODE='42501'; END IF;
    IF prior.operation_kind IS DISTINCT FROM p_kind OR prior.request_hash IS DISTINCT FROM p_hash THEN
        RAISE EXCEPTION 'Connection operation identity was reused' USING ERRCODE='PT409'; END IF;
END;
$$;
CREATE OR REPLACE FUNCTION identity.connection_recreate_begin(p_operation_id uuid,p_scope_key text,p_resource_key text,
    p_expected_revision bigint,p_device_id text DEFAULT NULL,p_provider_id text DEFAULT NULL,p_expected_head_revision bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.connection_owner(); current_revision bigint; intent identity.connection_recreation_intents%ROWTYPE;
BEGIN
    PERFORM identity.connection_scope(owner_id,p_scope_key,p_device_id);
    IF p_operation_id IS NULL OR (p_resource_key IS NOT NULL AND (length(p_resource_key) NOT BETWEEN 1 AND 512
        OR p_expected_revision IS NULL OR p_expected_revision < 0 OR p_expected_head_revision IS NOT NULL))
        OR (p_resource_key IS NULL AND (p_expected_revision IS NOT NULL OR p_provider_id IS NULL
            OR p_provider_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' OR p_expected_head_revision IS NULL OR p_expected_head_revision < 0)) THEN
        RAISE EXCEPTION 'Connection recreation parameters are invalid' USING ERRCODE = '22023';
    END IF;
    PERFORM identity.connection_owner_lock(owner_id);
    PERFORM identity.connection_uuid_lock(p_operation_id);
    SELECT revision INTO current_revision FROM identity.connection_items WHERE owner_user_id = owner_id AND scope_key = p_scope_key AND resource_key = p_resource_key;
    IF (p_resource_key IS NOT NULL AND COALESCE(current_revision,0) <> p_expected_revision)
        OR (p_resource_key IS NULL AND p_expected_head_revision IS DISTINCT FROM
            (SELECT revision FROM identity.connection_heads WHERE owner_user_id = owner_id)) THEN
        RAISE EXCEPTION 'Connection changed before authorization' USING ERRCODE = 'PT409';
    END IF;
    SELECT * INTO intent FROM identity.connection_recreation_intents WHERE operation_id = p_operation_id;
    IF FOUND THEN
        IF intent.owner_user_id <> owner_id OR intent.scope_key <> p_scope_key OR intent.resource_key IS DISTINCT FROM p_resource_key
            OR intent.expected_item_revision IS DISTINCT FROM p_expected_revision OR intent.device_id IS DISTINCT FROM p_device_id
            OR intent.provider_id IS DISTINCT FROM p_provider_id OR intent.expected_head_revision IS DISTINCT FROM p_expected_head_revision THEN
            RAISE EXCEPTION 'Connection operation identity was reused' USING ERRCODE = 'PT409';
        END IF;
    ELSE
        IF EXISTS (SELECT 1 FROM identity.connection_operation_identities WHERE operation_id=p_operation_id)
            OR EXISTS (SELECT 1 FROM identity.connection_operations WHERE operation_id=p_operation_id)
            OR EXISTS (SELECT 1 FROM identity.connection_batches WHERE operation_id=p_operation_id) THEN
            RAISE EXCEPTION 'Connection operation identity was already consumed' USING ERRCODE='PT409'; END IF;
        INSERT INTO identity.connection_recreation_intents(operation_id,owner_user_id,scope_key,resource_key,expected_item_revision,device_id,provider_id,expected_head_revision,evidence_protocol)
          VALUES(p_operation_id,owner_id,p_scope_key,p_resource_key,p_expected_revision,p_device_id,p_provider_id,p_expected_head_revision,
            (SELECT verification_protocol=2 FROM identity.connection_heads WHERE owner_user_id=owner_id)) RETURNING * INTO intent;
    END IF;
    PERFORM identity.connection_attempt_initialize(owner_id,p_operation_id);
    RETURN jsonb_build_object('recreationId',intent.recreation_id,'operationId',intent.operation_id,
        'expectedItemRevision',intent.expected_item_revision::text,'expectedHeadRevision',intent.expected_head_revision::text,
        'providerId',intent.provider_id,'revision',(SELECT revision::text FROM identity.connection_heads WHERE owner_user_id = owner_id),
        'expiresAt',intent.expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION identity.connection_commit_batch(p_operation_id uuid,p_recreation_id uuid,p_operations jsonb,
    p_runtime_instance_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.connection_owner(); intent identity.connection_recreation_intents%ROWTYPE;
    existing identity.connection_batches%ROWTYPE; request_hash text; child jsonb; child_id uuid; child_intent uuid;
    receipts jsonb := '[]'::jsonb; receipt jsonb; count_accounts integer;
BEGIN
    IF p_operation_id IS NULL OR p_recreation_id IS NULL OR jsonb_typeof(p_operations) IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_operations) NOT BETWEEN 1 AND 50 OR octet_length(p_operations::text)>8388608 THEN
        RAISE EXCEPTION 'Connection batch is invalid' USING ERRCODE='22023'; END IF;
    request_hash := encode(sha256(convert_to(jsonb_build_array(owner_id,p_recreation_id,p_operations,
        p_runtime_instance_id IS NOT NULL)::text,'UTF8')),'hex');
    PERFORM identity.connection_owner_lock(owner_id);
    -- Parent/child UUID locks have one order across concurrent batches.
    FOR child_id IN SELECT id FROM (SELECT p_operation_id AS id UNION SELECT (v->>'operationId')::uuid FROM jsonb_array_elements(p_operations) v) ids ORDER BY id LOOP
        PERFORM identity.connection_uuid_lock(child_id);
    END LOOP;
    PERFORM identity.connection_claim_operation(owner_id,p_operation_id,'batch',request_hash);
    SELECT * INTO existing FROM identity.connection_batches WHERE operation_id=p_operation_id;
    IF FOUND THEN
        IF existing.owner_user_id<>owner_id THEN RAISE EXCEPTION 'Connection batch is unavailable' USING ERRCODE='42501'; END IF;
        IF existing.request_hash<>request_hash THEN RAISE EXCEPTION 'Connection batch identity was reused' USING ERRCODE='PT409'; END IF;
        RETURN existing.receipt;
    END IF;
    SELECT * INTO intent FROM identity.connection_recreation_intents WHERE recreation_id=p_recreation_id;
    IF intent.owner_user_id IS DISTINCT FROM owner_id OR intent.operation_id IS DISTINCT FROM p_operation_id OR intent.resource_key IS NOT NULL
        OR intent.consumed_at IS NOT NULL OR intent.expires_at<=clock_timestamp() OR intent.provider_id IS NULL THEN
        RAISE EXCEPTION 'Connection batch intent is unavailable' USING ERRCODE='PT409'; END IF;
    IF intent.expected_head_revision IS DISTINCT FROM (SELECT revision FROM identity.connection_heads WHERE owner_user_id=owner_id) THEN
        RAISE EXCEPTION 'Connection changed during batch authorization' USING ERRCODE='PT409'; END IF;
    SELECT count(DISTINCT v->'data'->>'accountId') INTO count_accounts FROM jsonb_array_elements(p_operations) v;
    IF count_accounts<>jsonb_array_length(p_operations)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_operations) v WHERE jsonb_typeof(v) IS DISTINCT FROM 'object'
            OR v->'data'->>'providerId' IS DISTINCT FROM intent.provider_id
            OR jsonb_typeof(v->'document') IS DISTINCT FROM 'string'
            OR EXISTS (SELECT 1 FROM jsonb_object_keys(v) k WHERE k NOT IN ('operationId','data','document')))
        OR (SELECT count(DISTINCT v->>'operationId') FROM jsonb_array_elements(p_operations) v)<>count_accounts THEN
        RAISE EXCEPTION 'Connection batch accounts are invalid or repeated' USING ERRCODE='22023'; END IF;
    FOR child IN SELECT v FROM jsonb_array_elements(p_operations) v LOOP
        child_id := (child->>'operationId')::uuid;
        IF child_id IS NULL OR child_id=p_operation_id THEN RAISE EXCEPTION 'Connection batch operation is invalid' USING ERRCODE='22023'; END IF;
        -- Child tickets are internal derivatives of the already validated parent
        -- action, not newly asserted user intent. The owner lock spans every row.
        INSERT INTO identity.connection_recreation_intents(operation_id,owner_user_id,scope_key,device_id,provider_id,
            expected_head_revision,expires_at,evidence_protocol) VALUES(child_id,owner_id,intent.scope_key,intent.device_id,intent.provider_id,
            (SELECT revision FROM identity.connection_heads WHERE owner_user_id=owner_id),intent.expires_at,intent.evidence_protocol)
          RETURNING recreation_id INTO child_intent;
        receipts := receipts || jsonb_build_array(identity.connection_commit(child_id,intent.scope_key,NULL,NULL,'save',
            child->'data',child->>'document',intent.device_id,p_runtime_instance_id,child_intent));
    END LOOP;
    receipt := jsonb_build_object('operationId',p_operation_id,'revision',
        (SELECT revision::text FROM identity.connection_heads WHERE owner_user_id=owner_id),'receipts',receipts);
    UPDATE identity.connection_recreation_intents SET consumed_at=clock_timestamp() WHERE recreation_id=p_recreation_id;
    INSERT INTO identity.connection_batches(operation_id,owner_user_id,request_hash,receipt) VALUES(p_operation_id,owner_id,request_hash,receipt);
    RETURN receipt;
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_uuid_lock(uuid),identity.connection_claim_operation(text,uuid,text,text),
    identity.connection_recreate_begin(uuid,text,text,bigint,text,text,bigint),identity.connection_commit_batch(uuid,uuid,jsonb,text)
    FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.connection_public_request_hash(p_owner text,p_request jsonb,p_native boolean) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE document jsonb; provider text; account text;
BEGIN
    IF p_request IS NULL OR jsonb_typeof(p_request)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p_request))<>9
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_request) k WHERE k NOT IN
            ('operationId','scopeKey','resourceKey','expectedRevision','operation','data','document','deviceId','recreationId'))
        OR p_request->>'operation'<>'save' OR jsonb_typeof(p_request->'document') IS DISTINCT FROM 'string'
        OR jsonb_typeof(p_request->'data') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Connection public request is invalid' USING ERRCODE='22023'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(p_request->'data') v WHERE v.key NOT IN
        ('providerId','accountId','configured','isDefault','displayName') OR jsonb_typeof(v.value) IN ('object','array'))
        OR p_request->'data'->'configured' IS DISTINCT FROM 'true'::jsonb THEN
        RAISE EXCEPTION 'Connection public request data is invalid' USING ERRCODE='22023'; END IF;
    document:=(p_request->>'document')::jsonb;
    provider:=p_request->'data'->>'providerId'; account:=p_request->'data'->>'accountId';
    IF document->'version' IS DISTINCT FROM '1'::jsonb OR document->>'providerId' IS DISTINCT FROM provider
        OR document->>'accountId' IS DISTINCT FROM account OR EXISTS (SELECT 1 FROM jsonb_each(document) v
            WHERE v.key NOT IN ('version','providerId','accountId','isDefault','connectedAt','updatedAt','host','login','avatarUrl','credentialSource','displayName')
              OR jsonb_typeof(v.value) IN ('object','array')) THEN
        RAISE EXCEPTION 'Connection public request contains non-public content' USING ERRCODE='22023'; END IF;
    RETURN encode(sha256(convert_to(jsonb_build_array(p_owner,p_request->>'scopeKey',p_request->>'resourceKey',
        (p_request->>'expectedRevision')::bigint,p_request->>'operation',p_request->'data',p_request->>'document',
        p_request->>'deviceId',p_native,(p_request->>'recreationId')::uuid)::text,'UTF8')),'hex');
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_public_request_hash(text,jsonb,boolean) FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON SEQUENCE identity.connection_attempts_attempt_order_seq FROM PUBLIC,anon,authenticated,service_role;

-- Capability selection is explicit and dormant. Installing this release never
-- activates an owner or changes the legacy route; rollout owns the guarded 1->2.
ALTER TABLE identity.connection_heads ADD COLUMN verification_protocol smallint NOT NULL DEFAULT 1 CHECK(verification_protocol IN(1,2));
CREATE OR REPLACE FUNCTION identity.connection_authority() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id text:=identity.connection_owner(); head identity.connection_heads%ROWTYPE;
BEGIN
    SELECT * INTO head FROM identity.connection_heads WHERE owner_user_id=owner_id;
    RETURN jsonb_build_object('version',1,'mode',COALESCE(head.authority_mode,'legacy'),
        'epoch',COALESCE(head.authority_epoch,0)::text,'phase',COALESCE(head.authority_phase,'stable'),
        'acceptingNewOperations',COALESCE(head.authority_phase='stable',true),
        'verificationProtocol',COALESCE(head.verification_protocol,1));
END;
$$;
CREATE FUNCTION identity.connection_attempt_inspect(p_operation_id uuid,p_runtime_instance_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id text:=identity.connection_owner(); device text; context jsonb;
BEGIN
    device:=identity.connection_runtime(owner_id,p_runtime_instance_id);
    context:=identity.connection_attempt_context(owner_id,p_operation_id);
    IF context IS NULL OR context->>'deviceId' IS DISTINCT FROM device OR NOT EXISTS (
        SELECT 1 FROM identity.connection_attempts WHERE owner_user_id=owner_id AND operation_id=p_operation_id AND prepared_at IS NOT NULL) THEN RETURN NULL; END IF;
    RETURN context;
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_attempt_inspect(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
