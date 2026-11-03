-- Roll out only AFTER clients can notify owners through native session records.
-- The DM, membership, messages and file references remain available for historical reads.
-- A table trigger also covers service/definer send paths; an RLS-only policy would not.
CREATE OR REPLACE FUNCTION chat.reject_ordinary_agent_dm_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM chat.chats c
    JOIN chat.chat_members am ON am.chat_id = c.id
    JOIN identity.users a ON a.id = am.user_id AND a.type = 'agent'
    JOIN chat.chat_members hm ON hm.chat_id = c.id AND hm.user_id = a.owner_user_id
    JOIN identity.users h ON h.id = hm.user_id AND h.type = 'human'
    WHERE c.id = NEW.chat_id AND c.kind = 'dm'
      AND (SELECT count(*) FROM chat.chat_members cm WHERE cm.chat_id = c.id) = 2
      -- The assistant is identified by its durable provision marker, never its name/host.
      AND NOT EXISTS (
        SELECT 1 FROM identity.agent_provisions p
        WHERE p.agent_user_id = a.id AND p.owner_user_id = h.id AND p.member_key = 'assistant'
      )
  ) THEN
    RAISE EXCEPTION 'Ordinary agent private chats are read-only; use the agent session'
      USING ERRCODE = '42501', HINT = 'ordinary_agent_dm_read_only';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.reject_ordinary_agent_dm_message() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS messages_ordinary_agent_dm_read_only ON chat.messages;
CREATE TRIGGER messages_ordinary_agent_dm_read_only
BEFORE INSERT OR UPDATE OF chat_id ON chat.messages
FOR EACH ROW EXECUTE FUNCTION chat.reject_ordinary_agent_dm_message();


-- Complete ordinary provisioning without a message that no client can display.
-- Preserve the same locks, terminal checks, history requirement and operation completion.
CREATE OR REPLACE FUNCTION identity.complete_agent_provision_internal(p_provision_id uuid) RETURNS TABLE(message_id text, client_message_id text, already boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'identity', 'chat', 'public', 'pg_catalog'
    AS $$
DECLARE
    v_owner     TEXT := (SELECT auth.uid()::text);
    v_p         identity.agent_provisions;
    v_cmd_status TEXT;
    v_key       TEXT;
    v_msg_id    TEXT;
    v_content   TEXT;
    v_inserted  INT;
    v_already   BOOLEAN;
    v_e_sender  TEXT;
    v_e_content TEXT;
    v_e_ctype   TEXT;
    v_e_to      TEXT[];
    v_e_reply   TEXT;
    v_e_thread  TEXT;
BEGIN
    IF v_owner IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
    PERFORM identity.assert_provision_owner_live(v_owner);

    -- Unlocked locate (which chat/command to lock) then lock in global order and re-read + validate.
    SELECT * INTO v_p FROM identity.agent_provisions WHERE id = p_provision_id;
    IF NOT FOUND OR v_p.owner_user_id <> v_owner THEN RAISE EXCEPTION 'provision % not found for caller', p_provision_id; END IF;
    IF v_p.agent_user_id IS NULL OR v_p.dm_chat_id IS NULL OR v_p.create_command_id IS NULL THEN
        RAISE EXCEPTION 'provision % is not prepared', p_provision_id;
    END IF;

    -- F5 global lock order (identity -> chat -> command -> operation/member last): identity FIRST so complete and
    -- a concurrent remove_owned_agent (identity->chat) never form a cycle (the erase advisory does NOT cover
    -- ordinary removal — correctness is the shared identity->chat->command order, not the fence).
    -- identity lock (order 1): owner + agent, id-ordered, FOR KEY SHARE — compatible with the message insert's
    -- FK-share on the agent, consistently ahead of chat/command/op-member and behind erase's FOR UPDATE.
    PERFORM 1 FROM identity.users WHERE id IN (v_owner, v_p.agent_user_id) ORDER BY id FOR KEY SHARE;
    -- chat lock (order 2)
    PERFORM 1 FROM chat.chats WHERE id = v_p.dm_chat_id FOR UPDATE;
    -- command lock (order 3) + terminal check: reject completion before the create command is done.
    SELECT status INTO v_cmd_status FROM identity.gugu_device_commands WHERE id = v_p.create_command_id FOR UPDATE;
    IF v_cmd_status IS DISTINCT FROM 'done' THEN
        RAISE EXCEPTION 'agent.create command for provision % is not done (status=%)', p_provision_id, COALESCE(v_cmd_status,'<missing>');
    END IF;
    -- operation/member lock (LAST) + re-read and re-validate owner/phase under the lock. complete ONLY
    -- accepts a member already settled to 'ready' (its terminal folded by settle_agent_provision_terminal),
    -- and re-verifies the command is done above; 'completed' is the idempotent-replay case.
    SELECT * INTO v_p FROM identity.agent_provisions WHERE id = p_provision_id FOR UPDATE;
    IF v_p.owner_user_id <> v_owner THEN RAISE EXCEPTION 'provision % not owned by caller', p_provision_id; END IF;
    IF v_p.phase NOT IN ('ready','completed') THEN
        RAISE EXCEPTION 'provision % must be settled ready before complete (phase=%)', p_provision_id, v_p.phase;
    END IF;
    -- Required history import MUST already have landed (root non-null) before the template — imported standard
    -- history therefore always precedes the deterministic template (see import_agent_provision_history /
    -- [[conversation-data]]). No agent.deliver / model turn is ever involved.
    IF v_p.history_import_required AND v_p.history_thread_root_id IS NULL THEN
        RAISE EXCEPTION 'provision % requires history import to complete before the template (no history thread root)', p_provision_id;
    END IF;

    -- Only the personal assistant retains its cloud DM welcome. Ordinary sessions are native.
    IF v_p.member_key = 'assistant' THEN
        v_key := 'agent-bootstrap:' || p_provision_id::text || ':' || v_p.member_key;
        v_content := identity.provision_template_message(v_p.display_name, v_p.agent_type, v_p.special_focus,
            (SELECT o.blueprint->>'locale' FROM identity.agent_provision_operations o WHERE o.id = v_p.operation_id));
        v_msg_id := gen_random_uuid()::text;

        -- Agent-authored standard message, sender = the agent (only a definer path writes this under RLS).
        -- Targetless DO NOTHING avoids the partial-index WHERE predicate that shadows the OUT parameter
        -- client_message_id (42702). On a 0-row insert, re-read the stable dedup key and field-validate the FULL
        -- server-derived template projection (created_at excluded); a conflict that is NOT our dedup key (no row)
        -- or any divergent projection fails loud — never a false "already".
        INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, client_message_id)
        VALUES (v_msg_id, v_p.dm_chat_id, v_p.agent_user_id, v_content, 'text', v_key)
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 1 THEN
            v_already := false;
        ELSE
            SELECT m.id, m.sender_user_id, m.content, m.content_type, m.to_user_ids, m.reply_to_message_id, m.thread_root_id
            INTO v_msg_id, v_e_sender, v_e_content, v_e_ctype, v_e_to, v_e_reply, v_e_thread
            FROM chat.messages m WHERE m.chat_id = v_p.dm_chat_id AND m.client_message_id = v_key;
            IF v_msg_id IS NULL THEN
                RAISE EXCEPTION 'complete_agent_provision: unexpected unique conflict for provision % (no row at dedup key %)', p_provision_id, v_key;
            END IF;
            IF v_e_sender IS DISTINCT FROM v_p.agent_user_id
               OR v_e_content IS DISTINCT FROM v_content
               OR v_e_ctype IS DISTINCT FROM 'text'
               OR COALESCE(cardinality(v_e_to), 0) <> 0
               OR v_e_reply IS NOT NULL
               OR v_e_thread IS NOT NULL THEN
                RAISE EXCEPTION 'complete_agent_provision: dedup key % exists with a divergent server-derived projection', v_key;
            END IF;
            v_already := true;   -- exactly-once idempotent replay
        END IF;
    ELSE
        v_msg_id := NULL;
        v_key := NULL;
        v_already := v_p.phase = 'completed';
    END IF;

    -- Defensive raw-memory scrub for idempotent convergence (settle=done already cleared these): a completed
    -- member and its create command never retain raw memory_content.
    UPDATE identity.gugu_device_commands SET payload = payload - 'memory_content' WHERE id = v_p.create_command_id;
    IF v_p.phase <> 'completed' THEN
        UPDATE identity.agent_provisions SET phase = 'completed', template_client_message_id = v_key, memory_content = NULL, updated_at = now()
        WHERE id = p_provision_id;
    END IF;
    -- A single operation has no group / no finalize: it completes atomically once its sole member completes.
    UPDATE identity.agent_provision_operations SET phase = 'completed', updated_at = now()
    WHERE id = v_p.operation_id AND kind = 'single' AND phase <> 'completed';
    RETURN QUERY SELECT v_msg_id, v_key, v_already;
END;
$$;
REVOKE ALL ON FUNCTION identity.complete_agent_provision_internal(uuid) FROM PUBLIC, anon, authenticated, service_role;
