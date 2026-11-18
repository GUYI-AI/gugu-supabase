-- A visible owner notification has one UUID across its IM and native publication channels.
SET LOCAL ROLE postgres;
SET LOCAL lock_timeout='5s';
DO $native$
DECLARE definition text; marker text:='IF p_occurred_at >= chat.history_floor(p_chat_id,caller) THEN';
BEGIN
  SELECT pg_get_functiondef('chat.publish_native_conversation_message(text,text,text,text,text,timestamptz)'::regprocedure) INTO definition;
  IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected unified-publication predecessor'; END IF;
  definition:=replace(definition,marker,
    'IF p_occurred_at >= chat.history_floor(p_chat_id,caller) AND NOT EXISTS (SELECT 1 FROM chat.messages m WHERE m.id=p_message_id AND m.chat_id=p_chat_id AND m.sender_user_id=p_agent_user_id) THEN');
  EXECUTE definition;
END $native$;
GRANT EXECUTE ON FUNCTION chat.publish_native_conversation_message(text,text,text,text,text,timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION chat.restore_message_conversation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.deleted_at IS NULL AND NEW.retracted_at IS NULL
    AND NOT COALESCE(chat.is_pending_delivery(NEW.id,NEW.content_type,NEW.sender_user_id,NEW.client_message_id),false)
    AND COALESCE(NEW.client_message_id,'') !~ '^session-import-(root|turn):' THEN
    PERFORM chat.restore_conversation_list_rows(NEW.chat_id,ARRAY(
      SELECT DISTINCT m.user_id FROM chat.active_members m JOIN identity.users u ON u.id=m.user_id AND u.type='human'
      WHERE m.chat_id IN(NEW.chat_id,(SELECT c.source_chat_id FROM chat.chats c WHERE c.id=NEW.chat_id AND c.kind='topic'))
        AND chat.message_visible_to(NEW.chat_id,NEW.created_at,NEW.is_whisper,NEW.sender_user_id,NEW.to_user_ids,m.user_id)
        AND NOT EXISTS(SELECT 1 FROM chat.native_conversation_publications p WHERE p.owner_user_id=m.user_id
          AND p.agent_user_id=NEW.sender_user_id AND p.chat_id=NEW.chat_id AND p.message_id=NEW.id)));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION chat.restore_message_conversation() FROM PUBLIC,anon,authenticated,service_role;
