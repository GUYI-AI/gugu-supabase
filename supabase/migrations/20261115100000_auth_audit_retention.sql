-- The platform owner prepares the one concurrent index before this release.
-- The application installer never transfers ownership of a platform object.
DO $prerequisites$
BEGIN
    IF NOT has_column_privilege(current_user,'auth.audit_log_entries','id','SELECT')
       OR NOT has_column_privilege(current_user,'auth.audit_log_entries','payload','SELECT')
       OR NOT has_column_privilege(current_user,'auth.audit_log_entries','created_at','SELECT')
       OR NOT has_column_privilege(current_user,'auth.audit_log_entries','payload','UPDATE')
       OR NOT has_table_privilege(current_user,'auth.audit_log_entries','DELETE') THEN
        RAISE EXCEPTION 'Auth audit retention requires the reviewed platform privileges';
    END IF;
    IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=current_user::regrole
        WHERE c.oid='auth.audit_log_entries'::regclass AND c.relrowsecurity
        AND NOT (r.rolsuper OR r.rolbypassrls OR (c.relowner=r.oid AND NOT c.relforcerowsecurity))) THEN
        RAISE EXCEPTION 'Auth audit retention requires complete row visibility';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
        JOIN pg_am am ON am.oid=i.relam
        WHERE x.indrelid='auth.audit_log_entries'::regclass
        AND i.oid=to_regclass('auth.audit_log_entries_created_at_id_idx')
        AND x.indisvalid AND x.indisready AND NOT x.indisunique AND am.amname='btree'
        AND x.indpred IS NULL AND x.indexprs IS NULL AND x.indnatts=2 AND x.indnkeyatts=2
        AND ARRAY(SELECT a.attname::text FROM unnest(x.indkey::smallint[]) WITH ORDINALITY k(attnum,n)
            JOIN pg_attribute a ON a.attrelid=x.indrelid AND a.attnum=k.attnum ORDER BY k.n)
            =ARRAY['created_at','id']::text[]) THEN
        RAISE EXCEPTION 'Prepare and verify the concurrent Auth audit time index before this release';
    END IF;
END $prerequisites$;

-- Source-reviewed fields from Supabase Auth v2.196.0. Actor and target are
-- distinct: a target erasure must not erase another administrator's identity.
CREATE FUNCTION identity.auth_audit_redacted_payload(p_payload jsonb,p_ids text[],p_email text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE result jsonb:=p_payload; actor_matches boolean; target_matches boolean;
BEGIN
    IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RETURN p_payload; END IF;
    actor_matches:=COALESCE(lower(p_payload->>'actor_id')=ANY(p_ids),false)
        OR (p_email IS NOT NULL AND lower(btrim(p_payload->>'actor_username'))=p_email);
    target_matches:=COALESCE(lower(p_payload#>>'{traits,user_id}')=ANY(p_ids),false)
        OR (p_email IS NOT NULL AND lower(btrim(p_payload#>>'{traits,user_email}'))=p_email);
    IF actor_matches THEN result:=result-'actor_username'-'actor_name'; END IF;
    IF target_matches THEN
        result:=result#-'{traits,user_email}'#-'{traits,user_phone}';
    END IF;
    -- Auth's email identity provider uses the email as provider_id. Other
    -- providers' opaque IDs and all security IDs/actions/timestamps stay intact.
    IF p_payload#>>'{traits,provider}'='email' AND (actor_matches
        OR (p_email IS NOT NULL AND lower(btrim(p_payload#>>'{traits,provider_id}'))=p_email)) THEN
        result:=result#-'{traits,provider_id}';
    END IF;
    RETURN result;
END $$;
ALTER FUNCTION identity.auth_audit_redacted_payload(jsonb,text[],text) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.auth_audit_redacted_payload(jsonb,text[],text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.erase_auth_audit_actor(p_ids text[],p_auth_email text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE ids text[]; email text:=NULLIF(lower(btrim(p_auth_email)),'');
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids)=0
       OR EXISTS(SELECT 1 FROM unnest(p_ids) id WHERE id IS NULL OR id='')
       OR NOT EXISTS(SELECT 1 FROM identity.account_lifecycle_context c
          WHERE c.transaction_id=pg_current_xact_id() AND c.operation='privacy_erasure'
            AND c.subject_user_id=ANY(p_ids) AND c.delete_user_ids=p_ids) THEN
        RAISE EXCEPTION 'Auth audit erasure requires the auth deletion transaction' USING ERRCODE='42501';
    END IF;
    ids:=ARRAY(SELECT lower(id) FROM unnest(p_ids) id);
    UPDATE auth.audit_log_entries a
       SET payload=identity.auth_audit_redacted_payload(a.payload::jsonb,ids,email)::json
     WHERE (lower(a.payload->>'actor_id')=ANY(ids)
         OR lower(a.payload#>>'{traits,user_id}')=ANY(ids)
         OR (email IS NOT NULL AND (lower(btrim(a.payload->>'actor_username'))=email
             OR lower(btrim(a.payload#>>'{traits,user_email}'))=email
             OR (a.payload#>>'{traits,provider}'='email'
                 AND lower(btrim(a.payload#>>'{traits,provider_id}'))=email))))
       AND a.payload::jsonb IS DISTINCT FROM identity.auth_audit_redacted_payload(a.payload::jsonb,ids,email);
END $$;
ALTER FUNCTION identity.erase_auth_audit_actor(text[],text) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.erase_auth_audit_actor(text[],text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.prune_auth_audit_log(p_limit integer DEFAULT 100) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' SET TimeZone='UTC' AS $$
DECLARE n integer;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'Invalid Auth audit cleanup limit';
    END IF;
    -- Setting statement_timeout inside a function does not arm a new query
    -- deadline. The scheduler/caller must set it before invoking this function.
    IF NOT EXISTS(SELECT 1 FROM pg_settings WHERE name='statement_timeout'
        AND setting::bigint BETWEEN 1 AND 2000) THEN
        RAISE EXCEPTION 'Auth audit cleanup requires a positive statement timeout at most 2s';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('auth.audit_log_entries_created_at_id_idx')
        AND indrelid='auth.audit_log_entries'::regclass AND indisvalid AND indisready) THEN
        RAISE EXCEPTION 'Auth audit time index is unavailable';
    END IF;
    WITH expired AS MATERIALIZED (
        SELECT id FROM auth.audit_log_entries
        WHERE created_at<now()-interval '180 days'
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT p_limit
    )
    DELETE FROM auth.audit_log_entries a USING expired WHERE a.id=expired.id;
    GET DIAGNOSTICS n=ROW_COUNT;
    RETURN n;
END $$;
ALTER FUNCTION identity.prune_auth_audit_log(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.prune_auth_audit_log(integer) FROM PUBLIC,anon,authenticated,service_role;
SELECT cron.schedule('auth-audit-retention','*/10 * * * *',
    'SET statement_timeout=''2s''; SELECT identity.prune_auth_audit_log(100);');

-- The separate unified Auth migration calls erase_auth_audit_actor before
-- deleting its lifecycle context. This release does not modify that entry.
