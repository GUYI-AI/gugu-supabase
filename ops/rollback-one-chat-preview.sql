-- Roll back 20261110054000_one_chat_preview: chat.sync_snapshot and chat.list_chat_previews each define the preview again
-- (without retracted_at). The bodies below are the definitions that release replaced.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION chat.list_chat_previews(text[]);
CREATE FUNCTION chat.list_chat_previews(p_chat_ids text[])
 RETURNS TABLE(id text, chat_id text, created_at timestamp with time zone, preview text, seq bigint, content_type text, sender_user_id text, client_message_id text, preview_source text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
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
REVOKE ALL ON FUNCTION chat.list_chat_previews(text[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.list_chat_previews(text[]) TO authenticated;

CREATE OR REPLACE FUNCTION chat.sync_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    viewer text := auth.uid()::text;
    result jsonb;
    response_bytes integer;
    -- A response is complete or an explicit error; never silently truncate rows.
    max_response_bytes CONSTANT integer := 16777216;
BEGIN
    IF viewer IS NULL THEN
        RAISE EXCEPTION 'authenticated account is required' USING ERRCODE = '42501';
    END IF;

    WITH conversations AS MATERIALIZED (
        SELECT c.id, c.public_id, c.kind, c.status, c.name, c.avatar_url,
               c.created_at, c.next_message_seq, c.pinned_message_id,
               c.source_chat_id, c.source_message_id
          FROM chat.chats c
          JOIN chat.active_members own ON own.chat_id = c.id AND own.user_id = viewer
         WHERE own.inbox_published_at IS NOT NULL AND own.conversation_deleted_at IS NULL
           AND c.status IN ('active', 'stopped', 'paused')
    ), members AS MATERIALIZED (
        SELECT m.chat_id, m.user_id, m.last_read_seq, m.is_marked_unread, m.version,
               m.notification_level, m.is_pinned, m.updated_at, m.joined_at,
               m.inbox_published_at, m.role, m.conversation_deleted_at
          FROM chat.active_members m JOIN conversations c ON c.id = m.chat_id
    ), identity_ids AS (
        SELECT viewer AS id UNION SELECT user_id FROM members
        UNION SELECT CASE WHEN f.user_a_id = viewer THEN f.user_b_id ELSE f.user_a_id END
                FROM identity.active_friendships f
               WHERE viewer IN (f.user_a_id, f.user_b_id)
        UNION SELECT u.id FROM identity.users u WHERE u.owner_user_id = viewer
    ), identities AS MATERIALIZED (
        SELECT u.id, u.gugu_number, u.display_name, u.avatar, u.bio, u.type,
               u.owner_user_id, u.agent_public, u.desired_status, u.device_id,
               u.session_archived_at, u.session_lifecycle_revision, u.removed_at,
               u.category, u.is_official, u.local_path, u.created_at, u.updated_at
          FROM identity.users u JOIN identity_ids ids ON ids.id = u.id
    ), previews AS (
        SELECT c.id AS chat_id, p.id, p.created_at, p.preview, p.seq,
               p.content_type, p.sender_user_id, p.client_message_id
          FROM conversations c
          LEFT JOIN LATERAL (
              SELECT v.id, v.created_at, chat.preview(v) AS preview, v.seq, v.content_type,
                     v.sender_user_id, v.client_message_id
                FROM chat.messages_view v
               WHERE v.chat_id = c.id AND v.is_whisper = false
                 AND NOT chat.is_pending_delivery(v.id, v.content_type, v.sender_user_id, v.client_message_id)
               ORDER BY v.seq DESC LIMIT 1
          ) p ON true
    )
    SELECT jsonb_build_object(
        'account_id', viewer,
        'revision', COALESCE((SELECT h.revision FROM chat.account_revision_heads h
                              WHERE h.user_id = viewer), 0)::text,
        'chats', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM conversations c), '[]'::jsonb),
        'memberships', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.chat_id, m.user_id) FROM members m), '[]'::jsonb),
        'identities', COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM identities u), '[]'::jsonb),
        'previews', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.chat_id) FROM previews p), '[]'::jsonb),
        'unread', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.chat_id, r.stream_id)
                            FROM chat.list_unread_locators(NULL) r), '[]'::jsonb),
        'overrides', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'target_kind', o.target_kind, 'target_id', o.target_id,
            'contact_user_id', o.contact_user_id, 'alias', o.alias) ORDER BY o.target_kind, o.target_id)
            FROM identity.contact_overrides o WHERE o.owner_user_id = viewer), '[]'::jsonb),
        'presence', COALESCE((
          SELECT jsonb_object_agg(entry.key, CASE WHEN entry.value->>'status'='not_found' THEN NULL::jsonb
            ELSE jsonb_build_object('presence',entry.value->'presence') END)
          FROM (
            SELECT identity.get_agent_presence_batch(array_agg(requested.id ORDER BY requested.id)) AS payload
            FROM (SELECT u.id, (row_number() OVER (ORDER BY u.id)-1)/200 AS batch
              FROM identities u WHERE u.type='agent') requested GROUP BY requested.batch
          ) batches CROSS JOIN LATERAL jsonb_each(batches.payload->'results') entry
          WHERE entry.value->>'status' IN ('presence','not_found')
        ), '{}'::jsonb)
    ) INTO result;

    response_bytes := octet_length(result::text);
    IF response_bytes > max_response_bytes THEN
        RAISE EXCEPTION 'account snapshot requires % bytes; response budget is % bytes',
            response_bytes, max_response_bytes USING ERRCODE = '54000';
    END IF;
    RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION chat.sync_snapshot() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.sync_snapshot() TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
