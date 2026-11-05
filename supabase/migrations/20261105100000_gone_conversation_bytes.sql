-- A conversation nobody can reach again stops holding bytes.
-- No soft delete has a way back: an archived group, topic or DM never returns to active, and a DM deleted by its owner
-- is never listed again. A DM stays reachable while any live member has not deleted it (an archived agent can be
-- restored; a removed one cannot). A reference from a gone conversation is a lost reference, judged by the same
-- chat.file_transfer_reference_expired that idle expiry uses; the event that makes a conversation gone enqueues its
-- blobs into the one collection queue, and finish keeps a blob identity while rows still point at it.

-- References are kept per group: a topic's files belong to its source group.
CREATE FUNCTION chat.conversation_gone(p_chat text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT EXISTS(SELECT 1 FROM chat.chats c WHERE c.id=chat.file_transfer_group(p_chat) AND (c.status='archived'
        OR c.kind='dm' AND NOT EXISTS(SELECT 1 FROM chat.active_members m WHERE m.chat_id=c.id AND m.conversation_deleted_at IS NULL)))
$$;

CREATE OR REPLACE FUNCTION chat.file_transfer_reference_expired(p_blob uuid, p_chat text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT EXISTS(SELECT 1 FROM chat.file_transfer_storage_refs r
        JOIN chat.file_transfer_storage o ON o.id=r.storage_id
        WHERE o.blob_id=p_blob AND r.chat_id=chat.file_transfer_group(p_chat) AND r.expired_at IS NOT NULL)
        OR chat.conversation_gone(p_chat)
$$;

-- The legacy pointers of a gone conversation are lost references too.
CREATE OR REPLACE FUNCTION chat.file_blob_held_until(p_blob_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT CASE WHEN
        EXISTS(SELECT 1 FROM chat.file_temporary_transfers t WHERE t.blob_id=p_blob_id AND t.state='ready'
            AND t.serve_until>now() AND t.created_at>now()-interval '30 days' AND chat.file_temporary_current(t))
        OR EXISTS(SELECT 1 FROM chat.workspace_items w WHERE w.blob_id=p_blob_id
            AND NOT chat.file_transfer_reference_expired(p_blob_id,w.chat_id))
        OR EXISTS(SELECT 1 FROM chat.workspace_item_versions v JOIN chat.workspace_items w ON w.id=v.item_id
            WHERE v.blob_id=p_blob_id AND NOT chat.file_transfer_reference_expired(p_blob_id,w.chat_id))
        OR EXISTS(SELECT 1 FROM chat.file_blob_uploads u WHERE u.blob_id=p_blob_id AND u.expires_at>now())
        OR EXISTS(SELECT 1 FROM chat.messages m WHERE m.file_blob_id=p_blob_id
            AND NOT chat.file_transfer_reference_expired(p_blob_id,m.chat_id))
        OR EXISTS(SELECT 1 FROM chat.session_attachments a WHERE a.blob_id=p_blob_id AND a.revoked_at IS NULL)
        OR EXISTS(SELECT 1 FROM chat.file_blobs b WHERE b.id=p_blob_id AND (
            EXISTS(SELECT 1 FROM chat.messages m WHERE m.storage_bucket_id=b.bucket_id AND m.storage_object_name=b.object_name
                AND NOT chat.file_transfer_reference_expired(p_blob_id,m.chat_id))
            OR EXISTS(SELECT 1 FROM chat.chats c WHERE c.avatar_storage_bucket_id=b.bucket_id AND c.avatar_storage_object_name=b.object_name
                AND NOT chat.file_transfer_reference_expired(p_blob_id,c.id))
            OR EXISTS(SELECT 1 FROM chat.group_outputs o WHERE o.storage_bucket_id=b.bucket_id AND o.storage_object_name=b.object_name
                AND NOT chat.file_transfer_reference_expired(p_blob_id,o.chat_id))))
    THEN 'infinity'::timestamptz ELSE (
        -- Signed upload and download capabilities: the bytes must outlive them, and nothing fires when they lapse.
        SELECT max(v.expires_at) FROM chat.file_transfer_reservations v
         WHERE v.state IN ('reserved','issued') AND v.expires_at>now() AND (
            v.kind='upload' AND v.subject=(SELECT b.object_name FROM chat.file_blobs b WHERE b.id=p_blob_id AND b.bucket_id='temporary')
            OR v.kind='download' AND v.subject IN (SELECT 'object:'||o.id::text FROM chat.file_transfer_storage o WHERE o.blob_id=p_blob_id)))
    END
$$;

-- The event that makes a conversation gone enqueues what it referenced; the claim judges each blob as always.
CREATE FUNCTION chat.conversation_release(p_chat text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE b uuid; n integer:=0;
BEGIN
    IF chat.file_transfer_group(p_chat) IS DISTINCT FROM p_chat OR NOT chat.conversation_gone(p_chat) THEN RETURN 0; END IF;
    FOR b IN
        WITH rooms AS (SELECT p_chat AS id UNION SELECT c.id FROM chat.chats c WHERE c.source_chat_id=p_chat)
        SELECT w.blob_id FROM chat.workspace_items w WHERE w.chat_id IN (SELECT id FROM rooms) AND w.blob_id IS NOT NULL
        UNION SELECT v.blob_id FROM chat.workspace_item_versions v JOIN chat.workspace_items w ON w.id=v.item_id
            WHERE w.chat_id IN (SELECT id FROM rooms) AND v.blob_id IS NOT NULL
        UNION SELECT m.file_blob_id FROM chat.messages m WHERE m.chat_id IN (SELECT id FROM rooms) AND m.file_blob_id IS NOT NULL
        UNION SELECT chat.file_blob_for_object(x.bucket_id,x.object_name) FROM (
            SELECT m.storage_bucket_id AS bucket_id,m.storage_object_name AS object_name FROM chat.messages m
             WHERE m.chat_id IN (SELECT id FROM rooms) AND m.storage_object_name IS NOT NULL
            UNION SELECT c.avatar_storage_bucket_id,c.avatar_storage_object_name FROM chat.chats c
             WHERE c.id IN (SELECT id FROM rooms) AND c.avatar_storage_object_name IS NOT NULL
            UNION SELECT o.storage_bucket_id,o.storage_object_name FROM chat.group_outputs o
             WHERE o.chat_id IN (SELECT id FROM rooms) AND o.storage_object_name IS NOT NULL) x
    LOOP
        CONTINUE WHEN b IS NULL;
        PERFORM chat.file_blob_enqueue(b);
        n:=n+1;
    END LOOP;
    RETURN n;
END $$;

CREATE FUNCTION chat.conversation_release_on_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF TG_TABLE_NAME='chats' THEN
        PERFORM chat.conversation_release(NEW.id);
    ELSIF TG_TABLE_NAME='chat_members' THEN
        PERFORM chat.conversation_release(NEW.chat_id);
    ELSE
        -- The removed identity's own physical DM seats: it is no longer a live member of them.
        PERFORM chat.conversation_release(m.chat_id) FROM chat.chat_members m JOIN chat.chats c ON c.id=m.chat_id AND c.kind='dm'
         WHERE m.user_id=NEW.id;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER chats_release_gone_bytes AFTER UPDATE OF status ON chat.chats FOR EACH ROW
    WHEN (NEW.status='archived' AND OLD.status IS DISTINCT FROM 'archived') EXECUTE FUNCTION chat.conversation_release_on_change();
CREATE TRIGGER chat_members_release_gone_bytes AFTER UPDATE OF conversation_deleted_at ON chat.chat_members FOR EACH ROW
    WHEN (OLD.conversation_deleted_at IS NULL AND NEW.conversation_deleted_at IS NOT NULL) EXECUTE FUNCTION chat.conversation_release_on_change();
CREATE TRIGGER users_release_gone_bytes AFTER UPDATE OF removed_at ON identity.users FOR EACH ROW
    WHEN (OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL) EXECUTE FUNCTION chat.conversation_release_on_change();

-- Rows that still point at a collected blob keep its identity, its bytes recorded as gone (as for expired files).
CREATE OR REPLACE FUNCTION chat.file_blob_gc_finish(p_blob_id uuid, p_claim_token uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0));
    PERFORM 1 FROM chat.file_blob_gc g
     WHERE g.blob_id = p_blob_id AND g.claim_token = p_claim_token AND g.status = 'running'
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'file_blob_gc_finish: the lease on % is stale', p_blob_id;
    END IF;
    -- Physical deletion succeeded before this call. Release capacity atomically.
    UPDATE chat.file_transfer_storage SET state='gone' WHERE blob_id=p_blob_id;
    IF EXISTS(SELECT 1 FROM chat.file_transfer_storage_refs ref JOIN chat.file_transfer_storage o ON o.id=ref.storage_id
        WHERE o.blob_id=p_blob_id AND ref.expired_at IS NOT NULL)
       OR EXISTS(SELECT 1 FROM chat.messages m WHERE m.file_blob_id=p_blob_id)
       OR EXISTS(SELECT 1 FROM chat.workspace_items w WHERE w.blob_id=p_blob_id)
       OR EXISTS(SELECT 1 FROM chat.workspace_item_versions v WHERE v.blob_id=p_blob_id)
       OR EXISTS(SELECT 1 FROM chat.file_blob_uploads u WHERE u.blob_id=p_blob_id) THEN
        -- The recorded gone bytes are what refuses reuse of this identity (file_blob_take) and lets a fresh upload restore it.
        INSERT INTO chat.file_transfer_storage AS o(blob_id,bucket_id,object_name,size_bytes,state)
        SELECT b.id,b.bucket_id,b.object_name,b.size_bytes,'gone' FROM chat.file_blobs b WHERE b.id=p_blob_id
        ON CONFLICT(bucket_id,object_name) DO UPDATE SET blob_id=EXCLUDED.blob_id,state='gone';
        UPDATE chat.file_blobs SET state='live' WHERE id=p_blob_id AND state='deleting';
        IF NOT FOUND THEN RAISE EXCEPTION 'Expired blob is not being collected'; END IF;
        DELETE FROM chat.file_blob_gc WHERE blob_id=p_blob_id;
        RETURN;
    END IF;
    DELETE FROM chat.file_blobs b WHERE b.id = p_blob_id AND b.state = 'deleting';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'file_blob_gc_finish: % is not being collected', p_blob_id;
    END IF;
END;
$$;

-- Stock: conversations that are already gone release now, through the same function.
SELECT chat.conversation_release(c.id) FROM chat.chats c WHERE c.source_chat_id IS NULL AND chat.conversation_gone(c.id);

REVOKE ALL ON FUNCTION chat.conversation_gone(text),chat.conversation_release(text),chat.conversation_release_on_change() FROM PUBLIC,anon,authenticated;
-- The installation DDL guard closes replaced functions too; restore only their existing API grants.
GRANT EXECUTE ON FUNCTION chat.file_blob_gc_finish(uuid,uuid) TO service_role;
