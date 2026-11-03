-- Personal list state is separate from membership authorization and retained history.
-- Nullable, without a default or backfill: existing rows retain their current behavior.
SET LOCAL lock_timeout = '5s';
ALTER TABLE chat.chat_members ADD COLUMN IF NOT EXISTS conversation_deleted_at timestamptz;
COMMENT ON COLUMN chat.chat_members.conversation_deleted_at IS 'Personal conversation-list deletion only; does not revoke membership, historical messages or file access.';

-- SELECT * in an existing view has a fixed expansion; append the new state without changing its predicate.
CREATE OR REPLACE VIEW chat.active_members WITH (security_invoker = true) AS
  SELECT m.* FROM chat.chat_members m WHERE identity.user_is_live(m.user_id);

CREATE OR REPLACE FUNCTION chat.delete_my_dm_conversation(p_chat_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  caller text := auth.uid()::text;
  peer identity.users%ROWTYPE;
  deleted_at timestamptz;
  already_deleted boolean;
BEGIN
  IF caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM identity.users u WHERE u.id = caller AND u.type = 'human' AND u.removed_at IS NULL
  ) THEN RAISE EXCEPTION 'conversation_delete_owner_required' USING ERRCODE = '42501'; END IF;

  -- Locate without locks, then acquire identity -> chat -> member locks in the shared order.
  -- Physical seats are intentional here: a removed agent's historical identity still belongs to its owner.
  SELECT u.* INTO peer FROM chat.chat_members m JOIN identity.users u ON u.id = m.user_id
  WHERE m.chat_id = p_chat_id AND u.type = 'agent' AND u.owner_user_id = caller;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_dm_identity_unverified' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM identity.users u WHERE u.id IN (caller, peer.id) ORDER BY u.id FOR SHARE;
  SELECT u.* INTO peer FROM identity.users u WHERE u.id = peer.id;
  PERFORM 1 FROM chat.chats c WHERE c.id = p_chat_id AND c.kind = 'dm' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM chat.chat_members m WHERE m.chat_id = p_chat_id AND m.user_id = caller
  ) OR (SELECT count(*) FROM chat.chat_members m WHERE m.chat_id = p_chat_id) <> 2
    OR NOT EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = p_chat_id AND m.user_id = peer.id)
    OR peer.owner_user_id IS DISTINCT FROM caller THEN
    RAISE EXCEPTION 'conversation_dm_identity_unverified' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM identity.agent_provisions p WHERE p.agent_user_id = peer.id
      AND p.owner_user_id = caller AND p.member_key = 'assistant'
  ) THEN RAISE EXCEPTION 'conversation_assistant_in_use' USING ERRCODE = '55000'; END IF;
  IF peer.session_archived_at IS NULL AND peer.removed_at IS NULL THEN
    RAISE EXCEPTION 'conversation_agent_in_use' USING ERRCODE = '55000';
  END IF;

  SELECT m.conversation_deleted_at INTO deleted_at FROM chat.chat_members m
  WHERE m.chat_id = p_chat_id AND m.user_id = caller FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_delete_owner_required' USING ERRCODE = '42501'; END IF;
  already_deleted := deleted_at IS NOT NULL;
  IF NOT already_deleted THEN
    UPDATE chat.chat_members m SET conversation_deleted_at = clock_timestamp()
    WHERE m.chat_id = p_chat_id AND m.user_id = caller
    RETURNING m.conversation_deleted_at INTO deleted_at;
    -- Existing own-member revision carries the same membership key; no new event or permission change.
  END IF;
  RETURN jsonb_build_object('chat_id', p_chat_id, 'deleted_at', deleted_at, 'already', already_deleted);
END;
$$;
REVOKE ALL ON FUNCTION chat.delete_my_dm_conversation(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.delete_my_dm_conversation(text) TO authenticated;

CREATE OR REPLACE FUNCTION chat.list_my_chats_as(p_as_user_id text)
RETURNS TABLE(chat_id text, public_id integer, kind text, status text, name text, role text, listen_mode text,
  last_message_at timestamptz, last_message_preview text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE caller text := auth.uid()::text; actor text := NULLIF(btrim(COALESCE(p_as_user_id, '')), '');
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF actor IS NULL OR NOT chat.is_acting_as(actor) THEN
    RAISE EXCEPTION 'Not allowed to act as %', COALESCE(actor, '<null>');
  END IF;
  RETURN QUERY SELECT c.id,c.public_id,c.kind,c.status,c.name,mine.role,mine.listen_mode,c.last_message_at,c.last_message_preview
    FROM chat.active_members mine JOIN chat.chats c ON c.id = mine.chat_id
    WHERE mine.user_id = actor AND mine.conversation_deleted_at IS NULL AND c.status IN ('active','stopped','paused')
    ORDER BY c.last_message_at DESC NULLS LAST,c.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION chat.list_my_chats_as(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_my_chats_as(text) TO authenticated;
