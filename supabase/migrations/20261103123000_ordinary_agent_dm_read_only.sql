-- Roll out only AFTER clients can notify owners through native session records.
-- The DM, membership, messages and file references remain available for historical reads.
-- A table trigger also covers service/definer send paths; an RLS-only policy would not.
CREATE OR REPLACE FUNCTION chat.reject_ordinary_agent_dm_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM chat.chats c
    JOIN chat.chat_members am ON am.chat_id = c.id
    JOIN identity.users a ON a.id = am.user_id AND a.type = 'agent'
    JOIN chat.chat_members hm ON hm.chat_id = c.id AND hm.user_id = a.owner_user_id
    JOIN identity.users h ON h.id = hm.user_id AND h.type = 'human'
    WHERE c.id = NEW.chat_id AND c.kind = 'dm'
      AND (SELECT count(*) FROM chat.chat_members cm WHERE cm.chat_id = c.id) = 2
      -- The assistant is identified by its durable provision marker, never its name/host.
      AND NOT EXISTS (
        SELECT 1 FROM identity.agent_provisions p
        WHERE p.agent_user_id = a.id AND p.owner_user_id = h.id AND p.member_key = 'assistant'
      )
  ) THEN
    RAISE EXCEPTION 'Ordinary agent private chats are read-only; use the agent session'
      USING ERRCODE = '42501', HINT = 'ordinary_agent_dm_read_only';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.reject_ordinary_agent_dm_message() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS messages_ordinary_agent_dm_read_only ON chat.messages;
CREATE TRIGGER messages_ordinary_agent_dm_read_only
BEFORE INSERT OR UPDATE OF chat_id ON chat.messages
FOR EACH ROW EXECUTE FUNCTION chat.reject_ordinary_agent_dm_message();
