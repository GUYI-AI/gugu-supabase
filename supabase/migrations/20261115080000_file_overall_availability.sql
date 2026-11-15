-- Metadata describes the readable version, not just a reclaimed cloud copy.
-- One batch shares the joins across a returned page; scalar resolution calls the
-- same predicate with one source. No signing, downloads, TTL or activity writes.
CREATE FUNCTION chat.file_availability_batch(p_items uuid[],p_versions integer[],p_blobs uuid[] DEFAULT NULL,p_chats text[] DEFAULT NULL)
RETURNS TABLE(ordinality bigint,availability text,expired_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    WITH requested AS MATERIALIZED (
        SELECT * FROM unnest(p_items,p_versions,p_blobs,p_chats) WITH ORDINALITY AS r(item_id,version,blob_id,chat_id,ordinality)
    ), sources AS MATERIALIZED (
        SELECT r.ordinality,r.item_id AS requested_item,w.id AS found_item,w.kind,w.version AS current_version,
            COALESCE(r.version,w.version) AS wanted_version,v.inline_text,v.host_project_id,
            d.device_id,dp.local_project_id AS bound_project,
            COALESCE(r.blob_id,v.blob_id,CASE WHEN COALESCE(r.version,w.version)=w.version THEN w.blob_id END) AS blob_id,
            COALESCE(c.source_chat_id,c.id) AS transfer_group
        FROM requested r
        LEFT JOIN chat.workspace_items w ON w.id=r.item_id
        LEFT JOIN chat.workspace_item_versions v ON v.item_id=w.id AND v.n=COALESCE(r.version,w.version)
        LEFT JOIN identity.gugu_devices d ON d.device_id=v.host_device_id
        LEFT JOIN identity.device_projects dp ON dp.device_id=v.host_device_id AND dp.local_project_id=v.host_project_id AND dp.chat_id=w.chat_id
        LEFT JOIN chat.chats c ON c.id=COALESCE(w.chat_id,r.chat_id)
    ), wanted_blobs AS MATERIALIZED (
        SELECT DISTINCT blob_id,transfer_group FROM sources WHERE blob_id IS NOT NULL
    ), ledger AS (
        SELECT wanted.blob_id,wanted.transfer_group,count(o.id) AS copies,
            bool_or(o.state='ready' AND ref.storage_id IS NOT NULL AND ref.expired_at IS NULL
                AND (ref.expires_at IS NULL OR ref.expires_at>now())) AS readable,
            max(COALESCE(ref.expired_at,ref.expires_at)) FILTER (WHERE ref.expired_at IS NOT NULL OR ref.expires_at<=now()) AS expired
        FROM wanted_blobs wanted
        LEFT JOIN chat.file_transfer_storage o ON o.blob_id=wanted.blob_id
        LEFT JOIN chat.file_transfer_storage_refs ref ON ref.storage_id=o.id AND ref.chat_id=wanted.transfer_group
        GROUP BY wanted.blob_id,wanted.transfer_group
    ), decisions AS (
        SELECT s.ordinality,CASE
            WHEN s.requested_item IS NOT NULL AND s.found_item IS NULL THEN 'unavailable'
            WHEN s.wanted_version=s.current_version AND s.kind IN ('folder','document') THEN 'available'
            WHEN s.host_project_id IS NOT NULL THEN CASE WHEN s.device_id IS NOT NULL
                AND (s.host_project_id='device-store' OR s.bound_project IS NOT NULL) THEN 'available' ELSE 'unavailable' END
            WHEN s.inline_text IS NOT NULL THEN 'available'
            WHEN b.id IS NULL THEN 'unavailable'
            WHEN b.state='live' AND (l.copies=0 OR l.readable) THEN 'available'
            WHEN l.expired IS NOT NULL THEN 'expired'
            -- Physical absence has no implicit expiry or deliberate-deletion cause.
            ELSE 'unavailable' END AS availability,l.expired
        FROM sources s LEFT JOIN chat.file_blobs b ON b.id=s.blob_id
        LEFT JOIN ledger l ON l.blob_id=s.blob_id AND l.transfer_group IS NOT DISTINCT FROM s.transfer_group
    )
    SELECT d.ordinality,d.availability,CASE WHEN d.availability='expired' THEN d.expired END FROM decisions d
$$;
CREATE FUNCTION chat.file_blob_availability(p_blob uuid,p_chat text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT jsonb_build_object('availability',a.availability,'expired_at',
        to_char(a.expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    FROM chat.file_availability_batch(ARRAY[NULL::uuid],ARRAY[NULL::integer],ARRAY[p_blob],ARRAY[p_chat]) a
$$;
CREATE FUNCTION chat.workspace_version_availability(p_item uuid,p_version integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT jsonb_build_object('availability',a.availability,'expired_at',
        to_char(a.expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    FROM chat.file_availability_batch(ARRAY[p_item],ARRAY[p_version]) a
$$;
ALTER FUNCTION chat.file_availability_batch(uuid[],integer[],uuid[],text[]) OWNER TO postgres;
ALTER FUNCTION chat.file_blob_availability(uuid,text) OWNER TO postgres;
ALTER FUNCTION chat.workspace_version_availability(uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_availability_batch(uuid[],integer[],uuid[],text[]),
    chat.file_blob_availability(uuid,text),chat.workspace_version_availability(uuid,integer)
    FROM PUBLIC,anon,authenticated,service_role;

-- Preserve the original readers, authorization, ordering, limits and old columns.
-- Closed bases run paging first, so status work is bounded by returned rows.
-- Existing database dependencies keep the old result type/OID; Data API callers
-- keep their public names and receive only the two appended fields.
DO $readers$
DECLARE r record; signature regprocedure; definition text; result text; base_name text; volatility text; projection text;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('workspace_list_as','text,text,integer,integer,text,text,text,boolean',
         'p_chat_id text,p_as_user_id text,p_offset integer DEFAULT 0,p_limit integer DEFAULT NULL,p_name text DEFAULT NULL,p_kind text DEFAULT NULL,p_folder text DEFAULT NULL,p_exact boolean DEFAULT false',
         'p_chat_id,p_as_user_id,p_offset,p_limit,p_name,p_kind,p_folder,p_exact','p.id','p.version'),
        ('workspace_get_as','text,text','p_item_id text,p_as_user_id text','p_item_id,p_as_user_id','p.id','p.version'),
        ('workspace_search','text,text[],integer,text','p_query text DEFAULT NULL,p_suffixes text[] DEFAULT NULL,p_limit integer DEFAULT 50,p_as_user_id text DEFAULT NULL',
         'p_query,p_suffixes,p_limit,p_as_user_id','p.id','p.version'),
        ('workspace_recent','integer,text','p_limit integer DEFAULT 50,p_as_user_id text DEFAULT NULL','p_limit,p_as_user_id','p.id','p.version'),
        ('workspace_versions_as','text,text','p_item_id text,p_as_user_id text','p_item_id,p_as_user_id','p_item_id::uuid','p.n')
    ) AS readers(name,types,args,inputs,item_ref,version_ref) LOOP
        signature:=('chat.'||r.name||'('||r.types||')')::regprocedure;
        SELECT pg_get_function_result(oid),CASE provolatile WHEN 's' THEN 'STABLE' WHEN 'v' THEN 'VOLATILE' END
          INTO result,volatility FROM pg_proc WHERE oid=signature;
        IF result NOT LIKE 'TABLE(%)' OR result LIKE '%, availability %' OR volatility IS NULL THEN
            RAISE EXCEPTION 'Unexpected workspace availability reader predecessor';
        END IF;
        SELECT string_agg(format('p.%I',a.name),',' ORDER BY a.ordinality) INTO projection
          FROM pg_proc p CROSS JOIN LATERAL unnest(p.proargnames,p.proargmodes) WITH ORDINALITY a(name,mode,ordinality)
         WHERE p.oid=signature AND a.mode='t';
        result:=left(result,length(result)-1)||', availability text, expired_at timestamp with time zone)';
        base_name:=r.name||'_availability_base';
        EXECUTE format('ALTER FUNCTION %s RENAME TO %I',signature,base_name);
        EXECUTE format('ALTER FUNCTION chat.%I(%s) OWNER TO postgres',base_name,r.types);
        EXECUTE format('REVOKE ALL ON FUNCTION chat.%I(%s) FROM PUBLIC,anon,authenticated,service_role',base_name,r.types);
        definition:=format('WITH page AS MATERIALIZED (
            SELECT b.*,row_number() OVER () AS availability_ordinal FROM chat.%I(%s) b
        ), sources AS (
            SELECT array_agg(%s ORDER BY p.availability_ordinal) AS items,
                   array_agg(%s ORDER BY p.availability_ordinal) AS versions FROM page p
        )
        SELECT %s,a.availability,a.expired_at FROM sources s
        CROSS JOIN LATERAL chat.file_availability_batch(s.items,s.versions) a
        JOIN page p ON p.availability_ordinal=a.ordinality ORDER BY p.availability_ordinal',
            base_name,r.inputs,r.item_ref,r.version_ref,projection);
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
