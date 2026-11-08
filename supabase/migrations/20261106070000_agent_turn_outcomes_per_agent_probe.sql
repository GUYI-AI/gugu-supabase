-- Read the latest delivery per agent with one index probe per agent instead of reading and sorting every
-- delivery the owner ever made. Cost now follows the number of agents, not the number of messages.
-- Signature and output are unchanged. The conversation-scope index is built CONCURRENTLY by
-- 20261106065900_agent_turn_outcomes_chat_index.sql just before this release.
CREATE OR REPLACE FUNCTION identity.read_agent_turn_outcomes(
    p_chat_id text DEFAULT NULL,
    p_thread_root_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, identity
-- A cached generic plan cannot see which conversation is asked for and walks the per-agent index with a
-- chat filter (cost back to the owner's whole history); plan each call with its real values instead.
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
    v_owner uuid := auth.uid();
    v_thread text := coalesce(p_thread_root_id, '');
    v_rows jsonb;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
    END IF;

    -- @@@loose-scan - PostgreSQL has no skip scan for DISTINCT ON. Each step takes the first index entry
    -- after the previous agent: in (agent, created_at DESC, id DESC) order that entry is the next agent's
    -- newest delivery. Two branches so each scope's predicates match its own index exactly.
    IF p_chat_id IS NULL THEN
        WITH RECURSIVE latest AS (
            (SELECT c.payload->>'agent_user_id' AS agent_user_id, c.id, c.status, c.error, c.result, c.created_at, c.completed_at
               FROM gugu_device_commands c
              WHERE c.user_id = v_owner AND c.type = 'agent.deliver' AND jsonb_typeof(c.payload->'agent_user_id') = 'string'
              ORDER BY c.payload->>'agent_user_id', c.created_at DESC, c.id DESC LIMIT 1)
            UNION ALL
            SELECT n.* FROM latest l CROSS JOIN LATERAL (
                SELECT c.payload->>'agent_user_id', c.id, c.status, c.error, c.result, c.created_at, c.completed_at
                  FROM gugu_device_commands c
                 WHERE c.user_id = v_owner AND c.type = 'agent.deliver' AND jsonb_typeof(c.payload->'agent_user_id') = 'string'
                   AND c.payload->>'agent_user_id' > l.agent_user_id
                 ORDER BY c.payload->>'agent_user_id', c.created_at DESC, c.id DESC LIMIT 1) n
        )
        SELECT jsonb_agg(jsonb_build_object(
            'id', id, 'status', status, 'error', error,
            'result', jsonb_build_object('reply_notice', result->'reply_notice', 'reason', result->'reason'),
            'payload', jsonb_build_object('agent_user_id', agent_user_id),
            'created_at', created_at, 'completed_at', completed_at
        ) ORDER BY created_at DESC, id DESC) INTO v_rows FROM latest;
    ELSE
        WITH RECURSIVE latest AS (
            (SELECT c.payload->>'agent_user_id' AS agent_user_id, c.id, c.status, c.error, c.result, c.created_at, c.completed_at
               FROM gugu_device_commands c
              WHERE c.user_id = v_owner AND c.type = 'agent.deliver' AND jsonb_typeof(c.payload->'agent_user_id') = 'string'
                AND c.payload->>'chat_id' = p_chat_id AND coalesce(c.payload->>'thread_root_id', '') = v_thread
              ORDER BY c.payload->>'agent_user_id', c.created_at DESC, c.id DESC LIMIT 1)
            UNION ALL
            SELECT n.* FROM latest l CROSS JOIN LATERAL (
                SELECT c.payload->>'agent_user_id', c.id, c.status, c.error, c.result, c.created_at, c.completed_at
                  FROM gugu_device_commands c
                 WHERE c.user_id = v_owner AND c.type = 'agent.deliver' AND jsonb_typeof(c.payload->'agent_user_id') = 'string'
                   AND c.payload->>'chat_id' = p_chat_id AND coalesce(c.payload->>'thread_root_id', '') = v_thread
                   AND c.payload->>'agent_user_id' > l.agent_user_id
                 ORDER BY c.payload->>'agent_user_id', c.created_at DESC, c.id DESC LIMIT 1) n
        )
        SELECT jsonb_agg(jsonb_build_object(
            'id', id, 'status', status, 'error', error,
            'result', jsonb_build_object('reply_notice', result->'reply_notice', 'reason', result->'reason'),
            'payload', jsonb_build_object('agent_user_id', agent_user_id),
            'created_at', created_at, 'completed_at', completed_at
        ) ORDER BY created_at DESC, id DESC) INTO v_rows FROM latest;
    END IF;

    -- A scalar JSON array avoids PostgREST's row cap on set-returning functions.
    RETURN coalesce(v_rows, '[]'::jsonb);
END;
$$;

-- The foundation's gg_revoke_public_execute_on_functions trigger revokes EXECUTE on every CREATE [OR REPLACE]
-- FUNCTION here, so a replaced function has to state its grants again.
REVOKE ALL ON FUNCTION identity.read_agent_turn_outcomes(text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION identity.read_agent_turn_outcomes(text, text) TO authenticated;

COMMENT ON FUNCTION identity.read_agent_turn_outcomes(text, text) IS
'Latest delivery per agent for auth.uid(), chat and exact thread scope; caller applies its display roster. Existing table reads remain available to older clients. A NULL chat includes all chats and threads. Reason is classified by the host when recording the command. One index probe per agent: cost follows agents, not messages.';
