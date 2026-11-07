-- One lifecycle for stored bytes.
-- A blob (chat.file_blobs) is held by references. A reference ends either by a row event (delete, retirement,
-- revocation, expiry), whose trigger or expiry step enqueues the blob into chat.file_blob_gc, or by time alone (an upload
-- or download capability lapsing), which fires nothing. chat.file_blob_held_until is the one judgement:
-- 'infinity' = held by a row whose end enqueues again, a timestamp = held only until a capability lapses, NULL = free.
-- The claim acts on it: drop the job, defer the job to that time, or collect. chat.file_blob_gc is the only queue and
-- the attachments gc function its only consumer; account erasure enqueues there too.

CREATE FUNCTION chat.file_blob_held_until(p_blob_id uuid) RETURNS timestamptz
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
            OR EXISTS(SELECT 1 FROM chat.chats c WHERE c.avatar_storage_bucket_id=b.bucket_id AND c.avatar_storage_object_name=b.object_name)
            OR EXISTS(SELECT 1 FROM chat.group_outputs o WHERE o.storage_bucket_id=b.bucket_id AND o.storage_object_name=b.object_name)))
    THEN 'infinity'::timestamptz ELSE (
        -- Signed upload and download capabilities: the bytes must outlive them, and nothing fires when they lapse.
        SELECT max(v.expires_at) FROM chat.file_transfer_reservations v
         WHERE v.state IN ('reserved','issued') AND v.expires_at>now() AND (
            v.kind='upload' AND v.subject=(SELECT b.object_name FROM chat.file_blobs b WHERE b.id=p_blob_id AND b.bucket_id='temporary')
            OR v.kind='download' AND v.subject IN (SELECT 'object:'||o.id::text FROM chat.file_transfer_storage o WHERE o.blob_id=p_blob_id)))
    END
$$;

CREATE OR REPLACE FUNCTION chat.file_blob_in_use(p_blob_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT chat.file_blob_held_until(p_blob_id) IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION chat.file_blob_gc_claim(p_limit integer DEFAULT 50, p_stale_seconds integer DEFAULT 600)
 RETURNS TABLE(blob_id uuid, claim_token uuid, bucket_id text, object_name text, content_type text, attempt_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    r RECORD;
    v_token UUID;
    v_held TIMESTAMPTZ;
BEGIN
    IF NOT pg_try_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0)) THEN RETURN; END IF;
    IF p_limit < 1 OR p_limit > 500 OR p_stale_seconds < 30 THEN
        RAISE EXCEPTION 'file_blob_gc_claim: invalid bounds';
    END IF;
    UPDATE chat.file_blob_gc g
       SET status = 'failed', claim_token = NULL, claimed_at = NULL, next_attempt_at = now(),
           last_error = 'stale lease reclaimed', updated_at = now()
     WHERE g.status = 'running' AND g.claimed_at < now() - make_interval(secs => p_stale_seconds);

    FOR r IN
        SELECT g.blob_id
          FROM chat.file_blob_gc g
         WHERE g.status IN ('pending', 'failed') AND g.next_attempt_at <= now()
         ORDER BY g.next_attempt_at, g.blob_id
         LIMIT p_limit
           FOR UPDATE SKIP LOCKED
    LOOP
        -- 锁不到就跳过这一轮:正被人拿着(FOR SHARE)的 blob 本来就在用。❌ 等它 —— 拿着它的那一边可能接着要写这一行
        -- 队列(同一个事务里先用上 X、再让 X 失去一个引用,workspace_replace_file_as 换老文件就是这样),两边成环、死锁(复核 L11 实测)。
        PERFORM 1 FROM chat.file_blobs b WHERE b.id = r.blob_id FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN
            CONTINUE;
        END IF;
        v_held := chat.file_blob_held_until(r.blob_id);
        IF v_held = 'infinity' THEN
            -- The holding row's end enqueues the blob again.
            DELETE FROM chat.file_blob_gc g WHERE g.blob_id = r.blob_id;
            CONTINUE;
        ELSIF v_held IS NOT NULL THEN
            -- Nothing fires when a capability lapses: the job itself waits for it.
            UPDATE chat.file_blob_gc g SET next_attempt_at = v_held, updated_at = now() WHERE g.blob_id = r.blob_id;
            CONTINUE;
        END IF;
        UPDATE chat.file_blobs b SET state = 'deleting' WHERE b.id = r.blob_id;
        UPDATE chat.file_transfer_storage o SET state='deleting' WHERE o.blob_id=r.blob_id;
        v_token := gen_random_uuid();
        UPDATE chat.file_blob_gc g
           SET status = 'running', attempt_count = g.attempt_count + 1, claim_token = v_token,
               claimed_at = now(), last_error = NULL, updated_at = now()
         WHERE g.blob_id = r.blob_id;
        RETURN QUERY
        SELECT b.id, v_token, b.bucket_id, b.object_name, b.content_type, g.attempt_count
          FROM chat.file_blobs b JOIN chat.file_blob_gc g ON g.blob_id = b.id
         WHERE b.id = r.blob_id;
    END LOOP;
END;
$$;

-- Every bucket the collector removes from is a blob place; the attachments gc function already removes any Storage bucket.
ALTER TABLE chat.file_blobs DROP CONSTRAINT file_blobs_bucket_id_check;
ALTER TABLE chat.file_blobs ADD CONSTRAINT file_blobs_bucket_id_check
    CHECK(bucket_id IN ('oss','temporary','workspace','avatars','chat-media','attachments'));

-- The blob for an existing Storage object, registered on first need.
CREATE FUNCTION chat.file_blob_for_object(p_bucket text, p_name text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
    WITH added AS (
        INSERT INTO chat.file_blobs(bucket_id,object_name,size_bytes,content_type)
        SELECT o.bucket_id,o.name,(o.metadata->>'size')::bigint,COALESCE(NULLIF(btrim(o.metadata->>'mimetype'),''),'application/octet-stream')
          FROM storage.objects o WHERE o.bucket_id=p_bucket AND o.name=p_name
        ON CONFLICT ON CONSTRAINT file_blobs_place_key DO NOTHING
        RETURNING id)
    SELECT id FROM added
    UNION ALL
    SELECT b.id FROM chat.file_blobs b WHERE b.bucket_id=p_bucket AND b.object_name=p_name
$$;

DO $erase$
DECLARE definition text;
    before_text text := $old$    INSERT INTO identity.storage_object_deletion_outbox (bucket_id, name)
    SELECT o.bucket_id, o.name
    FROM storage.objects o$old$;
    after_text text := $new$    -- Unreferenced objects of the erased identities go to the one collector, like any other lost reference.
    PERFORM chat.file_blob_enqueue(chat.file_blob_for_object(o.bucket_id, o.name))
    FROM storage.objects o$new$;
    tail_before text := $old$      AND NOT identity.storage_object_is_referenced(o.bucket_id, o.name)
    ON CONFLICT (bucket_id, name) DO NOTHING;$old$;
    tail_after text := $new$      AND NOT identity.storage_object_is_referenced(o.bucket_id, o.name);$new$;
BEGIN
    SELECT pg_get_functiondef('identity.erase_human_account(text)'::regprocedure) INTO definition;
    IF position(before_text IN definition)=0 OR position(tail_before IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected predecessor: identity.erase_human_account(text)';
    END IF;
    EXECUTE replace(replace(definition,before_text,after_text),tail_before,tail_after);
END $erase$;

-- Stock: what the outbox still holds moves to the collector, which re-checks references before deleting.
SELECT chat.file_blob_enqueue(chat.file_blob_for_object(x.bucket_id, x.name))
  FROM identity.storage_object_deletion_outbox x
  JOIN storage.objects o ON o.bucket_id=x.bucket_id AND o.name=x.name;
DROP TABLE identity.storage_object_deletion_outbox, identity.storage_object_deletion_audit;
COMMENT ON TABLE chat.file_blob_gc IS 'The one collection queue for stored bytes: a blob enters when it loses a holder (any lost-reference trigger, an expiry step, account erasure); chat.file_blob_gc_claim re-judges it with chat.file_blob_held_until and drops, defers or collects it.';

-- Stock: a blob not held by an enqueuing row must have a job. Jobs dropped while only a capability held the blob come back.
SELECT chat.file_blob_enqueue(b.id)
  FROM chat.file_blobs b
 WHERE b.state='live'
   AND NOT EXISTS(SELECT 1 FROM chat.file_blob_gc g WHERE g.blob_id=b.id)
   AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_storage o WHERE o.blob_id=b.id AND o.state='gone')
   AND chat.file_blob_held_until(b.id) IS DISTINCT FROM 'infinity';

REVOKE ALL ON FUNCTION chat.file_blob_held_until(uuid),chat.file_blob_for_object(text,text) FROM PUBLIC,anon,authenticated;
-- The installation DDL guard closes replaced functions too; restore only their existing API grants.
GRANT EXECUTE ON FUNCTION chat.file_blob_gc_claim(integer,integer) TO service_role;
