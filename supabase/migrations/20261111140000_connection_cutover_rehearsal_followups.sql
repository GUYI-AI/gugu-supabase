-- Follow-ups from the connection cutover rehearsal (#238):
-- 1. Reinstalled owners become switchable. The import source is the owner's
--    single provisioned assistant that is not removed. Revocation tombstones of
--    removed assistants are imported too (more revoked is the safe direction);
--    their live rows and unfinished changes are not imported but counted.
-- 2. Expected owner-RPC refusals use PT409 with a stable errorCode instead of
--    55000 (an HTTP 500 through the Data API).
-- 3. A maintenance listing of operations stuck in CONNECTION_OUTCOME_UNKNOWN.
DO $prerequisites$ BEGIN
    IF to_regprocedure('identity.connection_authority_cutover(text,bigint,text,text,text)') IS NULL THEN
        RAISE EXCEPTION 'Install the connection authority cutover release first';
    END IF;
END;
$prerequisites$;

-- The rows a legacy import carries: every integrations row of the source
-- assistant, plus account tombstones of removed assistants whose resource key
-- the source does not have (the latest tombstone wins among removed ones). The
-- source's own row for a key is its current state and is kept.
CREATE FUNCTION identity.connection_legacy_import_rows(p_owner text,p_assistant text)
RETURNS SETOF identity.assistant_panel_items
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
    SELECT i.* FROM identity.assistant_panel_items i
     WHERE i.assistant_user_id = p_assistant AND i.owner_user_id = p_owner AND i.domain = 'integrations'
    UNION ALL
    SELECT r.* FROM (
        SELECT DISTINCT ON (i.resource_key) i.* FROM identity.assistant_panel_items i
          JOIN identity.users u ON u.id = i.assistant_user_id
         WHERE i.owner_user_id = p_owner AND i.domain = 'integrations' AND i.assistant_user_id <> p_assistant
           AND u.removed_at IS NOT NULL AND i.deleted_at IS NOT NULL
           AND NOT starts_with(i.resource_key,'catalog:') AND i.resource_key <> '__collection__'
           AND NOT starts_with(i.resource_key,'__collection__:')
           AND NOT EXISTS (SELECT 1 FROM identity.assistant_panel_items s WHERE s.assistant_user_id = p_assistant
               AND s.owner_user_id = p_owner AND s.domain = 'integrations' AND s.resource_key = i.resource_key)
         ORDER BY i.resource_key,i.deleted_at DESC,i.revision DESC,i.assistant_user_id) r
$$;
REVOKE ALL ON FUNCTION identity.connection_legacy_import_rows(text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Maintenance-only complete source export (same contract as before, plus the
-- removed-assistant rule above). headRevision is the owner head's starting
-- revision: the legacy control revision, or a higher imported tombstone revision.
CREATE OR REPLACE FUNCTION identity.connection_legacy_inventory(p_owner text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE assistant text; identity_count integer; item_count integer; operation_count integer; result jsonb;
    removed jsonb := jsonb_build_object('assistantIds','[]'::jsonb,'importedTombstones',0,'supersededTombstones',0,
        'excludedRows',0,'excludedOperations',0);
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.users WHERE id = p_owner AND type = 'human' AND removed_at IS NULL) THEN
        RAISE EXCEPTION 'Connection preparation owner is unavailable' USING ERRCODE = '42501';
    END IF;
    SELECT count(*), min(id) INTO identity_count, assistant FROM (
        SELECT DISTINCT u.id FROM identity.users u JOIN identity.agent_provisions p ON p.agent_user_id = u.id
        WHERE u.owner_user_id = p_owner AND u.type = 'agent' AND u.removed_at IS NULL AND p.owner_user_id = p_owner
          AND p.member_key = 'assistant' AND p.phase IN ('ready', 'completed')
    ) candidates;
    IF identity_count > 1 THEN RAISE EXCEPTION 'Connection legacy identity is ambiguous' USING ERRCODE = '55000'; END IF;
    IF assistant IS NOT NULL THEN
        -- A second assistant that is not removed and still holds connection state
        -- could keep using it: the account stays legacy.
        IF EXISTS (SELECT 1 FROM identity.assistant_panel_items i JOIN identity.users u ON u.id = i.assistant_user_id
                WHERE i.owner_user_id = p_owner AND i.domain = 'integrations' AND i.assistant_user_id <> assistant
                  AND u.removed_at IS NULL AND NOT starts_with(i.resource_key,'catalog:') AND i.resource_key <> '__collection__'
                  AND NOT starts_with(i.resource_key,'__collection__:'))
            OR EXISTS (SELECT 1 FROM identity.assistant_panel_changes c JOIN identity.users u ON u.id = c.assistant_user_id
                WHERE c.owner_user_id = p_owner AND c.domain = 'integrations' AND c.assistant_user_id <> assistant
                  AND u.removed_at IS NULL AND c.source = 'panel' AND c.status IN ('pending', 'failed')) THEN
            RAISE EXCEPTION 'Connection legacy rows belong to several assistants' USING ERRCODE = '55000';
        END IF;
        SELECT jsonb_build_object(
            'assistantIds',COALESCE((SELECT jsonb_agg(DISTINCT r.assistant_user_id ORDER BY r.assistant_user_id)
                FROM identity.connection_legacy_import_rows(p_owner,assistant) r WHERE r.assistant_user_id <> assistant),'[]'::jsonb),
            'importedTombstones',(SELECT count(*) FROM identity.connection_legacy_import_rows(p_owner,assistant) r
                WHERE r.assistant_user_id <> assistant),
            'supersededTombstones',(SELECT count(*) FROM identity.assistant_panel_items i JOIN identity.users u ON u.id = i.assistant_user_id
                WHERE i.owner_user_id = p_owner AND i.domain = 'integrations' AND i.assistant_user_id <> assistant
                  AND u.removed_at IS NOT NULL AND i.deleted_at IS NOT NULL AND NOT starts_with(i.resource_key,'catalog:')
                  AND i.resource_key <> '__collection__' AND NOT starts_with(i.resource_key,'__collection__:'))
                - (SELECT count(*) FROM identity.connection_legacy_import_rows(p_owner,assistant) r WHERE r.assistant_user_id <> assistant),
            'excludedRows',(SELECT count(*) FROM identity.assistant_panel_items i JOIN identity.users u ON u.id = i.assistant_user_id
                WHERE i.owner_user_id = p_owner AND i.domain = 'integrations' AND i.assistant_user_id <> assistant
                  AND u.removed_at IS NOT NULL AND i.deleted_at IS NULL AND NOT starts_with(i.resource_key,'catalog:')
                  AND i.resource_key <> '__collection__' AND NOT starts_with(i.resource_key,'__collection__:')),
            'excludedOperations',(SELECT count(*) FROM identity.assistant_panel_changes c JOIN identity.users u ON u.id = c.assistant_user_id
                WHERE c.owner_user_id = p_owner AND c.domain = 'integrations' AND c.assistant_user_id <> assistant
                  AND u.removed_at IS NOT NULL AND c.source = 'panel' AND c.status IN ('pending', 'failed'))) INTO removed;
    END IF;
    SELECT count(*) INTO item_count FROM identity.connection_legacy_import_rows(p_owner,assistant);
    SELECT count(*) INTO operation_count FROM identity.assistant_panel_changes
        WHERE assistant_user_id = assistant AND owner_user_id = p_owner AND domain = 'integrations'
          AND source = 'panel' AND status IN ('pending', 'failed');
    IF item_count > 2000 OR operation_count > 2000 THEN
        RAISE EXCEPTION 'Connection preparation exceeds the record limit' USING ERRCODE = '54000';
    END IF;
    SELECT jsonb_build_object('version', 1, 'complete', true, 'ownerId', p_owner,
        'identityState', CASE WHEN assistant IS NULL THEN 'none' ELSE 'found' END, 'assistantId', assistant,
        'headRevision', GREATEST(
            COALESCE((SELECT revision FROM identity.assistant_panel_items
                WHERE assistant_user_id = assistant AND owner_user_id = p_owner AND domain = 'control' AND resource_key = '__head__'), 0),
            COALESCE((SELECT max(revision) FROM identity.connection_legacy_import_rows(p_owner,assistant)), 0))::text,
        'items', COALESCE((SELECT jsonb_agg(to_jsonb(i) || jsonb_build_object('revision', i.revision::text) ORDER BY i.resource_key)
            FROM identity.connection_legacy_import_rows(p_owner,assistant) i), '[]'::jsonb),
        'operations', COALESCE((SELECT jsonb_agg(to_jsonb(c) || jsonb_build_object('revision', c.revision::text,
            'expected_item_revision', c.expected_item_revision::text) ORDER BY c.revision)
            FROM identity.assistant_panel_changes c WHERE c.assistant_user_id = assistant AND c.owner_user_id = p_owner
              AND c.domain = 'integrations' AND c.source = 'panel' AND c.status IN ('pending', 'failed')), '[]'::jsonb),
        'removedAssistants', removed) INTO result;
    IF octet_length(result::text) > 16777216 THEN
        RAISE EXCEPTION 'Connection preparation exceeds the inventory limit' USING ERRCODE = '54000';
    END IF;
    RETURN result || jsonb_build_object('databaseDigest', encode(sha256(convert_to(result::text, 'UTF8')), 'hex'));
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_legacy_inventory(text) FROM PUBLIC,anon,authenticated,service_role;

-- Patch installed definitions in place (one anchored change each; the anchor
-- must occur exactly once), keeping OIDs, owners, earlier guards and grants.
-- Preparation keeps each staged row's own assistant (a removed assistant's
-- tombstone stays attributed to it). Pending and the management write fence
-- report expected authority refusals as PT409 with a stable errorCode.
DO $followup_patches$
DECLARE spec record; fn oid; v_definition text;
BEGIN
    FOR spec IN SELECT * FROM (VALUES
      (1,'identity.connection_prepare_import(text,text,text,jsonb)',
       '(entry->>''body_item_id'')::uuid,assistant,entry->>''resource_key'',',
       '(entry->>''body_item_id'')::uuid,entry->>''assistant_user_id'',entry->>''resource_key'','),
      (2,'identity.connection_pending(text)',
       'RAISE EXCEPTION ''Connection account is not prepared'' USING ERRCODE=''55000'';',
       'RAISE EXCEPTION ''Connection authority has not been switched to owner'' USING ERRCODE=''PT409'',
        DETAIL=jsonb_build_object(''errorCode'',''CONNECTION_AUTHORITY_NOT_OWNER'',''feature'',''connection-management'')::text;'),
      (3,'identity.connection_management_write_fence(text,boolean)',
       'RAISE EXCEPTION ''Connection authority changed or is quiescing'' USING ERRCODE=''PT409''; END IF;',
       'IF p_legacy AND head.authority_mode=''owner'' THEN
            RAISE EXCEPTION ''Connection authority was switched to owner'' USING ERRCODE=''PT409'',
                DETAIL=jsonb_build_object(''errorCode'',''CONNECTION_AUTHORITY_SWITCHED'',''feature'',''connection-management'')::text;
        END IF;
        RAISE EXCEPTION ''Connection authority changed or is quiescing'' USING ERRCODE=''PT409'',
            DETAIL=jsonb_build_object(''errorCode'',''CONNECTION_AUTHORITY_QUIESCING'',''feature'',''connection-management'')::text; END IF;')
    ) AS patches(step,signature,anchor,replacement) ORDER BY step
    LOOP
        fn := to_regprocedure(spec.signature);
        IF fn IS NULL THEN RAISE EXCEPTION 'Missing connection function: %',spec.signature; END IF;
        v_definition := pg_get_functiondef(fn);
        IF (length(v_definition)-length(replace(v_definition,spec.anchor,'')))/length(spec.anchor) <> 1 THEN
            RAISE EXCEPTION 'Connection function has an unexpected body: %',spec.signature;
        END IF;
        EXECUTE replace(v_definition,spec.anchor,spec.replacement);
    END LOOP;
END;
$followup_patches$;
-- CREATE OR REPLACE re-ran the DDL privilege guard; restate the owner grant.
REVOKE ALL ON FUNCTION identity.connection_pending(text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION identity.connection_pending(text) TO authenticated;

-- Every owner write path (commit, recreate_begin, commit_batch, admit, ack,
-- platform revoke) passes through this lock. A refusal is an expected state of
-- the account, not a server fault: PT409 (HTTP 409) with a stable errorCode.
CREATE OR REPLACE FUNCTION identity.connection_owner_lock(p_owner text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    -- Same authority lock as the management write fence and the cutover writer.
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:connection-authority:' || p_owner,0));
    PERFORM 1 FROM identity.connection_heads WHERE owner_user_id = p_owner FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM identity.connection_heads WHERE owner_user_id = p_owner
        AND authority_mode = 'owner' AND native_initialized_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Connection authority has not been switched to owner' USING ERRCODE = 'PT409',
            DETAIL = jsonb_build_object('errorCode','CONNECTION_AUTHORITY_NOT_OWNER','feature','connection-management')::text;
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_owner_lock(text) FROM PUBLIC,anon,authenticated,service_role;

-- Same writer as before, with the import comparison taken from the inventory's
-- own rows: the staged candidate must equal exactly the rows the import rule
-- selects (source rows plus removed-assistant tombstones, with their assistant),
-- so any drift on either side still rolls the whole transaction back. Rows of a
-- second assistant that is not removed are refused by the inventory itself.
CREATE OR REPLACE FUNCTION identity.connection_authority_cutover(p_owner text,p_expected_epoch bigint,p_operator text,
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
        OR p_operator IS NULL OR p_operator !~ '^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,127}$'
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
        -- Unfinished effects of the source assistant keep the account legacy.
        IF jsonb_array_length(source->'operations') <> 0
            OR EXISTS (SELECT 1 FROM identity.connection_operations WHERE owner_user_id = p_owner) THEN
            RAISE EXCEPTION 'Connection legacy operations are unfinished' USING ERRCODE = '55000';
        END IF;
        -- Every staged row must be writable afterwards: connection_scope accepts only
        -- platform or a device the owner still owns (never legacy:unknown).
        IF EXISTS (SELECT 1 FROM identity.connection_items i WHERE i.owner_user_id = p_owner
                AND NOT (i.scope_key = 'platform' AND i.device_id IS NULL
                    OR i.scope_key = 'device:' || i.device_id AND EXISTS (SELECT 1 FROM identity.gugu_devices d
                        WHERE d.device_id = i.device_id AND d.user_id::text = p_owner)))
            OR EXISTS (SELECT 1 FROM identity.connection_operations c WHERE c.owner_user_id = p_owner
                AND NOT (c.scope_key = 'platform' AND c.device_id IS NULL
                    OR c.scope_key = 'device:' || c.device_id AND EXISTS (SELECT 1 FROM identity.gugu_devices d
                        WHERE d.device_id = c.device_id AND d.user_id::text = p_owner))) THEN
            RAISE EXCEPTION 'Connection candidate has rows outside an owned scope' USING ERRCODE = '55000';
        END IF;
        -- The staged rows are exactly the rows the import rule selects, tombstones
        -- and their assistant included, compared in both directions.
        IF EXISTS (
            (SELECT e->>'resource_key',e->>'assistant_user_id',e->>'device_id',(e->>'revision')::bigint,e->'data',
                    (e->>'body_item_id')::uuid,e->>'body_sha256',(e->>'deleted_at')::timestamptz,(e->>'stale_at')::timestamptz,
                    (e->>'observed_at')::timestamptz,(e->>'updated_at')::timestamptz
               FROM jsonb_array_elements(source->'items') e
             EXCEPT ALL
             SELECT legacy_resource_key,legacy_assistant_user_id,device_id,revision,data,legacy_body_item_id,body_sha256,
                    deleted_at,stale_at,observed_at,updated_at
               FROM identity.connection_items WHERE owner_user_id = p_owner)
            UNION ALL
            (SELECT legacy_resource_key,legacy_assistant_user_id,device_id,revision,data,legacy_body_item_id,body_sha256,
                    deleted_at,stale_at,observed_at,updated_at
               FROM identity.connection_items WHERE owner_user_id = p_owner
             EXCEPT ALL
             SELECT e->>'resource_key',e->>'assistant_user_id',e->>'device_id',(e->>'revision')::bigint,e->'data',
                    (e->>'body_item_id')::uuid,e->>'body_sha256',(e->>'deleted_at')::timestamptz,(e->>'stale_at')::timestamptz,
                    (e->>'observed_at')::timestamptz,(e->>'updated_at')::timestamptz
               FROM jsonb_array_elements(source->'items') e)
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
    INSERT INTO identity.connection_authority_switches(owner_user_id,authority_epoch,path,source_digest,manifest_hash,operator_id)
        VALUES(p_owner,head.authority_epoch,CASE WHEN imported THEN 'import' ELSE 'native' END,p_expected_digest,p_manifest_hash,p_operator);
    -- The owner RPCs' existing best-effort hint; online clients re-read.
    PERFORM chat.send_user_event(jsonb_build_object('revision',head.revision::text,'scopeKey',NULL,'resourceKey',NULL,
        'authorityEpoch',head.authority_epoch::text),'connection_changed','gugu:user:' || p_owner || ':events',true);
    RETURN jsonb_build_object('version',1,'mode',head.authority_mode,'epoch',head.authority_epoch::text,
        'phase',head.authority_phase,'acceptingNewOperations',head.authority_phase = 'stable');
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_authority_cutover(text,bigint,text,text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Maintenance listing: operations whose outcome is currently unknown, with the
-- repair entry point for each (native vs. imported legacy). p_owner NULL: all.
CREATE FUNCTION identity.connection_unknown_outcomes(p_owner text DEFAULT NULL)
RETURNS TABLE(owner_user_id text,operation_id uuid,admission_id uuid,source text,scope_key text,resource_key text,
    operation text,admitted_at timestamptz,reported_at timestamptz,repair text)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
    SELECT c.owner_user_id,c.operation_id,a.admission_id,c.source,c.scope_key,c.resource_key,c.operation,
        a.started_at,COALESCE(a.completed_at,c.terminal_at),
        CASE WHEN c.source = 'legacy' THEN 'connection_record_takeover' ELSE 'connection_resolve_unknown_outcome' END
      FROM identity.connection_operations c
      LEFT JOIN identity.connection_admissions a ON a.admission_id = c.last_admission_id AND a.operation_id = c.operation_id
     WHERE c.status = 'failed' AND c.error_code = 'CONNECTION_OUTCOME_UNKNOWN'
       AND (p_owner IS NULL OR c.owner_user_id = p_owner)
     ORDER BY c.owner_user_id,a.started_at NULLS FIRST,c.operation_id
$$;
REVOKE ALL ON FUNCTION identity.connection_unknown_outcomes(text) FROM PUBLIC,anon,authenticated,service_role;
