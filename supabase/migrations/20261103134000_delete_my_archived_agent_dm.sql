-- Personal list state is separate from membership authorization and retained history.
-- Nullable, without a default or backfill: existing rows retain their current behavior.
SET LOCAL lock_timeout = '5s';
ALTER TABLE chat.chat_members ADD COLUMN IF NOT EXISTS conversation_deleted_at timestamptz;
COMMENT ON COLUMN chat.chat_members.conversation_deleted_at IS 'Personal conversation-list deletion only; does not revoke membership, historical messages or file access.';

-- SELECT * in an existing view has a fixed expansion; append the new state without changing its predicate.
CREATE OR REPLACE VIEW chat.active_members WITH (security_invoker = true) AS
  SELECT m.* FROM chat.chat_members m WHERE identity.user_is_live(m.user_id);

CREATE OR REPLACE FUNCTION chat.delete_my_dm_conversation(p_chat_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  caller text := auth.uid()::text;
  peer identity.users%ROWTYPE;
  deleted_at timestamptz;
  already_deleted boolean;
BEGIN
  IF caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM identity.users u WHERE u.id = caller AND u.type = 'human' AND u.removed_at IS NULL
  ) THEN RAISE EXCEPTION 'conversation_delete_owner_required' USING ERRCODE = '42501'; END IF;

  -- Do not lock identity rows: archival locks revision heads before updating identity.
  -- This path locks chat -> own member -> revision heads, then rechecks archival under the shared head.
  -- Physical seats are intentional here: a removed agent's historical identity still belongs to its owner.
  SELECT u.* INTO peer FROM chat.chat_members m JOIN identity.users u ON u.id = m.user_id
  WHERE m.chat_id = p_chat_id AND u.type = 'agent' AND u.owner_user_id = caller;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_dm_identity_unverified' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM chat.chats c WHERE c.id = p_chat_id AND c.kind = 'dm' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM chat.chat_members m WHERE m.chat_id = p_chat_id AND m.user_id = caller
  ) OR (SELECT count(*) FROM chat.chat_members m WHERE m.chat_id = p_chat_id) <> 2
    OR NOT EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = p_chat_id AND m.user_id = peer.id)
    OR peer.owner_user_id IS DISTINCT FROM caller THEN
    RAISE EXCEPTION 'conversation_dm_identity_unverified' USING ERRCODE = '42501';
  END IF;
  SELECT m.conversation_deleted_at INTO deleted_at FROM chat.chat_members m
  WHERE m.chat_id = p_chat_id AND m.user_id = caller FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM identity.users u WHERE u.id = caller AND u.type = 'human' AND u.removed_at IS NULL
  ) THEN RAISE EXCEPTION 'conversation_delete_owner_required' USING ERRCODE = '42501'; END IF;
  already_deleted := deleted_at IS NOT NULL;
  IF NOT already_deleted THEN
    SELECT u.* INTO peer FROM identity.users u WHERE u.id = peer.id;
    IF peer.owner_user_id IS DISTINCT FROM caller THEN
      RAISE EXCEPTION 'conversation_dm_identity_unverified' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM identity.agent_provisions p WHERE p.agent_user_id = peer.id
        AND p.owner_user_id = caller AND p.member_key = 'assistant'
    ) THEN RAISE EXCEPTION 'conversation_assistant_in_use' USING ERRCODE = '55000'; END IF;
    IF peer.session_archived_at IS NULL AND peer.removed_at IS NULL THEN
      RAISE EXCEPTION 'conversation_agent_in_use' USING ERRCODE = '55000';
    END IF;
    UPDATE chat.chat_members m SET conversation_deleted_at = clock_timestamp()
    WHERE m.chat_id = p_chat_id AND m.user_id = caller
    RETURNING m.conversation_deleted_at INTO deleted_at;
    -- The existing member trigger holds the same ordered revision heads as archival.
    -- A restore/removal committed while we waited must win; an exception rolls back the update and revision.
    IF NOT EXISTS (
      SELECT 1 FROM identity.users u WHERE u.id = caller AND u.type = 'human' AND u.removed_at IS NULL
    ) THEN RAISE EXCEPTION 'conversation_delete_owner_required' USING ERRCODE = '42501'; END IF;
    IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id = peer.id
      AND u.session_archived_at IS NULL AND u.removed_at IS NULL) THEN
      RAISE EXCEPTION 'conversation_agent_in_use' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN jsonb_build_object('chat_id', p_chat_id, 'deleted_at', deleted_at, 'already', already_deleted);
END;
$$;
REVOKE ALL ON FUNCTION chat.delete_my_dm_conversation(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION chat.delete_my_dm_conversation(text) TO authenticated;

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
    WHERE mine.user_id = actor AND mine.conversation_deleted_at IS NULL AND c.status IN ('active','stopped','paused')
    ORDER BY c.last_message_at DESC NULLS LAST,c.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION chat.list_my_chats_as(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.list_my_chats_as(text) TO authenticated;

-- Keep account snapshots and unread/list projections aligned, without filtering authorization views.
-- Preserve installed function attributes/bodies and restore their exact ACLs after the DDL guard runs.
DO $personal_list_reads$
DECLARE target regprocedure; definition text; previous text; prior_acl aclitem[]; permission record;
BEGIN
  FOREACH target IN ARRAY ARRAY['chat.sync_snapshot()'::regprocedure,'chat.list_unread_locators(text)'::regprocedure] LOOP
    SELECT pg_get_functiondef(p.oid),COALESCE(p.proacl,acldefault('f',p.proowner))
      INTO definition,prior_acl FROM pg_proc p WHERE p.oid=target;
    previous := definition;
    IF target='chat.sync_snapshot()'::regprocedure THEN
      definition := replace(definition,'WHERE own.inbox_published_at IS NOT NULL',
        'WHERE own.inbox_published_at IS NOT NULL AND own.conversation_deleted_at IS NULL');
      IF definition=previous THEN RAISE EXCEPTION 'Unexpected account snapshot predecessor'; END IF;
      previous := definition;
      definition := replace(definition,'m.inbox_published_at, m.role','m.inbox_published_at, m.role, m.conversation_deleted_at');
      IF definition=previous THEN RAISE EXCEPTION 'Unexpected snapshot membership predecessor'; END IF;
    ELSE
      definition := replace(definition,'AND member.inbox_published_at IS NOT NULL',
        'AND member.inbox_published_at IS NOT NULL AND member.conversation_deleted_at IS NULL');
      IF definition=previous THEN RAISE EXCEPTION 'Unexpected unread locator predecessor'; END IF;
    END IF;
    EXECUTE definition;
    FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable FROM aclexplode(prior_acl)
      WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',target,
        CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END $personal_list_reads$;
