-- Roll back 20261110062000_batch_roster_revisions: every inserted seat, and every seat whose
-- role or listen mode changes, publishes chat_members_changed to each member again (row level),
-- topic seats tell the source line once per seat, and create_gugu_group seats its initial
-- members one INSERT at a time. Function bodies are the parent release's, as installed.
-- Seats, revisions already written and the installer ledger are not touched.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE chat.chat_members IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER chat_members_publish_roster_inserted ON chat.chat_members;
DROP TRIGGER chat_members_publish_roster_updated ON chat.chat_members;
DROP TRIGGER chat_members_publish_topic_summary_inserted ON chat.chat_members;
DROP FUNCTION chat.publish_roster_revisions();
DROP FUNCTION chat.publish_topic_roster_to_source_line();

DROP FUNCTION chat.lock_chat_revision_recipients(text, text[]);
CREATE OR REPLACE FUNCTION chat.lock_chat_revision_recipients(p_chat_id text, p_affected_user_id text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'pg_catalog'
AS $function$
DECLARE
    target_user_id TEXT;
BEGIN
    FOR target_user_id IN
        SELECT DISTINCT recipient.user_id
        FROM (
            SELECT cm.user_id
            FROM chat.active_members cm
            WHERE cm.chat_id = p_chat_id
               OR cm.chat_id = (
                   SELECT c.source_chat_id FROM chat.chats c
                   WHERE c.id = p_chat_id AND c.kind = 'topic'
               )
            UNION ALL
            SELECT p_affected_user_id
        ) recipient
        WHERE recipient.user_id IS NOT NULL
        ORDER BY recipient.user_id
    LOOP
        -- Initializing a missing head neither advances its revision nor emits an
        -- event. Keep creation and locking in the same global order. NO KEY
        -- UPDATE matches publish_user_revision and permits revision-row FKs.
        INSERT INTO chat.account_revision_heads (user_id)
        VALUES (target_user_id)
        ON CONFLICT (user_id) DO NOTHING;
        PERFORM 1 FROM chat.account_revision_heads h
        WHERE h.user_id = target_user_id
        FOR NO KEY UPDATE;
    END LOOP;
END;
$function$

;
REVOKE ALL ON FUNCTION chat.lock_chat_revision_recipients(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.lock_chat_revision_recipients(text, text) TO service_role;

CREATE OR REPLACE FUNCTION chat.publish_membership_revision()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'public', 'pg_catalog'
AS $function$
DECLARE
    target_chat_id TEXT := COALESCE(NEW.chat_id, OLD.chat_id);
    affected_user_id TEXT := COALESCE(NEW.user_id, OLD.user_id);
    target_user_id TEXT;
BEGIN
    PERFORM chat.lock_chat_revision_recipients(target_chat_id, affected_user_id);
    IF TG_OP = 'UPDATE'
       AND (NEW.role, NEW.listen_mode, NEW.chat_id, NEW.user_id)
           IS NOT DISTINCT FROM (OLD.role, OLD.listen_mode, OLD.chat_id, OLD.user_id) THEN
      IF NEW.last_read_seq IS DISTINCT FROM OLD.last_read_seq
         AND (to_jsonb(NEW) - ARRAY['last_read_seq', 'is_marked_unread', 'version', 'updated_at'])
             IS NOT DISTINCT FROM
             (to_jsonb(OLD) - ARRAY['last_read_seq', 'is_marked_unread', 'version', 'updated_at']) THEN
        RETURN NEW;
      END IF;
      PERFORM chat.publish_user_revision(
        affected_user_id,
        'chat_members_changed',
        jsonb_build_object('chat_id', target_chat_id, 'user_id', affected_user_id, 'kind', 'own'),
        false
      );
      RETURN NEW;
    END IF;

    FOR target_user_id IN
      SELECT DISTINCT recipient.user_id
        FROM (
          SELECT cm.user_id FROM chat.active_members cm WHERE cm.chat_id = target_chat_id
          UNION ALL
          SELECT affected_user_id
        ) recipient
       WHERE recipient.user_id IS NOT NULL
       ORDER BY recipient.user_id
    LOOP
      PERFORM chat.publish_user_revision(
        target_user_id,
        'chat_members_changed',
        jsonb_build_object('chat_id', target_chat_id, 'user_id', affected_user_id, 'kind', 'roster'),
        TG_OP = 'DELETE'
      );
    END LOOP;
    RETURN COALESCE(NEW, OLD);
END;
$function$

;
REVOKE ALL ON FUNCTION chat.publish_membership_revision() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.publish_membership_revision() TO service_role;

CREATE OR REPLACE FUNCTION chat.create_gugu_group(p_chat_id text, p_name text, p_owner_user_id text, p_initial_members jsonb, p_default_agent_type text DEFAULT NULL::text, p_group_prompt text DEFAULT NULL::text)
 RETURNS chat.chats
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'identity', 'public', 'pg_catalog'
AS $function$
DECLARE
    caller_user_id TEXT;
    inserted       chat.chats;
    m              JSONB;
    member_user_id TEXT;
    member_role    TEXT;
    inserted_member_count INT := 0;
    inserted_member_rows  INT := 0;
    member_denial  TEXT;
BEGIN
    caller_user_id := (SELECT auth.uid()::text);
    IF caller_user_id IS NULL OR caller_user_id <> p_owner_user_id THEN
        RAISE EXCEPTION 'caller % cannot create group on behalf of %',
                        caller_user_id, p_owner_user_id;
    END IF;

    IF p_chat_id IS NULL OR p_chat_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', HINT = 'chat_id_not_uuid',
            MESSAGE = 'chat id must be a UUID in 8-4-4-4-12 hexadecimal form';
    END IF;

    IF p_initial_members IS NULL OR jsonb_typeof(p_initial_members) <> 'array' THEN
        RAISE EXCEPTION 'p_initial_members must be a jsonb array';
    END IF;

    SET CONSTRAINTS ALL DEFERRED;

    INSERT INTO chat.chats (
        id, kind, name, status, creator_user_id,
        group_prompt, default_agent_type
    ) VALUES (
        p_chat_id, 'group', p_name, 'active', p_owner_user_id,
        p_group_prompt, p_default_agent_type
    ) RETURNING * INTO inserted;

    INSERT INTO chat.chat_members (chat_id, user_id, role)
    VALUES (p_chat_id, p_owner_user_id, 'owner');

    FOR m IN SELECT * FROM jsonb_array_elements(p_initial_members) LOOP
        member_user_id := m ->> 'user_id';
        member_role    := COALESCE(m ->> 'role', 'member');
        IF member_user_id IS NULL OR member_user_id = p_owner_user_id THEN
            CONTINUE;
        END IF;
        -- 群只有一个 owner(= 创建者);初始成员只能是 member/admin。
        IF member_role NOT IN ('member', 'admin') THEN
            RAISE EXCEPTION 'initial member % cannot have role %', member_user_id, member_role;
        END IF;
        -- 与其余入口同一道「能否加此人」(调用者就是 owner:拦的是上限、身份存在、别人名下的 agent ——
        -- 别人的 agent 要走 agent 群邀请,由它的主人接受)。
        IF NOT chat.group_related(p_owner_user_id, member_user_id) THEN
            RAISE EXCEPTION 'initial_member_requires_invitation';
        END IF;
        member_denial := chat.group_add_denial(p_chat_id, member_user_id, p_owner_user_id);
        IF member_denial IS NOT NULL THEN
            RAISE EXCEPTION 'cannot add % to group %: %', member_user_id, p_chat_id, member_denial;
        END IF;
        INSERT INTO chat.chat_members (chat_id, user_id, role)
        VALUES (p_chat_id, member_user_id, member_role)
        ON CONFLICT (chat_id, user_id) DO NOTHING;
        GET DIAGNOSTICS inserted_member_rows = ROW_COUNT;
        inserted_member_count := inserted_member_count + inserted_member_rows;
    END LOOP;


    RETURN inserted;
END;
$function$

;
REVOKE ALL ON FUNCTION chat.create_gugu_group(text, text, text, jsonb, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.create_gugu_group(text, text, text, jsonb, text, text) TO authenticated;

CREATE OR REPLACE TRIGGER chat_members_publish_account_revision
  AFTER INSERT OR DELETE OR UPDATE ON chat.chat_members
  FOR EACH ROW EXECUTE FUNCTION chat.publish_membership_revision();
CREATE OR REPLACE TRIGGER chat_members_publish_topic_summary
  AFTER INSERT OR DELETE ON chat.chat_members
  FOR EACH ROW EXECUTE FUNCTION chat.publish_topic_membership_to_source_line();
COMMIT;
