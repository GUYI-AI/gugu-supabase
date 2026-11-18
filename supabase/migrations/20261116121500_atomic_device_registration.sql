-- The private read classifies an occupied candidate without exposing another
-- owner's row. All device DML below still executes as the authenticated caller.
CREATE SCHEMA device_private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA device_private FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA device_private TO authenticated;
CREATE FUNCTION device_private.registration_scope(p_id text,p_machine text,p_tier text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=auth.uid();
BEGIN
    IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users a JOIN identity.users u ON u.id=a.id::text
        WHERE a.id=actor AND a.deleted_at IS NULL AND (a.banned_until IS NULL OR a.banned_until<=now())
          AND u.type='human' AND u.removed_at IS NULL) THEN
        RETURN 'DEVICE_REGISTRATION_FORBIDDEN';
    END IF;
    IF EXISTS(SELECT 1 FROM identity.gugu_devices d WHERE d.device_id=p_id
        AND (d.user_id IS DISTINCT FROM actor OR d.machine_id IS DISTINCT FROM p_machine
            OR d.tier IS DISTINCT FROM p_tier)) THEN
        RETURN 'DEVICE_REGISTRATION_SCOPE_CONFLICT';
    END IF;
    RETURN NULL;
END $$;
ALTER FUNCTION device_private.registration_scope(text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION device_private.registration_scope(text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION device_private.registration_scope(text,text,text) TO authenticated;

CREATE FUNCTION identity.register_gugu_device(p_device jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=auth.uid(); canonical text; k text; refusal text;
    reserve boolean; phone boolean; caps jsonb; current_device identity.gugu_devices%ROWTYPE;
BEGIN
    IF actor IS NULL THEN
        RAISE EXCEPTION 'DEVICE_REGISTRATION_FORBIDDEN' USING ERRCODE='42501';
    END IF;
    IF jsonb_typeof(p_device) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'DEVICE_REGISTRATION_INVALID' USING ERRCODE='22023';
    END IF;
    IF p_device ? 'user_id' THEN
        RAISE EXCEPTION 'DEVICE_REGISTRATION_FORBIDDEN' USING ERRCODE='42501';
    END IF;
    FOR k IN SELECT jsonb_object_keys(p_device) LOOP
        IF k<>ALL(ARRAY['device_id','machine_id','tier','label','hostname','platform',
            'capabilities','session_digest','reserve_only']) THEN
            RAISE EXCEPTION 'DEVICE_REGISTRATION_INVALID' USING ERRCODE='22023';
        END IF;
    END LOOP;
    FOREACH k IN ARRAY ARRAY['device_id','machine_id','tier','label','hostname','platform'] LOOP
        IF jsonb_typeof(p_device->k) IS DISTINCT FROM 'string' OR btrim(p_device->>k)='' THEN
            RAISE EXCEPTION 'DEVICE_REGISTRATION_INVALID' USING ERRCODE='22023';
        END IF;
    END LOOP;
    IF (p_device ? 'reserve_only' AND jsonb_typeof(p_device->'reserve_only') IS DISTINCT FROM 'boolean')
       OR jsonb_typeof(p_device->'capabilities') IS DISTINCT FROM 'object'
       OR (p_device ? 'session_digest' AND jsonb_typeof(p_device->'session_digest') IS DISTINCT FROM 'array') THEN
        RAISE EXCEPTION 'DEVICE_REGISTRATION_INVALID' USING ERRCODE='22023';
    END IF;
    reserve:=COALESCE((p_device->>'reserve_only')::boolean,false);
    caps:=p_device->'capabilities';
    IF reserve THEN
        IF jsonb_typeof(caps->'host_kind') IS DISTINCT FROM 'string'
           OR caps->>'host_kind' NOT IN ('desktop','server','phone')
           OR EXISTS(SELECT 1 FROM jsonb_object_keys(caps) key WHERE key<>ALL(ARRAY['host_kind','terminals','runtimes']))
           OR (caps ? 'terminals' AND caps->'terminals'<>'[]'::jsonb)
           OR (caps ? 'runtimes' AND caps->'runtimes'<>'[]'::jsonb)
           OR (p_device ? 'session_digest' AND p_device->'session_digest'<>'[]'::jsonb) THEN
            RAISE EXCEPTION 'DEVICE_REGISTRATION_INVALID' USING ERRCODE='22023';
        END IF;
        caps:=jsonb_build_object('host_kind',caps->>'host_kind','terminals','[]'::jsonb,'runtimes','[]'::jsonb);
    END IF;
    refusal:=device_private.registration_scope(p_device->>'device_id',p_device->>'machine_id',p_device->>'tier');
    IF refusal='DEVICE_REGISTRATION_FORBIDDEN' THEN RAISE EXCEPTION '%',refusal USING ERRCODE='42501'; END IF;
    phone:=caps->>'host_kind'='phone' OR p_device->>'platform' IN ('android','ios')
        OR left(p_device->>'device_id',6)='phone-';
    IF phone AND p_device->>'device_id'<>('phone-'||(p_device->>'machine_id')||'-'||actor::text) THEN
        RAISE EXCEPTION 'PHONE_DEVICE_ID_CONFLICT' USING ERRCODE='P0001';
    END IF;
    IF refusal IS NOT NULL THEN RAISE EXCEPTION '%',refusal USING ERRCODE='P0001'; END IF;
    LOOP
        -- A reservation of an existing row performs no UPDATE at all: even its
        -- lease, label, capabilities and revision stream remain untouched.
        SELECT * INTO current_device FROM identity.gugu_devices d WHERE d.user_id=actor
            AND d.machine_id=p_device->>'machine_id' AND d.tier=p_device->>'tier' FOR UPDATE;
        IF FOUND THEN
            IF (phone OR current_device.capabilities->>'host_kind'='phone'
                OR current_device.platform IN ('android','ios'))
                AND current_device.device_id<>p_device->>'device_id' THEN
                RAISE EXCEPTION 'PHONE_DEVICE_ID_CONFLICT' USING ERRCODE='P0001';
            END IF;
            IF NOT reserve THEN
                UPDATE identity.gugu_devices d SET hostname=p_device->>'hostname',platform=p_device->>'platform',
                    label=p_device->>'label',status='online',last_seen_at=clock_timestamp(),updated_at=clock_timestamp(),
                    capabilities=caps,session_digest=CASE WHEN p_device ? 'session_digest'
                        THEN p_device->'session_digest' ELSE d.session_digest END
                    WHERE d.device_id=current_device.device_id AND d.user_id=actor;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'DEVICE_REGISTRATION_FORBIDDEN' USING ERRCODE='42501';
                END IF;
            END IF;
            RETURN jsonb_build_object('device_id',current_device.device_id,'created',false);
        END IF;
        INSERT INTO identity.gugu_devices
            (device_id,user_id,machine_id,tier,label,hostname,platform,status,last_seen_at,updated_at,capabilities,session_digest)
        VALUES(p_device->>'device_id',actor,p_device->>'machine_id',p_device->>'tier',p_device->>'label',
            p_device->>'hostname',p_device->>'platform',CASE WHEN reserve THEN 'offline' ELSE 'online' END,
            clock_timestamp(),clock_timestamp(),caps,COALESCE(p_device->'session_digest','[]'::jsonb))
        ON CONFLICT DO NOTHING RETURNING device_id INTO canonical;
        IF FOUND THEN RETURN jsonb_build_object('device_id',canonical,'created',true); END IF;
        -- A concurrent winner may have committed after this statement's snapshot.
        -- Re-read, rather than returning an empty success or swallowing 23505.
        refusal:=device_private.registration_scope(p_device->>'device_id',p_device->>'machine_id',p_device->>'tier');
        IF refusal='DEVICE_REGISTRATION_FORBIDDEN' THEN RAISE EXCEPTION '%',refusal USING ERRCODE='42501'; END IF;
        IF refusal IS NOT NULL THEN RAISE EXCEPTION '%',refusal USING ERRCODE='P0001'; END IF;
    END LOOP;
END $$;
ALTER FUNCTION identity.register_gugu_device(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.register_gugu_device(jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION identity.register_gugu_device(jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';
