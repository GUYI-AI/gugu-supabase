-- One read per device: which of these agents have anything pull_agent_inbox_v2 would hand them.
-- A host that wakes (power or controller resume) asks this once for its whole roster and pulls
-- only the agents named here, instead of one pull_agent_inbox_v2 per agent (N concurrent RPCs per wake).
-- The candidate predicate is pull_agent_inbox_v2's, without the page: same wake, gate, block and read checks.
CREATE FUNCTION identity.agents_with_inbox(p_agent_user_ids text[])
  RETURNS TABLE(agent_user_id text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path TO 'chat', 'identity', 'public'
AS $$
DECLARE
  v_caller TEXT := (SELECT auth.uid()::text);
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  RETURN QUERY
  SELECT u.id
    FROM identity.users u
   WHERE u.id = ANY (p_agent_user_ids)
     -- A filter over the host's roster, not a grant: an id the caller cannot act for (another account's agent
     -- left on a shared machine) never qualifies; pulling it still goes through pull_agent_inbox_v2's own check.
     AND (u.id = v_caller OR (u.type = 'agent' AND u.owner_user_id = v_caller))
     AND u.session_archived_at IS NULL
     AND EXISTS (
       SELECT 1
         FROM chat.active_members cm
         JOIN chat.chats c    ON c.id = cm.chat_id
         JOIN chat.messages m ON m.chat_id = cm.chat_id
        WHERE cm.user_id = u.id
          AND c.status = 'active'
          AND m.deleted_at IS NULL
          AND (m.sender_user_id IS NOT NULL OR m.content_type = 'system')
          AND m.seq > cm.last_read_seq
          AND m.ingest_seq > cm.joined_ingest_seq
          AND EXISTS (SELECT 1 FROM chat.message_agent_wakes w WHERE w.message_id = m.id AND w.agent_user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM chat.message_agent_delivery_blocks b WHERE b.message_id = m.id AND b.agent_user_id = u.id)
          AND NOT EXISTS (
            SELECT 1 FROM chat.message_deliveries d
             WHERE d.message_id = m.id AND d.device_id = 'gugu-agent:' || u.id AND d.status = 'read'
          )
     );
END;
$$;

REVOKE ALL ON FUNCTION identity.agents_with_inbox(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.agents_with_inbox(text[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
