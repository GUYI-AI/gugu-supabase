
-- The release installer owns the transaction and migration ledger.
SET LOCAL lock_timeout = '5s';

-- The chat list's last-message preview also carries the message's full text when it holds a reference link, so the
-- client can summarize its top-level reference blocks ("[引用] …") with the viewer's own permissions. A transport hint,
-- not another Markdown parser: only the shared client AST decides whether these markers form reference paragraphs.
-- Ordinary messages keep only their bounded preview; retracted, deleted and deleted-for-me rows carry no source.
DROP FUNCTION chat.list_chat_previews(text[]);
CREATE FUNCTION chat.list_chat_previews(p_chat_ids text[])
RETURNS TABLE(id text, chat_id text, created_at timestamptz, preview text, seq bigint,
    content_type text, sender_user_id text, client_message_id text, preview_source text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
    IF p_chat_ids IS NULL THEN RAISE EXCEPTION 'chat ids are required'; END IF;
    RETURN QUERY
    SELECT latest.id, latest.chat_id, latest.created_at,
           chat.message_preview(latest.content, latest.content_type), latest.seq,
           latest.content_type, latest.sender_user_id, latest.client_message_id,
           CASE WHEN latest.content_type = 'text'
               AND latest.deleted_at IS NULL AND latest.retracted_at IS NULL
               AND NOT (latest.deleted_for_user_ids ? (SELECT auth.uid()::text))
               AND lower(coalesce(latest.content, '')) LIKE ANY (ARRAY['%gugu-chat://%', '%gugu-widget://%'])
           THEN latest.content END
    FROM (
        SELECT DISTINCT requested_chat.id
        FROM unnest(p_chat_ids) requested_chat(id)
        LEFT JOIN chat.active_members member
          ON member.chat_id = requested_chat.id AND member.user_id = (SELECT auth.uid()::text)
        WHERE requested_chat.id IS NOT NULL
          AND member.conversation_deleted_at IS NULL
    ) requested
    CROSS JOIN LATERAL (
        SELECT m.id, m.chat_id, m.created_at, m.seq, m.content, m.content_type,
               m.sender_user_id, m.client_message_id, m.deleted_at, m.retracted_at, m.deleted_for_user_ids
        FROM chat.messages m
        WHERE m.chat_id = requested.id AND NOT m.is_whisper
          AND NOT chat.is_pending_delivery(m.id,m.content_type,m.sender_user_id,m.client_message_id)
        ORDER BY m.seq DESC
        LIMIT 1
    ) latest;
END;
$function$;
REVOKE ALL ON FUNCTION chat.list_chat_previews(text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.list_chat_previews(text[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
