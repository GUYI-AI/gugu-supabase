-- Personal list maintenance is reversible; membership, history and Agent lifecycle are not changed.
-- This release is additive. Old permanent list tombstones are deliberately not converted.
SET LOCAL ROLE postgres;
SET LOCAL lock_timeout = '5s';

-- Private state deliberately stays outside chat_members: the existing peer SELECT policy,
-- active_members view and legacy row_to_json member broadcasts must never carry this fact.
CREATE TABLE chat.conversation_list_state (
  chat_id text NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  conversation_hidden_at timestamptz,
  PRIMARY KEY (chat_id,user_id)
);
ALTER TABLE chat.conversation_list_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.conversation_list_state FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON TABLE chat.conversation_list_state IS
  'Personal list state only; never an authorization, membership, history or file-retention predicate. Read through caller-scoped display RPCs.';

-- Lock rule: existing publishers finish their device/chat/member admission first and lock the
-- globally sorted chat+source account heads before touching private state. Restoration does not
-- acquire chat FOR UPDATE/NO KEY UPDATE or member locks, nor insert private rows after the heads.
-- Hide first shares the owner lifecycle guard used by erase_human_account, then takes parent
-- KEY SHARE (identity then chat, including every FK parent) before its
-- single own head; afterwards it writes private rows and publishes ONLY that account's revision.
-- There is no visibility barrier and no new lock inserted into nested management/topic/file paths.
-- Account erasure can publish a surviving peer's head while visiting an earlier DM. Acquire
-- every existing affected chat/member parent in deterministic order before that first publication;
-- otherwise a later chat FOR UPDATE cycles with that peer's hide holding its chat KEY SHARE.
-- Preserve the installed erasure body and ACL; only add this admission-lock prelude.
DO $erase_lock_order$
DECLARE definition text; previous text; marker text := '    FOR affected_chat_id IN';
BEGIN
  SELECT pg_get_functiondef('identity.erase_human_account(text)'::regprocedure) INTO definition;
  previous := definition;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker) <> 1 THEN
    RAISE EXCEPTION 'Unexpected erasure lock-order predecessor';
  END IF;
  definition := replace(definition,marker,
    '    PERFORM 1 FROM chat.chats c WHERE EXISTS (
        SELECT 1 FROM chat.chat_members cm
        WHERE cm.chat_id=c.id AND cm.user_id=ANY(delete_user_ids)
    ) ORDER BY c.id FOR UPDATE;
    PERFORM 1 FROM chat.chat_members cm WHERE EXISTS (
        SELECT 1 FROM chat.chat_members affected
        WHERE affected.chat_id=cm.chat_id AND affected.user_id=ANY(delete_user_ids)
    ) ORDER BY cm.chat_id,cm.user_id FOR UPDATE;

' || marker);
  IF definition=previous THEN RAISE EXCEPTION 'Missing erasure lock prelude'; END IF;
  EXECUTE definition;
END;
$erase_lock_order$;

CREATE FUNCTION chat.restore_conversation_list_rows(p_chat_id text, p_visible_users text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE restored record;
BEGIN
  PERFORM chat.lock_chat_revision_recipients(p_chat_id);
  FOR restored IN
    UPDATE chat.conversation_list_state state SET conversation_hidden_at = NULL
      FROM chat.chat_members m
      WHERE state.chat_id = m.chat_id AND state.user_id = m.user_id
        AND state.chat_id IN (p_chat_id, (SELECT c.source_chat_id FROM chat.chats c WHERE c.id = p_chat_id AND c.kind = 'topic'))
        AND state.user_id = ANY(p_visible_users) AND state.conversation_hidden_at IS NOT NULL
        AND m.conversation_deleted_at IS NULL AND identity.user_is_live(m.user_id)
      RETURNING state.chat_id,state.user_id
  LOOP
    PERFORM chat.publish_user_revision(restored.user_id,'chat_members_changed',
      jsonb_build_object('chat_id',restored.chat_id,'user_id',restored.user_id,'kind','own'),false);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION chat.restore_conversation_list_rows(text,text[]) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION chat.restore_message_conversation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- Imported root and turn rows are historical, including a late import with a recent created_at.
  IF NEW.deleted_at IS NULL AND NEW.retracted_at IS NULL
     AND NOT COALESCE(chat.is_pending_delivery(NEW.id,NEW.content_type,NEW.sender_user_id,NEW.client_message_id),false)
     AND COALESCE(NEW.client_message_id, '') !~ '^session-import-(root|turn):' THEN
    PERFORM chat.restore_conversation_list_rows(NEW.chat_id, ARRAY(
      SELECT DISTINCT m.user_id FROM chat.active_members m
      JOIN identity.users u ON u.id = m.user_id AND u.type = 'human'
      WHERE m.chat_id IN (NEW.chat_id, (SELECT c.source_chat_id FROM chat.chats c WHERE c.id = NEW.chat_id AND c.kind = 'topic'))
        AND chat.message_visible_to(NEW.chat_id, NEW.created_at, NEW.is_whisper,
          NEW.sender_user_id, NEW.to_user_ids, m.user_id)));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.restore_message_conversation() FROM PUBLIC, anon, authenticated, service_role;
-- An AFTER INSERT only fires for an inserted row: an idempotent conflict must not restore a row.
-- Alphabetically before messages_broadcast_created and all other AFTER INSERT publications.
CREATE TRIGGER messages_a_restore_conversation AFTER INSERT ON chat.messages
  FOR EACH ROW EXECUTE FUNCTION chat.restore_message_conversation();

CREATE TABLE chat.conversation_hide_operations (
  user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  chat_id text NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE,
  receipt jsonb NOT NULL,
  PRIMARY KEY (user_id, operation_id)
);
ALTER TABLE chat.conversation_hide_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.conversation_hide_operations FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION chat.hide_my_conversation(p_chat_id text, p_operation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE caller text := auth.uid()::text; hidden timestamptz; permanent timestamptz; already boolean; receipt jsonb;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'conversation_hide_owner_required' USING ERRCODE = '42501'; END IF;
  -- Erasure may visit other chats/heads before deleting its identity parent. Reuse its outer guard
  -- before FK parent locks, rather than holding an identity KEY SHARE while waiting on its head.
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:erase-human:' || caller,0));
  IF NOT EXISTS (SELECT 1 FROM identity.users u
    WHERE u.id = caller AND u.type = 'human' AND u.removed_at IS NULL) THEN
    RAISE EXCEPTION 'conversation_hide_owner_required' USING ERRCODE = '42501';
  END IF;
  IF p_operation_id IS NULL THEN RAISE EXCEPTION 'conversation_hide_operation_required' USING ERRCODE = '22023'; END IF;
  -- Authorize before taking any locks on a requested conversation.
  IF NOT EXISTS (SELECT 1 FROM chat.active_members m JOIN chat.chats c ON c.id = m.chat_id
    WHERE m.chat_id = p_chat_id AND m.user_id = caller AND c.kind IN ('dm','ai','group','topic')
      AND c.status IN ('active','stopped','paused')) THEN
    RAISE EXCEPTION 'conversation_hide_membership_required' USING ERRCODE = '42501';
  END IF;
  -- Serialize the same operation key even when an invalid retry names a different chat.
  PERFORM pg_advisory_xact_lock(hashtextextended('chat:hide:' || caller || ':' || p_operation_id::text,0));
  -- Parent locks precede the only account head this RPC may acquire. KEY SHARE permits message
  -- sequence/preview NO KEY UPDATE but waits before the head for management's FOR UPDATE.
  -- Both private tables below reference these same two parents; no implicit FK lock is deferred.
  PERFORM 1 FROM identity.users u WHERE u.id = caller FOR KEY SHARE;
  PERFORM 1 FROM chat.chats c WHERE c.id = p_chat_id FOR KEY SHARE;
  PERFORM chat.lock_revision_heads(ARRAY[caller]);
  SELECT o.receipt INTO receipt FROM chat.conversation_hide_operations o
    WHERE o.user_id = caller AND o.operation_id = p_operation_id;
  IF FOUND THEN
    IF receipt->>'chat_id' IS DISTINCT FROM p_chat_id THEN
      RAISE EXCEPTION 'conversation_hide_operation_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN receipt;
  END IF;
  SELECT state.conversation_hidden_at,m.conversation_deleted_at INTO hidden,permanent
    FROM chat.chat_members m LEFT JOIN chat.conversation_list_state state
      ON state.chat_id = m.chat_id AND state.user_id = m.user_id
    WHERE m.chat_id = p_chat_id AND m.user_id = caller;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_hide_membership_required' USING ERRCODE = '42501'; END IF;
  IF permanent IS NOT NULL THEN RAISE EXCEPTION 'conversation_permanently_deleted' USING ERRCODE = '55000'; END IF;
  already := hidden IS NOT NULL;
  IF NOT already THEN
    INSERT INTO chat.conversation_list_state(chat_id,user_id,conversation_hidden_at)
      VALUES(p_chat_id,caller,clock_timestamp()) ON CONFLICT (chat_id,user_id)
      DO UPDATE SET conversation_hidden_at = EXCLUDED.conversation_hidden_at
      RETURNING conversation_hidden_at INTO hidden;
    -- Never call the roster publisher here: it would acquire other accounts' heads after ours.
    PERFORM chat.publish_user_revision(caller,'chat_members_changed',
      jsonb_build_object('chat_id',p_chat_id,'user_id',caller,'kind','own'),false);
  END IF;
  IF NOT identity.user_is_live(caller) THEN
    RAISE EXCEPTION 'conversation_hide_owner_required' USING ERRCODE = '42501';
  END IF;
  receipt := jsonb_build_object('chat_id', p_chat_id, 'hidden_at', hidden, 'already', already,
    'operation_id',p_operation_id,
    'account_revision', COALESCE((SELECT h.revision FROM chat.account_revision_heads h WHERE h.user_id = caller),0)::text);
  INSERT INTO chat.conversation_hide_operations(user_id,operation_id,chat_id,receipt) VALUES(caller,p_operation_id,p_chat_id,receipt);
  RETURN receipt;
END;
$$;
REVOKE ALL ON FUNCTION chat.hide_my_conversation(text,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.hide_my_conversation(text,uuid) TO authenticated;

-- Old clients keep their receipt shape, but future operations have the same temporary meaning.
-- Already-written permanent records remain permanent and replay their original receipt.
CREATE OR REPLACE FUNCTION chat.delete_my_dm_conversation(p_chat_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE receipt jsonb; permanent timestamptz; caller text := auth.uid()::text;
BEGIN
  IF caller IS NULL OR NOT EXISTS (SELECT 1 FROM identity.users u WHERE u.id = caller AND u.type = 'human' AND u.removed_at IS NULL) THEN
    RAISE EXCEPTION 'conversation_delete_owner_required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chat.chats c JOIN chat.chat_members m ON m.chat_id = c.id
    WHERE c.id = p_chat_id AND c.kind = 'dm' AND m.user_id = caller) THEN
    RAISE EXCEPTION 'conversation_dm_identity_unverified' USING ERRCODE = '42501';
  END IF;
  SELECT m.conversation_deleted_at INTO permanent FROM chat.chat_members m
    WHERE m.chat_id = p_chat_id AND m.user_id = caller;
  IF permanent IS NOT NULL THEN
    RETURN jsonb_build_object('chat_id', p_chat_id, 'deleted_at', permanent, 'already', true);
  END IF;
  receipt := chat.hide_my_conversation(p_chat_id,gen_random_uuid());
  RETURN receipt || jsonb_build_object('deleted_at', receipt->'hidden_at');
END;
$$;
REVOKE ALL ON FUNCTION chat.delete_my_dm_conversation(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.delete_my_dm_conversation(text) TO authenticated;

-- A native message body stays in its transcript. This ledger only deduplicates live publication;
-- it is not a second message/history store and is never populated by replay or heartbeat.
CREATE TABLE chat.native_conversation_publications (
  -- Deduplication evidence outlives device unregister/re-register, Agent removal and chat removal.
  -- Identity/device/chat strings are receipts, not authorization grants. Only owner erasure purges them.
  owner_user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 256),
  message_id text NOT NULL CHECK (length(message_id) BETWEEN 1 AND 512),
  agent_user_id text NOT NULL,
  chat_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (device_id, session_id, message_id)
);
CREATE INDEX native_conversation_publications_owner ON chat.native_conversation_publications(owner_user_id);
ALTER TABLE chat.native_conversation_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.native_conversation_publications FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION chat.publish_native_conversation_message(p_device_id text, p_agent_user_id text,
  p_session_id text, p_message_id text, p_chat_id text, p_occurred_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE caller text := auth.uid()::text; inserted boolean; prior chat.native_conversation_publications%ROWTYPE;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'native_conversation_publication_denied' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:erase-human:' || caller,0));
  IF p_occurred_at IS NULL OR NOT EXISTS (
    SELECT 1 FROM identity.users a JOIN identity.gugu_devices d ON d.device_id = a.device_id
      JOIN identity.users owner ON owner.id = caller AND owner.type = 'human' AND owner.removed_at IS NULL
    WHERE a.id = p_agent_user_id AND a.type = 'agent' AND a.owner_user_id = caller AND a.removed_at IS NULL
      AND d.device_id = p_device_id AND d.user_id::text = caller
  ) OR NOT EXISTS (
    SELECT 1 FROM chat.chats c WHERE c.id = p_chat_id AND c.kind = 'dm' AND c.status = 'active'
      AND EXISTS (SELECT 1 FROM chat.active_members m WHERE m.chat_id = c.id AND m.user_id = caller)
      AND EXISTS (SELECT 1 FROM chat.active_members m WHERE m.chat_id = c.id AND m.user_id = p_agent_user_id)
      AND (SELECT count(*) FROM chat.chat_members m WHERE m.chat_id = c.id) = 2
  ) THEN RAISE EXCEPTION 'native_conversation_publication_denied' USING ERRCODE = '42501'; END IF;
  -- Native publication observes the same device/FK parent -> member -> heads -> private state order.
  PERFORM 1 FROM identity.gugu_devices d WHERE d.device_id = p_device_id FOR KEY SHARE;
  PERFORM 1 FROM identity.users u WHERE u.id IN (caller,p_agent_user_id) ORDER BY u.id FOR KEY SHARE;
  PERFORM 1 FROM chat.chats c WHERE c.id = p_chat_id FOR KEY SHARE;
  INSERT INTO chat.native_conversation_publications(owner_user_id,device_id,session_id,message_id,agent_user_id,chat_id,occurred_at)
    VALUES(caller,p_device_id,p_session_id,p_message_id,p_agent_user_id,p_chat_id,p_occurred_at)
    ON CONFLICT (device_id,session_id,message_id) DO NOTHING;
  inserted := FOUND;
  IF inserted THEN
    -- The inbox may have been unpublished before this first real personal exchange.
    UPDATE chat.chat_members m SET inbox_published_at = clock_timestamp()
      WHERE m.chat_id = p_chat_id AND m.user_id = caller AND m.inbox_published_at IS NULL;
    PERFORM chat.restore_conversation_list_rows(p_chat_id, ARRAY[caller]);
  ELSE
    SELECT * INTO prior FROM chat.native_conversation_publications p
      WHERE p.device_id = p_device_id AND p.session_id = p_session_id AND p.message_id = p_message_id;
    IF (prior.owner_user_id,prior.agent_user_id,prior.chat_id,prior.occurred_at) IS DISTINCT FROM (caller,p_agent_user_id,p_chat_id,p_occurred_at) THEN
      RAISE EXCEPTION 'native_conversation_publication_conflict' USING ERRCODE = '23505';
    END IF;
  END IF;
  IF NOT identity.user_is_live(caller) OR NOT identity.user_is_live(p_agent_user_id) THEN
    RAISE EXCEPTION 'native_conversation_publication_denied' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('chat_id',p_chat_id,'already',NOT inserted,
    'account_revision',COALESCE((SELECT h.revision FROM chat.account_revision_heads h WHERE h.user_id = caller),0)::text);
END;
$$;
REVOKE ALL ON FUNCTION chat.publish_native_conversation_message(text,text,text,text,text,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.publish_native_conversation_message(text,text,text,text,text,timestamptz) TO authenticated;

-- A display-only historical DM peer must not become an active membership again (#1890).
CREATE FUNCTION chat.list_conversation_memberships(p_chat_ids text[])
RETURNS TABLE(chat_id text,user_id text,last_read_seq bigint,is_marked_unread boolean,version integer,
  notification_level text,is_pinned boolean,updated_at timestamptz,joined_at timestamptz,
  inbox_published_at timestamptz,role text,conversation_deleted_at timestamptz,conversation_hidden_at timestamptz,historical_only boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE viewer text := auth.uid()::text;
BEGIN
  IF viewer IS NULL OR NOT identity.user_is_live(viewer) THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_chat_ids IS NULL THEN RAISE EXCEPTION 'chat ids are required' USING ERRCODE = '22023'; END IF;
  RETURN QUERY SELECT m.chat_id,m.user_id,m.last_read_seq,m.is_marked_unread,m.version,
      m.notification_level,m.is_pinned,m.updated_at,m.joined_at,m.inbox_published_at,m.role,
      CASE WHEN m.user_id = viewer THEN m.conversation_deleted_at END,
      CASE WHEN m.user_id = viewer THEN state.conversation_hidden_at END,
      NOT identity.user_is_live(m.user_id)
    FROM chat.chat_members m JOIN chat.chats c ON c.id = m.chat_id
    JOIN chat.active_members own ON own.chat_id = c.id AND own.user_id = viewer
    LEFT JOIN chat.conversation_list_state state ON state.chat_id = m.chat_id AND state.user_id = viewer AND m.user_id = viewer
    WHERE c.id = ANY(p_chat_ids) AND (identity.user_is_live(m.user_id)
      OR c.kind IN ('dm','ai') AND EXISTS (SELECT 1 FROM identity.users u WHERE u.id = m.user_id
        AND u.type = 'agent' AND u.owner_user_id = viewer));
END;
$$;
REVOKE ALL ON FUNCTION chat.list_conversation_memberships(text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.list_conversation_memberships(text[]) TO authenticated;

-- Keep these narrow predecessor edits fail-closed, including their exact existing ACLs. No broad
-- catalog rewrite: the list, caller-scoped snapshot and unread projection only.
DO $projection$
DECLARE target regprocedure; definition text; previous text; prior_acl aclitem[]; permission record;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'chat.list_my_chats_as(text)'::regprocedure,
    'chat.sync_snapshot()'::regprocedure,
    'chat.list_unread_locators_for_chats(text[])'::regprocedure
  ] LOOP
    SELECT pg_get_functiondef(p.oid),COALESCE(p.proacl,acldefault('f',p.proowner)) INTO definition,prior_acl FROM pg_proc p WHERE p.oid = target;
    previous := definition;
    IF target = 'chat.list_my_chats_as(text)'::regprocedure THEN
      definition := replace(definition,'mine.conversation_deleted_at IS NULL',
        'mine.conversation_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM chat.conversation_list_state state WHERE state.chat_id IN (c.id,c.source_chat_id) AND state.user_id = actor AND state.conversation_hidden_at IS NOT NULL)');
    ELSIF target = 'chat.sync_snapshot()'::regprocedure THEN
      definition := replace(definition,'m.conversation_deleted_at','m.conversation_deleted_at, m.conversation_hidden_at, m.historical_only');
      definition := replace(definition,'FROM chat.active_members m JOIN conversations c ON c.id = m.chat_id',
        'FROM chat.list_conversation_memberships(ARRAY(SELECT id FROM conversations)) m JOIN conversations c ON c.id = m.chat_id');
    ELSIF target = 'chat.list_unread_locators_for_chats(text[])'::regprocedure THEN
      definition := replace(definition,'AND member.conversation_deleted_at IS NULL',
        'AND member.conversation_deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM chat.conversation_list_state state WHERE state.chat_id IN (member.chat_id,conversation.source_chat_id) AND state.user_id = v_user AND state.conversation_hidden_at IS NOT NULL)');
    END IF;
    IF definition = previous THEN RAISE EXCEPTION 'Unexpected personal-list predecessor: %',target; END IF;
    EXECUTE definition;
    FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable FROM aclexplode(prior_acl)
      WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',target,
        CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END $projection$;

NOTIFY pgrst, 'reload schema';
