-- One latest delivery per agent in the caller's conversation scope. The caller's
-- display roster stays local, rather than expanding a PostgREST GET query string.
CREATE FUNCTION identity.read_agent_turn_outcomes(
    p_chat_id text,
    p_thread_root_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, identity
AS $$
DECLARE
    v_owner uuid := auth.uid();
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
    END IF;

    -- A scalar JSON array avoids PostgREST's row cap on set-returning functions.
    RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', latest.id, 'status', latest.status, 'error', latest.error,
        'result', jsonb_build_object('reply_notice', latest.reply_notice),
        'payload', jsonb_build_object('agent_user_id', latest.agent_user_id),
        'created_at', latest.created_at, 'completed_at', latest.completed_at
    ) ORDER BY latest.created_at DESC, latest.id DESC), '[]'::jsonb)
    FROM (
        SELECT DISTINCT ON (c.payload->>'agent_user_id')
               c.id, c.status, c.error, c.result->'reply_notice' AS reply_notice,
               c.payload->>'agent_user_id' AS agent_user_id, c.created_at, c.completed_at
        FROM identity.gugu_device_commands c
        WHERE c.user_id = v_owner
          AND c.type = 'agent.deliver'
          AND c.payload->>'chat_id' = p_chat_id
          AND c.payload->>'thread_root_id' IS NOT DISTINCT FROM p_thread_root_id
          AND jsonb_typeof(c.payload->'agent_user_id') = 'string'
        ORDER BY c.payload->>'agent_user_id', c.created_at DESC, c.id DESC
    ) latest
    );
END;
$$;

REVOKE ALL ON FUNCTION identity.read_agent_turn_outcomes(text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION identity.read_agent_turn_outcomes(text, text) TO authenticated;

COMMENT ON FUNCTION identity.read_agent_turn_outcomes(text, text) IS
'Latest delivery per agent for auth.uid(), chat and exact thread scope; caller applies its display roster. Existing table reads remain available to older clients.';
