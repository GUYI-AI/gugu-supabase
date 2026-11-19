-- Depends on the operation core in 20261116233000. No API role can enable or
-- invoke this layer directly. The common operation RPC owns authorization.
DO $dependency$
BEGIN
    IF to_regclass('account_deletion_private.operations') IS NULL THEN
        RAISE EXCEPTION 'Account closure operation core must be installed first';
    END IF;
END $dependency$;

CREATE TABLE account_deletion_private.device_preparation_access (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    enabled boolean NOT NULL DEFAULT false
);
INSERT INTO account_deletion_private.device_preparation_access DEFAULT VALUES;
CREATE TABLE account_deletion_private.device_preparations (
    operation_id uuid PRIMARY KEY REFERENCES account_deletion_private.operations(id) ON DELETE CASCADE,
    device_id text REFERENCES identity.gugu_devices(device_id) ON DELETE SET NULL,
    native_generation uuid NOT NULL,
    server_generation uuid NOT NULL DEFAULT gen_random_uuid(),
    state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','released')),
    prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    released_at timestamptz,
    CHECK ((state='prepared' AND released_at IS NULL) OR (state='released' AND released_at IS NOT NULL))
);
CREATE UNIQUE INDEX closure_device_one_preparation ON account_deletion_private.device_preparations(device_id)
    WHERE state='prepared' AND device_id IS NOT NULL;
ALTER TABLE account_deletion_private.device_preparation_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_private.device_preparations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON account_deletion_private.device_preparation_access,account_deletion_private.device_preparations
    FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION account_deletion_private.device_preparation_is_sealed(p_device text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
    SELECT EXISTS(SELECT 1 FROM account_deletion_private.device_preparations
        WHERE device_id=p_device AND state='prepared')
$$;

-- Called only by the postgres-owned common RPC after its account/operation
-- locks. Re-taking the parent row lock also makes direct owner invocation safe.
CREATE FUNCTION account_deletion_private.device_preparation_prepare(
    p_operation_id uuid,p_device_id text,p_native_generation uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE op account_deletion_private.operations%ROWTYPE;
    prepared account_deletion_private.device_preparations%ROWTYPE;
    device identity.gugu_devices%ROWTYPE;
BEGIN
    SELECT * INTO op FROM account_deletion_private.operations WHERE id=p_operation_id FOR UPDATE;
    IF op.id IS NULL OR op.state<>'open' OR op.confirm_started_at IS NOT NULL
       OR p_native_generation IS NULL OR NULLIF(p_device_id,'') IS NULL THEN
        RAISE EXCEPTION 'CLOSURE_PREPARATION_SCOPE_CONFLICT' USING ERRCODE='42501';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM auth.users u JOIN auth.sessions s ON s.user_id=u.id
        WHERE u.id=op.user_id AND s.id=op.session_id AND u.deleted_at IS NULL
          AND u.email_confirmed_at IS NOT NULL AND encode(sha256(convert_to(lower(u.email),'UTF8')),'hex')=op.email_digest
          AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
          AND (s.not_after IS NULL OR s.not_after>clock_timestamp())) THEN
        RAISE EXCEPTION 'CLOSURE_PREPARATION_AUTH_REQUIRED' USING ERRCODE='42501';
    END IF;
    IF NOT COALESCE((SELECT enabled FROM account_deletion_private.device_preparation_access WHERE singleton),false) THEN
        RAISE EXCEPTION 'CLOSURE_PREPARATION_UNAVAILABLE' USING ERRCODE='42501';
    END IF;
    SELECT * INTO prepared FROM account_deletion_private.device_preparations
        WHERE operation_id=op.id FOR UPDATE;
    IF FOUND THEN
        IF prepared.device_id IS DISTINCT FROM p_device_id OR prepared.native_generation IS DISTINCT FROM p_native_generation
           OR prepared.state<>'prepared' THEN
            RAISE EXCEPTION 'CLOSURE_PREPARATION_SCOPE_CONFLICT' USING ERRCODE='42501';
        END IF;
        RETURN jsonb_build_object('prepared',true,'native_generation',prepared.native_generation,'server_generation',prepared.server_generation);
    END IF;
    SELECT * INTO device FROM identity.gugu_devices WHERE device_id=p_device_id FOR UPDATE;
    IF device.device_id IS NULL OR device.user_id IS DISTINCT FROM op.user_id
       OR device.auth_session_id IS DISTINCT FROM op.session_id
       OR COALESCE(device.capabilities->>'host_kind','') NOT IN ('phone','desktop','server') THEN
        RAISE EXCEPTION 'CLOSURE_PREPARATION_SCOPE_CONFLICT' USING ERRCODE='42501';
    END IF;
    IF account_deletion_private.device_preparation_is_sealed(device.device_id) THEN
        RAISE EXCEPTION 'CLOSURE_PREPARATION_SCOPE_CONFLICT' USING ERRCODE='42501';
    END IF;
    IF EXISTS(SELECT 1 FROM identity.runtime_instances WHERE device_id=device.device_id AND owner_user_id IS DISTINCT FROM op.user_id) THEN
        RAISE EXCEPTION 'CLOSURE_PREPARATION_SCOPE_CONFLICT' USING ERRCODE='42501';
    END IF;
    -- A real UPDATE, even if already offline, is the MVCC fence against old
    -- device writers. Do not delete the device or any owned Agent/content.
    UPDATE identity.gugu_devices SET status='offline',updated_at=clock_timestamp(),session_digest='[]'::jsonb,
        capabilities=jsonb_build_object('host_kind',device.capabilities->>'host_kind','terminals','[]'::jsonb,'runtimes','[]'::jsonb)
        WHERE device_id=device.device_id;
    -- These are ephemeral liveness entries, not Agent/task/content records.
    -- The runtime trigger below never waits for a device lock while holding
    -- its instance row, so this order cannot form the reverse wait cycle.
    DELETE FROM identity.runtime_instances WHERE device_id=device.device_id AND owner_user_id=op.user_id;
    INSERT INTO account_deletion_private.device_preparations(operation_id,device_id,native_generation)
        VALUES(op.id,device.device_id,p_native_generation) RETURNING * INTO prepared;
    RETURN jsonb_build_object('prepared',true,'native_generation',prepared.native_generation,'server_generation',prepared.server_generation);
END $$;

CREATE FUNCTION account_deletion_private.device_preparation_read(
    p_operation_id uuid,p_native_generation uuid,p_server_generation uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE op account_deletion_private.operations%ROWTYPE;
    prepared account_deletion_private.device_preparations%ROWTYPE;
BEGIN
    SELECT * INTO op FROM account_deletion_private.operations WHERE id=p_operation_id FOR UPDATE;
    IF NOT COALESCE((SELECT enabled FROM account_deletion_private.device_preparation_access WHERE singleton),false) THEN
        RAISE EXCEPTION 'CLOSURE_PREPARATION_UNAVAILABLE' USING ERRCODE='42501';
    END IF;
    SELECT * INTO prepared FROM account_deletion_private.device_preparations WHERE operation_id=p_operation_id FOR UPDATE;
    IF op.id IS NULL OR prepared.operation_id IS NULL OR prepared.state<>'prepared'
       OR prepared.native_generation IS DISTINCT FROM p_native_generation
       OR prepared.server_generation IS DISTINCT FROM p_server_generation OR prepared.device_id IS NULL
       OR op.state NOT IN ('open','confirming','processing')
       OR NOT EXISTS(SELECT 1 FROM auth.users u JOIN auth.sessions s ON s.user_id=u.id
            WHERE u.id=op.user_id AND s.id=op.session_id AND u.deleted_at IS NULL
              AND u.email_confirmed_at IS NOT NULL AND encode(sha256(convert_to(lower(u.email),'UTF8')),'hex')=op.email_digest
          AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())
              AND (s.not_after IS NULL OR s.not_after>clock_timestamp())) THEN
        RAISE EXCEPTION 'CLOSURE_PREPARATION_SCOPE_CONFLICT' USING ERRCODE='42501';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM identity.gugu_devices d WHERE d.device_id=prepared.device_id
        AND d.user_id=op.user_id AND d.auth_session_id=op.session_id AND d.status='offline'
        AND COALESCE(d.capabilities->'terminals','[]'::jsonb)='[]'::jsonb
        AND COALESCE(d.capabilities->'runtimes','[]'::jsonb)='[]'::jsonb
        AND NOT(d.capabilities ? 'actions') AND d.session_digest='[]'::jsonb) THEN
        RAISE EXCEPTION 'CLOSURE_PREPARATION_SCOPE_CONFLICT' USING ERRCODE='42501';
    END IF;
    RETURN jsonb_build_object('prepared',true,'native_generation',prepared.native_generation,'server_generation',prepared.server_generation);
END $$;

CREATE FUNCTION account_deletion_private.device_preparation_cancel(
    p_operation_id uuid,p_native_generation uuid,p_server_generation uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE op account_deletion_private.operations%ROWTYPE;
    prepared account_deletion_private.device_preparations%ROWTYPE;
BEGIN
    SELECT * INTO op FROM account_deletion_private.operations WHERE id=p_operation_id FOR UPDATE;
    IF op.id IS NULL OR op.state<>'closed_before_confirm' OR op.confirm_started_at IS NOT NULL OR op.user_id IS NULL THEN
        RAISE EXCEPTION 'CLOSURE_PREPARATION_CANNOT_CANCEL' USING ERRCODE='42501';
    END IF;
    SELECT * INTO prepared FROM account_deletion_private.device_preparations WHERE operation_id=op.id FOR UPDATE;
    IF prepared.operation_id IS NULL OR prepared.native_generation IS DISTINCT FROM p_native_generation
       OR prepared.server_generation IS DISTINCT FROM p_server_generation THEN
        RAISE EXCEPTION 'CLOSURE_PREPARATION_SCOPE_CONFLICT' USING ERRCODE='42501';
    END IF;
    IF prepared.state='prepared' THEN
        UPDATE account_deletion_private.device_preparations SET state='released',released_at=clock_timestamp() WHERE operation_id=op.id;
    END IF;
    -- No online write, capabilities restore, Auth logout or native restart.
    RETURN jsonb_build_object('cancelled',true,'native_generation',prepared.native_generation,'server_generation',prepared.server_generation);
END $$;

CREATE FUNCTION account_deletion_private.device_preparation_device_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        -- Auth deletion has already removed this parent in the current
        -- transaction. Normal remove_device/cascade still sees the Auth row.
        IF EXISTS(SELECT 1 FROM auth.users WHERE id=OLD.user_id)
           AND account_deletion_private.device_preparation_is_sealed(OLD.device_id) THEN
            RAISE EXCEPTION 'DEVICE_CLOSURE_PREPARING' USING ERRCODE='42501';
        END IF;
        RETURN OLD;
    END IF;
    IF account_deletion_private.device_preparation_is_sealed(NEW.device_id)
       OR (TG_OP='UPDATE' AND account_deletion_private.device_preparation_is_sealed(OLD.device_id)) THEN
        RAISE EXCEPTION 'DEVICE_CLOSURE_PREPARING' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER aa_closure_device_preparation BEFORE INSERT OR UPDATE OR DELETE ON identity.gugu_devices
    FOR EACH ROW EXECUTE FUNCTION account_deletion_private.device_preparation_device_guard();

CREATE FUNCTION account_deletion_private.device_preparation_runtime_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE device text;
BEGIN
    -- Fail rather than waiting in the instance-row -> device order. This also
    -- serializes old RR writers with the preparation's real device UPDATE.
    FOR device IN SELECT DISTINCT value FROM unnest(CASE WHEN TG_OP='UPDATE'
        THEN ARRAY[OLD.device_id,NEW.device_id] ELSE ARRAY[NEW.device_id] END) AS ids(value) ORDER BY value LOOP
        PERFORM 1 FROM identity.gugu_devices WHERE device_id=device FOR SHARE NOWAIT;
        IF account_deletion_private.device_preparation_is_sealed(device) THEN
            RAISE EXCEPTION 'DEVICE_CLOSURE_PREPARING' USING ERRCODE='42501';
        END IF;
    END LOOP;
    RETURN NEW;
END $$;
CREATE TRIGGER aa_closure_runtime_preparation BEFORE INSERT OR UPDATE ON identity.runtime_instances
    FOR EACH ROW EXECUTE FUNCTION account_deletion_private.device_preparation_runtime_guard();

-- Registration is INVOKER. Reuse its already-authorized, private definer scope
-- classifier instead of granting ordinary roles any new preparation helper.
DO $registration$
DECLARE definition text; before text;
BEGIN
    SELECT pg_get_functiondef('device_private.registration_scope(text,text,text)'::regprocedure) INTO definition;
    before:='    RETURN NULL;';
    IF length(definition)-length(replace(definition,before,''))<>length(before) THEN RAISE EXCEPTION 'Unexpected registration scope predecessor'; END IF;
    EXECUTE replace(definition,before,$replace$
    IF EXISTS(SELECT 1 FROM identity.gugu_devices d WHERE d.user_id=actor
        AND (d.device_id=p_id OR (d.machine_id=p_machine AND d.tier=p_tier))
        AND account_deletion_private.device_preparation_is_sealed(d.device_id)) THEN
        RETURN 'DEVICE_CLOSURE_PREPARING';
    END IF;
    RETURN NULL;$replace$);
    SELECT pg_get_functiondef('identity.register_gugu_device(jsonb)'::regprocedure) INTO definition;
    before:=E'        IF FOUND THEN\n            IF (phone OR';
    IF length(definition)-length(replace(definition,before,''))<>length(before) THEN RAISE EXCEPTION 'Unexpected atomic registration predecessor'; END IF;
    EXECUTE replace(definition,before,$replace$        IF FOUND THEN
            refusal:=device_private.registration_scope(current_device.device_id,current_device.machine_id,current_device.tier);
            IF refusal IS NOT NULL THEN RAISE EXCEPTION '%',refusal USING ERRCODE='42501'; END IF;
            IF (phone OR$replace$);
END $registration$;
ALTER FUNCTION device_private.registration_scope(text,text,text) OWNER TO postgres;
ALTER FUNCTION identity.register_gugu_device(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION device_private.registration_scope(text,text,text),identity.register_gugu_device(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION device_private.registration_scope(text,text,text),identity.register_gugu_device(jsonb) TO authenticated;

DO $private_acl$
DECLARE f record;
BEGIN
    FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='account_deletion_private' AND p.proname=ANY(ARRAY['device_preparation_is_sealed',
            'device_preparation_prepare','device_preparation_read','device_preparation_cancel',
            'device_preparation_device_guard','device_preparation_runtime_guard']) LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f.signature);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
    END LOOP;
END $private_acl$;
NOTIFY pgrst,'reload schema';
