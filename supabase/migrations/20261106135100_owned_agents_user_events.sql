-- New hosts share their owner's existing events subscription. Keep the old
-- agents topic until all pre-change hosts (including 0.2.54/0.2.57/0.3.0/0.3.1)
-- have retired and unknown-version devices have been identified. Then remove
-- the legacy send and gugu_user_agents_select together.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION identity.broadcast_user_agent_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'identity', 'realtime', 'public', 'pg_catalog'
AS $$
DECLARE
    target_row identity.users%ROWTYPE;
    op TEXT;
    payload JSONB;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_row := OLD;
        op := 'deleted';
    ELSE
        target_row := NEW;
        op := lower(TG_OP);
    END IF;
    IF target_row.type IS DISTINCT FROM 'agent' OR target_row.owner_user_id IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    payload := jsonb_build_object(
        'op', op,
        'agent', jsonb_build_object(
            'id', target_row.id,
            'owner_user_id', target_row.owner_user_id,
            'device_id', target_row.device_id,
            'local_path', target_row.local_path,
            'prompt_path', target_row.prompt_path,
            'display_name', target_row.display_name,
            'agent_public', target_row.agent_public,
            'updated_at', target_row.updated_at
        )
    );
    PERFORM chat.send_user_event(payload, 'agent_changed', 'gugu:user:' || target_row.owner_user_id || ':events', true);
    PERFORM realtime.send(payload, 'agent_changed', 'gugu:user:' || target_row.owner_user_id || ':agents', true);
    RETURN COALESCE(NEW, OLD);
END;
$$;
