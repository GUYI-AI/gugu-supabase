-- The release installer owns the transaction and migration ledger.
SET LOCAL lock_timeout = '5s';

-- Removing an agent closes its DMs for the people on the other side, with the same personal deletion state
-- (chat_members.conversation_deleted_at) that chat.delete_my_dm_conversation writes. Seats, messages and the
-- identity's history stay as they are; the DM becomes a gone conversation, exactly as after a personal Delete.
-- Lock order: DM chat rows, then every member's revision head, then the identity row. A personal Delete takes
-- chat -> member -> heads and session archival takes heads -> identity, so neither can cross this one.
CREATE OR REPLACE FUNCTION identity.archive_user(p_user_id text, p_remove_social_identity boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target identity.users%ROWTYPE; caller text := auth.uid()::text; dms text[];
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_remove_social_identity IS NULL THEN
    RAISE EXCEPTION 'remove_social_identity must be a boolean' USING ERRCODE = '22023';
  END IF;
  IF p_remove_social_identity AND EXISTS (SELECT 1 FROM identity.users u WHERE u.id = p_user_id
    AND u.type = 'agent' AND u.owner_user_id = caller AND u.removed_at IS NULL) THEN
    SELECT array_agg(c.id ORDER BY c.id) INTO dms FROM chat.chats c
      WHERE c.kind = 'dm' AND EXISTS (SELECT 1 FROM chat.active_members a WHERE a.chat_id = c.id AND a.user_id = p_user_id);
    PERFORM 1 FROM chat.chats c WHERE c.id = ANY(dms) ORDER BY c.id FOR UPDATE;
    PERFORM chat.lock_revision_heads(ARRAY(SELECT m.user_id FROM chat.active_members m WHERE m.chat_id = ANY(dms)));
  END IF;
  SELECT * INTO target FROM identity.users u
    WHERE u.id = p_user_id AND (u.id = caller OR (u.type = 'agent' AND u.owner_user_id = caller))
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Identity is not owned by current user' USING ERRCODE = '42501'; END IF;
  IF target.removed_at IS NOT NULL AND NOT p_remove_social_identity THEN
    RAISE EXCEPTION 'identity_removed: restoring requires a new identity' USING ERRCODE = '55000';
  END IF;
  IF target.removed_at IS NULL AND NOT identity.user_is_live(caller) THEN
    RAISE EXCEPTION 'Identity is not active' USING ERRCODE = '42501';
  END IF;
  IF p_remove_social_identity AND target.removed_at IS NULL THEN
    IF target.type = 'agent' THEN
      UPDATE chat.chat_members m SET conversation_deleted_at = clock_timestamp()
        FROM chat.active_members peer
        WHERE peer.chat_id = ANY(dms) AND peer.user_id <> target.id AND peer.conversation_deleted_at IS NULL
          AND m.chat_id = peer.chat_id AND m.user_id = peer.user_id;
    END IF;
    UPDATE identity.users SET removed_at = clock_timestamp() WHERE id = target.id
      RETURNING * INTO target;
  END IF;
  -- false leaves social state alone; the host keeps its existing revisioned
  -- set_agent_session_archival/offline-interval path. No membership DML here.
  RETURN jsonb_build_object('user_id', target.id, 'removed_at', target.removed_at,
    'remove_social_identity', p_remove_social_identity);
END;
$$;
REVOKE ALL ON FUNCTION identity.archive_user(text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.archive_user(text,boolean) TO authenticated;
