-- Registered, bounded audit processing. Scheduling, the two scan rounds and
-- deletion of temporary identity conditions belong to the separate worker.
DO $prerequisites$
DECLARE name text;
BEGIN
    FOREACH name IN ARRAY ARRAY['identity.account_audit_redaction_jobs',
        'identity.account_audit_redaction_context'] LOOP
        IF to_regclass(name) IS NULL OR NOT EXISTS(SELECT 1 FROM pg_class c
            WHERE c.oid=to_regclass(name) AND c.relowner='postgres'::regrole AND c.relrowsecurity)
            OR has_table_privilege('anon',name,'SELECT,INSERT,UPDATE,DELETE')
            OR has_table_privilege('authenticated',name,'SELECT,INSERT,UPDATE,DELETE')
            OR has_table_privilege('service_role',name,'SELECT,INSERT,UPDATE,DELETE') THEN
            RAISE EXCEPTION 'Install the closed audit task registry before its batch helpers';
        END IF;
    END LOOP;
    IF to_regclass('file_private.storage_action_audit_items') IS NULL
       OR to_regprocedure('identity.auth_audit_redacted_payload(jsonb,text[],text)') IS NULL
       OR to_regprocedure('identity.assert_registered_audit_context(uuid,text[])') IS NULL THEN
        RAISE EXCEPTION 'Install both independent audit helpers before registered processing';
    END IF;
END $prerequisites$;

-- An explicit different actor/target ID protects that identity even when an
-- address has been reused. Unattributed target/provider fields also inherit a
-- different actor's protection; an explicit erased target remains independent
-- of an administrator actor. Opaque provider IDs are never email matches.
CREATE FUNCTION identity.registered_audit_redacted_payload(p_payload jsonb,p_ids text[],p_email text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE result jsonb:=p_payload; actor_id text; target_id text;
    actor_own boolean; target_own boolean; actor_other boolean; target_other boolean;
BEGIN
    IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RETURN p_payload; END IF;
    actor_id:=NULLIF(NULLIF(lower(btrim(p_payload->>'actor_id')),''),'00000000-0000-0000-0000-000000000000');
    target_id:=NULLIF(NULLIF(lower(btrim(p_payload#>>'{traits,user_id}')),''),'00000000-0000-0000-0000-000000000000');
    actor_own:=COALESCE(actor_id=ANY(p_ids),false);
    target_own:=COALESCE(target_id=ANY(p_ids),false);
    actor_other:=actor_id IS NOT NULL AND NOT actor_own;
    target_other:=target_id IS NOT NULL AND NOT target_own;
    IF actor_own OR (NOT actor_other AND p_email IS NOT NULL
        AND lower(btrim(p_payload->>'actor_username'))=p_email) THEN
        result:=result-'actor_username'-'actor_name';
    END IF;
    IF target_own OR (NOT target_other AND NOT (target_id IS NULL AND actor_other)
        AND p_email IS NOT NULL AND lower(btrim(p_payload#>>'{traits,user_email}'))=p_email) THEN
        result:=result#-'{traits,user_email}'#-'{traits,user_phone}';
    END IF;
    IF p_email IS NOT NULL AND p_payload#>>'{traits,provider}'='email'
        AND lower(btrim(p_payload#>>'{traits,provider_id}'))=p_email
        AND NOT target_other AND (target_own OR NOT actor_other) THEN
        result:=result#-'{traits,provider_id}';
    END IF;
    RETURN result;
END $$;

CREATE FUNCTION identity.redact_registered_auth_audit_batch(p_job_id uuid,p_limit integer DEFAULT 100)
RETURNS TABLE(scanned integer,locked integer,changed integer,next_id uuid,next_no bigint,exhausted boolean,blocked boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE job identity.account_audit_redaction_jobs%ROWTYPE; ids text[]; email text;
    page_ids uuid[]; locked_ids uuid[];
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'Invalid audit scan limit';
    END IF;
    job:=identity.assert_registered_audit_context(p_job_id,ARRAY['auth']);
    IF job.state<>'running' OR job.phase IS DISTINCT FROM 'auth' OR job.cursor_no IS NOT NULL THEN
        RAISE EXCEPTION 'Registered Auth audit phase does not match' USING ERRCODE='42501';
    END IF;
    ids:=ARRAY(SELECT lower(id) FROM unnest(job.delete_user_ids) id);
    email:=NULLIF(lower(btrim(job.auth_email)),'');
    page_ids:=ARRAY(SELECT a.id FROM auth.audit_log_entries a
        WHERE job.cursor_id IS NULL OR a.id>job.cursor_id ORDER BY a.id LIMIT p_limit);
    locked_ids:=ARRAY(SELECT a.id FROM auth.audit_log_entries a WHERE a.id=ANY(page_ids)
        ORDER BY a.id FOR UPDATE OF a SKIP LOCKED);
    scanned:=cardinality(page_ids); locked:=cardinality(locked_ids);
    UPDATE auth.audit_log_entries a
    SET payload=identity.registered_audit_redacted_payload(a.payload::jsonb,ids,email)::json
    WHERE a.id=ANY(locked_ids) AND a.payload::jsonb IS DISTINCT FROM
        identity.registered_audit_redacted_payload(a.payload::jsonb,ids,email);
    GET DIAGNOSTICS changed=ROW_COUNT;
    blocked:=locked<scanned;
    next_id:=CASE WHEN blocked OR scanned=0 THEN job.cursor_id ELSE page_ids[scanned] END;
    next_no:=NULL; exhausted:=NOT blocked AND scanned<p_limit;
    PERFORM identity.assert_registered_audit_context(p_job_id,ARRAY[job.phase]);
    RETURN NEXT;
END $$;

CREATE FUNCTION file_private.redact_registered_storage_audit_batch(p_job_id uuid,p_limit integer DEFAULT 100)
RETURNS TABLE(scanned integer,locked integer,changed integer,next_id uuid,next_no bigint,exhausted boolean,blocked boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE job identity.account_audit_redaction_jobs%ROWTYPE; ids text[]; patterns text[];
    page_ids uuid[]; page_nos bigint[]; locked_ids uuid[]; locked_nos bigint[];
    erased_actor text:='erased:'||gen_random_uuid()::text;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'Invalid audit scan limit';
    END IF;
    job:=identity.assert_registered_audit_context(p_job_id,ARRAY['file_headers','file_items']);
    IF job.state<>'running' OR job.phase IS NULL OR job.phase NOT IN ('file_headers','file_items')
       OR (job.phase='file_headers' AND job.cursor_no IS NOT NULL)
       OR (job.phase='file_items' AND (job.cursor_id IS NULL)<>(job.cursor_no IS NULL)) THEN
        RAISE EXCEPTION 'Registered file audit phase does not match' USING ERRCODE='42501';
    END IF;
    ids:=ARRAY(SELECT lower(id) FROM unnest(job.delete_user_ids) id);
    patterns:=ARRAY(SELECT '%'||replace(replace(replace(id,chr(92),chr(92)||chr(92)),
        '%',chr(92)||'%'),'_',chr(92)||'_')||'%' FROM unnest(ids) id);
    IF job.phase='file_headers' THEN
        page_ids:=ARRAY(SELECT a.id FROM file_private.storage_action_audit a
            WHERE job.cursor_id IS NULL OR a.id>job.cursor_id ORDER BY a.id LIMIT p_limit);
        locked_ids:=ARRAY(SELECT a.id FROM file_private.storage_action_audit a WHERE a.id=ANY(page_ids)
            ORDER BY a.id FOR UPDATE OF a SKIP LOCKED);
        scanned:=cardinality(page_ids); locked:=cardinality(locked_ids);
        UPDATE file_private.storage_action_audit a SET
            actor_user_id=CASE WHEN lower(a.actor_user_id)=ANY(ids) THEN erased_actor ELSE a.actor_user_id END,
            effective_actor_id=CASE WHEN lower(a.effective_actor_id)=ANY(ids) THEN erased_actor ELSE a.effective_actor_id END,
            requested_item_ids=ARRAY(SELECT id FROM unnest(a.requested_item_ids) id
                WHERE NOT (lower(id::text) LIKE ANY(patterns))),
            requested_message_ids=ARRAY(SELECT id FROM unnest(a.requested_message_ids) id
                WHERE NOT (lower(id) LIKE ANY(patterns)))
        WHERE a.id=ANY(locked_ids) AND (lower(a.actor_user_id)=ANY(ids) OR lower(a.effective_actor_id)=ANY(ids)
            OR EXISTS(SELECT 1 FROM unnest(a.requested_item_ids) id WHERE lower(id::text) LIKE ANY(patterns))
            OR EXISTS(SELECT 1 FROM unnest(a.requested_message_ids) id WHERE lower(id) LIKE ANY(patterns)));
        GET DIAGNOSTICS changed=ROW_COUNT;
        next_no:=NULL;
    ELSE
        SELECT COALESCE(array_agg(p.operation_id ORDER BY p.operation_id,p.change_no),'{}'::uuid[]),
            COALESCE(array_agg(p.change_no ORDER BY p.operation_id,p.change_no),'{}'::bigint[])
        INTO page_ids,page_nos FROM (
            SELECT a.operation_id,a.change_no FROM file_private.storage_action_audit_items a
            WHERE job.cursor_id IS NULL OR (a.operation_id,a.change_no)>(job.cursor_id,job.cursor_no)
            ORDER BY a.operation_id,a.change_no LIMIT p_limit
        ) p;
        SELECT COALESCE(array_agg(p.operation_id ORDER BY p.operation_id,p.change_no),'{}'::uuid[]),
            COALESCE(array_agg(p.change_no ORDER BY p.operation_id,p.change_no),'{}'::bigint[])
        INTO locked_ids,locked_nos FROM (
            SELECT a.operation_id,a.change_no FROM file_private.storage_action_audit_items a
            JOIN unnest(page_ids,page_nos) keys(operation_id,change_no)
              ON (a.operation_id,a.change_no)=(keys.operation_id,keys.change_no)
            ORDER BY a.operation_id,a.change_no FOR UPDATE OF a SKIP LOCKED
        ) p;
        scanned:=cardinality(page_ids); locked:=cardinality(locked_ids);
        UPDATE file_private.storage_action_audit_items a SET
            storage_id=CASE WHEN lower(a.storage_id::text) LIKE ANY(patterns) THEN NULL ELSE a.storage_id END,
            blob_id=CASE WHEN lower(a.blob_id::text) LIKE ANY(patterns) THEN NULL ELSE a.blob_id END,
            chat_id=CASE WHEN lower(a.chat_id) LIKE ANY(patterns) THEN NULL ELSE a.chat_id END,
            item_ids=ARRAY(SELECT item FROM unnest(a.item_ids,a.versions) WITH ORDINALITY pair(item,version,n)
                WHERE NOT (lower(item::text) LIKE ANY(patterns)) ORDER BY n),
            versions=ARRAY(SELECT version FROM unnest(a.item_ids,a.versions) WITH ORDINALITY pair(item,version,n)
                WHERE NOT (lower(item::text) LIKE ANY(patterns)) ORDER BY n)
        FROM unnest(locked_ids,locked_nos) keys(operation_id,change_no)
        WHERE (a.operation_id,a.change_no)=(keys.operation_id,keys.change_no)
          AND (lower(a.storage_id::text) LIKE ANY(patterns) OR lower(a.blob_id::text) LIKE ANY(patterns)
            OR lower(a.chat_id) LIKE ANY(patterns)
            OR EXISTS(SELECT 1 FROM unnest(a.item_ids) id WHERE lower(id::text) LIKE ANY(patterns)));
        GET DIAGNOSTICS changed=ROW_COUNT;
        next_no:=CASE WHEN locked<scanned OR scanned=0 THEN job.cursor_no ELSE page_nos[scanned] END;
    END IF;
    blocked:=locked<scanned;
    next_id:=CASE WHEN blocked OR scanned=0 THEN job.cursor_id ELSE page_ids[scanned] END;
    exhausted:=NOT blocked AND scanned<p_limit;
    PERFORM identity.assert_registered_audit_context(p_job_id,ARRAY[job.phase]);
    RETURN NEXT;
END $$;

-- Full residual checks deliberately do not use a cursor or SKIP LOCKED. A
-- drained page is only progress; it cannot authorize completing either round.
CREATE FUNCTION identity.registered_auth_audit_residual(p_job_id uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE job identity.account_audit_redaction_jobs%ROWTYPE; ids text[]; email text; remaining bigint;
BEGIN
    job:=identity.assert_registered_audit_context(p_job_id,ARRAY['auth','file_headers','file_items','verify']);
    ids:=ARRAY(SELECT lower(id) FROM unnest(job.delete_user_ids) id);
    email:=NULLIF(lower(btrim(job.auth_email)),'');
    SELECT count(*) INTO remaining FROM auth.audit_log_entries a WHERE a.payload::jsonb IS DISTINCT FROM
        identity.registered_audit_redacted_payload(a.payload::jsonb,ids,email);
    PERFORM identity.assert_registered_audit_context(p_job_id,ARRAY[job.phase]);
    RETURN remaining;
END $$;

CREATE FUNCTION file_private.registered_storage_audit_residual(p_job_id uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE job identity.account_audit_redaction_jobs%ROWTYPE; ids text[]; patterns text[]; remaining bigint;
BEGIN
    job:=identity.assert_registered_audit_context(p_job_id,ARRAY['auth','file_headers','file_items','verify']);
    ids:=ARRAY(SELECT lower(id) FROM unnest(job.delete_user_ids) id);
    patterns:=ARRAY(SELECT '%'||replace(replace(replace(id,chr(92),chr(92)||chr(92)),
        '%',chr(92)||'%'),'_',chr(92)||'_')||'%' FROM unnest(ids) id);
    SELECT (SELECT count(*) FROM file_private.storage_action_audit a
        WHERE lower(a.actor_user_id)=ANY(ids) OR lower(a.effective_actor_id)=ANY(ids)
           OR EXISTS(SELECT 1 FROM unnest(a.requested_item_ids) id WHERE lower(id::text) LIKE ANY(patterns))
           OR EXISTS(SELECT 1 FROM unnest(a.requested_message_ids) id WHERE lower(id) LIKE ANY(patterns)))
      +(SELECT count(*) FROM file_private.storage_action_audit_items a
        WHERE lower(a.storage_id::text) LIKE ANY(patterns) OR lower(a.blob_id::text) LIKE ANY(patterns)
           OR lower(a.chat_id) LIKE ANY(patterns)
           OR EXISTS(SELECT 1 FROM unnest(a.item_ids) id WHERE lower(id::text) LIKE ANY(patterns))) INTO remaining;
    PERFORM identity.assert_registered_audit_context(p_job_id,ARRAY[job.phase]);
    RETURN remaining;
END $$;

ALTER FUNCTION identity.registered_audit_redacted_payload(jsonb,text[],text) OWNER TO postgres;
ALTER FUNCTION identity.redact_registered_auth_audit_batch(uuid,integer) OWNER TO postgres;
ALTER FUNCTION file_private.redact_registered_storage_audit_batch(uuid,integer) OWNER TO postgres;
ALTER FUNCTION identity.registered_auth_audit_residual(uuid) OWNER TO postgres;
ALTER FUNCTION file_private.registered_storage_audit_residual(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.registered_audit_redacted_payload(jsonb,text[],text),
    identity.redact_registered_auth_audit_batch(uuid,integer),
    file_private.redact_registered_storage_audit_batch(uuid,integer),
    identity.registered_auth_audit_residual(uuid),file_private.registered_storage_audit_residual(uuid)
FROM PUBLIC,anon,authenticated,service_role;
