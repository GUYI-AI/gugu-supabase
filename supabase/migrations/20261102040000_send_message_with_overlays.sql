-- Confirm a send and its caller-visible overlays in one transaction. The
-- canonical sender and all attachment callers retain their existing row type.
CREATE FUNCTION chat.send_message_with_overlays(
    p_message_id text, p_chat_id text, p_sender_user_id text, p_to_user_ids text[],
    p_content text, p_content_type text, p_reply_to_message_id text, p_thread_root_id text,
    p_is_thread_root boolean, p_is_whisper boolean,
    p_via_app text DEFAULT NULL, p_file_item_id uuid DEFAULT NULL,
    p_file_version integer DEFAULT NULL, p_forwarded_from_message_id text DEFAULT NULL,
    p_file_blob_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = chat, public, pg_catalog
AS $$
DECLARE
    message chat.messages_view%ROWTYPE;
BEGIN
    SELECT * INTO STRICT message FROM chat.send_message_idempotent(
        p_message_id, p_chat_id, p_sender_user_id, p_to_user_ids, p_content, p_content_type,
        p_reply_to_message_id, p_thread_root_id, p_is_thread_root, p_is_whisper,
        p_via_app, p_file_item_id, p_file_version, p_forwarded_from_message_id, p_file_blob_id);
    -- Admission triggers have finished. On replay, include the current rows.
    -- These SELECTs run under the same caller RLS as window revalidation.
    RETURN jsonb_build_object(
        'message', to_jsonb(message),
        'reactions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'message_id', r.message_id, 'user_id', r.user_id, 'emoji', r.emoji))
            FROM chat.message_reactions r WHERE r.message_id = message.id), '[]'::jsonb),
        'deliveries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'message_id', d.message_id, 'status', d.status, 'device_id', d.device_id))
            FROM chat.message_deliveries d WHERE d.message_id = message.id), '[]'::jsonb),
        'delivery_blocks', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'message_id', b.message_id, 'agent_user_id', b.agent_user_id, 'reason', b.reason))
            FROM chat.message_agent_delivery_blocks b WHERE b.message_id = message.id), '[]'::jsonb)
    );
END;
$$;

REVOKE ALL ON FUNCTION chat.send_message_with_overlays(text,text,text,text[],text,text,text,text,boolean,boolean,text,uuid,integer,text,uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.send_message_with_overlays(text,text,text,text[],text,text,text,text,boolean,boolean,text,uuid,integer,text,uuid)
    TO authenticated;
NOTIFY pgrst, 'reload schema';
