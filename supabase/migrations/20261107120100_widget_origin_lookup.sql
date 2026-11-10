-- Resolve a cold widget reference without exposing its immutable specification.
-- Retraction hides the specification through widgets RLS, but a viewer who can
-- still read the original message may distinguish it from an unreadable origin.
CREATE FUNCTION chat.widget_origin(p_widget_id text)
RETURNS TABLE(widget_id text, origin_message_id text, is_retracted boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT w.id, m.id, m.retracted_at IS NOT NULL
      FROM chat.widgets w
      JOIN chat.messages m ON m.id = w.message_id
     WHERE w.id = p_widget_id
       AND chat.can_read_message(m.id, (SELECT auth.uid()::text))
       AND NOT (m.deleted_for_user_ids ? (SELECT auth.uid()::text));
$$;

REVOKE ALL ON FUNCTION chat.widget_origin(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.widget_origin(text) TO authenticated;
COMMENT ON FUNCTION chat.widget_origin(text) IS 'Read-only widget origin and retraction state, checked against the caller visibility of the original message; never returns a widget specification.';
