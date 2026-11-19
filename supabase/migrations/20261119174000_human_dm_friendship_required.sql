-- #343: friendship is an additional write boundary for human-to-human DMs.
-- Existing seats and history stay intact. The table guards also cover writes
-- made through SECURITY DEFINER functions, rather than relying on RLS alone.

CREATE OR REPLACE FUNCTION chat_private.require_human_friendship(p_user_a text, p_user_b text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- Agent conversations keep their own ownership/social-group contracts.
  IF NOT EXISTS (
    SELECT 1 FROM identity.users a, identity.users b
    WHERE a.id = p_user_a AND b.id = p_user_b
      AND a.type = 'human' AND b.type = 'human'
  ) THEN RETURN; END IF;

  -- Same canonical relationship and live-identity semantics as active_friendships.
  -- SHARE conflicts with DELETE and keeps removal from committing ahead of a
  -- write authorized by this row. A waiter rechecks the row after removal.
  PERFORM 1 FROM identity.friendships f
  WHERE f.user_a_id = LEAST(p_user_a, p_user_b)
    AND f.user_b_id = GREATEST(p_user_a, p_user_b)
    AND identity.user_is_live(f.user_a_id)
    AND identity.user_is_live(f.user_b_id)
  FOR SHARE OF f;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dm_friendship_required'
      USING ERRCODE = '42501', HINT = 'dm_friendship_required';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION chat_private.require_human_friendship(text,text)
  FROM PUBLIC, anon, authenticated, service_role, gugu_files;

CREATE OR REPLACE FUNCTION chat_private.require_dm_friendship(p_chat_id text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE people text[]; has_agent boolean; all_humans boolean;
BEGIN
  -- Do not turn a rejected insert/reaction into a probe of somebody else's DM.
  -- Trusted server writes without an end-user claim are still checked below.
  IF auth.uid() IS NOT NULL
     AND NOT chat.is_chat_member(p_chat_id, auth.uid()::text) THEN RETURN; END IF;

  SELECT array_agg(m.user_id ORDER BY m.user_id),
         bool_or(COALESCE(u.type = 'agent', false)),
         bool_and(COALESCE(u.type = 'human', false))
    INTO people, has_agent, all_humans
  FROM chat.chats c
  JOIN chat.chat_members m ON m.chat_id = c.id
  LEFT JOIN identity.users u ON u.id = m.user_id
  WHERE c.id = p_chat_id AND c.kind = 'dm';
  IF people IS NULL OR has_agent THEN RETURN; END IF;
  -- A missing/deleted human peer is not a friendship exemption.
  IF cardinality(people) <> 2 OR NOT all_humans THEN
    RAISE EXCEPTION 'dm_friendship_required'
      USING ERRCODE = '42501', HINT = 'dm_friendship_required';
  END IF;
  PERFORM chat_private.require_human_friendship(people[1], people[2]);
END;
$$;
REVOKE ALL ON FUNCTION chat_private.require_dm_friendship(text)
  FROM PUBLIC, anon, authenticated, service_role, gugu_files;

CREATE OR REPLACE FUNCTION chat.get_or_create_dm(p_target_user_id text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'chat', 'identity', 'public'
    AS $$
DECLARE
    v_current_user_id TEXT := auth.uid()::text;
    v_target_user_id TEXT := NULLIF(p_target_user_id, '');
    v_target_type TEXT;
    v_target_name TEXT;
    v_dm_name TEXT;
    v_user_low TEXT;
    v_user_high TEXT;
    v_chat_id TEXT;
BEGIN
    IF v_current_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF v_target_user_id IS NULL OR v_target_user_id = v_current_user_id THEN
        RAISE EXCEPTION 'Invalid DM target';
    END IF;

    SELECT u.type, u.display_name
    INTO v_target_type, v_target_name
    FROM identity.users u
    WHERE u.id = v_target_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target user no longer exists';
    END IF;

    -- @@@dm-owned-agent-only (#509) - a DM whose target is an agent is only allowed
    -- when the caller owns that agent. A non-owner reaches the agent through the
    -- shared owner+agent+requester group instead, never a private 1:1 (privacy).
    -- IS DISTINCT FROM (not <>) so an agent with a NULL owner is also rejected — an
    -- ownerless agent must not be DM-able by anyone.
    IF EXISTS (
        SELECT 1 FROM identity.users u
        WHERE u.id = v_target_user_id
          AND u.type = 'agent'
          AND u.owner_user_id IS DISTINCT FROM v_current_user_id
    ) THEN
        RAISE EXCEPTION 'Cannot open a DM with an agent you do not own; use the shared group';
    END IF;

    PERFORM chat_private.require_human_friendship(v_current_user_id, v_target_user_id);

    -- @@@1623 - snapshot the agent's name into chats.name so the DM keeps a readable name after the agent is
    -- removed / its membership disappears. Only for agent DMs; human DMs keep NULL (peer name is computed live
    -- because a human can rename their profile). A blank agent name stays NULL → #1624 fail-loud (no fake).
    v_dm_name := CASE WHEN v_target_type = 'agent' THEN NULLIF(btrim(v_target_name), '') ELSE NULL END;

    v_user_low := LEAST(v_current_user_id, v_target_user_id);
    v_user_high := GREATEST(v_current_user_id, v_target_user_id);

    PERFORM pg_advisory_xact_lock(hashtextextended('chat:dm:' || v_user_low || ':' || v_user_high, 0));

    SELECT c.id
    INTO v_chat_id
    FROM chat.chats c
    WHERE c.kind = 'dm'
      AND c.status = 'active'
      AND EXISTS (
          SELECT 1 FROM chat.chat_members cm
          WHERE cm.chat_id = c.id
            AND cm.user_id = v_current_user_id
      )
      AND EXISTS (
          SELECT 1 FROM chat.chat_members cm
          WHERE cm.chat_id = c.id
            AND cm.user_id = v_target_user_id
      )
      AND (
          SELECT COUNT(*)
          FROM chat.chat_members cm
          WHERE cm.chat_id = c.id
      ) = 2
    ORDER BY c.created_at ASC
    LIMIT 1;

    IF v_chat_id IS NOT NULL THEN
        -- @@@1623 - heal an existing agent DM that predates this snapshot (name still NULL) while the agent is
        -- still resolvable. Only fill when currently NULL — never clobber an already-persisted name.
        IF v_dm_name IS NOT NULL THEN
            UPDATE chat.chats SET name = v_dm_name WHERE id = v_chat_id AND name IS NULL;
        END IF;
        RETURN v_chat_id;
    END IF;

    v_chat_id := gen_random_uuid()::text;
    INSERT INTO chat.chats (id, kind, name, creator_user_id)
    VALUES (v_chat_id, 'dm', v_dm_name, v_current_user_id);

    INSERT INTO chat.chat_members (chat_id, user_id, role)
    VALUES
        (v_chat_id, v_current_user_id, 'owner'),
        (v_chat_id, v_target_user_id, 'member');

    RETURN v_chat_id;
END;
$$;

-- Locking authorization must be VOLATILE, not the old read-only STABLE entry.
CREATE OR REPLACE FUNCTION chat.attachment_sender_check(p_chat_id text, p_sender_user_id text) RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
    IF (SELECT auth.uid()) IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;
    IF NOT chat.is_acting_as(p_sender_user_id) THEN
        RAISE EXCEPTION 'Not allowed to act as %', COALESCE(p_sender_user_id, '<null>');
    END IF;
    PERFORM chat.workspace_require_room_member(p_chat_id, p_sender_user_id);
    PERFORM chat_private.require_dm_friendship(p_chat_id);
END;
$$;

CREATE OR REPLACE FUNCTION chat_private.guard_human_dm_message()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only user-facing body edits are new communication here. Existing column
    -- grants and private entrypoints still own routing/attachment locators.
    -- In particular do not block a settled blob rewrite, identity redaction,
    -- retraction, or personal/global deletion of an existing historical row.
    IF ROW(NEW.content, NEW.content_type, NEW.encrypted_content, NEW.encryption_key_id)
       IS NOT DISTINCT FROM
       ROW(OLD.content, OLD.content_type, OLD.encrypted_content, OLD.encryption_key_id)
    THEN RETURN NEW; END IF;
    -- Moving a row out of a DM cannot be used to edit around its old boundary.
    PERFORM chat_private.require_dm_friendship(OLD.chat_id);
  ELSIF NEW.sender_user_id IS NULL AND NEW.content_type = 'system' THEN
    -- Server notices are not person-to-person sends. Existing RLS still refuses
    -- an ordinary caller trying to forge a sender-less message.
    RETURN NEW;
  END IF;

  PERFORM chat_private.require_dm_friendship(NEW.chat_id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat_private.guard_human_dm_message()
  FROM PUBLIC, anon, authenticated, service_role, gugu_files;

DROP TRIGGER IF EXISTS messages_b_human_dm_friendship ON chat.messages;
CREATE TRIGGER messages_b_human_dm_friendship
  BEFORE INSERT OR UPDATE ON chat.messages
  FOR EACH ROW EXECUTE FUNCTION chat_private.guard_human_dm_message();

CREATE OR REPLACE FUNCTION chat_private.guard_human_dm_reaction()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE room text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    SELECT m.chat_id INTO room FROM chat.messages m WHERE m.id = OLD.message_id;
    IF room IS NOT NULL THEN PERFORM chat_private.require_dm_friendship(room); END IF;
  END IF;
  SELECT m.chat_id INTO room FROM chat.messages m WHERE m.id = NEW.message_id;
  IF room IS NOT NULL THEN PERFORM chat_private.require_dm_friendship(room); END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat_private.guard_human_dm_reaction()
  FROM PUBLIC, anon, authenticated, service_role, gugu_files;

DROP TRIGGER IF EXISTS reactions_human_dm_friendship ON chat.message_reactions;
CREATE TRIGGER reactions_human_dm_friendship
  BEFORE INSERT OR UPDATE ON chat.message_reactions
  FOR EACH ROW EXECUTE FUNCTION chat_private.guard_human_dm_reaction();

NOTIFY pgrst, 'reload schema';
