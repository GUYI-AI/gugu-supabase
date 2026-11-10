-- Owner-scoped metadata and migration evidence. Credential stores do not move.
-- Preparation only: these rows never become an execution queue or live authority.
-- No legacy routing, authority switch, old table or old policy is altered.
CREATE TABLE identity.connection_heads (
    owner_user_id text PRIMARY KEY REFERENCES identity.users(id) ON DELETE CASCADE,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    legacy_assistant_user_id text,
    source_revision bigint,
    source_digest text CHECK (source_digest IS NULL OR source_digest ~ '^[0-9a-f]{64}$'),
    manifest_hash text CHECK (manifest_hash IS NULL OR manifest_hash ~ '^[0-9a-f]{64}$'),
    prepared_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE identity.connection_items (
    owner_user_id text NOT NULL REFERENCES identity.connection_heads(owner_user_id) ON DELETE CASCADE,
    scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
    resource_key text NOT NULL CHECK (length(resource_key) BETWEEN 1 AND 512),
    device_id text,
    provider_id text CHECK (provider_id IS NULL OR provider_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
    account_id text CHECK (account_id IS NULL OR length(account_id) BETWEEN 1 AND 512),
    revision bigint NOT NULL CHECK (revision >= 0),
    data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 262144),
    public_metadata jsonb CHECK (public_metadata IS NULL OR jsonb_typeof(public_metadata) = 'object'),
    body_document text CHECK (body_document IS NULL OR octet_length(body_document) <= 1048576),
    body_sha256 text CHECK (body_sha256 IS NULL OR body_sha256 ~ '^[0-9a-f]{64}$'),
    legacy_body_item_id uuid,
    legacy_assistant_user_id text,
    legacy_resource_key text,
    deleted_at timestamptz,
    stale_at timestamptz,
    observed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_user_id, scope_key, resource_key),
    CHECK (body_document IS NULL OR body_sha256 IS NOT NULL AND body_sha256 = encode(sha256(convert_to(body_document, 'UTF8')), 'hex')),
    CHECK (deleted_at IS NULL OR body_document IS NULL AND public_metadata IS NULL)
);

-- Imported operations can reference their original durable receipt rather than
-- creating another independently writable execution queue for the same effect.
CREATE TABLE identity.connection_operations (
    operation_id uuid PRIMARY KEY,
    owner_user_id text NOT NULL REFERENCES identity.connection_heads(owner_user_id) ON DELETE CASCADE,
    scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
    resource_key text NOT NULL CHECK (length(resource_key) BETWEEN 1 AND 512),
    device_id text,
    revision bigint NOT NULL UNIQUE CHECK (revision > 0),
    expected_item_revision bigint NOT NULL CHECK (expected_item_revision >= 0),
    operation text NOT NULL CHECK (operation IN ('save', 'remove', 'enable', 'disable', 'prepared', 'error')),
    source text NOT NULL CHECK (source IN ('panel', 'runtime', 'legacy')),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 263168),
    status text NOT NULL CHECK (status IN ('pending', 'failed', 'applied', 'superseded')),
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    terminal_at timestamptz,
    cleanup_attempted_at timestamptz,
    applied_device_id text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    applied_at timestamptz,
    legacy_operation_id uuid,
    CHECK (source <> 'legacy' OR legacy_operation_id = operation_id AND legacy_operation_id IS NOT NULL)
);
CREATE INDEX connection_operations_pending ON identity.connection_operations(owner_user_id, device_id, revision)
    WHERE status IN ('pending', 'failed') AND terminal_at IS NULL;

-- Deliberately no FK to the assistant, its home, or a private DM. Uninstalling
-- an assistant must not delete account-level connection metadata or tombstones.
ALTER TABLE identity.connection_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.connection_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.connection_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.connection_heads, identity.connection_items, identity.connection_operations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON identity.connection_heads, identity.connection_items, identity.connection_operations TO authenticated;
CREATE POLICY connection_heads_owner ON identity.connection_heads FOR SELECT TO authenticated
    USING (owner_user_id = (SELECT auth.uid())::text);
CREATE POLICY connection_items_owner ON identity.connection_items FOR SELECT TO authenticated
    USING (owner_user_id = (SELECT auth.uid())::text);
CREATE POLICY connection_operations_owner ON identity.connection_operations FOR SELECT TO authenticated
    USING (owner_user_id = (SELECT auth.uid())::text);

-- Exact installed definitions, never reconstructed from source migration text.
-- This evidence is maintenance-only and cannot be read or rewritten by clients.
CREATE TABLE identity.connection_legacy_functions (
    signature text PRIMARY KEY,
    original_oid oid NOT NULL,
    definition text NOT NULL,
    definition_sha256 text NOT NULL CHECK (definition_sha256 ~ '^[0-9a-f]{64}$'),
    original_acl aclitem[],
    original_owner oid NOT NULL,
    original_attributes jsonb NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (definition_sha256 = encode(sha256(convert_to(definition, 'UTF8')), 'hex'))
);
ALTER TABLE identity.connection_legacy_functions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.connection_legacy_functions FROM PUBLIC, anon, authenticated, service_role;

DO $predecessors$
DECLARE expected record; target oid; definition text; actual_hash text;
BEGIN
    FOR expected IN SELECT * FROM (VALUES
        ('identity.assistant_panel_snapshot(text)', '9421e302b0e60cc7e00a9b7df3babb4eddeda150c4006ad3f78566950198ca3e'),
        ('identity.assistant_panel_resource(text,text,text)', 'fcdabc85a17624ef9d3f36411238001dc5273845504f0a6fca25af2919581794'),
        ('identity.assistant_panel_commit(text,uuid,text,text,bigint,text,jsonb,uuid,text,text,text)', 'b71a1fadf001f8a1b7b206969f3b935a8710ceac6833a7d87eb60bbcee0ddcb9'),
        ('identity.assistant_panel_pending(text,text)', 'e6bb8dfb759ce405ebe1f6d465acd989529c938bb9e1c069c607250da57969af'),
        ('identity.assistant_panel_ack(text,text,uuid,text)', '02a0c689f93f1505ad9391e8a8245ca2832947e3a47c36b60192f4a2668f21bf'),
        ('identity.assistant_panel_reject(text,text,uuid,text)', 'f6e29dcffc6532be4b7508a33d8a03306346ff1d6ce690985b3173a567ddc336'),
        ('identity.assistant_panel_admit(text,text,bigint)', '45ee50eab5fa9d77483ed1b34e79a9d83b8bd22166c5bdefe8ac80d5e999eb89')
    ) AS baseline(signature, sha256)
    LOOP
        target := to_regprocedure(expected.signature);
        IF target IS NULL THEN RAISE EXCEPTION 'Connection predecessor is missing: %', expected.signature; END IF;
        definition := pg_get_functiondef(target);
        actual_hash := encode(sha256(convert_to(definition, 'UTF8')), 'hex');
        IF actual_hash IS DISTINCT FROM expected.sha256 THEN
            RAISE EXCEPTION 'Connection predecessor differs from the reviewed source: %', expected.signature;
        END IF;
        INSERT INTO identity.connection_legacy_functions(signature, original_oid, definition,
            definition_sha256, original_acl, original_owner, original_attributes)
        SELECT expected.signature, p.oid, definition, actual_hash, p.proacl, p.proowner,
            jsonb_build_object('prosecdef', p.prosecdef, 'provolatile', p.provolatile, 'proisstrict', p.proisstrict,
                'proparallel', p.proparallel, 'proconfig', to_jsonb(p.proconfig), 'prorettype', p.prorettype,
                'proargtypes', p.proargtypes::text, 'prokind', p.prokind, 'proleakproof', p.proleakproof)
        FROM pg_proc p WHERE p.oid = target;
    END LOOP;
END;
$predecessors$;

-- Maintenance-only complete source export, including retired rows, tombstones
-- and terminal failures. Ordinary visible snapshots are insufficient for import.
CREATE FUNCTION identity.connection_legacy_inventory(p_owner text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE assistant text; identity_count integer; item_count integer; operation_count integer; result jsonb;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.users WHERE id = p_owner AND type = 'human' AND removed_at IS NULL) THEN
        RAISE EXCEPTION 'Connection preparation owner is unavailable' USING ERRCODE = '42501';
    END IF;
    SELECT count(*), min(id) INTO identity_count, assistant FROM (
        SELECT DISTINCT u.id FROM identity.users u JOIN identity.agent_provisions p ON p.agent_user_id = u.id
        WHERE u.owner_user_id = p_owner AND u.type = 'agent' AND p.owner_user_id = p_owner
          AND p.member_key = 'assistant' AND p.phase IN ('ready', 'completed')
    ) candidates;
    IF identity_count > 1 THEN RAISE EXCEPTION 'Connection legacy identity is ambiguous' USING ERRCODE = '55000'; END IF;
    SELECT count(*) INTO item_count FROM identity.assistant_panel_items
        WHERE assistant_user_id = assistant AND owner_user_id = p_owner AND domain = 'integrations';
    SELECT count(*) INTO operation_count FROM identity.assistant_panel_changes
        WHERE assistant_user_id = assistant AND owner_user_id = p_owner AND domain = 'integrations'
          AND source = 'panel' AND status IN ('pending', 'failed');
    IF item_count > 2000 OR operation_count > 2000 THEN
        RAISE EXCEPTION 'Connection preparation exceeds the record limit' USING ERRCODE = '54000';
    END IF;
    SELECT jsonb_build_object('version', 1, 'complete', true, 'ownerId', p_owner,
        'identityState', CASE WHEN assistant IS NULL THEN 'none' ELSE 'found' END, 'assistantId', assistant,
        'headRevision', COALESCE((SELECT revision::text FROM identity.assistant_panel_items
            WHERE assistant_user_id = assistant AND owner_user_id = p_owner AND domain = 'control' AND resource_key = '__head__'), '0'),
        'items', COALESCE((SELECT jsonb_agg(to_jsonb(i) || jsonb_build_object('revision', i.revision::text) ORDER BY i.resource_key)
            FROM identity.assistant_panel_items i WHERE i.assistant_user_id = assistant AND i.owner_user_id = p_owner AND i.domain = 'integrations'), '[]'::jsonb),
        'operations', COALESCE((SELECT jsonb_agg(to_jsonb(c) || jsonb_build_object('revision', c.revision::text,
            'expected_item_revision', c.expected_item_revision::text) ORDER BY c.revision)
            FROM identity.assistant_panel_changes c WHERE c.assistant_user_id = assistant AND c.owner_user_id = p_owner
              AND c.domain = 'integrations' AND c.source = 'panel' AND c.status IN ('pending', 'failed')), '[]'::jsonb)) INTO result;
    IF octet_length(result::text) > 16777216 THEN
        RAISE EXCEPTION 'Connection preparation exceeds the inventory limit' USING ERRCODE = '54000';
    END IF;
    RETURN result || jsonb_build_object('databaseDigest', encode(sha256(convert_to(result::text, 'UTF8')), 'hex'));
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_legacy_inventory(text) FROM PUBLIC, anon, authenticated, service_role;

-- Stages a bounded, verified candidate. Never updates the old source, changes
-- routing or executes pending operations. A later cutover must recheck its digest.
CREATE FUNCTION identity.connection_prepare_import(p_owner text, p_expected_digest text, p_manifest_hash text, p_bodies jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    source jsonb; assistant text; entry jsonb; document text; parsed jsonb; marker boolean; catalog boolean;
    body_bytes bigint := 0; current_markers integer := 0; actual_count integer;
    lock_acquired_at timestamptz;
    statement_limit integer := extract(epoch FROM current_setting('statement_timeout')::interval) * 1000;
    lock_limit integer := extract(epoch FROM current_setting('lock_timeout')::interval) * 1000;
    transaction_limit integer := extract(epoch FROM current_setting('transaction_timeout')::interval) * 1000;
BEGIN
    IF statement_limit NOT BETWEEN 1 AND 2000 OR lock_limit NOT BETWEEN 1 AND 250 OR transaction_limit NOT BETWEEN 1 AND 2000 THEN
        RAISE EXCEPTION 'Connection preparation requires bounded outer statement and lock timeouts' USING ERRCODE = '22023';
    END IF;
    IF p_expected_digest IS NULL OR p_expected_digest !~ '^[0-9a-f]{64}$'
        OR p_manifest_hash IS NULL OR p_manifest_hash !~ '^[0-9a-f]{64}$'
        OR p_bodies IS NULL OR jsonb_typeof(p_bodies) <> 'object' OR octet_length(p_bodies::text) > 16777216 THEN
        RAISE EXCEPTION 'Connection preparation evidence is invalid' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(p_bodies) b WHERE jsonb_typeof(b.value) <> 'string'
        OR b.key !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') THEN
        RAISE EXCEPTION 'Connection body map is invalid' USING ERRCODE = '22023';
    END IF;
    -- Body IO, download verification and normalization belong before this call.
    -- Bound submitted bytes before acquiring the old shared control lock.
    FOR document IN SELECT value #>> '{}' FROM jsonb_each(p_bodies) LOOP
        IF document IS NULL OR octet_length(document) > 1048576 THEN
            RAISE EXCEPTION 'Connection preparation body exceeds the limit' USING ERRCODE = '54000';
        END IF;
        body_bytes := body_bytes + octet_length(document);
    END LOOP;
    IF body_bytes > 8388608 THEN RAISE EXCEPTION 'Connection preparation bodies exceed the limit' USING ERRCODE = '54000'; END IF;
    source := identity.connection_legacy_inventory(p_owner);
    IF source->>'identityState' <> 'found' THEN
        RAISE EXCEPTION 'Connection preparation has no legacy source; native initialization is separate' USING ERRCODE = '55000';
    END IF;
    assistant := source->>'assistantId';
    -- Same order as the old writer: assistant identity, old control, new owner.
    PERFORM 1 FROM identity.users WHERE id = assistant FOR SHARE;
    PERFORM 1 FROM identity.assistant_panel_items WHERE assistant_user_id = assistant
        AND owner_user_id = p_owner AND domain = 'control' AND resource_key = '__head__' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Connection legacy control is unprepared' USING ERRCODE = '55000'; END IF;
    lock_acquired_at := clock_timestamp();
    source := identity.connection_legacy_inventory(p_owner);
    IF source->>'databaseDigest' IS DISTINCT FROM p_expected_digest THEN
        RAISE EXCEPTION 'Connection source changed after audit' USING ERRCODE = 'PT409';
    END IF;
    INSERT INTO identity.connection_heads(owner_user_id) VALUES(p_owner) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM identity.connection_heads WHERE owner_user_id = p_owner FOR UPDATE;
    -- These tables contain preparation candidates only. Re-preparing one owner
    -- atomically replaces its previous candidate, never live state or old data.
    DELETE FROM identity.connection_operations WHERE owner_user_id = p_owner;
    DELETE FROM identity.connection_items WHERE owner_user_id = p_owner;
    FOR entry IN SELECT value FROM jsonb_array_elements(source->'items') LOOP
        marker := entry->>'resource_key' = '__collection__' OR starts_with(entry->>'resource_key', '__collection__:');
        catalog := starts_with(entry->>'resource_key', 'catalog:');
        PERFORM identity.assistant_panel_validate('integrations', entry->>'resource_key', entry->'data');
        document := NULL; parsed := NULL;
        IF entry->>'body_item_id' IS NOT NULL THEN
            IF entry->>'deleted_at' IS NOT NULL OR marker OR jsonb_typeof(p_bodies->(entry->>'body_item_id')) IS DISTINCT FROM 'string' THEN
                RAISE EXCEPTION 'Connection body bytes are missing or invalid' USING ERRCODE = '22023';
            END IF;
            document := p_bodies->>(entry->>'body_item_id');
            IF encode(sha256(convert_to(document, 'UTF8')), 'hex') IS DISTINCT FROM entry->>'body_sha256' THEN
                RAISE EXCEPTION 'Connection body bytes differ from the source hash' USING ERRCODE = '22023';
            END IF;
            parsed := document::jsonb;
            IF jsonb_typeof(parsed) <> 'object' OR parsed->'version' IS DISTINCT FROM '1'::jsonb THEN
                RAISE EXCEPTION 'Connection body schema is invalid' USING ERRCODE = '22023';
            END IF;
            IF catalog THEN
                IF parsed->'en'->>'id' IS DISTINCT FROM entry->'data'->>'providerId'
                    OR parsed->'zh-CN'->>'id' IS DISTINCT FROM entry->'data'->>'providerId'
                    OR entry->>'resource_key' IS DISTINCT FROM 'catalog:' || (entry->'data'->>'providerId') THEN
                    RAISE EXCEPTION 'Connection catalog identity differs' USING ERRCODE = '22023';
                END IF;
            ELSIF parsed->>'providerId' IS DISTINCT FROM entry->'data'->>'providerId'
                OR parsed->>'accountId' IS DISTINCT FROM entry->'data'->>'accountId'
                OR EXISTS (SELECT 1 FROM jsonb_each(parsed) v WHERE v.key NOT IN
                    ('version','providerId','accountId','isDefault','connectedAt','updatedAt','host','login','avatarUrl','credentialSource','displayName')
                    OR jsonb_typeof(v.value) IN ('object','array')) THEN
                RAISE EXCEPTION 'Connection public account metadata is invalid' USING ERRCODE = '22023';
            END IF;
        ELSIF entry->>'body_sha256' IS NOT NULL OR NOT marker AND entry->>'deleted_at' IS NULL THEN
            RAISE EXCEPTION 'Connection body reference is incomplete' USING ERRCODE = '22023';
        END IF;
        IF marker AND entry->>'deleted_at' IS NULL AND entry->>'stale_at' IS NULL THEN
            current_markers := current_markers + 1;
            SELECT count(*) INTO actual_count FROM jsonb_array_elements(source->'items') i
                WHERE i->>'deleted_at' IS NULL AND i->>'stale_at' IS NULL
                  AND i->>'resource_key' <> '__collection__' AND NOT starts_with(i->>'resource_key', '__collection__:')
                  AND (entry->>'resource_key' = '__collection__' OR i->>'device_id' = entry->>'device_id');
            IF entry->'data'->>'state' IS DISTINCT FROM 'ready' OR entry->'data'->'schemaVersion' IS DISTINCT FROM '1'::jsonb
                OR entry->'data'->'itemCount' IS DISTINCT FROM to_jsonb(actual_count)
                OR entry->>'resource_key' <> '__collection__' AND entry->>'resource_key' IS DISTINCT FROM '__collection__:' || (entry->>'device_id') THEN
                RAISE EXCEPTION 'Connection collection is incomplete' USING ERRCODE = '55000';
            END IF;
        END IF;
        INSERT INTO identity.connection_items(owner_user_id,scope_key,resource_key,device_id,provider_id,account_id,revision,data,
            public_metadata,body_document,body_sha256,legacy_body_item_id,legacy_assistant_user_id,legacy_resource_key,
            deleted_at,stale_at,observed_at,updated_at)
        VALUES(p_owner,CASE WHEN entry->>'device_id' IS NULL THEN 'legacy:unknown' ELSE 'device:' || (entry->>'device_id') END,
            entry->>'resource_key',entry->>'device_id',entry->'data'->>'providerId',entry->'data'->>'accountId',
            (entry->>'revision')::bigint,entry->'data',CASE WHEN catalog THEN NULL ELSE parsed END,document,entry->>'body_sha256',
            (entry->>'body_item_id')::uuid,assistant,entry->>'resource_key',
            (entry->>'deleted_at')::timestamptz,(entry->>'stale_at')::timestamptz,(entry->>'observed_at')::timestamptz,(entry->>'updated_at')::timestamptz);
    END LOOP;
    IF current_markers = 0 THEN RAISE EXCEPTION 'Connection collection is unprepared' USING ERRCODE = '55000'; END IF;
    INSERT INTO identity.connection_operations(operation_id,owner_user_id,scope_key,resource_key,device_id,revision,
        expected_item_revision,operation,source,request_hash,payload,status,error_code,terminal_at,cleanup_attempted_at,
        applied_device_id,created_at,applied_at,legacy_operation_id)
    SELECT (c->>'operation_id')::uuid,p_owner,
        CASE WHEN c->>'device_id' IS NULL THEN 'legacy:unknown' ELSE 'device:' || (c->>'device_id') END,
        c->>'resource_key',c->>'device_id',(c->>'revision')::bigint,(c->>'expected_item_revision')::bigint,
        c->>'operation','legacy',c->>'request_hash',c->'payload',c->>'status',c->>'error_code',
        (c->>'terminal_at')::timestamptz,(c->>'cleanup_attempted_at')::timestamptz,c->>'applied_device_id',
        (c->>'created_at')::timestamptz,(c->>'applied_at')::timestamptz,(c->>'operation_id')::uuid
    FROM jsonb_array_elements(source->'operations') c;
    UPDATE identity.connection_heads SET revision = (source->>'headRevision')::bigint,
        source_revision = (source->>'headRevision')::bigint,legacy_assistant_user_id = assistant,
        source_digest = p_expected_digest,manifest_hash = p_manifest_hash,prepared_at = clock_timestamp(),updated_at = clock_timestamp()
        WHERE owner_user_id = p_owner;
    RETURN jsonb_build_object('prepared',true,'activated',false,'itemCount',jsonb_array_length(source->'items'),
        'operationCount',jsonb_array_length(source->'operations'),'sourceDigest',p_expected_digest,'lockAcquiredAt',lock_acquired_at);
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_prepare_import(text,text,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Reconstruct from actual candidate columns, rather than returning a saved copy
-- of the input. The same external normalizer must compare source and candidate.
CREATE FUNCTION identity.connection_prepared_inventory(p_owner text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE head identity.connection_heads%ROWTYPE; result jsonb;
BEGIN
    SELECT * INTO head FROM identity.connection_heads WHERE owner_user_id = p_owner AND prepared_at IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Connection candidate is not prepared' USING ERRCODE = '55000'; END IF;
    SELECT jsonb_build_object('version',1,'complete',true,'ownerId',p_owner,'identityState','found',
        'assistantId',head.legacy_assistant_user_id,'headRevision',head.source_revision::text,'databaseDigest',head.source_digest,
        'items',COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'assistant_user_id',i.legacy_assistant_user_id,'owner_user_id',i.owner_user_id,'domain','integrations',
            'resource_key',i.resource_key,'device_id',i.device_id,'revision',i.revision::text,'data',i.data,
            'body_item_id',i.legacy_body_item_id,'body_sha256',i.body_sha256,'deleted_at',i.deleted_at,
            'stale_at',i.stale_at,'observed_at',i.observed_at,'updated_at',i.updated_at,
            'prepared_public_metadata',i.public_metadata) ORDER BY i.resource_key)
            FROM identity.connection_items i WHERE i.owner_user_id = p_owner),'[]'::jsonb),
        'operations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'operation_id',c.operation_id,'revision',c.revision::text,'assistant_user_id',head.legacy_assistant_user_id,
            'owner_user_id',c.owner_user_id,'domain','integrations','resource_key',c.resource_key,'device_id',c.device_id,
            'source','panel','operation',c.operation,'expected_item_revision',c.expected_item_revision::text,
            'request_hash',c.request_hash,'payload',c.payload,'status',c.status,'created_at',c.created_at,
            'applied_at',c.applied_at,'applied_device_id',c.applied_device_id,'cleanup_attempted_at',c.cleanup_attempted_at,
            'error_code',c.error_code,'terminal_at',c.terminal_at) ORDER BY c.revision)
            FROM identity.connection_operations c WHERE c.owner_user_id = p_owner),'[]'::jsonb)) INTO result;
    RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_prepared_inventory(text) FROM PUBLIC, anon, authenticated, service_role;
