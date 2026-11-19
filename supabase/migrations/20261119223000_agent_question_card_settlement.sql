-- The addressee settles an owned agent's question, without changing the message's identity or sending a receipt.
-- Body refreshes add data to chat_changed; older clients must not receive an unknown revision event name.
SET LOCAL lock_timeout = '5s';

-- A terminal result changes no derived chat preview. Avoid taking the chat row again while holding the line lock:
-- sends take that row before their line lock. Ordinary text, timestamps and deletion retain the existing trigger.
DO $preview_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='chat.messages'::regclass
    AND tgname='trg_recompute_chat_last_message_on_update' AND tgfoid='chat.recompute_chat_last_message_on_update()'::regprocedure
    AND tgqual IS NULL AND tgenabled='O') THEN RAISE EXCEPTION 'unexpected message preview trigger'; END IF;
END;
$preview_guard$;
DROP TRIGGER trg_recompute_chat_last_message_on_update ON chat.messages;
CREATE TRIGGER trg_recompute_chat_last_message_on_update AFTER UPDATE OF deleted_at,content,created_at ON chat.messages
FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR OLD.created_at IS DISTINCT FROM NEW.created_at
  OR (OLD.content IS DISTINCT FROM NEW.content AND NOT COALESCE(
    OLD.content_type='card' AND NEW.content_type='card'
    AND OLD.content LIKE '{"v":1,"type":"question","text":%' AND NEW.content LIKE '{"v":1,"type":"question","text":%'
    AND chat.message_preview(OLD.content,OLD.content_type) IS NOT DISTINCT FROM chat.message_preview(NEW.content,NEW.content_type),false)))
EXECUTE FUNCTION chat.recompute_chat_last_message_on_update();

CREATE FUNCTION chat.settle_agent_question_card(p_message_id text, p_state text, p_answers jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  owner_id text := auth.uid()::text;
  room_id text;
  original chat.messages%ROWTYPE;
  card jsonb;
  settlement jsonb;
  answer jsonb;
  question jsonb;
  question_index integer;
  recipient text;
BEGIN
  IF owner_id IS NULL THEN RAISE EXCEPTION 'authenticated owner required' USING ERRCODE = '42501'; END IF;
  IF p_state IS NULL OR p_state NOT IN ('answered', 'withdrawn', 'discuss') THEN
    RAISE EXCEPTION 'invalid question settlement' USING ERRCODE = '22023';
  END IF;
  IF p_state = 'answered' THEN
    IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'array' OR jsonb_array_length(p_answers) NOT BETWEEN 1 AND 3 THEN
      RAISE EXCEPTION 'complete question answers required' USING ERRCODE = '22023';
    END IF;
    FOR answer IN SELECT value FROM jsonb_array_elements(p_answers) LOOP
      IF jsonb_typeof(answer) <> 'object' OR jsonb_typeof(answer->'selected') IS DISTINCT FROM 'array'
        OR (answer ? 'other' AND jsonb_typeof(answer->'other') <> 'string')
        OR (answer ? 'skipped' AND answer->'skipped' <> 'true'::jsonb)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(answer->'selected') s WHERE jsonb_typeof(s.value) <> 'string')
        OR (answer->'skipped' = 'true'::jsonb AND (jsonb_array_length(answer->'selected') <> 0 OR btrim(COALESCE(answer->>'other','')) <> ''))
        OR answer - ARRAY['selected','other','skipped'] <> '{}'::jsonb THEN
        RAISE EXCEPTION 'invalid question answer' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  ELSIF p_answers IS NOT NULL THEN
    RAISE EXCEPTION 'unanswered settlement cannot contain answers' USING ERRCODE = '22023';
  END IF;

  SELECT m.chat_id INTO room_id FROM chat.messages m WHERE m.id = p_message_id;
  IF room_id IS NULL THEN RAISE EXCEPTION 'question card unavailable' USING ERRCODE = '42501'; END IF;
  -- Like deletion, serialize this message before line publication. Settlement-only bodies never rewrite the chat row.
  SELECT * INTO original FROM chat.messages m WHERE m.id = p_message_id FOR UPDATE;
  PERFORM chat.lock_chat_revision_recipients(room_id);
  IF original.id IS NULL OR original.content_type <> 'card' OR original.deleted_at IS NOT NULL OR original.retracted_at IS NOT NULL
    OR original.deleted_for_user_ids @> jsonb_build_array(owner_id)
    OR NOT EXISTS (SELECT 1 FROM identity.users a WHERE a.id = original.sender_user_id AND a.type = 'agent' AND a.owner_user_id = owner_id)
    OR NOT chat.message_visible_at(chat.history_floor(room_id,owner_id), original.created_at,original.is_whisper,original.sender_user_id,original.to_user_ids,owner_id) THEN
    RAISE EXCEPTION 'question card unavailable' USING ERRCODE = '42501';
  END IF;
  BEGIN card := original.content::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'question card unavailable' USING ERRCODE = '42501'; END;
  IF jsonb_typeof(card) IS DISTINCT FROM 'object' OR card->'v' IS DISTINCT FROM '1'::jsonb OR card->>'type' IS DISTINCT FROM 'question'
    OR jsonb_typeof(card->'text') IS DISTINCT FROM 'string' OR btrim(card->>'text') = ''
    OR card->>'ownerUserId' IS DISTINCT FROM owner_id OR card->>'questionId' IS DISTINCT FROM 'agent-question:' || p_message_id THEN
    RAISE EXCEPTION 'question card unavailable' USING ERRCODE = '42501';
  END IF;
  IF card ? 'settled' THEN
    IF card->'settled'->>'state' IS NULL OR card->'settled'->>'state' NOT IN ('answered','withdrawn','discuss') THEN
      RAISE EXCEPTION 'invalid stored question settlement' USING ERRCODE = '22023';
    END IF;
    RETURN card->'settled'; -- The first explicit result wins, including retries with a different proposed result.
  END IF;
  IF p_state = 'answered' AND jsonb_typeof(card->'questions') = 'array'
    AND jsonb_array_length(card->'questions') <> jsonb_array_length(p_answers) THEN
    RAISE EXCEPTION 'answer count differs from question count' USING ERRCODE = '22023';
  END IF;
  IF p_state = 'answered' AND jsonb_typeof(card->'questions') = 'array' THEN
    FOR question_index IN 0..jsonb_array_length(p_answers)-1 LOOP
      question := card->'questions'->question_index;
      answer := p_answers->question_index;
      IF jsonb_typeof(question->'options') IS DISTINCT FROM 'array' OR jsonb_typeof(question->'multiSelect') IS DISTINCT FROM 'boolean'
        OR (SELECT count(*) <> count(DISTINCT value) FROM jsonb_array_elements(answer->'selected'))
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(answer->'selected') selected
          WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(question->'options') offered WHERE offered->>'optionId'=selected.value))
        OR (question->'multiSelect' = 'false'::jsonb AND jsonb_array_length(answer->'selected') > 1)
        OR (question->'multiSelect' = 'false'::jsonb AND answer->'skipped' IS DISTINCT FROM 'true'::jsonb
          AND jsonb_array_length(answer->'selected') = 0 AND btrim(COALESCE(answer->>'other','')) = '') THEN
        RAISE EXCEPTION 'answer differs from question' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;
  settlement := jsonb_build_object('state',p_state,'at',clock_timestamp());
  IF p_state = 'answered' THEN settlement := settlement || jsonb_build_object('answers',p_answers); END IF;
  -- v/type/text must remain first: older list-preview readers inspect only the first 100 characters.
  UPDATE chat.messages SET content = '{"v":1,"type":"question","text":' || (card->'text')::text || ','
    || substr(((card - ARRAY['v','type','text']) || jsonb_build_object('settled',settlement))::text,2)
    WHERE id = p_message_id;
  FOR recipient IN
    SELECT DISTINCT m.user_id FROM chat.active_members m WHERE m.chat_id = room_id
      AND NOT original.deleted_for_user_ids @> jsonb_build_array(m.user_id)
      AND chat.message_visible_at(chat.history_floor(room_id,m.user_id),original.created_at,original.is_whisper,original.sender_user_id,original.to_user_ids,m.user_id)
    ORDER BY m.user_id
  LOOP
    PERFORM chat.publish_user_revision(recipient,'chat_changed',jsonb_build_object('chat_id',room_id,'message_id',p_message_id),false);
  END LOOP;
  RETURN settlement;
END;
$$;
REVOKE ALL ON FUNCTION chat.settle_agent_question_card(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.settle_agent_question_card(text,text,jsonb) TO authenticated;

-- Carry the current message body in revision replay as well as live wakeups. All pre-existing event meanings stay intact.
DO $refresh$
DECLARE definition text; acl aclitem[]; permission record;
BEGIN
  SELECT pg_get_functiondef(p.oid),COALESCE(p.proacl,acldefault('f',p.proowner)) INTO definition,acl
    FROM pg_proc p WHERE p.oid='chat.sync_since(bigint,integer)'::regprocedure;
  IF strpos(definition, 'WHEN selected.event = ''message_created'' THEN COALESCE(') = 0
    OR strpos(definition, 'WHERE v.id::text = selected.resource_key ->> ''entity_id''') = 0 THEN
    RAISE EXCEPTION 'unexpected sync_since predecessor';
  END IF;
  definition := replace(definition, 'WHEN selected.event = ''message_created'' THEN COALESCE(',
    'WHEN selected.event = ''message_created'' OR (selected.event = ''chat_changed'' AND selected.resource_key ? ''message_id'') THEN COALESCE(');
  definition := replace(definition, 'WHERE v.id::text = selected.resource_key ->> ''entity_id''',
    'WHERE v.id::text = CASE WHEN selected.event = ''chat_changed'' THEN selected.resource_key ->> ''message_id'' ELSE selected.resource_key ->> ''entity_id'' END
      AND (selected.event <> ''chat_changed'' OR (v.chat_id = selected.resource_key ->> ''chat_id''
        AND v.deleted_at IS NULL AND v.retracted_at IS NULL AND NOT v.deleted_for_user_ids @> jsonb_build_array(current_user_id)
        AND chat.message_visible_at(chat.history_floor(v.chat_id,current_user_id),v.created_at,v.is_whisper,v.sender_user_id,v.to_user_ids,current_user_id)))');
  EXECUTE definition;
  -- Replacement also invokes the installed API-close DDL guard. Restore exactly its predecessor ACL.
  FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable
    FROM aclexplode(acl) WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION chat.sync_since(bigint,integer) TO %s%s',
      CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
      CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END;
$refresh$;
NOTIFY pgrst, 'reload schema';
