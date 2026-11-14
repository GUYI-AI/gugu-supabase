-- Auth erasure already preserves group messages and clears sender_user_id via
-- its FK. Make every standard reader name that NULL author consistently.
DO $upgrade$
DECLARE definition text; anchor text; replacement text; target regprocedure; sender_aliases text[];
BEGIN
    SELECT pg_get_viewdef('chat.messages_view'::regclass,true) INTO definition;
    anchor:='COALESCE(su.display_name, ''未知用户''::text)';
    -- The view deparser can rename the nested base alias to m_1. Bind to that
    -- actual alias; a missing profile is not by itself proof of account deletion.
    SELECT array_agg(match[1]) INTO sender_aliases FROM regexp_matches(definition,
        'FROM[[:space:](]+chat[.]messages[[:space:]]+([a-zA-Z0-9_]+)','g') AS match;
    IF cardinality(sender_aliases) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Unexpected message source alias'; END IF;
    replacement:=format('CASE WHEN %I.sender_user_id IS NULL THEN ''已注销用户''::text ELSE COALESCE(su.display_name, ''未知用户''::text) END',sender_aliases[1]);
    IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
        RAISE EXCEPTION 'Unexpected message view predecessor';
    END IF;
    EXECUTE 'CREATE OR REPLACE VIEW chat.messages_view WITH(security_invoker=true) AS '||replace(definition,anchor,replacement);

    FOREACH target IN ARRAY ARRAY[
        'chat.message_history_as(text,text,text,bigint,integer)'::regprocedure,
        'chat.message_search_as(text,text,text,bigint,integer)'::regprocedure
    ] LOOP
        SELECT pg_get_functiondef(target) INTO definition;
        anchor:='COALESCE(u.display_name, ''未知用户'')';
        replacement:='CASE WHEN m.sender_user_id IS NULL THEN ''已注销用户'' ELSE COALESCE(u.display_name, ''未知用户'') END';
        IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
            RAISE EXCEPTION 'Unexpected message reader predecessor: %',target;
        END IF;
        EXECUTE replace(definition,anchor,replacement);
    END LOOP;

    SELECT pg_get_functiondef('identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint)'::regprocedure) INTO definition;
    anchor:='         su.display_name,';
    replacement:='         CASE WHEN page.sender_user_id IS NULL THEN ''已注销用户'' ELSE su.display_name END,';
    IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
        RAISE EXCEPTION 'Unexpected agent inbox predecessor';
    END IF;
    EXECUTE replace(definition,anchor,replacement);
END $upgrade$;
