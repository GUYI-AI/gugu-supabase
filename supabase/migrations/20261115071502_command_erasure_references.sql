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

-- Ordinary index creation is atomic with the helper and erasure replacement.
-- Release review accepted the measured sub-second write-lock interval.
CREATE INDEX gugu_device_commands_erasure_refs_idx ON identity.gugu_device_commands
    USING gin (identity.command_erasure_references_v1(type,payload));

-- Index each original mutation predicate without changing its result or the
-- per-statement snapshot. Payload transformations and lock ordering stay intact.
DO $upgrade$
DECLARE definition text; before_chunk text :=
$old$    -- Global lock order shared with transfer/post paths: chat, command, then identity/device.
    PERFORM 1 FROM identity.gugu_device_commands c
    WHERE c.user_id = p_user_id::uuid
       OR c.payload->>'agent_user_id' = ANY(delete_user_ids)
       OR (c.type IN ('agent.deliver', 'agent.wake')
           AND c.payload->>'sender_user_id' = ANY(delete_user_ids))
       OR c.payload->>'reply_to_sender_user_id' = ANY(delete_user_ids)
       OR (jsonb_typeof(c.payload->'to_user_ids') = 'array' AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(c.payload->'to_user_ids') AS recipient(value)
            WHERE recipient.value = ANY(delete_user_ids)
       ))
    ORDER BY c.id FOR UPDATE;
    DELETE FROM identity.gugu_device_commands c
    WHERE c.user_id = p_user_id::uuid
       OR c.payload->>'agent_user_id' = ANY(delete_user_ids)
       OR (c.type IN ('agent.deliver', 'agent.wake')
           AND c.payload->>'sender_user_id' = ANY(delete_user_ids));
    UPDATE identity.gugu_device_commands c
    SET payload = (c.payload - 'reply_to_sender_user_id')
                  || jsonb_build_object('reply_to_sender_name', '已注销用户')
    WHERE c.payload->>'reply_to_sender_user_id' = ANY(delete_user_ids);
    UPDATE identity.gugu_device_commands c
    SET payload = jsonb_set(c.payload, '{to_user_ids}', COALESCE((
            SELECT jsonb_agg(recipient.value ORDER BY recipient.ordinality)
            FROM jsonb_array_elements_text(c.payload->'to_user_ids')
                 WITH ORDINALITY AS recipient(value, ordinality)
            WHERE recipient.value = '*'
               OR NOT (recipient.value = ANY(delete_user_ids))
        ), '[]'::jsonb), true)
    WHERE jsonb_typeof(c.payload->'to_user_ids') = 'array'
      AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.payload->'to_user_ids') AS recipient(value)
          WHERE recipient.value = ANY(delete_user_ids)
      );

$old$; after_chunk text :=
$new$    -- Keep the established chat -> command -> identity/device lock order.
    -- The indexed JSON projection is equivalent to the old reference clauses;
    -- owner scope remains the human UUID, independently of owned-agent IDs.
    PERFORM 1 FROM identity.gugu_device_commands c
    WHERE c.user_id=p_user_id::uuid
       OR identity.command_erasure_references_v1(c.type,c.payload) && delete_user_ids
    ORDER BY c.id FOR UPDATE;
    DELETE FROM identity.gugu_device_commands c
    WHERE (c.user_id=p_user_id::uuid
           OR identity.command_erasure_references_v1(c.type,c.payload) && delete_user_ids)
      AND (c.user_id = p_user_id::uuid
        OR c.payload->>'agent_user_id' = ANY(delete_user_ids)
        OR (c.type IN ('agent.deliver', 'agent.wake')
            AND c.payload->>'sender_user_id' = ANY(delete_user_ids)));
    UPDATE identity.gugu_device_commands c
    SET payload = (c.payload - 'reply_to_sender_user_id')
                  || jsonb_build_object('reply_to_sender_name', '已注销用户')
    WHERE identity.command_erasure_references_v1(c.type,c.payload) && delete_user_ids
      AND c.payload->>'reply_to_sender_user_id' = ANY(delete_user_ids);
    UPDATE identity.gugu_device_commands c
    SET payload = jsonb_set(c.payload, '{to_user_ids}', COALESCE((
            SELECT jsonb_agg(recipient.value ORDER BY recipient.ordinality)
            FROM jsonb_array_elements_text(c.payload->'to_user_ids')
                 WITH ORDINALITY AS recipient(value, ordinality)
            WHERE recipient.value = '*'
               OR NOT (recipient.value = ANY(delete_user_ids))
        ), '[]'::jsonb), true)
    WHERE identity.command_erasure_references_v1(c.type,c.payload) && delete_user_ids
      AND jsonb_typeof(c.payload->'to_user_ids') = 'array'
      AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.payload->'to_user_ids') AS recipient(value)
          WHERE recipient.value = ANY(delete_user_ids)
      );

$new$;
BEGIN
    SELECT pg_get_functiondef('identity.erase_human_account(text)'::regprocedure) INTO definition;
    IF length(definition)-length(replace(definition,before_chunk,''))<>length(before_chunk) THEN
        RAISE EXCEPTION 'Unexpected account erasure command predecessor';
    END IF;
    EXECUTE replace(definition,before_chunk,after_chunk);
END $upgrade$;
REVOKE ALL ON FUNCTION identity.erase_human_account(text) FROM PUBLIC,anon,authenticated,service_role;
