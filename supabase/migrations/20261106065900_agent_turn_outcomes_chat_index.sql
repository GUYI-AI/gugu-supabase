-- gugu:transaction off
-- Run this single statement outside a transaction, then verify validity before recording it.
-- Conversation-scope twin of idx_gugu_device_commands_agent_latest for read_agent_turn_outcomes: built
-- CONCURRENTLY so agent deliveries keep writing to this table while it builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gugu_device_commands_agent_latest_in_chat ON identity.gugu_device_commands (user_id, (payload->>'chat_id'), (coalesce(payload->>'thread_root_id', '')), (payload->>'agent_user_id'), created_at DESC, id DESC)
    WHERE type = 'agent.deliver' AND jsonb_typeof(payload->'agent_user_id') = 'string';
