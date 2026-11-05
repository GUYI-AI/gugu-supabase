-- Run through the approved backend migration workflow after rolling back the client.
-- Keep the additive column, view shape and deletion timestamps for safe forward recovery.
-- Restore the prior list behavior and close the deletion RPC; do not erase user choices.
BEGIN;
REVOKE EXECUTE ON FUNCTION chat.delete_my_dm_conversation(text) FROM authenticated;
CREATE OR REPLACE FUNCTION chat.list_my_chats_as(p_as_user_id text)
RETURNS TABLE(chat_id text, public_id integer, kind text, status text, name text, role text, listen_mode text,
  last_message_at timestamptz, last_message_preview text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE caller text := auth.uid()::text; actor text := NULLIF(btrim(COALESCE(p_as_user_id, '')), '');
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF actor IS NULL OR NOT chat.is_acting_as(actor) THEN
    RAISE EXCEPTION 'Not allowed to act as %', COALESCE(actor, '<null>');
  END IF;
  RETURN QUERY SELECT c.id,c.public_id,c.kind,c.status,c.name,mine.role,mine.listen_mode,c.last_message_at,c.last_message_preview
    FROM chat.active_members mine JOIN chat.chats c ON c.id = mine.chat_id
    WHERE mine.user_id = actor AND c.status IN ('active','stopped','paused')
    ORDER BY c.last_message_at DESC NULLS LAST,c.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION chat.list_my_chats_as(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_my_chats_as(text) TO authenticated;
DO $restore_list_reads$
DECLARE target regprocedure; definition text; previous text; prior_acl aclitem[]; permission record;
BEGIN
  FOREACH target IN ARRAY ARRAY['chat.sync_snapshot()'::regprocedure,
    COALESCE(to_regprocedure('chat.list_unread_locators_for_chats(text[])'),'chat.list_unread_locators(text)'::regprocedure),
    to_regprocedure('chat.list_chat_previews(text[])')] LOOP
    IF target IS NULL THEN CONTINUE; END IF;
    SELECT pg_get_functiondef(p.oid),COALESCE(p.proacl,acldefault('f',p.proowner))
      INTO definition,prior_acl FROM pg_proc p WHERE p.oid=target;
    previous := definition;
    definition := replace(definition,' AND own.conversation_deleted_at IS NULL','');
    definition := replace(definition,' AND member.conversation_deleted_at IS NULL','');
    definition := replace(definition,', m.conversation_deleted_at','');
    IF definition=previous THEN RAISE EXCEPTION 'Unexpected personal list read predecessor: %',target; END IF;
    EXECUTE definition;
    FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable FROM aclexplode(prior_acl)
      WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',target,
        CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END $restore_list_reads$;
COMMIT;
