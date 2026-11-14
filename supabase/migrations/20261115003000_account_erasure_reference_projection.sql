-- Internal, immutable reference projection. It indexes identity references only,
-- never the command body, result, or unrelated payload values.
CREATE SCHEMA account_erasure_private;
REVOKE ALL ON SCHEMA account_erasure_private FROM PUBLIC;
CREATE FUNCTION account_erasure_private.command_reference_user_ids(p_payload jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path='' AS $$
    SELECT array_remove(ARRAY[
        p_payload->>'agent_user_id',p_payload->>'sender_user_id',p_payload->>'reply_to_sender_user_id'
    ] || ARRAY(SELECT value FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(p_payload->'to_user_ids')='array'
            THEN p_payload->'to_user_ids' ELSE '[]'::jsonb END) AS recipient(value)),NULL);
$$;
REVOKE ALL ON FUNCTION account_erasure_private.command_reference_user_ids(jsonb)
    FROM PUBLIC,anon,authenticated,service_role;
-- Table writers must be able to evaluate the index expression. This private
-- schema is not an API schema; the function reads no table and takes caller data.
GRANT USAGE ON SCHEMA account_erasure_private TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION account_erasure_private.command_reference_user_ids(jsonb)
    TO authenticated,service_role;
