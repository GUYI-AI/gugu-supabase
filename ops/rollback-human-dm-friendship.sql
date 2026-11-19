-- Roll back the human-DM friendship release before older releases that drop
-- chat_private. Restores prior entrypoints without changing seats, history,
-- relationships or installer digests. A later install requires a forward fix.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $entrypoints$
DECLARE
  target record;
  previous text;
  definition text;
  acl aclitem[];
  permission record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('chat.get_or_create_dm(text)'::regprocedure,
     E'    PERFORM chat_private.require_human_friendship(v_current_user_id, v_target_user_id);\n\n', false),
    ('chat.attachment_sender_check(text,text)'::regprocedure,
     E'    PERFORM chat_private.require_dm_friendship(p_chat_id);\n', true)
  ) AS entries(signature, inserted_sql, restore_stable)
  LOOP
    SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl, acldefault('f',p.proowner))
      INTO previous, acl FROM pg_proc p WHERE p.oid=target.signature;
    IF array_length(string_to_array(previous,target.inserted_sql),1) <> 2 THEN
      RAISE EXCEPTION 'Unexpected human-DM friendship release body: %', target.signature;
    END IF;
    definition := replace(previous,target.inserted_sql,'');
    EXECUTE definition;
    IF target.restore_stable THEN
      EXECUTE format('ALTER FUNCTION %s STABLE',target.signature);
    END IF;
    -- CREATE OR REPLACE runs the installation's API guard. Preserve exact ACLs.
    FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable
      FROM aclexplode(acl) WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',target.signature,
        CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END $entrypoints$;

DROP TRIGGER messages_b_human_dm_friendship ON chat.messages;
DROP TRIGGER reactions_human_dm_friendship ON chat.message_reactions;
DROP FUNCTION chat_private.guard_human_dm_message();
DROP FUNCTION chat_private.guard_human_dm_reaction();
DROP FUNCTION chat_private.require_dm_friendship(text);
DROP FUNCTION chat_private.require_human_friendship(text,text);

NOTIFY pgrst, 'reload schema';
COMMIT;
