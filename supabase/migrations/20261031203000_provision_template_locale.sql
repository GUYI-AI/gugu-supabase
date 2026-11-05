-- The welcome template an agent posts the moment its provision completes (every agent, the personal assistant too),
-- in the UI language the owner set it up in (blueprint.locale). No locale (a client that predates it): Chinese, as
-- before. The parameter list changes, so the old three-argument function is dropped; complete is its only caller.
DROP FUNCTION identity.provision_template_message(text, text, text);
CREATE FUNCTION identity.provision_template_message(p_display_name text, p_agent_type text, p_special_focus text, p_locale text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
    SELECT CASE WHEN p_locale = 'en-US' THEN
        'I''m ' || COALESCE(NULLIF(btrim(p_display_name), ''), 'your agent') || ', ready to help. '
        || CASE WHEN NULLIF(btrim(coalesce(p_special_focus,'')), '') IS NOT NULL
                THEN 'My focus: ' || btrim(p_special_focus) || '. ' ELSE '' END
        || 'Tell me what you need.'
    ELSE
        '我是'
        || CASE WHEN COALESCE(NULLIF(btrim(p_display_name), ''), '你的 Agent') ~ '^[A-Za-z0-9]' THEN ' ' ELSE '' END
        || COALESCE(NULLIF(btrim(p_display_name), ''), '你的 Agent')
        || '，已就位。'
        || CASE WHEN NULLIF(btrim(coalesce(p_special_focus,'')), '') IS NOT NULL
                THEN '我的方向：' || btrim(p_special_focus) || '。' ELSE '' END
        || '有什么可以帮你的，直接说。'
    END;
$$;
REVOKE ALL ON FUNCTION identity.provision_template_message(p_display_name text, p_agent_type text, p_special_focus text, p_locale text) FROM PUBLIC;

-- Completion writes the template in the provision's locale (read from its operation's blueprint).
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

-- The start validator accepts blueprint.locale (strict key list, so it must be named here).
CREATE OR REPLACE FUNCTION identity.start_agent_provision_operation_legacy_7199(p_operation_id uuid, p_device_id text, p_blueprint jsonb, p_memory_content jsonb DEFAULT NULL::jsonb, p_initial_message jsonb DEFAULT NULL::jsonb, p_model text DEFAULT NULL::text, p_effort text DEFAULT NULL::text, p_permission_mode text DEFAULT NULL::text) RETURNS identity.agent_provision_operations
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'identity', 'chat', 'public', 'pg_catalog'
    AS $_$
DECLARE
  v_op identity.agent_provision_operations;
  v_model TEXT := NULLIF(btrim(p_model), '');
  v_effort TEXT := NULLIF(btrim(p_effort), '');
  v_permission_mode TEXT := NULLIF(btrim(p_permission_mode), '');
  v_existing identity.agent_provisions;
  -- 原 _legacy_6264(首条消息)
  v_text TEXT;
  v_message_id TEXT;
  -- 原 _legacy_4567(开单本体)
    v_owner        TEXT := (SELECT auth.uid()::text);
    v_kind         TEXT;
    v_hash         TEXT;
    v_limit        SMALLINT;
    v_members      JSONB;
    v_norm_members JSONB := '[]'::jsonb;
    v_norm_bp      JSONB;
    m              JSONB;
    v_norm_m       JSONB;
    v_mkey         TEXT;
    v_srcs         JSONB;
    v_mc           JSONB;
    v_mc_hash      TEXT;
    v_srcs_arr     TEXT[];
    v_keys         TEXT[] := '{}';
    v_pids         TEXT[] := '{}';
BEGIN
  -- ── 校验:建模型选项(原 _legacy_7199)→ 首条消息(原 _legacy_6264),顺序与原来逐层调用时一致 ──
  IF v_model IS NOT NULL
     AND (length(v_model) > 200 OR v_model !~ '^[A-Za-z0-9._:/@+-]+$') THEN
    RAISE EXCEPTION 'model must be a model id from the create list';
  END IF;
  IF v_effort IS NOT NULL
     AND (length(v_effort) > 200 OR v_effort !~ '^[A-Za-z0-9._:/@+-]+$') THEN
    RAISE EXCEPTION 'effort must be an effort id from the create list';
  END IF;
  IF v_permission_mode IS NOT NULL AND v_permission_mode !~ '^[a-z][a-z-]{0,40}$' THEN
    RAISE EXCEPTION 'permission_mode must be a gugu permission mode';
  END IF;
  IF (v_model IS NOT NULL OR v_effort IS NOT NULL OR v_permission_mode IS NOT NULL)
     AND p_blueprint->>'kind' <> 'single' THEN
    RAISE EXCEPTION 'model / effort / permission_mode are only valid for a single agent';
  END IF;

  IF p_initial_message IS NOT NULL THEN
    IF jsonb_typeof(p_initial_message) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_initial_message) AS k(key)
                  WHERE key NOT IN ('text', 'client_message_id'))
       OR NULLIF(btrim(p_initial_message->>'text'), '') IS NULL
       OR NULLIF(btrim(p_initial_message->>'client_message_id'), '') IS NULL THEN
      RAISE EXCEPTION 'initial message must contain non-empty text and client_message_id';
    END IF;
    v_text := p_initial_message->>'text';
    v_message_id := p_initial_message->>'client_message_id';
    IF p_blueprint->>'kind' <> 'single' THEN
      RAISE EXCEPTION 'initial message is only valid for a single chat-page agent';
    END IF;
  END IF;

  -- ── 开单本体(原 _legacy_4567)。原来的提前 RETURN 换成 EXIT core:后面两步照样要跑 ──
  <<core>>
  BEGIN
      IF v_owner IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
      PERFORM identity.assert_provision_owner_live(v_owner);
      IF NOT EXISTS (SELECT 1 FROM identity.gugu_devices WHERE device_id = p_device_id AND user_id::text = v_owner) THEN
          RAISE EXCEPTION 'device % is not owned by current user', p_device_id;
      END IF;

      -- ── kind-branched STRICT allowlist + shape validation ────────────────────────────────────────
      IF p_blueprint IS NULL OR jsonb_typeof(p_blueprint) <> 'object' THEN RAISE EXCEPTION 'blueprint must be a jsonb object'; END IF;
      IF p_memory_content IS NOT NULL AND jsonb_typeof(p_memory_content) <> 'object' THEN RAISE EXCEPTION 'p_memory_content must be a jsonb object'; END IF;
      v_kind := p_blueprint->>'kind';
      IF v_kind NOT IN ('single','team') THEN RAISE EXCEPTION 'blueprint.kind must be single|team'; END IF;
      -- locale: the UI language the owner set this up in; the welcome template is written in it. Optional (a client
      -- that predates it sends none: the template stays Chinese, as before), but a present one must be a known string.
      IF p_blueprint ? 'locale' AND (jsonb_typeof(p_blueprint->'locale') <> 'string' OR p_blueprint->>'locale' NOT IN ('zh-CN','en-US')) THEN
          RAISE EXCEPTION 'blueprint.locale must be zh-CN|en-US';
      END IF;

      IF v_kind = 'single' THEN
          -- single carries NO group intent at all; exactly one member; concurrency fixed at 1.
          IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_blueprint) AS ok(k)
                     WHERE k NOT IN ('kind','concurrency_limit','members','locale')) THEN
              RAISE EXCEPTION 'single blueprint forbids team-only keys (group_chat_id/team_name/group_prompt)';
          END IF;
          v_limit := COALESCE((p_blueprint->>'concurrency_limit')::smallint, 1);
          IF v_limit <> 1 THEN RAISE EXCEPTION 'single blueprint.concurrency_limit must be 1'; END IF;
          v_members := p_blueprint->'members';
          IF v_members IS NULL OR jsonb_typeof(v_members) <> 'array' OR jsonb_array_length(v_members) <> 1 THEN
              RAISE EXCEPTION 'single blueprint.members must have exactly 1 member';
          END IF;
      ELSE
          IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_blueprint) AS ok(k)
                     WHERE k NOT IN ('kind','group_chat_id','team_name','group_prompt','concurrency_limit','members','locale')) THEN
              RAISE EXCEPTION 'team blueprint has unexpected top-level keys';
          END IF;
          IF COALESCE(p_blueprint->>'group_chat_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
              RAISE EXCEPTION 'team blueprint.group_chat_id must be a uuid';
          END IF;
          IF NULLIF(btrim(p_blueprint->>'team_name'), '') IS NULL OR length(p_blueprint->>'team_name') > 200 THEN
              RAISE EXCEPTION 'team blueprint.team_name is required and must be <= 200 chars';
          END IF;
          -- group_prompt is a REQUIRED team group field: present + a JSON string (empty '' allowed for "no
          -- charter"). Missing key, JSON null, or a non-string type all fail loud (never mapped silently to NULL).
          IF NOT (p_blueprint ? 'group_prompt') OR jsonb_typeof(p_blueprint->'group_prompt') <> 'string' THEN
              RAISE EXCEPTION 'team blueprint.group_prompt is required and must be a string';
          END IF;
          IF length(p_blueprint->>'group_prompt') > 8000 THEN RAISE EXCEPTION 'team blueprint.group_prompt too long'; END IF;
          v_limit := COALESCE((p_blueprint->>'concurrency_limit')::smallint, 2);
          IF v_limit < 1 THEN RAISE EXCEPTION 'team blueprint.concurrency_limit must be >= 1'; END IF;
          v_members := p_blueprint->'members';
          IF v_members IS NULL OR jsonb_typeof(v_members) <> 'array' OR jsonb_array_length(v_members) < 1 THEN
              RAISE EXCEPTION 'team blueprint.members must be a non-empty array';
          END IF;
      END IF;

      FOR m IN SELECT * FROM jsonb_array_elements(v_members) LOOP
          IF v_kind = 'single' THEN
              IF EXISTS (SELECT 1 FROM jsonb_object_keys(m) AS ok(k)
                         WHERE k NOT IN ('provision_id','member_key','display_name','agent_type','project_path','avatar','special_focus','inherit_memory','history_import_required','memory_sources')) THEN
                  RAISE EXCEPTION 'single member has unexpected keys (listen_mode forbidden)';
              END IF;
          ELSE
              IF EXISTS (SELECT 1 FROM jsonb_object_keys(m) AS ok(k)
                         WHERE k NOT IN ('provision_id','member_key','display_name','agent_type','project_path','avatar','special_focus','inherit_memory','history_import_required','memory_sources','listen_mode')) THEN
                  RAISE EXCEPTION 'team member has unexpected keys';
              END IF;
              -- listen_mode is REQUIRED for a team member: present, a non-null STRING, in the enum. Missing,
              -- JSON null, empty string, unknown value, or a non-string type all fail loud (never default silently).
              IF NOT (m ? 'listen_mode')
                 OR jsonb_typeof(m->'listen_mode') <> 'string'
                 OR (m->>'listen_mode') NOT IN ('passive','active') THEN
                  RAISE EXCEPTION 'team member.listen_mode is required and must be passive|active';
              END IF;
          END IF;
          IF COALESCE(m->>'provision_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
              RAISE EXCEPTION 'member.provision_id must be a uuid';
          END IF;
          IF NULLIF(btrim(m->>'member_key'),'') IS NULL THEN RAISE EXCEPTION 'member.member_key is required'; END IF;
          IF NULLIF(btrim(m->>'display_name'),'') IS NULL THEN RAISE EXCEPTION 'member.display_name is required'; END IF;
          IF NULLIF(btrim(m->>'agent_type'),'') IS NULL THEN RAISE EXCEPTION 'member.agent_type is required'; END IF;
          -- inherit_memory + history_import_required: REQUIRED explicit strict booleans (never inferred/defaulted).
          IF NOT (m ? 'inherit_memory') OR jsonb_typeof(m->'inherit_memory') <> 'boolean' THEN
              RAISE EXCEPTION 'member.inherit_memory is required and must be a boolean';
          END IF;
          IF NOT (m ? 'history_import_required') OR jsonb_typeof(m->'history_import_required') <> 'boolean' THEN
              RAISE EXCEPTION 'member.history_import_required is required and must be a boolean';
          END IF;

          v_mkey := m->>'member_key';
          v_srcs := m->'memory_sources';
          v_mc   := CASE WHEN p_memory_content IS NOT NULL THEN p_memory_content->v_mkey ELSE NULL END;
          IF v_srcs IS NOT NULL AND jsonb_typeof(v_srcs) <> 'null' THEN
              -- memory_sources present: non-empty array of unique known sources, with content for EXACTLY them.
              IF jsonb_typeof(v_srcs) <> 'array' OR jsonb_array_length(v_srcs) = 0 THEN
                  RAISE EXCEPTION 'member.memory_sources must be a non-empty array when present';
              END IF;
              IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_srcs) s
                         WHERE jsonb_typeof(s) <> 'string' OR (s #>> '{}') NOT IN ('claude-code','codex')) THEN
                  RAISE EXCEPTION 'member.memory_sources must be strings in claude-code|codex';
              END IF;
              IF (SELECT count(DISTINCT s) FROM jsonb_array_elements_text(v_srcs) s) <> jsonb_array_length(v_srcs) THEN
                  RAISE EXCEPTION 'member.memory_sources must be unique';
              END IF;
              IF v_mc IS NULL OR jsonb_typeof(v_mc) <> 'object' THEN
                  RAISE EXCEPTION 'p_memory_content missing content for member % with selected memory_sources', v_mkey;
              END IF;
              IF (SELECT count(*) FROM jsonb_object_keys(v_mc)) <> jsonb_array_length(v_srcs)
                 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_srcs) s WHERE NOT (v_mc ? s))
                 OR EXISTS (SELECT 1 FROM jsonb_each(v_mc) e WHERE jsonb_typeof(e.value) <> 'string') THEN
                  RAISE EXCEPTION 'p_memory_content for member % must map EXACTLY its memory_sources to string content', v_mkey;
              END IF;
              v_srcs_arr := ARRAY(SELECT jsonb_array_elements_text(v_srcs));
              v_mc_hash  := md5(v_mc::text);
          ELSE
              -- no sources selected → there must be NO content supplied for this member.
              IF v_mc IS NOT NULL AND jsonb_typeof(v_mc) <> 'null' THEN
                  RAISE EXCEPTION 'p_memory_content has content for member % which selected no memory_sources', v_mkey;
              END IF;
              v_srcs_arr := NULL;
              v_mc       := NULL;
              v_mc_hash  := NULL;
          END IF;

          -- normalized member = INPUT member + server-derived memory_content_hash (only when sources present).
          v_norm_m := m || (CASE WHEN v_mc_hash IS NOT NULL THEN jsonb_build_object('memory_content_hash', v_mc_hash) ELSE '{}'::jsonb END);
          v_norm_members := v_norm_members || jsonb_build_array(v_norm_m);

          v_keys := v_keys || v_mkey;
          v_pids := v_pids || (m->>'provision_id');
      END LOOP;
      IF (SELECT count(DISTINCT x) FROM unnest(v_keys) x) <> cardinality(v_keys) THEN RAISE EXCEPTION 'member_key values must be unique'; END IF;
      IF (SELECT count(DISTINCT x) FROM unnest(v_pids) x) <> cardinality(v_pids) THEN RAISE EXCEPTION 'provision_id values must be unique'; END IF;
      -- reject any p_memory_content key not matching a member (content without sources / unknown member).
      IF p_memory_content IS NOT NULL AND EXISTS (
          SELECT 1 FROM jsonb_object_keys(p_memory_content) AS k(key) WHERE key <> ALL(v_keys)
      ) THEN
          RAISE EXCEPTION 'p_memory_content has keys not matching any member';
      END IF;

      -- NORMALIZED stored blueprint = INPUT with members replaced by the normalized members. jsonb text is
      -- canonical (sorted keys) → operation hash is stable across equal-value inputs regardless of key order.
      v_norm_bp := jsonb_set(p_blueprint, '{members}', v_norm_members);
      v_hash := md5(v_norm_bp::text);

      -- Idempotent replay: re-normalized new INPUT must match the stored NORMALIZED blueprint + hash + kind.
      SELECT * INTO v_op FROM identity.agent_provision_operations WHERE id = p_operation_id FOR UPDATE;
      IF FOUND THEN
          IF v_op.owner_user_id <> v_owner THEN RAISE EXCEPTION 'operation % not owned by caller', p_operation_id; END IF;
          -- device is part of the operation's durable intent: same id + same blueprint but a DIFFERENT device is a
          -- divergent intent, not an idempotent success — never silently return the original (old-device) operation.
          IF v_op.blueprint <> v_norm_bp OR v_op.payload_hash <> v_hash OR v_op.kind <> v_kind
             OR v_op.device_id IS DISTINCT FROM p_device_id THEN
              RAISE EXCEPTION 'operation % already exists with a different blueprint/device (same-id divergent intent)', p_operation_id;
          END IF;
          EXIT core;
      END IF;

      INSERT INTO identity.agent_provision_operations (id, owner_user_id, device_id, kind, payload_hash, blueprint, concurrency_limit)
      VALUES (p_operation_id, v_owner, p_device_id, v_kind, v_hash, v_norm_bp, v_limit)
      RETURNING * INTO v_op;

      -- Member rows from the NORMALIZED members. Raw memory bytes are stored in memory_content (cleared later);
      -- the per-member payload_hash is the shared provision_member_hash (prepare re-derives the same from the row).
      FOR v_norm_m IN SELECT * FROM jsonb_array_elements(v_norm_members) LOOP
          v_mkey := v_norm_m->>'member_key';
          v_srcs := v_norm_m->'memory_sources';
          v_srcs_arr := CASE WHEN v_srcs IS NOT NULL AND jsonb_typeof(v_srcs) = 'array'
                             THEN ARRAY(SELECT jsonb_array_elements_text(v_srcs)) ELSE NULL END;
          v_mc := CASE WHEN p_memory_content IS NOT NULL THEN p_memory_content->v_mkey ELSE NULL END;
          INSERT INTO identity.agent_provisions (
              id, owner_user_id, operation_id, member_key, device_id,
              display_name, agent_type, project_path, avatar, special_focus,
              inherit_memory, memory_sources, memory_content, memory_content_hash, history_import_required,
              payload_hash, phase
          ) VALUES (
              (v_norm_m->>'provision_id')::uuid, v_owner, p_operation_id, v_mkey, p_device_id,
              v_norm_m->>'display_name', v_norm_m->>'agent_type', NULLIF(v_norm_m->>'project_path',''), NULLIF(v_norm_m->>'avatar',''),
              NULLIF(v_norm_m->>'special_focus',''),
              -- F2: persist the server-derived memory hash immutably; the shared per-member hash consumes THAT
              -- (not raw memory_content), so prepare re-derives the same payload_hash after the raw bytes are scrubbed.
              (v_norm_m->>'inherit_memory')::boolean, v_srcs_arr, v_mc, v_norm_m->>'memory_content_hash', (v_norm_m->>'history_import_required')::boolean,
              identity.provision_member_hash(
                  p_operation_id, v_mkey, v_norm_m->>'display_name', v_norm_m->>'agent_type',
                  NULLIF(v_norm_m->>'project_path',''), NULLIF(v_norm_m->>'avatar',''), NULLIF(v_norm_m->>'special_focus',''),
                  p_device_id, (v_norm_m->>'inherit_memory')::boolean, (v_norm_m->>'history_import_required')::boolean,
                  v_srcs_arr, v_norm_m->>'memory_content_hash'),
              'queued'
          );
      END LOOP;
      EXIT core;
  END core;

  -- ── 记下首条消息(原 _legacy_6264 的后半)──
  IF v_text IS NOT NULL THEN
    DECLARE
      v_existing identity.agent_provisions;
    BEGIN
      SELECT * INTO v_existing
        FROM identity.agent_provisions
       WHERE operation_id = p_operation_id
         AND member_key = (p_blueprint->'members'->0->>'member_key')
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'initial message member % not found', (p_blueprint->'members'->0->>'member_key');
      END IF;
      IF v_existing.initial_message_text IS NOT NULL OR v_existing.initial_message_id IS NOT NULL THEN
        IF v_existing.initial_message_text IS DISTINCT FROM v_text
           OR v_existing.initial_message_id IS DISTINCT FROM v_message_id THEN
          RAISE EXCEPTION 'initial message replay has divergent text or client_message_id';
        END IF;
      ELSIF v_existing.phase NOT IN ('queued','preparing') THEN
        RAISE EXCEPTION 'initial message cannot be attached after member preparation';
      ELSE
        UPDATE identity.agent_provisions
           SET initial_message_text = v_text,
               initial_message_id = v_message_id,
               updated_at = now()
         WHERE id = v_existing.id;
      END IF;
    END;
  END IF;

  -- ── 记下模型选项(原 _legacy_7199 的后半)──
  IF v_model IS NOT NULL OR v_effort IS NOT NULL OR v_permission_mode IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM identity.agent_provisions
     WHERE operation_id = p_operation_id
       AND member_key = (p_blueprint->'members'->0->>'member_key')
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'create-choice member % not found', (p_blueprint->'members'->0->>'member_key');
    END IF;
    -- 重放:已记下的值必须一致;逐项判,一项分歧就拒。
    IF v_model IS NOT NULL AND v_existing.model IS NOT NULL
       AND v_existing.model IS DISTINCT FROM v_model THEN
      RAISE EXCEPTION 'model replay diverges from the recorded model';
    END IF;
    IF v_effort IS NOT NULL AND v_existing.effort IS NOT NULL
       AND v_existing.effort IS DISTINCT FROM v_effort THEN
      RAISE EXCEPTION 'effort replay diverges from the recorded effort';
    END IF;
    IF v_permission_mode IS NOT NULL AND v_existing.permission_mode IS NOT NULL
       AND v_existing.permission_mode IS DISTINCT FROM v_permission_mode THEN
      RAISE EXCEPTION 'permission_mode replay diverges from the recorded permission_mode';
    END IF;
    IF (v_model IS NOT NULL AND v_existing.model IS NULL)
       OR (v_effort IS NOT NULL AND v_existing.effort IS NULL)
       OR (v_permission_mode IS NOT NULL AND v_existing.permission_mode IS NULL) THEN
      IF v_existing.phase NOT IN ('queued','preparing') THEN
        RAISE EXCEPTION 'create choices cannot be attached after member preparation';
      END IF;
      UPDATE identity.agent_provisions
         SET model = COALESCE(model, v_model),
             effort = COALESCE(effort, v_effort),
             permission_mode = COALESCE(permission_mode, v_permission_mode),
             updated_at = now()
       WHERE id = v_existing.id;
    END IF;
  END IF;
  RETURN v_op;
END;
$_$;
