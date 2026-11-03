-- Both desktop creation and topic_open use this writer. Include a source author
-- only while they remain a source member; explicit recipient admission is unchanged.
DO $migration$
DECLARE
    signature text := 'chat.create_topic(text,text,text,text[],text,text)';
    definition text := pg_get_functiondef(signature::regprocedure);
    original_acl aclitem[];
    change record;
    permission record;
BEGIN
    SELECT COALESCE(proacl, acldefault('f', proowner)) INTO original_acl
      FROM pg_proc WHERE oid = signature::regprocedure;
    FOR change IN SELECT * FROM (VALUES
        ('    v_source_content TEXT;', E'    v_source_content TEXT;\n    v_source_author TEXT;'),
        ('SELECT m.content, m.is_whisper, m.retracted_at, m.content_type',
         'SELECT m.content, m.is_whisper, m.retracted_at, m.content_type, m.sender_user_id'),
        ('INTO v_source_content, v_source_is_whisper, v_source_retracted, v_source_content_type',
         'INTO v_source_content, v_source_is_whisper, v_source_retracted, v_source_content_type, v_source_author'),
        ('unnest(COALESCE(p_member_user_ids, ARRAY[]::TEXT[])) AS candidate(user_id)',
         'unnest(array_append(COALESCE(p_member_user_ids, ARRAY[]::TEXT[]), v_source_author)) AS candidate(user_id)')
    ) AS changes(needle, replacement) LOOP
        IF (length(definition) - length(replace(definition, change.needle, ''))) / length(change.needle) <> 1 THEN
            RAISE EXCEPTION 'create_topic source-author upgrade anchor differs';
        END IF;
        definition := replace(definition, change.needle, change.replacement);
    END LOOP;
    EXECUTE definition;
    -- CREATE OR REPLACE also invokes the foundation's API-closing DDL trigger.
    -- Restore exactly the predecessor's execution grants, including grant options.
    FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
      FROM aclexplode(original_acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', signature,
          CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
          CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
END;
$migration$;
