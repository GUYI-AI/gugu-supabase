-- Metadata describes the readable version, not just a reclaimed cloud copy.
-- These closed predicates never sign, download, renew activity or release bytes.
CREATE FUNCTION chat.file_blob_availability(p_blob uuid,p_chat text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE b chat.file_blobs%ROWTYPE; g text:=chat.file_transfer_group(p_chat); expired timestamptz;
BEGIN
    SELECT * INTO b FROM chat.file_blobs WHERE id=p_blob;
    IF NOT FOUND THEN RETURN jsonb_build_object('availability','unavailable','expired_at',NULL); END IF;
    IF b.state='live' AND (
        NOT EXISTS(SELECT 1 FROM chat.file_transfer_storage WHERE blob_id=b.id)
        OR EXISTS(SELECT 1 FROM chat.file_transfer_storage o JOIN chat.file_transfer_storage_refs r ON r.storage_id=o.id
            WHERE o.blob_id=b.id AND o.state='ready' AND r.chat_id=g AND r.expired_at IS NULL
              AND (r.expires_at IS NULL OR r.expires_at>now()))) THEN
        RETURN jsonb_build_object('availability','available','expired_at',NULL);
    END IF;
    SELECT max(COALESCE(r.expired_at,r.expires_at)) INTO expired
      FROM chat.file_transfer_storage o JOIN chat.file_transfer_storage_refs r ON r.storage_id=o.id
     WHERE o.blob_id=b.id AND r.chat_id=g
       AND (r.expired_at IS NOT NULL OR r.expires_at<=now());
    IF expired IS NOT NULL THEN
        RETURN jsonb_build_object('availability','expired','expired_at',
            to_char(expired AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
    END IF;
    -- A physical absence has no implicit cause. Without explicit expiry/deletion
    -- evidence, do not invent either a deadline or a user's deletion action.
    RETURN jsonb_build_object('availability','unavailable','expired_at',NULL);
END $$;

CREATE FUNCTION chat.workspace_version_availability(p_item uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE w chat.workspace_items%ROWTYPE; v chat.workspace_item_versions%ROWTYPE;
BEGIN
    SELECT * INTO w FROM chat.workspace_items WHERE id=p_item;
    IF NOT FOUND THEN RETURN jsonb_build_object('availability','unavailable','expired_at',NULL); END IF;
    p_version:=COALESCE(p_version,w.version);
    IF p_version=w.version AND w.kind IN ('folder','document') THEN
        RETURN jsonb_build_object('availability','available','expired_at',NULL);
    END IF;
    SELECT * INTO v FROM chat.workspace_item_versions WHERE item_id=p_item AND n=p_version;
    IF FOUND AND v.host_project_id IS NOT NULL THEN
        IF EXISTS(SELECT 1 FROM identity.gugu_devices WHERE device_id=v.host_device_id)
          AND (v.host_project_id='device-store' OR EXISTS(SELECT 1 FROM identity.device_projects
              WHERE device_id=v.host_device_id AND local_project_id=v.host_project_id AND chat_id=w.chat_id)) THEN
            RETURN jsonb_build_object('availability','available','expired_at',NULL);
        END IF;
        RETURN jsonb_build_object('availability','unavailable','expired_at',NULL);
    END IF;
    IF v.inline_text IS NOT NULL THEN RETURN jsonb_build_object('availability','available','expired_at',NULL); END IF;
    RETURN chat.file_blob_availability(COALESCE(v.blob_id,CASE WHEN p_version=w.version THEN w.blob_id END),w.chat_id);
END $$;
ALTER FUNCTION chat.file_blob_availability(uuid,text) OWNER TO postgres;
ALTER FUNCTION chat.workspace_version_availability(uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_blob_availability(uuid,text),chat.workspace_version_availability(uuid,integer)
    FROM PUBLIC,anon,authenticated,service_role;

-- Preserve the original readers, authorization, ordering, limits and old columns.
-- Closed bases run paging first, so status work is bounded by returned rows.
-- Existing database dependencies keep the old result type/OID; Data API callers
-- keep their public names and receive only the two appended fields.
DO $readers$
DECLARE r record; signature regprocedure; definition text; result text; base_name text; volatility text;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('workspace_list_as','text,text,integer,integer,text,text,text,boolean',
         'p_chat_id text,p_as_user_id text,p_offset integer DEFAULT 0,p_limit integer DEFAULT NULL,p_name text DEFAULT NULL,p_kind text DEFAULT NULL,p_folder text DEFAULT NULL,p_exact boolean DEFAULT false',
         'p_chat_id,p_as_user_id,p_offset,p_limit,p_name,p_kind,p_folder,p_exact','b.id,b.version'),
        ('workspace_get_as','text,text','p_item_id text,p_as_user_id text','p_item_id,p_as_user_id','b.id,b.version'),
        ('workspace_search','text,text[],integer,text','p_query text DEFAULT NULL,p_suffixes text[] DEFAULT NULL,p_limit integer DEFAULT 50,p_as_user_id text DEFAULT NULL',
         'p_query,p_suffixes,p_limit,p_as_user_id','b.id,b.version'),
        ('workspace_recent','integer,text','p_limit integer DEFAULT 50,p_as_user_id text DEFAULT NULL','p_limit,p_as_user_id','b.id,b.version'),
        ('workspace_versions_as','text,text','p_item_id text,p_as_user_id text','p_item_id,p_as_user_id','p_item_id::uuid,b.n')
    ) AS readers(name,types,args,inputs,version_ref) LOOP
        signature:=('chat.'||r.name||'('||r.types||')')::regprocedure;
        SELECT pg_get_function_result(oid),CASE provolatile WHEN 's' THEN 'STABLE' WHEN 'v' THEN 'VOLATILE' END
          INTO result,volatility FROM pg_proc WHERE oid=signature;
        IF result NOT LIKE 'TABLE(%)' OR result LIKE '%, availability %' OR volatility IS NULL THEN
            RAISE EXCEPTION 'Unexpected workspace availability reader predecessor';
        END IF;
        result:=left(result,length(result)-1)||', availability text, expired_at timestamp with time zone)';
        base_name:=r.name||'_availability_base';
        EXECUTE format('ALTER FUNCTION %s RENAME TO %I',signature,base_name);
        EXECUTE format('ALTER FUNCTION chat.%I(%s) OWNER TO postgres',base_name,r.types);
        EXECUTE format('REVOKE ALL ON FUNCTION chat.%I(%s) FROM PUBLIC,anon,authenticated,service_role',base_name,r.types);
        definition:=format('SELECT b.*,a.value->>''availability'',(a.value->>''expired_at'')::timestamptz
            FROM chat.%I(%s) b CROSS JOIN LATERAL
            (SELECT chat.workspace_version_availability(%s) AS value OFFSET 0) a',base_name,r.inputs,r.version_ref);
        EXECUTE format('CREATE FUNCTION chat.%I(%s) RETURNS %s LANGUAGE sql %s SECURITY DEFINER SET search_path='''' AS %L',
            r.name,r.args,result,volatility,definition);
        EXECUTE format('ALTER FUNCTION chat.%I(%s) OWNER TO postgres',r.name,r.types);
        EXECUTE format('REVOKE ALL ON FUNCTION chat.%I(%s) FROM PUBLIC,anon,authenticated,service_role',r.name,r.types);
        EXECUTE format('GRANT EXECUTE ON FUNCTION chat.%I(%s) TO authenticated',r.name,r.types);
    END LOOP;
END $readers$;

-- Message views bind the resolver's OID. Keep that OID and its JSON result type,
-- so their existing projections use the new metadata without gaining a second
-- API-callable resolver or losing permission to resolve an attachment.
DO $resolver$
DECLARE definition text:=pg_get_functiondef('chat.file_resolve_as(jsonb,text)'::regprocedure);
BEGIN
    IF position('CREATE OR REPLACE FUNCTION chat.file_resolve_as(' IN definition)<>1 THEN
        RAISE EXCEPTION 'Unexpected file resolver predecessor';
    END IF;
    EXECUTE replace(definition,'CREATE OR REPLACE FUNCTION chat.file_resolve_as(',
        'CREATE FUNCTION chat.file_resolve_availability_base(');
END $resolver$;
ALTER FUNCTION chat.file_resolve_availability_base(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_resolve_availability_base(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION chat.file_resolve_as(p_ref jsonb,p_as text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; state jsonb:=jsonb_build_object('availability','unavailable','expired_at',NULL);
    actor text:=chat.workspace_actor_for(p_as); item chat.workspace_items%ROWTYPE; blob uuid; version integer; hint text;
BEGIN
    result:=chat.file_resolve_availability_base(p_ref,p_as);
    IF result->>'source'='local' AND result->>'status'='ready' THEN
        state:=jsonb_build_object('availability','available','expired_at',NULL);
    ELSIF p_ref ? 'item_id' THEN
        -- Recheck through the same room/member door before consulting a closed
        -- predicate, including the old resolver's unavailable-version result.
        BEGIN item:=chat.workspace_item_for(p_ref->>'item_id',actor,false);
        EXCEPTION WHEN raise_exception THEN
            GET STACKED DIAGNOSTICS hint=PG_EXCEPTION_HINT;
            IF hint='workspace_item_not_found' THEN RETURN result||state; END IF;
            RAISE;
        END;
        state:=chat.workspace_version_availability(item.id,COALESCE((p_ref->>'version')::integer,item.version));
    ELSIF p_ref ? 'message_id' AND chat.can_read_message(p_ref->>'message_id',actor) THEN
        SELECT file_item_id,file_version,file_blob_id INTO item.id,version,blob FROM chat.messages
         WHERE id=p_ref->>'message_id' AND retracted_at IS NULL;
        IF item.id IS NOT NULL THEN state:=chat.workspace_version_availability(item.id,version);
        ELSIF result->>'source'='managed-object' THEN state:=chat.file_blob_availability(blob,result->>'chat_id'); END IF;
    ELSIF result->>'source'='managed-object' THEN
        SELECT id INTO blob FROM chat.file_blobs WHERE bucket_id=result->>'bucket_id' AND object_name=result->>'object_name';
        state:=chat.file_blob_availability(blob,result->>'chat_id');
    END IF;
    RETURN result||state;
END $$;
ALTER FUNCTION chat.file_resolve_as(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_resolve_as(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.file_resolve_as(jsonb,text) TO authenticated;
NOTIFY pgrst,'reload schema';
