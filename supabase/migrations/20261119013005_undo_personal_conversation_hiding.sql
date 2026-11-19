-- Undo is scoped to the hide operation which actually made the row hidden.
-- A later hide or history clear is a new personal intent and cannot be undone by an older notice.
SET LOCAL ROLE postgres;
SET LOCAL lock_timeout = '5s';

CREATE TABLE chat.conversation_unhide_operations (
  user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  hide_operation_id uuid NOT NULL,
  chat_id text NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  receipt jsonb NOT NULL,
  PRIMARY KEY (user_id,operation_id)
);
ALTER TABLE chat.conversation_unhide_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.conversation_unhide_operations FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION chat.undo_my_conversation_hide(p_chat_id text,p_hide_operation_id uuid,p_operation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  caller text:=auth.uid()::text;
  receipt jsonb;
  hidden_receipt jsonb;
  hidden timestamptz;
  permanent timestamptz;
  restored boolean:=false;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'conversation_hide_owner_required' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:erase-human:'||caller,0));
  IF NOT EXISTS(SELECT 1 FROM identity.users u WHERE u.id=caller AND u.type='human' AND u.removed_at IS NULL) THEN
    RAISE EXCEPTION 'conversation_hide_owner_required' USING ERRCODE='42501';
  END IF;
  IF p_hide_operation_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'conversation_hide_operation_required' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM chat.active_members m JOIN chat.chats c ON c.id=m.chat_id
    WHERE m.chat_id=p_chat_id AND m.user_id=caller AND c.kind IN('dm','ai','group','topic')
      AND c.status IN('active','stopped','paused')) THEN
    RAISE EXCEPTION 'conversation_hide_membership_required' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('chat:unhide:'||caller||':'||p_operation_id::text,0));
  PERFORM 1 FROM identity.users u WHERE u.id=caller FOR KEY SHARE;
  PERFORM 1 FROM chat.chats c WHERE c.id=p_chat_id FOR KEY SHARE;
  PERFORM chat.lock_lines(ARRAY[p_chat_id]);
  -- Authorize again after a concurrent leave/removal has released this line.
  SELECT m.conversation_deleted_at INTO permanent FROM chat.active_members m WHERE m.chat_id=p_chat_id AND m.user_id=caller;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_hide_membership_required' USING ERRCODE='42501'; END IF;
  SELECT o.receipt INTO receipt FROM chat.conversation_unhide_operations o
    WHERE o.user_id=caller AND o.operation_id=p_operation_id;
  IF FOUND THEN
    IF receipt->>'chat_id' IS DISTINCT FROM p_chat_id
      OR receipt->>'hide_operation_id' IS DISTINCT FROM p_hide_operation_id::text THEN
      RAISE EXCEPTION 'conversation_hide_operation_conflict' USING ERRCODE='23505';
    END IF;
    RETURN receipt;
  END IF;
  SELECT o.receipt INTO hidden_receipt FROM chat.conversation_hide_operations o
    WHERE o.user_id=caller AND o.operation_id=p_hide_operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_hide_operation_unknown' USING ERRCODE='42501'; END IF;
  IF hidden_receipt->>'chat_id' IS DISTINCT FROM p_chat_id THEN
    RAISE EXCEPTION 'conversation_hide_operation_conflict' USING ERRCODE='23505';
  END IF;
  IF permanent IS NOT NULL THEN RAISE EXCEPTION 'conversation_permanently_deleted' USING ERRCODE='55000'; END IF;
  UPDATE chat.conversation_list_state s SET conversation_hidden_at=NULL,hidden_by_operation_id=NULL
    WHERE s.chat_id=p_chat_id AND s.user_id=caller AND s.conversation_hidden_at IS NOT NULL
      AND s.hidden_by_operation_id=p_hide_operation_id AND (hidden_receipt->>'already')::boolean=false;
  restored:=FOUND;
  IF restored THEN
    PERFORM chat.publish_user_revision(caller,'chat_members_changed',
      jsonb_build_object('chat_id',p_chat_id,'user_id',caller,'kind','own'),false);
  END IF;
  PERFORM chat.flush_pending_user_revisions();
  SELECT s.conversation_hidden_at INTO hidden FROM chat.conversation_list_state s WHERE s.chat_id=p_chat_id AND s.user_id=caller;
  receipt:=jsonb_build_object('chat_id',p_chat_id,'operation_id',p_operation_id,'hide_operation_id',p_hide_operation_id,
    'restored',restored,'hidden_at',hidden,
    'account_revision',COALESCE((SELECT h.revision FROM chat.account_revision_heads h WHERE h.user_id=caller),0)::text);
  INSERT INTO chat.conversation_unhide_operations(user_id,operation_id,hide_operation_id,chat_id,receipt)
    VALUES(caller,p_operation_id,p_hide_operation_id,p_chat_id,receipt);
  RETURN receipt;
END;
$$;
REVOKE ALL ON FUNCTION chat.undo_my_conversation_hide(text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.undo_my_conversation_hide(text,uuid,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
