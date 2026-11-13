-- Hide retains readable history. Delete clears only the caller's history and hides its row.
SET LOCAL ROLE postgres;
SET LOCAL lock_timeout = '5s';

ALTER TABLE chat.conversation_list_state ADD COLUMN conversation_cleared_at timestamptz;
CREATE TABLE chat.conversation_clear_operations (
  user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  chat_id text NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  receipt jsonb NOT NULL,
  PRIMARY KEY(user_id,operation_id)
);
ALTER TABLE chat.conversation_clear_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.conversation_clear_operations FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION chat.delete_my_conversation(p_chat_id text,p_operation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE caller text:=auth.uid()::text; receipt jsonb; cleared timestamptz;
BEGIN
  IF caller IS NULL OR p_operation_id IS NULL THEN RAISE EXCEPTION 'conversation_delete_owner_required' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:erase-human:'||caller,0));
  IF NOT EXISTS(SELECT 1 FROM identity.users u WHERE u.id=caller AND u.type='human' AND u.removed_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM chat.active_members m JOIN chat.chats c ON c.id=m.chat_id
      WHERE m.chat_id=p_chat_id AND m.user_id=caller AND c.kind IN('dm','ai','group','topic') AND c.status IN('active','stopped','paused')) THEN
    RAISE EXCEPTION 'conversation_delete_membership_required' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('chat:clear:'||caller||':'||p_operation_id::text,0));
  PERFORM 1 FROM identity.users WHERE id=caller FOR KEY SHARE;
  PERFORM 1 FROM chat.chats WHERE id=p_chat_id FOR KEY SHARE;
  PERFORM chat.lock_revision_heads(ARRAY[caller]);
  SELECT o.receipt INTO receipt FROM chat.conversation_clear_operations o WHERE o.user_id=caller AND o.operation_id=p_operation_id;
  IF FOUND THEN
    IF receipt->>'chat_id' IS DISTINCT FROM p_chat_id THEN RAISE EXCEPTION 'conversation_delete_operation_conflict' USING ERRCODE='23505'; END IF;
    RETURN receipt;
  END IF;
  INSERT INTO chat.conversation_list_state(chat_id,user_id,conversation_hidden_at,conversation_cleared_at)
    VALUES(p_chat_id,caller,clock_timestamp(),clock_timestamp()) ON CONFLICT(chat_id,user_id) DO UPDATE SET
    conversation_hidden_at=EXCLUDED.conversation_hidden_at,
    conversation_cleared_at=GREATEST(chat.conversation_list_state.conversation_cleared_at,EXCLUDED.conversation_cleared_at)
    RETURNING conversation_cleared_at INTO cleared;
  PERFORM chat.publish_user_revision(caller,'chat_members_changed',jsonb_build_object('chat_id',p_chat_id,'user_id',caller,'kind','own'),false);
  SELECT jsonb_build_object('chat_id',p_chat_id,'operation_id',p_operation_id,'cleared_at',cleared,
    'hidden_at',s.conversation_hidden_at,'account_revision',COALESCE(h.revision,0)::text)
    INTO receipt FROM chat.conversation_list_state s LEFT JOIN chat.account_revision_heads h ON h.user_id=s.user_id
    WHERE s.chat_id=p_chat_id AND s.user_id=caller;
  INSERT INTO chat.conversation_clear_operations VALUES(caller,p_operation_id,p_chat_id,receipt);
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION chat.delete_my_conversation(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.delete_my_conversation(text,uuid) TO authenticated;

-- A floor never grants membership. A former member's private clear record cannot reopen history.
CREATE OR REPLACE FUNCTION chat.history_floor(p_chat_id text,p_actor text) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  WITH RECURSIVE ancestors(id) AS (
    SELECT p_chat_id UNION SELECT c.source_chat_id FROM chat.chats c JOIN ancestors a ON a.id=c.id
      WHERE c.kind='topic' AND c.source_chat_id IS NOT NULL
  ), admission AS (
    SELECT LEAST(
      (SELECT COALESCE(m.hide_history_before,'-infinity'::timestamptz) FROM chat.active_members m WHERE m.chat_id=p_chat_id AND m.user_id=p_actor),
      (SELECT COALESCE(m.hide_history_before,'-infinity'::timestamptz) FROM chat.chats c JOIN chat.active_members m ON m.chat_id=c.source_chat_id
        WHERE c.id=p_chat_id AND c.kind='topic' AND m.user_id=p_actor)) AS floor
  ) SELECT CASE WHEN admission.floor IS NULL THEN NULL ELSE GREATEST(admission.floor,
    (SELECT max(s.conversation_cleared_at) FROM chat.conversation_list_state s JOIN ancestors a ON a.id=s.chat_id WHERE s.user_id=p_actor)) END
    FROM admission
$$;

CREATE OR REPLACE FUNCTION chat.can_see_topic_message(p_chat_id text,p_created_at timestamptz,p_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM chat.chats t JOIN chat.active_members m ON m.chat_id=t.source_chat_id AND m.user_id=p_user_id
    WHERE t.id=p_chat_id AND t.kind='topic' AND p_created_at>=chat.history_floor(p_chat_id,p_user_id))
    AND chat.caller_may_probe_chat(p_chat_id)
$$;

CREATE OR REPLACE FUNCTION chat.caller_member_chats_without_floor() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT m.chat_id FROM chat.active_members m WHERE m.user_id=(SELECT auth.uid()::text)
    AND chat.history_floor(m.chat_id,(SELECT auth.uid()::text))='-infinity'::timestamptz
$$;
CREATE FUNCTION chat.caller_history_floor(p_chat_id text) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$ SELECT chat.history_floor(p_chat_id,auth.uid()::text) $$;
REVOKE ALL ON FUNCTION chat.caller_history_floor(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.caller_history_floor(text) TO authenticated;
ALTER POLICY messages_select_member ON chat.messages USING (
  deleted_at IS NULL AND (
    chat_id IN(SELECT chat.caller_member_chats_without_floor()) OR EXISTS(
      SELECT 1 FROM chat.active_members m WHERE m.chat_id=messages.chat_id AND m.user_id=(SELECT auth.uid()::text)
        AND messages.created_at>=chat.caller_history_floor(m.chat_id))
    OR chat.can_see_topic_message(chat_id,created_at,(SELECT auth.uid()::text)))
  AND chat.whisper_visible_to(is_whisper,sender_user_id,to_user_ids,(SELECT auth.uid()::text))
);

-- Existing unread producers share the same effective floor, including source/topic inheritance.
DO $unread$
DECLARE definition text; prior text;
BEGIN
  SELECT pg_get_functiondef('chat.list_unread_locators_for_chats(text[])'::regprocedure) INTO definition;
  prior:=definition;
  definition:=replace(definition,'member.version, member.hide_history_before','member.version, chat.history_floor(member.chat_id,v_user) AS hide_history_before');
  definition:=replace(definition,'stream.version, member.hide_history_before','stream.version, chat.history_floor(member.chat_id,v_user)');
  definition:=replace(definition,'0, false, 0, member.hide_history_before','0, false, 0, chat.history_floor(member.chat_id,v_user)');
  definition:=replace(definition,'source.version, source.hide_history_before','source.version, chat.history_floor(source.chat_id,v_user)');
  IF definition=prior THEN RAISE EXCEPTION 'Unexpected conversation-clear unread predecessor'; END IF;
  EXECUTE definition;
END $unread$;

-- Late first publication of content predating Delete cannot recreate the cleared conversation.
DO $native$
DECLARE definition text; marker text:='PERFORM chat.restore_conversation_list_rows(p_chat_id, ARRAY[caller]);';
BEGIN
  SELECT pg_get_functiondef('chat.publish_native_conversation_message(text,text,text,text,text,timestamptz)'::regprocedure) INTO definition;
  IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected conversation-clear native predecessor'; END IF;
  definition:=replace(definition,marker,
    'IF p_occurred_at >= chat.history_floor(p_chat_id,caller) THEN '||marker||' END IF;');
  EXECUTE definition;
END $native$;

-- Keep the caller-scoped protocol additive. Peer rows never expose a private clear timestamp.
ALTER FUNCTION chat.list_conversation_memberships(text[]) RENAME TO conversation_memberships_before_clear;
REVOKE ALL ON FUNCTION chat.conversation_memberships_before_clear(text[]) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION chat.list_conversation_memberships(p_chat_ids text[]) RETURNS TABLE(
  chat_id text,user_id text,last_read_seq bigint,is_marked_unread boolean,version integer,
  notification_level text,is_pinned boolean,updated_at timestamptz,joined_at timestamptz,
  inbox_published_at timestamptz,role text,conversation_deleted_at timestamptz,conversation_hidden_at timestamptz,historical_only boolean,
  native_personal_activity_at timestamptz,native_personal_activity_revision text,personal_state_observed_revision text,conversation_cleared_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT m.*,CASE WHEN m.user_id=auth.uid()::text THEN (
    SELECT max(s.conversation_cleared_at) FROM chat.conversation_list_state s WHERE s.user_id=m.user_id
      AND s.chat_id IN(m.chat_id,(SELECT c.source_chat_id FROM chat.chats c WHERE c.id=m.chat_id AND c.kind='topic')))
    END FROM chat.conversation_memberships_before_clear(p_chat_ids) m
$$;
REVOKE ALL ON FUNCTION chat.list_conversation_memberships(text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.list_conversation_memberships(text[]) TO authenticated;
DO $snapshot$
DECLARE definition text; prior text;
BEGIN
  SELECT pg_get_functiondef('chat.sync_snapshot()'::regprocedure) INTO definition;
  prior:=definition;
  definition:=replace(definition,'m.personal_state_observed_revision','m.personal_state_observed_revision, m.conversation_cleared_at');
  IF definition=prior THEN RAISE EXCEPTION 'Unexpected conversation-clear snapshot predecessor'; END IF;
  EXECUTE definition;
END $snapshot$;
-- The installation DDL guard closes every replacement. Restate the predecessor execution ACLs.
GRANT EXECUTE ON FUNCTION chat.history_floor(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION chat.can_see_topic_message(text,timestamptz,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.caller_member_chats_without_floor() TO authenticated;
GRANT EXECUTE ON FUNCTION chat.list_unread_locators_for_chats(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.publish_native_conversation_message(text,text,text,text,text,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION chat.sync_snapshot() TO authenticated;
NOTIFY pgrst,'reload schema';
