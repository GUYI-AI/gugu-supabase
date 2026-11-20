-- An empty label means "the client has no name for this machine": the existing
-- BEFORE INSERT trigger gugu_devices_default_label names it (Linux 1, Mac 2, ...),
-- and on an existing row gugu_devices_preserve_custom_label keeps the stored one.
-- That was the table contract before atomic registration; the RPC must not refuse
-- it. label stays a required string key; every other check is unchanged.
DO $registration$
DECLARE definition text; before text; acl aclitem[];
BEGIN
    SELECT proacl INTO acl FROM pg_proc WHERE oid='identity.register_gugu_device(jsonb)'::regprocedure;
    SELECT pg_get_functiondef('identity.register_gugu_device(jsonb)'::regprocedure) INTO definition;
    before:=$before$    FOREACH k IN ARRAY ARRAY['device_id','machine_id','tier','label','hostname','platform'] LOOP$before$;
    IF length(definition)-length(replace(definition,before,''))<>length(before) THEN
        RAISE EXCEPTION 'Unexpected atomic registration predecessor';
    END IF;
    EXECUTE replace(definition,before,$replace$    IF jsonb_typeof(p_device->'label') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'DEVICE_REGISTRATION_INVALID' USING ERRCODE='22023';
    END IF;
    FOREACH k IN ARRAY ARRAY['device_id','machine_id','tier','hostname','platform'] LOOP$replace$);
    ALTER FUNCTION identity.register_gugu_device(jsonb) OWNER TO postgres;
    REVOKE ALL ON FUNCTION identity.register_gugu_device(jsonb) FROM PUBLIC,anon,authenticated,service_role;
    GRANT EXECUTE ON FUNCTION identity.register_gugu_device(jsonb) TO authenticated;
    IF (SELECT proacl FROM pg_proc WHERE oid='identity.register_gugu_device(jsonb)'::regprocedure) IS DISTINCT FROM acl THEN
        RAISE EXCEPTION 'Atomic registration grants changed';
    END IF;
END $registration$;
NOTIFY pgrst,'reload schema';
