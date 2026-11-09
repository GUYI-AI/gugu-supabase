-- GUYI-AI/gugu#2383: a message that mentions an agent whose social identity was removed
-- (archive with "remove social identity") is accepted for the other members, and the
-- removed agent gets a terminal refusal, the same outcome as an archived agent (#236).
-- Before, is_addressable_in judged the removed agent not addressable and RLS rejected
-- the whole message, so nobody in the chat received it.
--
-- Only a former member qualifies: removal keeps the agent's seat row (20261031031000),
-- so the retained seat in this chat, or in a topic's source chat, is the proof. An id
-- that never had a seat here is still rejected. Whispers still require a retained,
-- live member (enforce_whisper_rule is unchanged). Removed humans and people who left
-- are unchanged; see docs/removed-agent-mentions.md.

ALTER TABLE chat.message_agent_delivery_blocks
  DROP CONSTRAINT message_agent_delivery_blocks_reason_check,
  ADD CONSTRAINT message_agent_delivery_blocks_reason_check CHECK (reason IN ('agent_archived', 'identity_removed'));

-- A removed agent that held a seat in this chat (or, for a topic, in its source chat).
-- Reads the physical seat table: removed identities have no live membership by design.
CREATE FUNCTION chat_private.is_removed_agent_seat(p_chat_id text, p_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM identity.users u
     WHERE u.id = p_user_id AND u.type = 'agent' AND u.removed_at IS NOT NULL)
  AND EXISTS (
    SELECT 1 FROM chat.chat_members m
     WHERE m.user_id = p_user_id
       AND (m.chat_id = p_chat_id OR m.chat_id = (
         SELECT t.source_chat_id FROM chat.chats t WHERE t.id = p_chat_id AND t.kind = 'topic')))
$$;
REVOKE ALL ON FUNCTION chat_private.is_removed_agent_seat(text, text) FROM PUBLIC, anon, authenticated, service_role, gugu_files;

-- The policy's recipient test, for the message author's session: the caller may probe the
-- chat (the same gate as is_addressable_in) and the recipient is a removed former member.
CREATE FUNCTION chat_private.is_removed_agent_recipient(p_chat_id text, p_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT chat.caller_may_probe_chat(p_chat_id) AND chat_private.is_removed_agent_seat(p_chat_id, p_user_id)
$$;
REVOKE ALL ON FUNCTION chat_private.is_removed_agent_recipient(text, text) FROM PUBLIC, anon, service_role, gugu_files;
GRANT EXECUTE ON FUNCTION chat_private.is_removed_agent_recipient(text, text) TO authenticated;

-- Same expression as before except that one recipient test.
DO $policy$
DECLARE
    previous text;
    prior_sql constant text := '(NOT chat.is_addressable_in(messages.chat_id, target.target_user_id))';
    replacement_sql constant text := '(NOT chat.is_addressable_in(messages.chat_id, target.target_user_id))'
      || ' AND (NOT chat_private.is_removed_agent_recipient(messages.chat_id, target.target_user_id))';
BEGIN
    SELECT pg_get_expr(p.polwithcheck, p.polrelid) INTO previous
      FROM pg_policy p WHERE p.polrelid = 'chat.messages'::regclass AND p.polname = 'messages_insert_member';
    IF array_length(string_to_array(previous, prior_sql), 1) <> 2 THEN
        RAISE EXCEPTION 'Unexpected messages_insert_member predecessor';
    END IF;
    EXECUTE format('ALTER POLICY messages_insert_member ON chat.messages WITH CHECK (%s)', replace(previous, prior_sql, replacement_sql));
END $policy$;

-- The refusal for each mentioned removed former member. A message that would wake nobody
-- records nothing, the same rule as the archived refusal.
CREATE FUNCTION chat.record_message_removed_agent_refusals() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.to_user_ids IS NULL
     OR chat.message_wakes_nobody(NEW.content_type, NEW.reply_to_message_id) THEN
    RETURN NEW;
  END IF;
  INSERT INTO chat.message_agent_delivery_blocks(message_id, agent_user_id, reason)
  SELECT DISTINCT NEW.id, target.user_id, 'identity_removed'
    FROM unnest(NEW.to_user_ids) AS target(user_id)
   WHERE target.user_id <> '*' AND chat_private.is_removed_agent_seat(NEW.chat_id, target.user_id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.record_message_removed_agent_refusals() FROM PUBLIC, anon, authenticated, service_role, gugu_files;
CREATE TRIGGER messages_c_record_removed_agent_refusals AFTER INSERT ON chat.messages
  FOR EACH ROW EXECUTE FUNCTION chat.record_message_removed_agent_refusals();

NOTIFY pgrst, 'reload schema';
