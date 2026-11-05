-- Session archival retains membership and history but no longer consumes group
-- capacity. Keep the existing-member admission shortcut and restoration path.
-- Update both admission checks and the serialized insertion guard together.
DO $capacity$
DECLARE
    target record;
    previous text;
    definition text;
    acl aclitem[];
    permission record;
BEGIN
    FOR target IN SELECT * FROM (VALUES
      ('chat.group_add_denial(text,text,text,boolean,boolean)'::regprocedure,
       'SELECT count(*) INTO v_count FROM chat.active_members WHERE chat_id = p_chat_id;',
       'SELECT count(*) INTO v_count FROM chat.active_members m JOIN identity.users u ON u.id = m.user_id WHERE m.chat_id = p_chat_id AND u.session_archived_at IS NULL;'),
      ('chat.enforce_group_member_limit()'::regprocedure,
       'SELECT count(*) INTO v_count FROM chat.active_members cm WHERE cm.chat_id = NEW.chat_id;',
       'SELECT count(*) INTO v_count FROM chat.active_members cm JOIN identity.users u ON u.id = cm.user_id WHERE cm.chat_id = NEW.chat_id AND u.session_archived_at IS NULL;'),
      ('chat.decide_group_invitation_as(text,boolean,text)'::regprocedure,
       'SELECT count(*) INTO v_count FROM chat.active_members WHERE chat_id=v_group.id;',
       'SELECT count(*) INTO v_count FROM chat.active_members m JOIN identity.users u ON u.id = m.user_id WHERE m.chat_id = v_group.id AND u.session_archived_at IS NULL;'),
      ('chat.join_public_group(integer,text)'::regprocedure,
       'from chat.active_members where active_members.chat_id = v_chat_id;',
       'from chat.active_members m join identity.users u on u.id = m.user_id where m.chat_id = v_chat_id and u.session_archived_at is null;'),
      ('chat.request_group_join(integer,text,text)'::regprocedure,
       'from chat.active_members where chat_id = v_chat_id;',
       'from chat.active_members m join identity.users u on u.id = m.user_id where m.chat_id = v_chat_id and u.session_archived_at is null;')
    ) AS definitions(signature, prior_sql, replacement_sql)
    LOOP
        SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl, acldefault('f', p.proowner))
          INTO previous, acl FROM pg_proc p WHERE p.oid = target.signature;
        IF array_length(string_to_array(previous, target.prior_sql), 1) <> 2 THEN
            RAISE EXCEPTION 'Unexpected group capacity predecessor: %', target.signature;
        END IF;
        definition := replace(previous, target.prior_sql, target.replacement_sql);
        EXECUTE definition;
        -- CREATE OR REPLACE activates the installation's API execution guard.
        FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
          FROM aclexplode(acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', target.signature,
              CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
              CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
        END LOOP;
    END LOOP;
END $capacity$;
