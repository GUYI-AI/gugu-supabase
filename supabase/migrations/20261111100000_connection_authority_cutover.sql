-- Connection authority cutover (#238). Adds the only maintenance writer of
-- authority_mode='owner', opens the owner RPCs to authenticated owners, and
-- makes every owner RPC refuse an account whose authority is not owner. No
-- legacy table, row, policy, function definition or ACL is changed.
DO $prerequisites$ BEGIN
    IF to_regprocedure('identity.connection_management_write_fence(text,boolean)') IS NULL
        OR to_regprocedure('identity.connection_authority()') IS NULL
        OR to_regprocedure('identity.connection_prepare_import(text,text,text,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'Install the owner runtime, authority reader and management gate releases first';
    END IF;
END;
$prerequisites$;

-- The one definition of "this account has legacy connection data": account
-- rows or tombstones, or unfinished legacy panel operations. Catalog entries
-- and collection markers are not account state.
CREATE FUNCTION identity.connection_has_legacy_data(p_owner text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
    SELECT EXISTS (SELECT 1 FROM identity.assistant_panel_items WHERE owner_user_id = p_owner AND domain = 'integrations'
            AND NOT starts_with(resource_key,'catalog:') AND resource_key <> '__collection__'
            AND NOT starts_with(resource_key,'__collection__:'))
        OR EXISTS (SELECT 1 FROM identity.assistant_panel_changes WHERE owner_user_id = p_owner AND domain = 'integrations'
            AND source = 'panel' AND status IN ('pending','failed'))
$$;
REVOKE ALL ON FUNCTION identity.connection_has_legacy_data(text) FROM PUBLIC,anon,authenticated,service_role;

-- Every owner RPC write path (commit, recreate_begin, commit_batch, admit,
-- ack, platform revoke) passes through this lock. It now requires owner
-- authority. An account with no head and no legacy connection data is
-- initialized natively in the cutover writer's shape: owner, epoch 1, stable.
-- Legacy and prepared-but-not-switched heads are refused.
CREATE OR REPLACE FUNCTION identity.connection_owner_lock(p_owner text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE head identity.connection_heads%ROWTYPE;
BEGIN
    -- Same authority lock as the management write fence and the cutover writer.
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:connection-authority:' || p_owner,0));
    SELECT * INTO head FROM identity.connection_heads WHERE owner_user_id = p_owner FOR UPDATE;
    IF NOT FOUND THEN
        -- Native initialization is not a migration: an unprepared legacy account
        -- with account rows/tombstones or pending effects must not become empty.
        IF identity.connection_has_legacy_data(p_owner) THEN
            RAISE EXCEPTION 'Connection migration is not prepared' USING ERRCODE = '55000';
        END IF;
        INSERT INTO identity.connection_heads(owner_user_id,native_initialized_at,authority_mode,authority_epoch,authority_phase)
            VALUES(p_owner,clock_timestamp(),'owner',1,'stable') ON CONFLICT DO NOTHING RETURNING * INTO head;
        IF FOUND THEN
            PERFORM chat.send_user_event(jsonb_build_object('revision',head.revision::text,'scopeKey',NULL,'resourceKey',NULL,
                'authorityEpoch',head.authority_epoch::text),'connection_changed','gugu:user:' || p_owner || ':events',true);
            RETURN;
        END IF;
        -- A concurrent preparation created the head first; judge that row.
        SELECT * INTO head FROM identity.connection_heads WHERE owner_user_id = p_owner FOR UPDATE;
    END IF;
    IF head.authority_mode IS DISTINCT FROM 'owner' THEN
        RAISE EXCEPTION 'Connection authority has not been switched to owner' USING ERRCODE = '55000';
    END IF;
    IF head.native_initialized_at IS NULL THEN
        RAISE EXCEPTION 'Connection candidate has not completed authority handover' USING ERRCODE = '55000';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_owner_lock(text) FROM PUBLIC,anon,authenticated,service_role;

-- Owner reads report a legacy account exactly like an uninitialized one
-- (not-ready / refused pending). Patch the installed definitions in place so
-- the earlier entry-point guards, OIDs, owners and other grants are kept.
DO $owner_readers$
DECLARE spec record; fn oid; v_definition text;
BEGIN
    FOR spec IN SELECT * FROM (VALUES
      ('identity.connection_snapshot(text)',
       'SELECT revision,native_initialized_at IS NOT NULL INTO head_revision,initialized FROM identity.connection_heads WHERE owner_user_id = owner_id;',
       'SELECT revision,native_initialized_at IS NOT NULL AND authority_mode = ''owner'' INTO head_revision,initialized FROM identity.connection_heads WHERE owner_user_id = owner_id;'),
      ('identity.connection_resource(text,text)',
       'SELECT revision INTO head_revision FROM identity.connection_heads WHERE owner_user_id = owner_id AND native_initialized_at IS NOT NULL;',
       'SELECT revision INTO head_revision FROM identity.connection_heads WHERE owner_user_id = owner_id AND native_initialized_at IS NOT NULL AND authority_mode = ''owner'';'),
      ('identity.connection_pending(text)',
       'SELECT revision INTO head_revision FROM identity.connection_heads WHERE owner_user_id=owner_id AND native_initialized_at IS NOT NULL;',
       'SELECT revision INTO head_revision FROM identity.connection_heads WHERE owner_user_id=owner_id AND native_initialized_at IS NOT NULL AND authority_mode=''owner'';')
    ) AS patches(signature,anchor,replacement)
    LOOP
        fn := to_regprocedure(spec.signature);
        IF fn IS NULL THEN RAISE EXCEPTION 'Missing owner connection reader: %',spec.signature; END IF;
        v_definition := pg_get_functiondef(fn);
        IF (length(v_definition)-length(replace(v_definition,spec.anchor,'')))/length(spec.anchor) <> 1 THEN
            RAISE EXCEPTION 'Owner connection reader has an unexpected body: %',spec.signature;
        END IF;
        EXECUTE replace(v_definition,spec.anchor,spec.replacement);
    END LOOP;
END;
$owner_readers$;

-- Maintenance-only authority writer. The only path from legacy to owner.
-- p_expected_digest/p_manifest_hash NULL: native initialization of an account
-- without legacy connection data. Otherwise the audited, prepared candidate is
-- rechecked against the live legacy source and handed over in this transaction.
-- Any drift raises and rolls back the whole transaction; the account stays legacy.
CREATE FUNCTION identity.connection_authority_cutover(p_owner text,p_expected_epoch bigint,
    p_expected_digest text DEFAULT NULL,p_manifest_hash text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
    head identity.connection_heads%ROWTYPE; source jsonb; assistant text;
    imported boolean := p_expected_digest IS NOT NULL;
    statement_limit integer := extract(epoch FROM current_setting('statement_timeout')::interval) * 1000;
    lock_limit integer := extract(epoch FROM current_setting('lock_timeout')::interval) * 1000;
    transaction_limit integer := extract(epoch FROM current_setting('transaction_timeout')::interval) * 1000;
BEGIN
    IF statement_limit NOT BETWEEN 1 AND 2000 OR lock_limit NOT BETWEEN 1 AND 250 OR transaction_limit NOT BETWEEN 1 AND 2000 THEN
        RAISE EXCEPTION 'Connection cutover requires bounded outer statement and lock timeouts' USING ERRCODE = '22023';
    END IF;
    IF p_owner IS NULL OR p_expected_epoch IS NULL OR p_expected_epoch < 0
        OR imported AND (p_expected_digest !~ '^[0-9a-f]{64}$' OR p_manifest_hash IS NULL OR p_manifest_hash !~ '^[0-9a-f]{64}$')
        OR NOT imported AND p_manifest_hash IS NOT NULL THEN
        RAISE EXCEPTION 'Connection cutover evidence is invalid' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM identity.users WHERE id = p_owner AND type = 'human' AND removed_at IS NULL) THEN
        RAISE EXCEPTION 'Connection account is unavailable' USING ERRCODE = '42501';
    END IF;
    -- Same order as every guarded management write: shared policy lock, owner
    -- authority advisory lock, owner head row, then the legacy control row.
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('gugu:connection-management-policy',0));
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:connection-authority:' || p_owner,0));
    SELECT * INTO head FROM identity.connection_heads WHERE owner_user_id = p_owner FOR UPDATE;
    IF COALESCE(head.authority_mode,'legacy') <> 'legacy' THEN
        RAISE EXCEPTION 'Connection authority was already switched' USING ERRCODE = 'PT409';
    END IF;
    IF COALESCE(head.authority_epoch,0) <> p_expected_epoch OR COALESCE(head.authority_phase,'stable') <> 'stable' THEN
        RAISE EXCEPTION 'Connection authority changed or is quiescing' USING ERRCODE = 'PT409';
    END IF;
    IF imported THEN
        IF head.owner_user_id IS NULL OR head.prepared_at IS NULL OR head.native_initialized_at IS NOT NULL
            OR head.source_digest IS DISTINCT FROM p_expected_digest OR head.manifest_hash IS DISTINCT FROM p_manifest_hash THEN
            RAISE EXCEPTION 'Connection candidate differs from the audited preparation' USING ERRCODE = 'PT409';
        END IF;
        assistant := head.legacy_assistant_user_id;
        PERFORM 1 FROM identity.users WHERE id = assistant FOR SHARE;
        PERFORM 1 FROM identity.assistant_panel_items WHERE assistant_user_id = assistant
            AND owner_user_id = p_owner AND domain = 'control' AND resource_key = '__head__' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Connection legacy control is unprepared' USING ERRCODE = '55000'; END IF;
        source := identity.connection_legacy_inventory(p_owner);
        IF source->>'identityState' IS DISTINCT FROM 'found' OR source->>'assistantId' IS DISTINCT FROM assistant
            OR source->>'databaseDigest' IS DISTINCT FROM p_expected_digest
            OR (source->>'headRevision')::bigint IS DISTINCT FROM head.source_revision THEN
            RAISE EXCEPTION 'Connection source changed after preparation' USING ERRCODE = 'PT409';
        END IF;
        -- Unfinished legacy effects keep the account on legacy authority.
        IF jsonb_array_length(source->'operations') <> 0
            OR EXISTS (SELECT 1 FROM identity.connection_operations WHERE owner_user_id = p_owner) THEN
            RAISE EXCEPTION 'Connection legacy operations are unfinished' USING ERRCODE = '55000';
        END IF;
        -- The staged rows are exactly the live legacy rows, tombstones included.
        IF EXISTS (
            (SELECT resource_key,device_id,revision,data,body_item_id,body_sha256,deleted_at,stale_at,observed_at,updated_at
               FROM identity.assistant_panel_items
              WHERE assistant_user_id = assistant AND owner_user_id = p_owner AND domain = 'integrations'
             EXCEPT ALL
             SELECT legacy_resource_key,device_id,revision,data,legacy_body_item_id,body_sha256,deleted_at,stale_at,observed_at,updated_at
               FROM identity.connection_items WHERE owner_user_id = p_owner AND legacy_assistant_user_id = assistant)
            UNION ALL
            (SELECT legacy_resource_key,device_id,revision,data,legacy_body_item_id,body_sha256,deleted_at,stale_at,observed_at,updated_at
               FROM identity.connection_items WHERE owner_user_id = p_owner
             EXCEPT ALL
             SELECT resource_key,device_id,revision,data,body_item_id,body_sha256,deleted_at,stale_at,observed_at,updated_at
               FROM identity.assistant_panel_items
              WHERE assistant_user_id = assistant AND owner_user_id = p_owner AND domain = 'integrations')
        ) THEN
            RAISE EXCEPTION 'Connection candidate differs from its legacy source' USING ERRCODE = 'PT409';
        END IF;
    ELSE
        IF head.prepared_at IS NOT NULL THEN
            RAISE EXCEPTION 'Connection candidate requires its audited preparation digest' USING ERRCODE = '55000';
        END IF;
        IF identity.connection_has_legacy_data(p_owner) THEN
            RAISE EXCEPTION 'Connection legacy data requires an audited preparation' USING ERRCODE = '55000';
        END IF;
        INSERT INTO identity.connection_heads(owner_user_id) VALUES(p_owner) ON CONFLICT DO NOTHING;
    END IF;
    -- Handover (native_initialized_at) and the authority switch are one write.
    UPDATE identity.connection_heads SET authority_mode = 'owner',authority_epoch = authority_epoch + 1,
        authority_phase = 'stable',native_initialized_at = COALESCE(native_initialized_at,clock_timestamp()),
        updated_at = clock_timestamp()
      WHERE owner_user_id = p_owner AND authority_mode = 'legacy' AND authority_epoch = p_expected_epoch
        AND authority_phase = 'stable' AND (prepared_at IS NOT NULL) = imported
      RETURNING * INTO head;
    IF NOT FOUND THEN RAISE EXCEPTION 'Connection authority changed during cutover' USING ERRCODE = 'PT409'; END IF;
    -- The owner RPCs' existing best-effort hint; online clients re-read.
    PERFORM chat.send_user_event(jsonb_build_object('revision',head.revision::text,'scopeKey',NULL,'resourceKey',NULL,
        'authorityEpoch',head.authority_epoch::text),'connection_changed','gugu:user:' || p_owner || ':events',true);
    RETURN jsonb_build_object('version',1,'mode',head.authority_mode,'epoch',head.authority_epoch::text,
        'phase',head.authority_phase,'acceptingNewOperations',head.authority_phase = 'stable');
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_authority_cutover(text,bigint,text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Operator resolution of a post-cutover operation whose executor reported
-- CONNECTION_OUTCOME_UNKNOWN. Bound to that operation's UUID and unknown
-- admission; the decision and its external evidence hash are immutable.
-- Imported legacy operations keep using connection_record_takeover.
CREATE TABLE identity.connection_unknown_outcome_resolutions (
    operation_id uuid NOT NULL REFERENCES identity.connection_operations(operation_id) ON DELETE CASCADE,
    admission_id uuid NOT NULL REFERENCES identity.connection_admissions(admission_id) ON DELETE CASCADE,
    owner_user_id text NOT NULL REFERENCES identity.connection_heads(owner_user_id) ON DELETE CASCADE,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    outcome text NOT NULL CHECK (outcome IN ('applied','failed','not-started')),
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$' AND error_code <> 'CONNECTION_OUTCOME_UNKNOWN'),
    evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
    recorded_by text NOT NULL DEFAULT current_user,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (operation_id,admission_id),
    CHECK ((outcome = 'failed') = (error_code IS NOT NULL))
);
ALTER TABLE identity.connection_unknown_outcome_resolutions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.connection_unknown_outcome_resolutions FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.connection_resolve_unknown_outcome(p_owner text,p_operation_id uuid,p_outcome text,
    p_evidence_hash text,p_error_code text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE change identity.connection_operations%ROWTYPE; admission identity.connection_admissions%ROWTYPE;
    resolution identity.connection_unknown_outcome_resolutions%ROWTYPE; head_revision bigint;
BEGIN
    IF p_owner IS NULL OR p_operation_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('applied','failed','not-started')
        OR p_evidence_hash IS NULL OR p_evidence_hash !~ '^[0-9a-f]{64}$'
        OR p_outcome = 'failed' AND (p_error_code IS NULL OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$'
            OR p_error_code = 'CONNECTION_OUTCOME_UNKNOWN')
        OR p_outcome <> 'failed' AND p_error_code IS NOT NULL THEN
        RAISE EXCEPTION 'Connection outcome resolution is invalid' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:connection-authority:' || p_owner,0));
    SELECT revision INTO head_revision FROM identity.connection_heads
      WHERE owner_user_id = p_owner AND authority_mode = 'owner' AND native_initialized_at IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Connection authority is not owner' USING ERRCODE = '55000'; END IF;
    SELECT * INTO change FROM identity.connection_operations WHERE owner_user_id = p_owner AND operation_id = p_operation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Connection operation is unavailable' USING ERRCODE = '42501'; END IF;
    IF change.source = 'legacy' THEN
        RAISE EXCEPTION 'Imported legacy operations use connection_record_takeover' USING ERRCODE = '55000';
    END IF;
    -- Repeating the identical recorded decision returns its original receipt.
    SELECT * INTO resolution FROM identity.connection_unknown_outcome_resolutions
      WHERE operation_id = p_operation_id AND outcome = p_outcome AND evidence_hash = p_evidence_hash
        AND error_code IS NOT DISTINCT FROM p_error_code ORDER BY recorded_at DESC LIMIT 1;
    IF NOT FOUND THEN
        SELECT * INTO admission FROM identity.connection_admissions
          WHERE admission_id = change.last_admission_id AND operation_id = p_operation_id;
        IF change.status <> 'failed' OR change.error_code IS DISTINCT FROM 'CONNECTION_OUTCOME_UNKNOWN' OR change.terminal_at IS NULL
            OR admission.admission_id IS NULL OR admission.status <> 'failed' OR NOT admission.terminal
            OR admission.error_code IS DISTINCT FROM 'CONNECTION_OUTCOME_UNKNOWN' THEN
            RAISE EXCEPTION 'Connection operation outcome is not unknown' USING ERRCODE = 'PT409';
        END IF;
        INSERT INTO identity.connection_unknown_outcome_resolutions(operation_id,admission_id,owner_user_id,request_hash,
            outcome,error_code,evidence_hash) VALUES(p_operation_id,admission.admission_id,p_owner,change.request_hash,
            p_outcome,p_error_code,p_evidence_hash) RETURNING * INTO resolution;
        -- The admission receipt stays immutable and no item is written:
        -- applied completes, failed stays terminal, not-started is admissible
        -- again under the same original UUID.
        UPDATE identity.connection_operations SET
            status = CASE p_outcome WHEN 'applied' THEN 'applied' WHEN 'not-started' THEN 'pending' ELSE 'failed' END,
            error_code = CASE WHEN p_outcome = 'failed' THEN p_error_code END,
            terminal_at = CASE WHEN p_outcome = 'failed' THEN change.terminal_at END,
            applied_at = CASE WHEN p_outcome = 'applied' THEN clock_timestamp() END
          WHERE operation_id = p_operation_id;
        PERFORM chat.send_user_event(jsonb_build_object('revision',head_revision::text,'scopeKey',change.scope_key,
            'resourceKey',change.resource_key),'connection_changed','gugu:user:' || p_owner || ':events',true);
    END IF;
    RETURN jsonb_build_object('operationId',resolution.operation_id,'admissionId',resolution.admission_id,
        'outcome',resolution.outcome,'errorCode',resolution.error_code,'recordedAt',resolution.recorded_at);
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_resolve_unknown_outcome(text,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Open the owner RPCs to signed-in owners only, in the same transaction as
-- the owner-authority guard above. anon, PUBLIC and service_role stay closed.
REVOKE ALL ON FUNCTION identity.connection_snapshot(text),identity.connection_resource(text,text),
    identity.connection_recreate_begin(uuid,text,text,bigint,text,text,bigint),
    identity.connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid),
    identity.connection_commit_batch(uuid,uuid,jsonb,text),identity.connection_pending(text),
    identity.connection_admit(text,bigint,uuid),identity.connection_ack(text,uuid,uuid,text,boolean)
    FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION identity.connection_snapshot(text),identity.connection_resource(text,text),
    identity.connection_recreate_begin(uuid,text,text,bigint,text,text,bigint),
    identity.connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid),
    identity.connection_commit_batch(uuid,uuid,jsonb,text),identity.connection_pending(text),
    identity.connection_admit(text,bigint,uuid),identity.connection_ack(text,uuid,uuid,text,boolean)
    TO authenticated;
