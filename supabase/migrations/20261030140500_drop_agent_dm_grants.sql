-- Remove the "Agent DM sharing" objects that exist only on some databases.
--
-- They were created outside migrations (from a draft PR that was never merged) on the production and
-- the old shared test database, and are not part of this repository's schema:
--   table identity.agent_dm_grants (+ its policy, index, constraints), functions identity.share_agent_dm,
--   identity.revoke_agent_dm, identity.has_agent_dm_grant, identity.agent_dm_access, chat.dm_read_only_for,
--   and the RESTRICTIVE insert policy chat.messages.messages_insert_dm_read_only.
-- On those databases chat.get_or_create_dm was also rewritten to call identity.has_agent_dm_grant, so it
-- is put back to this repository's definition (the #509 rule) BEFORE the function it calls is dropped.
--
-- Grantees that were already let into someone else's agent DM lose that membership first (see the DO block),
-- otherwise dropping the read-only policy would turn their access into read-write.
--
-- Everything is DROP ... IF EXISTS / CREATE OR REPLACE, so this is a no-op on a database that never had
-- the objects (including a fresh install) and safe to run twice.

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

-- Existing shared DMs. With the grants a non-owner was made a member of a DM chat with someone else's agent,
-- and the RESTRICTIVE policy below was the only thing that kept read-only grantees from writing there.
-- Once the policy is gone those memberships would turn into read-write access, so revoke them first: remove
-- exactly the granted user's membership in their DM chat with the agent they were granted.
-- (Skipped when the grants table does not exist, e.g. a fresh install.)
DO $do$
BEGIN
  IF to_regclass('identity.agent_dm_grants') IS NOT NULL THEN
    EXECUTE $q$
      DELETE FROM chat.chat_members cm
      USING identity.agent_dm_grants g, chat.chats c, chat.chat_members am
      WHERE c.kind = 'dm'
        AND cm.chat_id = c.id
        AND cm.user_id = g.grantee_user_id
        AND am.chat_id = c.id
        AND am.user_id = g.agent_user_id
    $q$;
  END IF;
END
$do$;

DROP POLICY IF EXISTS messages_insert_dm_read_only ON chat.messages;
DROP FUNCTION IF EXISTS chat.dm_read_only_for(text, text);
DROP FUNCTION IF EXISTS identity.share_agent_dm(text, text, text);
DROP FUNCTION IF EXISTS identity.revoke_agent_dm(text, text);
DROP FUNCTION IF EXISTS identity.has_agent_dm_grant(text, text);
DROP FUNCTION IF EXISTS identity.agent_dm_access(text, text);
DROP TABLE IF EXISTS identity.agent_dm_grants;
