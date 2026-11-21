-- One read for "this actor reads these messages by id": the rows themselves, filtered by the same rule as
-- can_read_message (chat.message_visible_to: membership, history floor, whisper parties). An agent's owner asks for the
-- agent (is_acting_as), so a whisper to the agent reads as the agent, not as the owner, who is no party to it.
-- A full id is p_id_from = p_id_to; a prefix is the id range it spans. deleted_for_me: the actor hid it for themselves.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION chat.messages_by_id_as(p_as text, p_id_from text, p_id_to text, p_chat_id text DEFAULT NULL, p_limit integer DEFAULT 1)
RETURNS TABLE(id text, chat_id text, sender_user_id text, content text, content_type text, created_at timestamptz,
    file_item_id uuid, file_version integer, file_blob_id uuid, retracted_at timestamptz, deleted_for_me boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF p_as IS NULL OR NOT chat.is_acting_as(p_as) THEN
        RAISE EXCEPTION 'Not allowed to act as %', p_as;
    END IF;
    RETURN QUERY
    SELECT m.id, m.chat_id, m.sender_user_id, m.content, m.content_type, m.created_at,
           m.file_item_id, m.file_version, m.file_blob_id, m.retracted_at, COALESCE(m.deleted_for_user_ids ? p_as, false)
      FROM chat.messages m
     WHERE m.id >= p_id_from AND m.id <= p_id_to
       AND (p_chat_id IS NULL OR m.chat_id = p_chat_id)
       AND m.deleted_at IS NULL
       AND chat.message_visible_to(m.chat_id, m.created_at, m.is_whisper, m.sender_user_id, m.to_user_ids, p_as)
     ORDER BY m.id
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 100);
END $$;
ALTER FUNCTION chat.messages_by_id_as(text,text,text,text,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.messages_by_id_as(text,text,text,text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.messages_by_id_as(text,text,text,text,integer) TO authenticated;

-- The widget registry lookup reads the same way: p_as (default the caller) is the one whose visibility of the original
-- message decides, so an owner can ask as their agent (can_read_message checks is_acting_as). Same columns, same
-- one-argument call for every existing caller.
DROP FUNCTION chat.widget_origin(text);
CREATE FUNCTION chat.widget_origin(p_widget_id text, p_as text DEFAULT NULL)
RETURNS TABLE(widget_id text, origin_message_id text, is_retracted boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT w.id, m.id, m.retracted_at IS NOT NULL
      FROM chat.widgets w
      JOIN chat.messages m ON m.id = w.message_id
     WHERE w.id = p_widget_id
       AND chat.can_read_message(m.id, COALESCE(p_as, (SELECT auth.uid()::text)))
       AND NOT (m.deleted_for_user_ids ? COALESCE(p_as, (SELECT auth.uid()::text)));
$$;
ALTER FUNCTION chat.widget_origin(text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.widget_origin(text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.widget_origin(text,text) TO authenticated;
COMMENT ON FUNCTION chat.widget_origin(text,text) IS 'Read-only widget origin and retraction state, checked against p_as (default the caller) reading the original message; never returns a widget specification.';
NOTIFY pgrst, 'reload schema';
