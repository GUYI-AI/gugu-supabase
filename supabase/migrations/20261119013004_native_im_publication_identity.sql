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

-- Apply the cross-channel identity filter to the insert-only restoration helper.
-- Its private text signature is introduced by 013001; no unused trigger overload.
DO $im$
DECLARE definition text; marker text := '        message.sender_user_id,message.to_user_ids,m.user_id));';
BEGIN
  SELECT pg_get_functiondef('chat.restore_message_conversation(text)'::regprocedure) INTO definition;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
    RAISE EXCEPTION 'Unexpected unified IM restoration predecessor';
  END IF;
  definition := replace(definition,marker,
    '        message.sender_user_id,message.to_user_ids,m.user_id)
      AND NOT EXISTS (SELECT 1 FROM chat.native_conversation_publications p
        WHERE p.owner_user_id=m.user_id AND p.agent_user_id=message.sender_user_id
          AND p.chat_id=message.chat_id AND p.message_id=message.id));');
  EXECUTE definition;
END $im$;
REVOKE ALL ON FUNCTION chat.restore_message_conversation(text) FROM PUBLIC,anon,authenticated,service_role;
