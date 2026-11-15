-- Audit committed retention actions at the shared write door. Rejected/rolled-
-- back calls belong to separate Edge/gateway logs, not this successful-action log.
CREATE TABLE file_private.storage_action_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    actor_user_id text,
    effective_actor_id text,
    action text NOT NULL CHECK(action IN ('temporary','permanent','release')),
    entrypoint text NOT NULL DEFAULT 'file_storage_mark_as' CHECK(entrypoint='file_storage_mark_as'),
    requested_ref_count integer NOT NULL CHECK(requested_ref_count BETWEEN 1 AND 500),
    requested_item_ids uuid[] NOT NULL DEFAULT '{}',
    requested_message_ids text[] NOT NULL DEFAULT '{}',
    requested_classes text[] NOT NULL DEFAULT '{}',
    changed_copy_count integer NOT NULL DEFAULT 0 CHECK(changed_copy_count>=0),
    backend_pid integer DEFAULT pg_backend_pid(),
    transaction_id xid8 DEFAULT pg_current_xact_id()
);
CREATE INDEX storage_action_audit_time ON file_private.storage_action_audit(occurred_at,id);
CREATE TABLE file_private.storage_action_audit_items (
    operation_id uuid NOT NULL REFERENCES file_private.storage_action_audit(id) ON DELETE CASCADE,
    change_no bigint NOT NULL,
    storage_id uuid,
    blob_id uuid,
    chat_id text,
    before_expires_at timestamptz,
    after_expires_at timestamptz,
    before_expired_at timestamptz,
    after_expired_at timestamptz,
    item_ids uuid[] NOT NULL DEFAULT '{}',
    versions integer[] NOT NULL DEFAULT '{}',
    PRIMARY KEY(operation_id,change_no),
    CHECK(cardinality(item_ids)=cardinality(versions))
);
-- No user/file foreign keys: deleting a source cannot erase the audit trail.
-- Actor de-identification is a separate approved erasure policy, never implicit
-- permanent retention of the original account/agent identifier.
ALTER TABLE file_private.storage_action_audit OWNER TO postgres;
ALTER TABLE file_private.storage_action_audit_items OWNER TO postgres;
ALTER TABLE file_private.storage_action_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_private.storage_action_audit_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON file_private.storage_action_audit,file_private.storage_action_audit_items FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION file_private.collect_storage_action_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE context text:=current_setting('gugu.storage_audit_operation',true); operation uuid; base bigint;
BEGIN
    IF context IS NULL OR context='' THEN RETURN NULL; END IF;
    operation:=context::uuid;
    IF NOT EXISTS(SELECT 1 FROM file_private.storage_action_audit a WHERE a.id=operation
        AND a.backend_pid=pg_backend_pid() AND a.transaction_id=pg_current_xact_id()
        AND a.actor_user_id=auth.uid()::text) THEN
        RAISE EXCEPTION 'Invalid storage action audit context' USING HINT='file_storage_audit_invalid';
    END IF;
    SELECT COALESCE(max(change_no),0) INTO base FROM file_private.storage_action_audit_items WHERE operation_id=operation;
    -- Transition relations are the trigger's statement-local OLD/NEW tables.
    -- Capture even equal-value updates (a retry). The expiry consumer changes
    -- expired_at, so its unrelated overdue copies are not attributed to a user.
    WITH changed AS MATERIALIZED (
        SELECT fresh.storage_id,fresh.chat_id,o.blob_id,o.bucket_id,o.object_name,prior.expires_at AS before_expires_at,
            fresh.expires_at AS after_expires_at,prior.expired_at AS before_expired_at,fresh.expired_at AS after_expired_at
        FROM storage_audit_old_refs prior JOIN storage_audit_new_refs fresh USING(storage_id,chat_id)
        JOIN chat.file_transfer_storage o ON o.id=fresh.storage_id
        WHERE prior.expired_at IS NOT DISTINCT FROM fresh.expired_at
    ), links AS MATERIALIZED (
        SELECT changed.storage_id,changed.chat_id,v.item_id,v.n
        FROM changed JOIN chat.workspace_item_versions v ON v.blob_id=changed.blob_id
        JOIN chat.workspace_items w ON w.id=v.item_id JOIN chat.chats room ON room.id=w.chat_id
        WHERE COALESCE(room.source_chat_id,room.id)=changed.chat_id
        UNION
        SELECT changed.storage_id,changed.chat_id,t.item_id,t.version
        FROM changed JOIN chat.file_temporary_transfers t ON changed.bucket_id='temporary'
            AND t.object_name=changed.object_name AND t.blob_id=changed.blob_id
        WHERE chat.file_transfer_group(t.chat_id)=changed.chat_id
    ), grouped AS (
        SELECT storage_id,chat_id,array_agg(item_id ORDER BY item_id,n) AS item_ids,array_agg(n ORDER BY item_id,n) AS versions
        FROM links GROUP BY storage_id,chat_id
    )
    INSERT INTO file_private.storage_action_audit_items(operation_id,change_no,storage_id,blob_id,chat_id,
        before_expires_at,after_expires_at,before_expired_at,after_expired_at,item_ids,versions)
    SELECT operation,base+row_number() OVER(ORDER BY changed.storage_id,changed.chat_id),changed.storage_id,changed.blob_id,changed.chat_id,
        changed.before_expires_at,changed.after_expires_at,changed.before_expired_at,changed.after_expired_at,
        COALESCE(grouped.item_ids,'{}'::uuid[]),COALESCE(grouped.versions,'{}'::integer[])
    FROM changed LEFT JOIN grouped USING(storage_id,chat_id);
    RETURN NULL;
END $$;
ALTER FUNCTION file_private.collect_storage_action_audit() OWNER TO postgres;
REVOKE ALL ON FUNCTION file_private.collect_storage_action_audit() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER storage_action_audit_changes AFTER UPDATE ON chat.file_transfer_storage_refs
REFERENCING OLD TABLE AS storage_audit_old_refs NEW TABLE AS storage_audit_new_refs
FOR EACH STATEMENT EXECUTE FUNCTION file_private.collect_storage_action_audit();

-- Preserve the original write implementation and the public function's OID.
-- All actual authorization, class expansion and expiry/GC work stays there.
DO $base$
DECLARE definition text:=pg_get_functiondef('chat.file_storage_mark_as(jsonb,text,text)'::regprocedure);
BEGIN
    IF position('CREATE OR REPLACE FUNCTION chat.file_storage_mark_as(' IN definition)<>1
       OR position('UPDATE chat.file_transfer_storage_refs ref SET expires_at=' IN definition)=0
       OR position('IF p_action=''release'' THEN PERFORM chat.file_transfer_expire(500); END IF;' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected storage action predecessor';
    END IF;
    EXECUTE replace(definition,'CREATE OR REPLACE FUNCTION chat.file_storage_mark_as(',
        'CREATE FUNCTION file_private.storage_mark_audit_base(');
END $base$;
ALTER FUNCTION file_private.storage_mark_audit_base(jsonb,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION file_private.storage_mark_audit_base(jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION chat.file_storage_mark_as(p_refs jsonb,p_action text,p_as text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE me text:=auth.uid()::text; actor text; operation uuid; n integer; owner_subject text;
    previous text:=current_setting('gugu.storage_audit_operation',true);
BEGIN
    -- Same outer refusal contract as the original; per-reference authorization
    -- and all mutations are still performed by the unchanged closed base.
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING HINT='file_transfer_denied'; END IF;
    SELECT CASE WHEN u.type='human' THEN u.id ELSE u.owner_user_id END INTO owner_subject
    FROM identity.users u WHERE u.id=me;
    IF owner_subject IS NULL THEN RAISE EXCEPTION 'Account is unavailable' USING HINT='file_transfer_denied'; END IF;
    -- The Auth eraser takes the exclusive lock on this existing owner key. Let
    -- in-flight actions commit first, and refuse a late JWT after erasure wins.
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('identity:erase-human:'||owner_subject,0));
    -- Lock the current identity tuple too: an old REPEATABLE READ snapshot must
    -- serialize/fail after removal, not recreate an original-ID audit record.
    PERFORM 1 FROM identity.users u WHERE u.id=me AND u.removed_at IS NULL
        AND CASE WHEN u.type='human' THEN u.id ELSE u.owner_user_id END=owner_subject
        FOR KEY SHARE OF u;
    IF NOT FOUND OR NOT identity.user_is_live(me) THEN
        RAISE EXCEPTION 'Account is unavailable' USING HINT='file_transfer_denied';
    END IF;
    actor:=chat.workspace_actor_for(COALESCE(p_as,me));
    IF p_action IS NULL OR p_action NOT IN ('temporary','permanent','release') THEN
        RAISE EXCEPTION 'Invalid file storage action' USING HINT='file_transfer_invalid';
    END IF;
    IF jsonb_typeof(p_refs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_refs) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'Give 1 to 500 file references' USING HINT='file_transfer_invalid';
    END IF;
    INSERT INTO file_private.storage_action_audit(actor_user_id,effective_actor_id,action,requested_ref_count)
    VALUES(me,actor,p_action,jsonb_array_length(p_refs)) RETURNING id INTO operation;
    PERFORM set_config('gugu.storage_audit_operation',operation::text,true);
    n:=file_private.storage_mark_audit_base(p_refs,p_action,p_as);
    PERFORM set_config('gugu.storage_audit_operation',COALESCE(previous,''),true);
    UPDATE file_private.storage_action_audit SET changed_copy_count=n,backend_pid=NULL,transaction_id=NULL,
        requested_item_ids=ARRAY(SELECT DISTINCT (r->>'item_id')::uuid FROM jsonb_array_elements(p_refs) r WHERE r ? 'item_id'),
        requested_message_ids=ARRAY(SELECT DISTINCT r->>'message_id' FROM jsonb_array_elements(p_refs) r WHERE r ? 'message_id'),
        requested_classes=ARRAY(SELECT DISTINCT r->>'class' FROM jsonb_array_elements(p_refs) r WHERE r ? 'class')
    WHERE id=operation;
    -- A release can have immediately expired its marked copies. Only update
    -- those captured targets; the consumer's unrelated work stays outside.
    UPDATE file_private.storage_action_audit_items a SET after_expired_at=r.expired_at
    FROM chat.file_transfer_storage_refs r WHERE a.operation_id=operation AND a.storage_id=r.storage_id AND a.chat_id=r.chat_id;
    RETURN n;
EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('gugu.storage_audit_operation',COALESCE(previous,''),true);
    RAISE;
END $$;
ALTER FUNCTION chat.file_storage_mark_as(jsonb,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_storage_mark_as(jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.file_storage_mark_as(jsonb,text,text) TO authenticated;

-- Closed integration contract. The unified Auth erasure migration calls this
-- before deleting its lifecycle context; this release does not wire that hook.
CREATE FUNCTION file_private.erase_storage_action_audit(p_ids text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE erased_actor text:='erased:'||gen_random_uuid()::text; normalized text[]; patterns text[];
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids)=0 OR EXISTS(SELECT 1 FROM unnest(p_ids) id WHERE id IS NULL OR id='')
       OR NOT EXISTS(SELECT 1 FROM identity.account_lifecycle_context c
           WHERE c.transaction_id=pg_current_xact_id() AND c.operation='privacy_erasure' AND c.delete_user_ids=p_ids) THEN
        RAISE EXCEPTION 'Storage action erasure requires the auth deletion transaction' USING ERRCODE='42501';
    END IF;
    normalized:=ARRAY(SELECT lower(id) FROM unnest(p_ids) id);
    -- Literal LIKE fragments: identifiers containing %, _ or a backslash must
    -- never turn into wildcard instructions. No reverse identity map is kept.
    patterns:=ARRAY(SELECT '%'||replace(replace(replace(id,chr(92),chr(92)||chr(92)),
        '%',chr(92)||'%'),'_',chr(92)||'_')||'%' FROM unnest(normalized) id);
    UPDATE file_private.storage_action_audit a SET
        actor_user_id=CASE WHEN lower(a.actor_user_id)=ANY(normalized) THEN erased_actor ELSE a.actor_user_id END,
        effective_actor_id=CASE WHEN lower(a.effective_actor_id)=ANY(normalized) THEN erased_actor ELSE a.effective_actor_id END,
        requested_item_ids=ARRAY(SELECT id FROM unnest(a.requested_item_ids) id WHERE NOT (lower(id::text) LIKE ANY(patterns))),
        requested_message_ids=ARRAY(SELECT id FROM unnest(a.requested_message_ids) id WHERE NOT (lower(id) LIKE ANY(patterns)))
    WHERE lower(a.actor_user_id)=ANY(normalized) OR lower(a.effective_actor_id)=ANY(normalized)
       OR EXISTS(SELECT 1 FROM unnest(a.requested_item_ids) id WHERE lower(id::text) LIKE ANY(patterns))
       OR EXISTS(SELECT 1 FROM unnest(a.requested_message_ids) id WHERE lower(id) LIKE ANY(patterns));
    UPDATE file_private.storage_action_audit_items a SET
        storage_id=CASE WHEN lower(a.storage_id::text) LIKE ANY(patterns) THEN NULL ELSE a.storage_id END,
        blob_id=CASE WHEN lower(a.blob_id::text) LIKE ANY(patterns) THEN NULL ELSE a.blob_id END,
        chat_id=CASE WHEN lower(a.chat_id) LIKE ANY(patterns) THEN NULL ELSE a.chat_id END,
        item_ids=ARRAY(SELECT item FROM unnest(a.item_ids,a.versions) WITH ORDINALITY pair(item,version,n)
            WHERE NOT (lower(item::text) LIKE ANY(patterns)) ORDER BY n),
        versions=ARRAY(SELECT version FROM unnest(a.item_ids,a.versions) WITH ORDINALITY pair(item,version,n)
            WHERE NOT (lower(item::text) LIKE ANY(patterns)) ORDER BY n)
    WHERE lower(a.storage_id::text) LIKE ANY(patterns) OR lower(a.blob_id::text) LIKE ANY(patterns)
       OR lower(a.chat_id) LIKE ANY(patterns)
       OR EXISTS(SELECT 1 FROM unnest(a.item_ids) id WHERE lower(id::text) LIKE ANY(patterns));
END $$;
ALTER FUNCTION file_private.erase_storage_action_audit(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION file_private.erase_storage_action_audit(text[]) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION file_private.prune_storage_action_audit(p_limit integer DEFAULT 1000) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n integer;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid audit cleanup limit'; END IF;
    -- Bound detail work too: a class action can have many copies. A parent is
    -- removed only after its expired details have drained, never by an unbounded
    -- cascade in a supposedly small header batch.
    WITH expired_items AS (
        SELECT i.operation_id,i.change_no FROM file_private.storage_action_audit_items i
        JOIN file_private.storage_action_audit a ON a.id=i.operation_id
        WHERE a.occurred_at<now()-interval '180 days'
        ORDER BY a.occurred_at,a.id,i.change_no FOR UPDATE OF i SKIP LOCKED LIMIT p_limit
    )
    DELETE FROM file_private.storage_action_audit_items i USING expired_items old
    WHERE i.operation_id=old.operation_id AND i.change_no=old.change_no;
    WITH expired AS (
        SELECT a.id FROM file_private.storage_action_audit a WHERE a.occurred_at<now()-interval '180 days'
          AND NOT EXISTS(SELECT 1 FROM file_private.storage_action_audit_items i WHERE i.operation_id=a.id)
        ORDER BY a.occurred_at,a.id FOR UPDATE SKIP LOCKED LIMIT p_limit
    )
    DELETE FROM file_private.storage_action_audit a USING expired WHERE a.id=expired.id;
    GET DIAGNOSTICS n=ROW_COUNT;
    RETURN n;
END $$;
ALTER FUNCTION file_private.prune_storage_action_audit(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION file_private.prune_storage_action_audit(integer) FROM PUBLIC,anon,authenticated,service_role;
SELECT cron.schedule('file-storage-audit-prune','*/10 * * * *','SELECT file_private.prune_storage_action_audit(1000);');
NOTIFY pgrst,'reload schema';
