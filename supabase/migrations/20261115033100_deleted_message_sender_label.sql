-- Auth erasure already preserves group messages and clears sender_user_id via
-- its FK. Make every standard reader name that NULL author consistently.
DO $upgrade$
DECLARE definition text; anchor text; replacement text; target regprocedure; sender_aliases text[];
    acl aclitem[]; permission record;
BEGIN
    SELECT pg_get_viewdef('chat.messages_view'::regclass,true) INTO definition;
    anchor:='COALESCE(su.display_name, ''未知用户''::text)';
    -- The view deparser can rename the nested base alias to m_1. Bind to that
    -- actual alias; a missing profile is not by itself proof of account deletion.
    SELECT array_agg(match[1]) INTO sender_aliases FROM regexp_matches(definition,
        'FROM[[:space:](]+chat[.]messages[[:space:]]+([a-zA-Z0-9_]+)','g') AS match;
    IF cardinality(sender_aliases) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Unexpected message source alias'; END IF;
    replacement:=format('CASE WHEN %1$I.sender_user_id IS NULL AND %1$I.content_type<>''system'' THEN ''已注销用户''::text ELSE COALESCE(su.display_name, ''未知用户''::text) END',sender_aliases[1]);
    IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
        RAISE EXCEPTION 'Unexpected message view predecessor';
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW chat.messages_view WITH(security_invoker=true) AS '||replace(definition,anchor,replacement);

    FOREACH target IN ARRAY ARRAY[
        'chat.message_history_as(text,text,text,bigint,integer)'::regprocedure,
        'chat.message_search_as(text,text,text,bigint,integer)'::regprocedure
    ] LOOP
        SELECT pg_get_functiondef(p.oid),COALESCE(p.proacl,acldefault('f',p.proowner)) INTO definition,acl
            FROM pg_proc p WHERE p.oid=target;
        anchor:='COALESCE(u.display_name, ''未知用户'')';
        replacement:='CASE WHEN m.sender_user_id IS NULL AND m.content_type<>''system'' THEN ''已注销用户'' ELSE COALESCE(u.display_name, ''未知用户'') END';
        IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
            RAISE EXCEPTION 'Unexpected message reader predecessor: %',target;
        END IF;
        EXECUTE replace(definition,anchor,replacement);
        -- The repository's function-DDL guard closes API execution even on
        -- replacement. Restore the exact prior grants, not a broader role list.
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',target);
        FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable
            FROM aclexplode(acl) WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',target,
                CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
                CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
        END LOOP;
    END LOOP;

    target:='identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint)'::regprocedure;
    SELECT pg_get_functiondef(p.oid),COALESCE(p.proacl,acldefault('f',p.proowner)) INTO definition,acl
        FROM pg_proc p WHERE p.oid=target;
    anchor:='         su.display_name,';
    replacement:='         CASE WHEN page.sender_user_id IS NULL AND page.content_type<>''system'' THEN ''已注销用户'' ELSE su.display_name END,';
    IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
        RAISE EXCEPTION 'Unexpected agent inbox predecessor';
    END IF;
    EXECUTE replace(definition,anchor,replacement);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',target);
    FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable
        FROM aclexplode(acl) WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',target,
            CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
            CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
END $upgrade$;
