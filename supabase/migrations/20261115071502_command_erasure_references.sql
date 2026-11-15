-- Pure projection of the existing command-erasure JSON predicates. In
-- particular, legacy non-string recipients keep jsonb_array_elements_text's
-- exact conversion semantics; a broad JSON containment index is not required.
CREATE FUNCTION identity.command_erasure_references_v1(p_type text,p_payload jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
    SELECT array_remove(ARRAY[
        p_payload->>'agent_user_id',
        CASE WHEN p_type IN ('agent.deliver','agent.wake') THEN p_payload->>'sender_user_id' END,
        p_payload->>'reply_to_sender_user_id'
    ] || ARRAY(
        SELECT recipient.value
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_payload->'to_user_ids')='array'
            THEN p_payload->'to_user_ids' ELSE '[]'::jsonb END) recipient(value)
    ),NULL::text)
$$;
REVOKE ALL ON FUNCTION identity.command_erasure_references_v1(text,jsonb) FROM PUBLIC,anon;
-- This function only projects the value supplied by its caller. It reads no
-- tables and confers no new authority. Writers need EXECUTE for index evaluation.
GRANT EXECUTE ON FUNCTION identity.command_erasure_references_v1(text,jsonb) TO authenticated,service_role;
-- Index expressions also run for service/trigger writers, not just API users.
-- This pure function exposes only its input. Keep every existing table writer
-- compatible, and enforce the same invariant for future roles in schema tests.
DO $writers$
DECLARE writer record;
BEGIN
    FOR writer IN SELECT rolname FROM pg_roles
        WHERE has_table_privilege(rolname,'identity.gugu_device_commands','INSERT')
           OR has_table_privilege(rolname,'identity.gugu_device_commands','UPDATE')
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION identity.command_erasure_references_v1(text,jsonb) TO %I',writer.rolname);
    END LOOP;
END $writers$;
