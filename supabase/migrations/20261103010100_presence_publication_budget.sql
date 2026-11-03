-- Reuse the existing account revision and its already computed presence.
CREATE OR REPLACE FUNCTION identity.broadcast_agent_presence_from_runtime()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'identity', 'realtime', 'public', 'pg_catalog'
AS $function$
DECLARE
    v_payload JSONB;
BEGIN
    -- Recent actions travel with the next state edge without waking every viewer on their own.
    -- Reading and host identity edges still publish immediately.
    IF TG_OP = 'UPDATE'
       AND NEW.runtime_status      IS NOT DISTINCT FROM OLD.runtime_status
       AND NEW.activity_status     IS NOT DISTINCT FROM OLD.activity_status
       AND NEW.agent_status        IS NOT DISTINCT FROM OLD.agent_status
       AND NEW.agent_status_detail IS NOT DISTINCT FROM OLD.agent_status_detail
       AND NEW.runtime_kind        IS NOT DISTINCT FROM OLD.runtime_kind
       AND NEW.runtime_label       IS NOT DISTINCT FROM OLD.runtime_label
       AND NEW.window_title        IS NOT DISTINCT FROM OLD.window_title
       AND NEW.pid                 IS NOT DISTINCT FROM OLD.pid
       AND NEW.active_chat_id      IS NOT DISTINCT FROM OLD.active_chat_id
    THEN
        RETURN NEW;
    END IF;

    v_payload := identity.build_agent_presence_payload(NEW.agent_user_id);
    IF v_payload IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM identity.fan_agent_presence_to_viewers(NEW.agent_user_id, v_payload);

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION identity.fan_agent_presence_to_viewers(p_agent_user_id text, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'identity', 'chat', 'realtime', 'public', 'pg_catalog'
AS $function$
DECLARE
    viewer_user_id TEXT;
    next_revision BIGINT;
    v_resource_key JSONB;
BEGIN
    IF p_payload IS NULL THEN
        RAISE EXCEPTION 'Agent presence payload is required';
    END IF;

    v_resource_key := jsonb_build_object('agent_user_id', p_agent_user_id, 'presence', p_payload -> 'presence');

    FOR viewer_user_id IN
        SELECT DISTINCT candidate.user_id
          FROM (
            SELECT unnest(t.presence_viewer_user_ids) AS user_id
              FROM identity.agent_lifecycle_tombstones t
             WHERE t.agent_user_id = p_agent_user_id
            UNION
            SELECT u.owner_user_id
              FROM identity.users u
             WHERE u.id = p_agent_user_id
               AND u.type = 'agent'
               AND u.owner_user_id IS NOT NULL
            UNION
            SELECT CASE WHEN f.user_a_id = p_agent_user_id THEN f.user_b_id ELSE f.user_a_id END
              FROM identity.active_friendships f
             WHERE f.user_a_id = p_agent_user_id OR f.user_b_id = p_agent_user_id
            UNION
            SELECT cm_self.user_id
              FROM chat.active_members cm_agent
              JOIN chat.active_members cm_self ON cm_self.chat_id = cm_agent.chat_id
             WHERE cm_agent.user_id = p_agent_user_id
               AND cm_self.user_id <> p_agent_user_id
          ) candidate
          JOIN identity.users viewer ON viewer.id = candidate.user_id
                                    AND viewer.type = 'human'
         WHERE candidate.user_id IS NOT NULL
         ORDER BY candidate.user_id
    LOOP
        next_revision := chat.append_user_revision(
          viewer_user_id,
          'presence_changed',
          v_resource_key
        );
        IF next_revision IS NOT NULL AND chat.claim_presence_wake(viewer_user_id) THEN
            PERFORM chat.send_user_event(
                jsonb_build_object('revision', next_revision),
                'im_revision_advanced',
                'gugu:user:' || viewer_user_id || ':events',
                true
            );
        END IF;
    END LOOP;
END;
$function$;
