-- #170: a computed preview consumes the whole view row. The budget release's LATERAL reply join
-- therefore ran before sorting/LIMIT across the matching history, not just the returned page.
-- Restore the effective prior view expression: three target-list subqueries evaluated after LIMIT.
-- Keep every published column/type/order, invoker RLS, file metadata and all other budget objects.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE VIEW chat.messages_view WITH (security_invoker=true) AS
SELECT m.*,
    CASE WHEN m.content_type = 'attachment'
        AND (m.file_version IS NOT NULL OR m.file_blob_id IS NOT NULL)
        AND (SELECT auth.uid()) IS NOT NULL
    THEN chat.file_resolve_as(jsonb_build_object('message_id', m.id), (SELECT auth.uid())::text)
        - ARRAY['bucket_id','object_name']
    END AS file_metadata
FROM (
SELECT m.id,
    m.chat_id,
    m.sender_user_id,
    m.to_user_ids,
    COALESCE(su.display_name, '未知用户'::text) AS sender_name,
    su.avatar AS sender_avatar,
    m.seq,
    m.content,
    m.content_type,
    m.reply_to_message_id,
    ( SELECT rp.reply_to_sender_user_id
        FROM chat.message_reply_preview_for(m.reply_to_message_id, ( SELECT (auth.uid())::text AS uid)) rp) AS reply_to_sender_user_id,
    ( SELECT rp.reply_to_sender_name
        FROM chat.message_reply_preview_for(m.reply_to_message_id, ( SELECT (auth.uid())::text AS uid)) rp) AS reply_to_sender_name,
    ( SELECT rp.reply_to_content
        FROM chat.message_reply_preview_for(m.reply_to_message_id, ( SELECT (auth.uid())::text AS uid)) rp) AS reply_to_content,
    m.deleted_at,
    m.deleted_for_user_ids,
    m.retracted_at,
    m.created_at,
    m.forwarded_from_message_id,
    m.thread_root_id,
    m.edited_at,
    m.is_whisper,
    m.is_thread_root,
    m.client_message_id,
    COALESCE((m.client_message_id ~ '^session-import-root:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text), false) AS is_imported_history_root,
    m.via_app,
    m.file_item_id,
    m.file_version,
    m.sent_by_agent,
        CASE
            WHEN (m.sender_user_id = ( SELECT (auth.uid())::text AS uid)) THEN ( SELECT jsonb_build_object('id', a.agent_user_id, 'name', a.agent_name) AS jsonb_build_object
               FROM chat.message_agent_sends a
              WHERE ((a.message_id = m.id) AND (a.owner_user_id = ( SELECT (auth.uid())::text AS uid))))
            ELSE NULL::jsonb
        END AS agent_sender,
    m.file_blob_id
   FROM (chat.messages m
     LEFT JOIN identity.users su ON ((su.id = m.sender_user_id)))) m;
