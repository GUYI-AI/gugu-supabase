-- Conversation removal belongs to the same trusted account-erasure transaction.
-- The byte collector remains asynchronous and rechecks live references/leases.
CREATE FUNCTION identity.erase_self_only_conversations(p_ids text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidates text[]; roots text[]; locked_rooms text[]:=ARRAY[]::text[];
    room record; object_row record; pointers jsonb; blobs uuid[]; blob uuid;
    removed integer:=0;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM identity.account_lifecycle_context c
        WHERE c.transaction_id=pg_current_xact_id() AND c.operation='privacy_erasure'
          AND c.delete_user_ids=p_ids AND c.subject_user_id=p_ids[1]) THEN
        RAISE EXCEPTION 'Conversation erasure requires the complete Auth deletion context' USING ERRCODE='42501';
    END IF;
    WITH affected AS (
      SELECT m.chat_id id FROM chat.chat_members m WHERE m.user_id=ANY(p_ids)
      UNION SELECT c.id FROM chat.chats c WHERE c.creator_user_id=ANY(p_ids)
    ) SELECT array_agg(c.id),array_agg(DISTINCT COALESCE(c.source_chat_id,c.id)) INTO candidates,roots
    FROM affected a JOIN chat.chats c ON c.id=a.id;
    IF candidates IS NULL THEN RETURN 0; END IF;

    -- Sources before their topics, before any membership row or publishing DML.
    -- A new membership/topic FK cannot pass this chat FOR UPDATE fence. Recheck
    -- membership only after acquiring it, including a join that committed first.
    FOR room IN SELECT c.id FROM chat.chats c
      WHERE c.id=ANY(roots) OR (c.kind='topic' AND c.source_chat_id=ANY(roots))
      ORDER BY COALESCE(c.source_chat_id,c.id),(c.source_chat_id IS NOT NULL),c.id FOR UPDATE
    LOOP locked_rooms:=array_append(locked_rooms,room.id); END LOOP;
    PERFORM 1 FROM chat.chat_members m WHERE m.chat_id=ANY(locked_rooms)
      ORDER BY m.chat_id,m.user_id FOR UPDATE;

    -- Validate unsupported deep cascades before deleting any cursor row;
    -- otherwise a UUID sort could remove a descendant before this check.
    IF EXISTS(SELECT 1 FROM chat.chats c
      JOIN chat.chats child ON child.source_chat_id=c.id AND child.kind='topic'
      JOIN chat.chats nested ON nested.source_chat_id=child.id AND nested.kind='topic'
      WHERE c.id=ANY(candidates) AND NOT EXISTS(SELECT 1 FROM chat.chat_members m
        WHERE m.chat_id=c.id AND NOT m.user_id=ANY(p_ids))) THEN
        RAISE EXCEPTION 'Nested source topics require explicit repair before erasure' USING ERRCODE='55000';
    END IF;

    FOR room IN SELECT c.id FROM chat.chats c WHERE c.id=ANY(candidates)
      ORDER BY COALESCE(c.source_chat_id,c.id),(c.source_chat_id IS NOT NULL),c.id
    LOOP
        -- A source deleted earlier in this cursor may have cascaded this topic.
        CONTINUE WHEN NOT EXISTS(SELECT 1 FROM chat.chats WHERE id=room.id);
        CONTINUE WHEN EXISTS(SELECT 1 FROM chat.chat_members m
          WHERE m.chat_id=room.id AND NOT m.user_id=ANY(p_ids));
        -- Normal source-seat removal also removes that participant's topic
        -- seats. Refuse inconsistent legacy state rather than cascade a topic
        -- with an outside participant whom this deletion must preserve.
        IF EXISTS(SELECT 1 FROM chat.chats t JOIN chat.chat_members m ON m.chat_id=t.id
          WHERE t.source_chat_id=room.id AND NOT m.user_id=ANY(p_ids)) THEN
            RAISE EXCEPTION 'A source conversation has surviving topic participants' USING ERRCODE='55000';
        END IF;

        WITH rooms AS (SELECT room.id AS id UNION SELECT t.id FROM chat.chats t WHERE t.source_chat_id=room.id),
        objects AS (
          SELECT m.storage_bucket_id bucket_id,m.storage_object_name object_name FROM chat.messages m
            WHERE m.chat_id IN (SELECT id FROM rooms) AND m.storage_object_name IS NOT NULL
          UNION SELECT c.avatar_storage_bucket_id,c.avatar_storage_object_name FROM chat.chats c
            WHERE c.id IN (SELECT id FROM rooms) AND c.avatar_storage_object_name IS NOT NULL
          UNION SELECT g.storage_bucket_id,g.storage_object_name FROM chat.group_outputs g
            WHERE g.chat_id IN (SELECT id FROM rooms) AND g.storage_object_name IS NOT NULL
          UNION SELECT o.bucket_id,o.object_name FROM chat.file_transfer_storage o
            JOIN chat.file_transfer_storage_refs r ON r.storage_id=o.id WHERE r.chat_id IN (SELECT id FROM rooms)
        ) SELECT COALESCE(jsonb_agg(to_jsonb(objects)),'[]'::jsonb) INTO pointers FROM objects;
        WITH rooms AS (SELECT room.id AS id UNION SELECT t.id FROM chat.chats t WHERE t.source_chat_id=room.id),
        referenced AS (
          SELECT w.blob_id id FROM chat.workspace_items w WHERE w.chat_id IN (SELECT id FROM rooms)
          UNION SELECT v.blob_id FROM chat.workspace_item_versions v JOIN chat.workspace_items w ON w.id=v.item_id
            WHERE w.chat_id IN (SELECT id FROM rooms)
          UNION SELECT m.file_blob_id FROM chat.messages m WHERE m.chat_id IN (SELECT id FROM rooms)
          UNION SELECT b.id FROM chat.file_blobs b JOIN jsonb_to_recordset(pointers)
            AS p(bucket_id text,object_name text) ON (b.bucket_id,b.object_name)=(p.bucket_id,p.object_name)
        ) SELECT array_agg(id) FILTER(WHERE id IS NOT NULL) INTO blobs FROM referenced;

        -- Cascades remove messages, file versions/items, storage refs and topics.
        -- File-folder delete guards permit a cascade after its chat has gone.
        DELETE FROM chat.chats WHERE id=room.id;
        removed:=removed+1;
        FOREACH blob IN ARRAY COALESCE(blobs,ARRAY[]::uuid[]) LOOP
            IF NOT chat.file_blob_in_use(blob) THEN PERFORM chat.file_blob_enqueue(blob); END IF;
        END LOOP;
        -- Also cover legacy named objects/avatars that had no registered blob.
        -- Keep shared content and active capabilities on the existing collector.
        FOR object_row IN SELECT o.id,o.bucket_id,o.name FROM storage.objects o
          JOIN jsonb_to_recordset(pointers) AS p(bucket_id text,object_name text)
            ON (o.bucket_id,o.name)=(p.bucket_id,p.object_name)
          ORDER BY o.id FOR UPDATE OF o
        LOOP
            IF NOT identity.storage_object_is_referenced(object_row.bucket_id,object_row.name) THEN
                PERFORM chat.file_blob_enqueue(chat.file_blob_for_object(object_row.bucket_id,object_row.name));
            END IF;
        END LOOP;
    END LOOP;
    RETURN removed;
END $$;
ALTER FUNCTION identity.erase_self_only_conversations(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.erase_self_only_conversations(text[]) FROM PUBLIC,anon,authenticated,service_role;

-- The preceding unified release owns the trusted two-argument body and one-argument compatibility
-- wrapper. Patch only that body after the installed personal-list lock-order
-- release, before its snapshot/prelock prelude and the original
-- shared-chat/command/identity/storage cleanup; fail closed on an unknown shape.
DO $upgrade$
DECLARE definition text;
    anchor text:='    SELECT COALESCE(array_agg(DISTINCT cm.chat_id ORDER BY cm.chat_id),ARRAY[]::text[])';
BEGIN
    SELECT pg_get_functiondef('identity.erase_human_account(text,text)'::regprocedure) INTO definition;
    IF position('identity.enqueue_account_audit_redaction(delete_user_ids,p_auth_email)' IN definition)=0
      OR position('identity.command_erasure_references_v1' IN definition)=0
      OR position('FOREACH affected_chat_id IN ARRAY locked_chat_ids' IN definition)=0
      OR length(definition)-length(replace(definition,anchor,''))<>length(anchor)
      OR position('identity.erase_self_only_conversations' IN definition)<>0 THEN
        RAISE EXCEPTION 'Unexpected registered account erasure predecessor';
    END IF;
    EXECUTE replace(definition,anchor,
      '    PERFORM identity.erase_self_only_conversations(delete_user_ids);'||chr(10)||chr(10)||anchor);
END $upgrade$;
ALTER FUNCTION identity.erase_human_account(text,text) SET search_path=pg_catalog;
REVOKE ALL ON FUNCTION identity.erase_human_account(text,text) FROM PUBLIC,anon,authenticated,service_role;
