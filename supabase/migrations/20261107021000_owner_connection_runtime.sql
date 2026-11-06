-- Native owner primitives. API EXECUTE stays closed until the separately
-- approved activation release fences old writes. No legacy RPC is modified.
ALTER TABLE identity.connection_heads ADD COLUMN publishers jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(publishers) = 'object');
ALTER TABLE identity.connection_heads ADD COLUMN native_initialized_at timestamptz;

CREATE TABLE identity.connection_recreation_intents (
    recreation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id uuid NOT NULL UNIQUE,
    owner_user_id text NOT NULL REFERENCES identity.connection_heads(owner_user_id) ON DELETE CASCADE,
    scope_key text NOT NULL,
    resource_key text,
    expected_item_revision bigint CHECK (expected_item_revision >= 0),
    provider_id text,
    expected_head_revision bigint CHECK (expected_head_revision >= 0),
    device_id text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '30 minutes',
    consumed_at timestamptz,
    CHECK ((resource_key IS NOT NULL AND expected_item_revision IS NOT NULL AND expected_head_revision IS NULL)
        OR (resource_key IS NULL AND expected_item_revision IS NULL AND provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND expected_head_revision IS NOT NULL AND provider_id IS NOT NULL))
);
CREATE TABLE identity.connection_admissions (
    admission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id uuid NOT NULL REFERENCES identity.connection_operations(operation_id) ON DELETE CASCADE,
    owner_user_id text NOT NULL REFERENCES identity.connection_heads(owner_user_id) ON DELETE CASCADE,
    executor_kind text NOT NULL DEFAULT 'runtime' CHECK (executor_kind IN ('runtime','platform')),
    device_id text,
    runtime_instance_id text,
    operation_revision bigint NOT NULL,
    admitted_head_revision bigint NOT NULL,
    request_hash text NOT NULL,
    status text NOT NULL DEFAULT 'started' CHECK (status IN ('started','applied','failed')),
    error_code text,
    terminal boolean NOT NULL DEFAULT false,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    receipt jsonb,
    CHECK ((executor_kind = 'runtime' AND device_id IS NOT NULL AND runtime_instance_id IS NOT NULL)
        OR (executor_kind = 'platform' AND device_id IS NULL AND runtime_instance_id IS NULL))
);
CREATE UNIQUE INDEX connection_one_started_admission ON identity.connection_admissions(operation_id) WHERE status = 'started';
ALTER TABLE identity.connection_operations ADD COLUMN last_admission_id uuid REFERENCES identity.connection_admissions(admission_id);
ALTER TABLE identity.connection_recreation_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.connection_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.connection_recreation_intents, identity.connection_admissions FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION identity.connection_owner() RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE owner_id text := auth.uid()::text;
BEGIN
    IF owner_id IS NULL OR NOT EXISTS (SELECT 1 FROM identity.users WHERE id = owner_id AND type = 'human' AND removed_at IS NULL) THEN
        RAISE EXCEPTION 'Connection account is unavailable' USING ERRCODE = '42501';
    END IF;
    RETURN owner_id;
END;
$$;

CREATE FUNCTION identity.connection_scope(p_owner text,p_scope text,p_device text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
    IF p_scope IS NULL OR p_scope = 'platform' AND p_device IS NOT NULL
        OR p_scope <> 'platform' AND (p_device IS NULL OR p_scope IS DISTINCT FROM 'device:' || p_device) THEN
        RAISE EXCEPTION 'Connection scope is invalid' USING ERRCODE = '22023';
    END IF;
    IF p_device IS NOT NULL AND NOT EXISTS (SELECT 1 FROM identity.gugu_devices WHERE device_id = p_device AND user_id::text = p_owner) THEN
        RAISE EXCEPTION 'Connection target device is not owned' USING ERRCODE = '42501';
    END IF;
END;
$$;

CREATE FUNCTION identity.connection_owner_lock(p_owner text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    -- Native initialization is not a migration: an unprepared legacy account
    -- with account rows/tombstones or pending effects must not become empty.
    IF NOT EXISTS (SELECT 1 FROM identity.connection_heads WHERE owner_user_id = p_owner) AND (
        EXISTS (SELECT 1 FROM identity.assistant_panel_items WHERE owner_user_id = p_owner AND domain = 'integrations'
            AND NOT starts_with(resource_key,'catalog:') AND resource_key <> '__collection__'
            AND NOT starts_with(resource_key,'__collection__:'))
        OR EXISTS (SELECT 1 FROM identity.assistant_panel_changes WHERE owner_user_id = p_owner AND domain = 'integrations'
            AND source = 'panel' AND status IN ('pending','failed'))
    ) THEN RAISE EXCEPTION 'Connection migration is not prepared' USING ERRCODE = '55000'; END IF;
    INSERT INTO identity.connection_heads(owner_user_id,native_initialized_at) VALUES(p_owner,clock_timestamp()) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM identity.connection_heads WHERE owner_user_id = p_owner FOR UPDATE;
    IF EXISTS (SELECT 1 FROM identity.connection_heads WHERE owner_user_id=p_owner AND native_initialized_at IS NULL) THEN
        RAISE EXCEPTION 'Connection candidate has not completed authority handover' USING ERRCODE='55000'; END IF;
END;
$$;

CREATE FUNCTION identity.connection_runtime(p_owner text,p_instance text,p_publish boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE device text; prior text;
BEGIN
    SELECT i.device_id INTO device FROM identity.runtime_instances i
      JOIN identity.gugu_devices d ON d.device_id = i.device_id AND d.user_id = i.owner_user_id
      WHERE i.instance_id = p_instance AND i.owner_user_id::text = p_owner
        AND i.last_heartbeat_at > clock_timestamp() - interval '90 seconds';
    IF device IS NULL THEN RAISE EXCEPTION 'Connection runtime is not current or owned' USING ERRCODE = '42501'; END IF;
    IF p_publish THEN
        SELECT publishers->>device INTO prior FROM identity.connection_heads WHERE owner_user_id = p_owner;
        IF prior IS DISTINCT FROM p_instance AND EXISTS (SELECT 1 FROM identity.runtime_instances
            WHERE instance_id = prior AND owner_user_id::text = p_owner AND device_id = device
              AND last_heartbeat_at > clock_timestamp() - interval '90 seconds') THEN
            RAISE EXCEPTION 'Connection device publisher is still live' USING ERRCODE = '55000';
        END IF;
        UPDATE identity.connection_heads SET publishers = publishers || jsonb_build_object(device,p_instance) WHERE owner_user_id = p_owner;
    END IF;
    RETURN device;
END;
$$;

CREATE FUNCTION identity.connection_item_projection(p_item identity.connection_items) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
    SELECT jsonb_build_object('scopeKey',p_item.scope_key,'resourceKey',p_item.resource_key,'deviceId',p_item.device_id,
        'revision',p_item.revision::text,'data',p_item.data,'publicMetadata',p_item.public_metadata,
        'document',p_item.body_document,'bodySha256',p_item.body_sha256,'deletedAt',p_item.deleted_at,
        'staleAt',p_item.stale_at,'observedAt',p_item.observed_at,'updatedAt',p_item.updated_at)
$$;

CREATE FUNCTION identity.connection_operation_projection(p_operation identity.connection_operations,p_payload boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
    SELECT jsonb_build_object('operationId',p_operation.operation_id,'requestHash',p_operation.request_hash,
        'scopeKey',p_operation.scope_key,'resourceKey',p_operation.resource_key,'deviceId',p_operation.device_id,
        'revision',p_operation.revision::text,'expectedItemRevision',p_operation.expected_item_revision::text,
        'operation',p_operation.operation,'status',CASE WHEN a.status = 'started' THEN 'started' ELSE p_operation.status END,
        'errorCode',p_operation.error_code,'terminal',p_operation.terminal_at IS NOT NULL,
        'admissionId',p_operation.last_admission_id,'startedAt',a.started_at)
        || CASE WHEN p_payload THEN jsonb_build_object('payload',p_operation.payload) ELSE '{}'::jsonb END
    FROM (SELECT 1) singleton LEFT JOIN identity.connection_admissions a ON a.admission_id = p_operation.last_admission_id
$$;

CREATE FUNCTION identity.connection_snapshot(p_device_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.connection_owner(); head_revision bigint; items jsonb; application jsonb; result jsonb; initialized boolean;
BEGIN
    PERFORM identity.connection_scope(owner_id,CASE WHEN p_device_id IS NULL THEN 'platform' ELSE 'device:' || p_device_id END,p_device_id);
    SELECT revision,native_initialized_at IS NOT NULL INTO head_revision,initialized FROM identity.connection_heads WHERE owner_user_id = owner_id;
    IF NOT FOUND OR NOT initialized THEN
        RETURN jsonb_build_object('version',1,'state','not-ready','revision',COALESCE(head_revision,0)::text,'items',NULL,'application',NULL);
    END IF;
    IF (SELECT count(*) FROM identity.connection_items WHERE owner_user_id = owner_id) > 2000
        OR (SELECT count(*) FROM identity.connection_operations WHERE owner_user_id = owner_id AND status IN ('pending','failed')) > 2000 THEN
        RAISE EXCEPTION 'Connection snapshot exceeds the complete inventory limit' USING ERRCODE = '54000';
    END IF;
    SELECT COALESCE(jsonb_agg(identity.connection_item_projection(i) ORDER BY i.scope_key,i.resource_key),'[]'::jsonb)
      INTO items FROM identity.connection_items i WHERE i.owner_user_id = owner_id
        AND (p_device_id IS NULL OR i.scope_key = 'platform' OR i.scope_key = 'device:' || p_device_id);
    SELECT COALESCE(jsonb_agg(identity.connection_operation_projection(c) ORDER BY c.revision),'[]'::jsonb)
      INTO application FROM identity.connection_operations c WHERE c.owner_user_id = owner_id AND c.status IN ('pending','failed')
        AND (p_device_id IS NULL OR c.device_id IS NULL OR c.device_id = p_device_id);
    result := jsonb_build_object('version',1,'state','ready',
        'revision',head_revision::text,'items',items,'application',application);
    IF octet_length(result::text) > 16777216 THEN RAISE EXCEPTION 'Connection snapshot exceeds the response limit' USING ERRCODE = '54000'; END IF;
    RETURN result;
END;
$$;

CREATE FUNCTION identity.connection_resource(p_scope_key text,p_resource_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.connection_owner(); head_revision bigint; item identity.connection_items%ROWTYPE;
BEGIN
    SELECT revision INTO head_revision FROM identity.connection_heads WHERE owner_user_id = owner_id AND native_initialized_at IS NOT NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('version',1,'state','not-ready','revision','0','item',NULL); END IF;
    SELECT * INTO item FROM identity.connection_items WHERE owner_user_id = owner_id AND scope_key = p_scope_key AND resource_key = p_resource_key;
    RETURN jsonb_build_object('version',1,'state',CASE WHEN head_revision IS NULL THEN 'not-ready' ELSE 'ready' END,
        'revision',COALESCE(head_revision,0)::text,'item',CASE WHEN item.owner_user_id IS NULL THEN NULL ELSE identity.connection_item_projection(item) END);
END;
$$;

CREATE FUNCTION identity.connection_recreate_begin(p_operation_id uuid,p_scope_key text,p_resource_key text,
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
        INSERT INTO identity.connection_recreation_intents(operation_id,owner_user_id,scope_key,resource_key,expected_item_revision,device_id,provider_id,expected_head_revision)
          VALUES(p_operation_id,owner_id,p_scope_key,p_resource_key,p_expected_revision,p_device_id,p_provider_id,p_expected_head_revision) RETURNING * INTO intent;
    END IF;
    RETURN jsonb_build_object('recreationId',intent.recreation_id,'operationId',intent.operation_id,
        'expectedItemRevision',intent.expected_item_revision::text,'expectedHeadRevision',intent.expected_head_revision::text,
        'providerId',intent.provider_id,'revision',(SELECT revision::text FROM identity.connection_heads WHERE owner_user_id = owner_id),
        'expiresAt',intent.expires_at);
END;
$$;

REVOKE ALL ON FUNCTION identity.connection_owner(),identity.connection_scope(text,text,text),identity.connection_owner_lock(text),
    identity.connection_runtime(text,text,boolean),identity.connection_item_projection(identity.connection_items),
    identity.connection_operation_projection(identity.connection_operations,boolean),
    identity.connection_snapshot(text),identity.connection_resource(text,text),
    identity.connection_recreate_begin(uuid,text,text,bigint,text,text,bigint) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.connection_account_key(p_key text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE value jsonb;
BEGIN
    value := p_key::jsonb;
    IF jsonb_typeof(value) = 'array' AND jsonb_array_length(value) = 2
        AND jsonb_typeof(value->0) = 'string' AND jsonb_typeof(value->1) = 'string' THEN RETURN value; END IF;
    RETURN NULL;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END;
$$;

CREATE FUNCTION identity.connection_commit(p_operation_id uuid,p_scope_key text,p_resource_key text,
    p_expected_revision bigint,p_operation text,p_data jsonb,p_document text DEFAULT NULL,
    p_device_id text DEFAULT NULL,p_runtime_instance_id text DEFAULT NULL,p_recreation_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    owner_id text := identity.connection_owner(); target_key text := p_resource_key; expected_revision bigint := p_expected_revision;
    prior identity.connection_items%ROWTYPE; existing identity.connection_operations%ROWTYPE;
    intent identity.connection_recreation_intents%ROWTYPE; candidate identity.connection_items%ROWTYPE;
    request_hash text; new_revision bigint; actor_device text; catalog boolean; marker boolean; matches integer := 0;
    document text; public_metadata jsonb; parsed jsonb; data jsonb := p_data; payload jsonb;
    provider text; account text; key_identity jsonb; outcome text;
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
    SELECT * INTO existing FROM identity.connection_operations WHERE operation_id = p_operation_id;
    IF FOUND THEN
        IF existing.owner_user_id <> owner_id THEN RAISE EXCEPTION 'Connection operation is unavailable' USING ERRCODE = '42501'; END IF;
        IF existing.request_hash <> request_hash THEN RAISE EXCEPTION 'Connection operation identity was reused' USING ERRCODE = 'PT409'; END IF;
        RETURN jsonb_build_object('operationId',existing.operation_id,'scopeKey',existing.scope_key,'resourceKey',existing.resource_key,
            'revision',existing.revision::text,'status',existing.status);
    END IF;
    IF p_runtime_instance_id IS NOT NULL THEN
        actor_device := identity.connection_runtime(owner_id,p_runtime_instance_id,true);
        IF p_scope_key <> 'platform' AND actor_device IS DISTINCT FROM p_device_id THEN
            RAISE EXCEPTION 'Connection publisher cannot publish another device' USING ERRCODE = '42501';
        END IF;
    END IF;
    IF p_recreation_id IS NOT NULL THEN
        SELECT * INTO intent FROM identity.connection_recreation_intents WHERE recreation_id = p_recreation_id;
        IF NOT FOUND OR intent.owner_user_id <> owner_id OR intent.operation_id <> p_operation_id
            OR intent.scope_key <> p_scope_key OR intent.device_id IS DISTINCT FROM p_device_id
            OR intent.consumed_at IS NOT NULL OR intent.expires_at <= clock_timestamp() THEN
            RAISE EXCEPTION 'Connection recreation intent is unavailable' USING ERRCODE = 'PT409';
        END IF;
        IF intent.expected_head_revision IS NOT NULL AND intent.expected_head_revision IS DISTINCT FROM
            (SELECT revision FROM identity.connection_heads WHERE owner_user_id = owner_id) THEN
            RAISE EXCEPTION 'Connection changed during provider authorization' USING ERRCODE = 'PT409';
        END IF;
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
    IF p_recreation_id IS NULL AND p_operation='save' AND NOT marker AND NOT catalog
        AND EXISTS (SELECT 1 FROM (SELECT consumed_at FROM identity.connection_recreation_intents
            WHERE owner_user_id=owner_id AND scope_key=p_scope_key AND provider_id=p_data->>'providerId'
            ORDER BY created_at DESC,recreation_id DESC LIMIT 1) latest WHERE consumed_at IS NULL) THEN
        RAISE EXCEPTION 'Connection authorization requires explicit reconciliation' USING ERRCODE='PT409';
    END IF;
    IF prior.deleted_at IS NOT NULL AND NOT marker AND NOT catalog AND p_operation NOT IN ('save','remove') THEN
        RAISE EXCEPTION 'Connection state changes cannot clear a revocation' USING ERRCODE = 'PT409';
    END IF;
    IF marker IS DISTINCT FROM (p_operation IN ('prepared','error')) AND p_operation <> 'remove' THEN
        RAISE EXCEPTION 'Connection operation does not match its resource' USING ERRCODE = '22023';
    END IF;
    IF p_scope_key <> 'platform' AND p_operation IN ('save','prepared','error') AND p_runtime_instance_id IS NULL THEN
        RAISE EXCEPTION 'Device connection publication requires its current runtime' USING ERRCODE = '42501';
    END IF;
    IF p_operation IN ('save','prepared','error') THEN
        PERFORM identity.assistant_panel_validate('integrations',target_key,p_data);
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
    outcome := CASE WHEN p_runtime_instance_id IS NULL AND p_operation IN ('remove','enable','disable') THEN 'pending' ELSE 'applied' END;
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

CREATE FUNCTION identity.connection_pending(p_runtime_instance_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.connection_owner(); device text; head_revision bigint; changes jsonb;
BEGIN
    device := identity.connection_runtime(owner_id,p_runtime_instance_id);
    SELECT revision INTO head_revision FROM identity.connection_heads WHERE owner_user_id=owner_id AND native_initialized_at IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Connection account is not prepared' USING ERRCODE='55000'; END IF;
    IF (SELECT count(*) FROM identity.connection_operations WHERE owner_user_id=owner_id
        AND scope_key='device:' || device AND status IN ('pending','failed')) > 2000 THEN
        RAISE EXCEPTION 'Connection pending inventory exceeds its limit' USING ERRCODE='54000';
    END IF;
    SELECT COALESCE(jsonb_agg(identity.connection_operation_projection(c,true) ORDER BY c.revision),'[]'::jsonb)
      INTO changes FROM identity.connection_operations c WHERE c.owner_user_id=owner_id
        AND c.scope_key='device:' || device AND c.device_id=device AND c.status IN ('pending','failed');
    RETURN jsonb_build_object('version',1,'revision',head_revision::text,'changes',changes);
END;
$$;

-- Internal only. Runtime and official-platform wrappers authenticate first and
-- serialize on the owner head. A platform admission cannot be claimed by a host.
CREATE TABLE identity.connection_takeover_evidence (
    operation_id uuid PRIMARY KEY REFERENCES identity.connection_operations(operation_id) ON DELETE CASCADE,
    manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
    outcome text NOT NULL CHECK (outcome IN ('not-started','applied','failed','unknown')),
    error_code text,
    recorded_by text NOT NULL DEFAULT current_user,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE identity.connection_takeover_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.connection_takeover_evidence FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.connection_admit_operation(p_owner text,p_operation uuid,p_head bigint,
    p_kind text,p_device text,p_runtime text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE change identity.connection_operations%ROWTYPE; admission uuid; current_revision bigint; item_revision bigint;
BEGIN
    SELECT * INTO change FROM identity.connection_operations WHERE owner_user_id=p_owner AND operation_id=p_operation;
    IF NOT FOUND THEN RAISE EXCEPTION 'Connection operation is unavailable' USING ERRCODE='42501'; END IF;
    IF (p_kind='runtime' AND (change.scope_key IS DISTINCT FROM 'device:' || p_device OR change.device_id IS DISTINCT FROM p_device))
        OR (p_kind='platform' AND (change.scope_key <> 'platform' OR change.device_id IS NOT NULL))
        OR p_kind NOT IN ('runtime','platform') OR p_kind IS NULL THEN
        RAISE EXCEPTION 'Connection executor does not own the target' USING ERRCODE='42501';
    END IF;
    SELECT revision INTO current_revision FROM identity.connection_heads WHERE owner_user_id=p_owner FOR UPDATE;
    IF p_head IS DISTINCT FROM current_revision THEN RAISE EXCEPTION 'Connection changed before admission' USING ERRCODE='PT409'; END IF;
    IF change.status IN ('applied','superseded') THEN
        RETURN jsonb_build_object('admitted',false,'revision',current_revision::text,'operationId',p_operation,'reason','superseded');
    END IF;
    IF change.terminal_at IS NOT NULL THEN
        RETURN jsonb_build_object('admitted',false,'revision',current_revision::text,'operationId',p_operation,
            'reason',CASE WHEN change.error_code='CONNECTION_OUTCOME_UNKNOWN' THEN 'outcome-unknown' ELSE 'terminal' END);
    END IF;
    IF EXISTS (SELECT 1 FROM identity.connection_admissions WHERE admission_id=change.last_admission_id AND status='started') THEN
        RETURN jsonb_build_object('admitted',false,'revision',current_revision::text,'operationId',p_operation,'reason','already-started');
    END IF;
    SELECT revision INTO item_revision FROM identity.connection_items WHERE owner_user_id=p_owner
      AND scope_key=change.scope_key AND resource_key=change.resource_key;
    IF item_revision IS DISTINCT FROM change.revision THEN
        RETURN jsonb_build_object('admitted',false,'revision',current_revision::text,'operationId',p_operation,'reason','superseded');
    END IF;
    IF change.source='legacy' AND NOT EXISTS (SELECT 1 FROM identity.connection_takeover_evidence
        WHERE operation_id=p_operation AND request_hash=change.request_hash AND outcome='not-started') THEN
        -- Preparation did not establish whether an old executor already began.
        -- Quiescence and receipt reconciliation are prerequisites for takeover.
        UPDATE identity.connection_operations SET status='failed',error_code='CONNECTION_OUTCOME_UNKNOWN',terminal_at=clock_timestamp()
          WHERE operation_id=p_operation;
        RETURN jsonb_build_object('admitted',false,'revision',current_revision::text,'operationId',p_operation,'reason','outcome-unknown');
    END IF;
    INSERT INTO identity.connection_admissions(operation_id,owner_user_id,executor_kind,device_id,runtime_instance_id,
        operation_revision,admitted_head_revision,request_hash) VALUES(p_operation,p_owner,p_kind,p_device,p_runtime,change.revision,p_head,change.request_hash)
        RETURNING admission_id INTO admission;
    UPDATE identity.connection_operations SET last_admission_id=admission,status='pending',error_code=NULL WHERE operation_id=p_operation;
    RETURN jsonb_build_object('admitted',true,'revision',current_revision::text,'operationId',p_operation,
        'operationRevision',change.revision::text,'requestHash',change.request_hash,'admissionId',admission);
END;
$$;

CREATE FUNCTION identity.connection_admit(p_runtime_instance_id text,p_expected_revision bigint,p_operation_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.connection_owner(); device text; current_revision bigint; change identity.connection_operations%ROWTYPE;
BEGIN
    PERFORM identity.connection_owner_lock(owner_id);
    device := identity.connection_runtime(owner_id,p_runtime_instance_id);
    IF p_operation_id IS NOT NULL THEN
        RETURN identity.connection_admit_operation(owner_id,p_operation_id,p_expected_revision,'runtime',device,p_runtime_instance_id);
    END IF;
    SELECT revision INTO current_revision FROM identity.connection_heads WHERE owner_user_id=owner_id;
    IF p_expected_revision IS DISTINCT FROM current_revision THEN RAISE EXCEPTION 'Connection changed before task admission' USING ERRCODE='PT409'; END IF;
    SELECT * INTO change FROM identity.connection_operations WHERE owner_user_id=owner_id AND status IN ('pending','failed')
      AND terminal_at IS NULL ORDER BY revision LIMIT 1;
    IF FOUND THEN RETURN jsonb_build_object('admitted',false,'revision',current_revision::text,'operationId',change.operation_id,
        'domain','integrations','resourceKey',change.resource_key,'errorCode',change.error_code); END IF;
    RETURN jsonb_build_object('admitted',true,'revision',current_revision::text);
END;
$$;

CREATE FUNCTION identity.connection_ack(p_runtime_instance_id text,p_operation_id uuid,p_admission_id uuid,
    p_error_code text DEFAULT NULL,p_terminal boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.connection_owner(); device text; change identity.connection_operations%ROWTYPE;
    admission identity.connection_admissions%ROWTYPE; v_receipt jsonb;
BEGIN
    IF p_terminal IS NULL OR p_error_code IS NULL AND p_terminal OR p_error_code IS NOT NULL AND p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
        OR p_error_code='CONNECTION_OUTCOME_UNKNOWN' AND NOT p_terminal THEN
        RAISE EXCEPTION 'Connection outcome is invalid' USING ERRCODE='22023'; END IF;
    PERFORM identity.connection_owner_lock(owner_id);
    device := identity.connection_runtime(owner_id,p_runtime_instance_id);
    SELECT * INTO change FROM identity.connection_operations WHERE owner_user_id=owner_id AND operation_id=p_operation_id;
    SELECT * INTO admission FROM identity.connection_admissions WHERE owner_user_id=owner_id AND operation_id=p_operation_id AND admission_id=p_admission_id;
    IF change.operation_id IS NULL OR admission.admission_id IS NULL OR admission.executor_kind<>'runtime'
        OR admission.device_id IS DISTINCT FROM device OR change.device_id IS DISTINCT FROM device
        OR admission.request_hash IS DISTINCT FROM change.request_hash OR admission.operation_revision IS DISTINCT FROM change.revision THEN
        RAISE EXCEPTION 'Connection acknowledgement is unavailable' USING ERRCODE='42501'; END IF;
    IF admission.receipt IS NOT NULL THEN
        IF admission.error_code IS DISTINCT FROM p_error_code OR admission.terminal IS DISTINCT FROM p_terminal THEN
            RAISE EXCEPTION 'Connection acknowledgement differs from its receipt' USING ERRCODE='PT409'; END IF;
        RETURN admission.receipt;
    END IF;
    IF admission.status<>'started' OR change.last_admission_id IS DISTINCT FROM p_admission_id THEN
        RAISE EXCEPTION 'Connection admission was superseded' USING ERRCODE='PT409'; END IF;
    v_receipt := jsonb_build_object('operationId',p_operation_id,'admissionId',p_admission_id,'scopeKey',change.scope_key,
        'resourceKey',change.resource_key,'revision',change.revision::text,'status',CASE WHEN p_error_code IS NULL THEN 'applied' ELSE 'failed' END,
        'errorCode',p_error_code,'terminal',p_terminal);
    UPDATE identity.connection_admissions SET status=CASE WHEN p_error_code IS NULL THEN 'applied' ELSE 'failed' END,
        error_code=p_error_code,terminal=p_terminal,completed_at=clock_timestamp(),receipt=v_receipt WHERE admission_id=p_admission_id;
    UPDATE identity.connection_operations SET status=CASE WHEN status='superseded' THEN 'superseded'
        WHEN p_error_code IS NULL THEN 'applied' ELSE 'failed' END,error_code=p_error_code,
        terminal_at=CASE WHEN p_terminal THEN clock_timestamp() END,applied_at=CASE WHEN p_error_code IS NULL THEN clock_timestamp() END,
        applied_device_id=device WHERE operation_id=p_operation_id;
    -- The outcome never writes an item: an old ack cannot resurrect or replace
    -- a newer revision, account document, or permanent revocation tombstone.
    RETURN v_receipt;
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_pending(text),identity.connection_admit_operation(text,uuid,bigint,text,text,text),
    identity.connection_admit(text,bigint,uuid),identity.connection_ack(text,uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE identity.connection_batches (
    operation_id uuid PRIMARY KEY,
    owner_user_id text NOT NULL REFERENCES identity.connection_heads(owner_user_id) ON DELETE CASCADE,
    request_hash text NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE identity.connection_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.connection_batches FROM PUBLIC,anon,authenticated,service_role;

-- An explicit CLI import can return several previously unknown accounts. One
-- provider intent fences the entire set; partial publication is never visible.
CREATE FUNCTION identity.connection_commit_batch(p_operation_id uuid,p_recreation_id uuid,p_operations jsonb,
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
            expected_head_revision,expires_at) VALUES(child_id,owner_id,intent.scope_key,intent.device_id,intent.provider_id,
            (SELECT revision FROM identity.connection_heads WHERE owner_user_id=owner_id),intent.expires_at)
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
REVOKE ALL ON FUNCTION identity.connection_commit_batch(uuid,uuid,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

-- Maintenance-only attestation of an offline executor's original durable
-- ledger. The external evidence must establish quiescence and the outcome;
-- absence of a database ack is never sufficient proof of 'not-started'.
CREATE FUNCTION identity.connection_record_takeover(p_owner text,p_operation_id uuid,p_manifest_hash text,
    p_request_hash text,p_evidence_hash text,p_outcome text,p_error_code text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE change identity.connection_operations%ROWTYPE; existing identity.connection_takeover_evidence%ROWTYPE;
BEGIN
    IF p_outcome IS NULL OR p_outcome NOT IN ('not-started','applied','failed','unknown')
        OR p_evidence_hash IS NULL OR p_evidence_hash !~ '^[0-9a-f]{64}$'
        OR p_outcome='failed' AND (p_error_code IS NULL OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$')
        OR p_outcome<>'failed' AND p_error_code IS NOT NULL THEN
        RAISE EXCEPTION 'Connection takeover evidence is invalid' USING ERRCODE='22023'; END IF;
    PERFORM 1 FROM identity.connection_heads WHERE owner_user_id=p_owner AND manifest_hash=p_manifest_hash FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Connection prepared manifest differs' USING ERRCODE='PT409'; END IF;
    SELECT * INTO change FROM identity.connection_operations WHERE owner_user_id=p_owner AND operation_id=p_operation_id;
    IF NOT FOUND OR change.source<>'legacy' OR change.request_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION 'Connection original operation differs' USING ERRCODE='PT409'; END IF;
    IF change.status='superseded' OR change.status='applied' AND p_outcome<>'applied' THEN
        RAISE EXCEPTION 'Connection completed operation cannot be requeued' USING ERRCODE='PT409'; END IF;
    SELECT * INTO existing FROM identity.connection_takeover_evidence WHERE operation_id=p_operation_id;
    IF FOUND THEN
        IF existing.manifest_hash IS DISTINCT FROM p_manifest_hash OR existing.request_hash IS DISTINCT FROM p_request_hash
            OR existing.evidence_hash IS DISTINCT FROM p_evidence_hash OR existing.outcome IS DISTINCT FROM p_outcome
            OR existing.error_code IS DISTINCT FROM p_error_code THEN
            RAISE EXCEPTION 'Connection takeover evidence is immutable' USING ERRCODE='PT409'; END IF;
        RETURN;
    END IF;
    IF change.last_admission_id IS NOT NULL OR EXISTS (SELECT 1 FROM identity.runtime_instances
        WHERE owner_user_id::text=p_owner AND (change.device_id IS NULL OR device_id=change.device_id)
        AND last_heartbeat_at>clock_timestamp()-interval '90 seconds') THEN
        RAISE EXCEPTION 'Connection old executor is not quiesced' USING ERRCODE='55000'; END IF;
    INSERT INTO identity.connection_takeover_evidence(operation_id,manifest_hash,request_hash,evidence_hash,outcome,error_code)
      VALUES(p_operation_id,p_manifest_hash,p_request_hash,p_evidence_hash,p_outcome,p_error_code);
    UPDATE identity.connection_operations SET
        status=CASE p_outcome WHEN 'applied' THEN 'applied' WHEN 'not-started' THEN 'pending' ELSE 'failed' END,
        error_code=CASE p_outcome WHEN 'unknown' THEN 'CONNECTION_OUTCOME_UNKNOWN' WHEN 'failed' THEN p_error_code END,
        terminal_at=CASE WHEN p_outcome IN ('unknown','failed') THEN clock_timestamp() END,
        applied_at=CASE WHEN p_outcome='applied' THEN clock_timestamp() END
      WHERE operation_id=p_operation_id;
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_record_takeover(text,uuid,text,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
