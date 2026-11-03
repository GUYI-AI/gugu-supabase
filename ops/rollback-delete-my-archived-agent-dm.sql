-- Run through the approved backend migration workflow after rolling back the client.
-- Keep the additive column, view shape and deletion timestamps for safe forward recovery.
-- Restore the prior list behavior and close the deletion RPC; do not erase user choices.
BEGIN;
REVOKE EXECUTE ON FUNCTION chat.delete_my_dm_conversation(text) FROM authenticated;
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
    WHERE mine.user_id = actor AND c.status IN ('active','stopped','paused')
    ORDER BY c.last_message_at DESC NULLS LAST,c.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION chat.list_my_chats_as(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_my_chats_as(text) TO authenticated;
COMMIT;
