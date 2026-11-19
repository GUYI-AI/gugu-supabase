-- Restore the 11-02 DISTINCT ON read of read_agent_turn_outcomes.
-- The per-agent loose scan from 20261106070000 took about a minute for an owner with ~39k deliveries and
-- ~240 agents when called as authenticated (row security runs on every recursive step), so clients timed
-- out with "Reply status could not be read". Same signature and output; the two indexes stay.
CREATE OR REPLACE FUNCTION identity.read_agent_turn_outcomes(
    p_chat_id text DEFAULT NULL,
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
        'result', jsonb_build_object('reply_notice', latest.reply_notice, 'reason', latest.reason),
        'payload', jsonb_build_object('agent_user_id', latest.agent_user_id),
        'created_at', latest.created_at, 'completed_at', latest.completed_at
    ) ORDER BY latest.created_at DESC, latest.id DESC), '[]'::jsonb)
    FROM (
        SELECT DISTINCT ON (c.payload->>'agent_user_id')
               c.id, c.status, c.error, c.result->'reply_notice' AS reply_notice,
               c.result->'reason' AS reason,
               c.payload->>'agent_user_id' AS agent_user_id, c.created_at, c.completed_at
        FROM identity.gugu_device_commands c
        WHERE c.user_id = v_owner
          AND c.type = 'agent.deliver'
          AND (p_chat_id IS NULL OR (
              c.payload->>'chat_id' = p_chat_id
              AND c.payload->>'thread_root_id' IS NOT DISTINCT FROM p_thread_root_id
          ))
          AND jsonb_typeof(c.payload->'agent_user_id') = 'string'
        ORDER BY c.payload->>'agent_user_id', c.created_at DESC, c.id DESC
    ) latest
    );
END;
$$;

REVOKE ALL ON FUNCTION identity.read_agent_turn_outcomes(text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION identity.read_agent_turn_outcomes(text, text) TO authenticated;

COMMENT ON FUNCTION identity.read_agent_turn_outcomes(text, text) IS
'Latest delivery per agent for auth.uid(), chat and exact thread scope; caller applies its display roster. Existing table reads remain available to older clients. A NULL chat includes all chats and threads. Reason is classified by the host when recording the command.';
