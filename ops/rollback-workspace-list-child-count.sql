-- Roll back 20261112030000_workspace_list_child_count: workspace_list_as without child_count, exactly as 20261108130000 and
-- 20261109150000 left it. Run on that schema only.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean);

CREATE FUNCTION chat.workspace_list_as(p_chat_id text, p_as_user_id text, p_offset integer DEFAULT 0, p_limit integer DEFAULT NULL::integer, p_name text DEFAULT NULL::text, p_kind text DEFAULT NULL::text, p_folder text DEFAULT NULL::text, p_exact boolean DEFAULT false)
 RETURNS TABLE(id uuid, chat_id text, kind text, filename text, content_type text, size_bytes bigint, pointer text, source_message_ids text[], created_by text, version integer, created_at timestamp with time zone, updated_at timestamp with time zone, total bigint, parent_id uuid, system_role text, path text, updated_by text, metadata jsonb, expires_at timestamp with time zone, is_mine boolean, storage_class text, copy_expired_at timestamp with time zone, copy_account_id text, host_device_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_name TEXT := NULLIF(btrim(COALESCE(p_name, '')), '');
    v_exact BOOLEAN := COALESCE(p_exact, false);
    v_key TEXT := lower(chat.workspace_stored_name(p_name));
    v_offset INTEGER := COALESCE(p_offset, 0);
    v_all BOOLEAN := p_folder IS NULL;
    v_parent UUID; v_transfer_group TEXT; v_transfer_account TEXT;
    v_base TEXT; v_depth INTEGER := 0;
BEGIN
    IF v_offset < 0 OR p_limit < 0 THEN
        RAISE EXCEPTION 'workspace_list: offset and limit must not be negative';
    END IF;
    IF p_kind IS NOT NULL AND p_kind NOT IN ('document', 'file', 'folder') THEN
        RAISE EXCEPTION 'workspace_list: kind must be document, file or folder, got %', p_kind;
    END IF;
    p_chat_id := chat.workspace_require_room_member(p_chat_id, v_actor);
    IF NOT v_all THEN
        v_parent := chat.workspace_folder_for(p_chat_id, p_folder, v_actor, false);
    END IF;
    -- The folder's own path and depth. A folder 64 deep or more lists nothing, as the walk from the top stops there.
    IF v_parent IS NOT NULL THEN
        WITH RECURSIVE up AS (
            SELECT a.parent_id, a.filename::TEXT AS name, 1 AS depth FROM chat.workspace_items a WHERE a.id = v_parent
            UNION ALL
            SELECT a.parent_id, a.filename, u.depth + 1 FROM chat.workspace_items a JOIN up u ON a.id = u.parent_id WHERE u.depth < 64
        )
        SELECT string_agg(u.name, '/' ORDER BY u.depth DESC), max(u.depth) INTO v_base, v_depth FROM up u;
    END IF;
    v_transfer_group := chat.file_transfer_group(p_chat_id);
    v_transfer_account := chat.file_transfer_account(v_actor);
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT r.id AS item_id, concat_ws('/', v_base, r.filename) AS item_path, v_depth + 1 AS depth
          FROM chat.workspace_items r
         WHERE r.chat_id = p_chat_id AND v_depth < 64
           AND (r.parent_id = v_parent OR (v_parent IS NULL AND r.parent_id IS NULL))
        UNION ALL
        SELECT c.id, t.item_path || '/' || c.filename, t.depth + 1
          FROM chat.workspace_items c
          JOIN tree t ON c.parent_id = t.item_id
         WHERE v_all AND t.depth < 64
    ), page AS (
        SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, w.blob_id, w.source_message_ids,
               w.created_by, w.version, w.created_at, w.updated_at, count(*) OVER () AS total, w.parent_id, w.system_role,
               t.item_path, w.updated_by, w.metadata
          FROM chat.workspace_items w
          JOIN tree t ON t.item_id = w.id
         WHERE w.chat_id = p_chat_id
           AND (p_kind IS NULL OR w.kind = p_kind)
           AND (v_name IS NULL
                OR (v_exact AND w.name_key = v_key)
                OR (NOT v_exact AND w.filename ILIKE '%' || replace(replace(replace(v_name, '\', '\\'), '%', '\%'), '_', '\_') || '%'))
         ORDER BY w.created_at DESC, w.id DESC
        OFFSET v_offset
         LIMIT p_limit
    )
    SELECT w.id, w.chat_id, w.kind, w.filename, w.content_type, w.size_bytes, chat.file_blob_pointer(w.blob_id),
           w.source_message_ids, w.created_by, w.version, w.created_at, w.updated_at,
           w.total, w.parent_id, w.system_role, w.item_path, w.updated_by, w.metadata, copy.expires_at, copy.account_id = v_transfer_account,
           CASE WHEN ref.found AND ref.expired_at IS NULL THEN CASE WHEN ref.content_type LIKE 'image/%' THEN 'image'
               WHEN ref.expires_at IS NOT NULL THEN 'temporary' ELSE 'kept' END END,
           ref.expired_at, ref.account_id, dev.host_device_id
      FROM page w
      LEFT JOIN LATERAL (SELECT r.expires_at, r.account_id FROM chat.file_transfer_storage o
          JOIN chat.file_transfer_storage_refs r ON r.storage_id = o.id
         WHERE o.blob_id = w.blob_id AND r.chat_id = v_transfer_group AND r.expired_at IS NULL ORDER BY o.id LIMIT 1) copy ON true
      -- The live copy if there is one, else the latest reclaimed one.
      LEFT JOIN LATERAL (SELECT true AS found, r.expires_at, r.expired_at, r.account_id, b.content_type FROM chat.file_transfer_storage o
          JOIN chat.file_transfer_storage_refs r ON r.storage_id = o.id JOIN chat.file_blobs b ON b.id = o.blob_id
         WHERE o.blob_id = w.blob_id AND r.chat_id = v_transfer_group
         ORDER BY r.expired_at IS NOT NULL, r.expired_at DESC, o.id LIMIT 1) ref ON true
      LEFT JOIN LATERAL (SELECT d.host_device_id FROM chat.workspace_item_versions d
         WHERE d.item_id = w.id AND d.n = w.version AND d.host_project_id IS NOT NULL) dev ON true
     ORDER BY w.created_at DESC, w.id DESC;
END;
$function$
;

REVOKE ALL ON FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
