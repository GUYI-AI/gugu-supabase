-- One membership statement, one roster revision per recipient.
--
-- Before, every inserted seat published chat_members_changed to every member of the
-- chat, and a topic seat also published chat_changed to every member of the source
-- line. A statement that seats k people in a chat of n therefore wrote k*n journal
-- rows and k*n realtime messages (create_topic and join_topic_participants seat
-- everyone in one INSERT; create_gugu_group seated its initial members one INSERT
-- at a time). The journal writes dominate, and every realtime write holds the day's
-- realtime.messages partition until commit.
--
-- Now a membership INSERT, and an UPDATE that changes role or listen mode, publish
-- once per statement (AFTER ... FOR EACH STATEMENT with transition tables):
--   * each recipient (current members plus the changed seats) gets one
--     chat_members_changed {chat_id, user_id, kind: 'roster'};
--   * user_id is the recipient's own seat when that seat changed, otherwise the
--     first changed seat (by id). With one changed seat this is exactly the old
--     row-level revision.
--   * a topic gets one chat_changed on its source line per statement.
-- Clients read a roster by chat: a revision naming a seat they do not know makes
-- them read the chat's members again (projection membership reader, read-receipt
-- denominator, App rosterMoved), and a recipient's own seat tells it about its own
-- access. See docs/batch-roster-revisions.md.
--
-- Deletes and private-state updates ('own') stay row-level and unchanged.
-- Rollback: ops/rollback-batch-roster-revisions.sql.

-- The recipients' revision heads, locked in one sorted pass, now for several seats.
DROP FUNCTION chat.lock_chat_revision_recipients(text, text);
CREATE FUNCTION chat.lock_chat_revision_recipients(p_chat_id text, p_affected_user_ids text[] DEFAULT '{}'::text[])
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
            SELECT unnest(COALESCE(p_affected_user_ids, '{}'::text[]))
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
$function$;
REVOKE ALL ON FUNCTION chat.lock_chat_revision_recipients(text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.lock_chat_revision_recipients(text, text[]) TO service_role;

-- Row level: deletes and a seat's private state. Inserts and roster updates are
-- published by chat.publish_roster_revisions, once per statement.
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
    IF TG_OP = 'UPDATE'
       AND (NEW.role, NEW.listen_mode, NEW.chat_id, NEW.user_id)
           IS DISTINCT FROM (OLD.role, OLD.listen_mode, OLD.chat_id, OLD.user_id) THEN
      RETURN NEW;
    END IF;
    PERFORM chat.lock_chat_revision_recipients(target_chat_id, ARRAY[affected_user_id]);
    IF TG_OP = 'UPDATE' THEN
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
$function$;
REVOKE ALL ON FUNCTION chat.publish_membership_revision() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION chat.publish_membership_revision() TO service_role;

-- Statement level: the seats this statement added, or whose role or listen mode it changed.
CREATE FUNCTION chat.publish_roster_revisions()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'public', 'pg_catalog'
AS $function$
DECLARE
    v_chat_ids TEXT[];
    v_user_ids TEXT[];
    v_chat_id TEXT;
    v_seats TEXT[];
    v_recipient TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT array_agg(n.chat_id), array_agg(n.user_id)
          INTO v_chat_ids, v_user_ids
          FROM changed_seats n;
    ELSE
        -- A row whose key changed has no match and counts as a seat of its new chat.
        SELECT array_agg(n.chat_id), array_agg(n.user_id)
          INTO v_chat_ids, v_user_ids
          FROM changed_seats n
          LEFT JOIN previous_seats o ON o.chat_id = n.chat_id AND o.user_id = n.user_id
         WHERE o.chat_id IS NULL
            OR (n.role, n.listen_mode) IS DISTINCT FROM (o.role, o.listen_mode);
    END IF;

    FOR v_chat_id, v_seats IN
        SELECT seat.chat_id, array_agg(DISTINCT seat.user_id ORDER BY seat.user_id)
          FROM unnest(v_chat_ids, v_user_ids) AS seat(chat_id, user_id)
         GROUP BY seat.chat_id
         ORDER BY seat.chat_id
    LOOP
        PERFORM chat.lock_chat_revision_recipients(v_chat_id, v_seats);
        FOR v_recipient IN
            SELECT DISTINCT recipient.user_id
              FROM (
                SELECT cm.user_id FROM chat.active_members cm WHERE cm.chat_id = v_chat_id
                UNION ALL
                SELECT unnest(v_seats)
              ) recipient
             ORDER BY recipient.user_id
        LOOP
            PERFORM chat.publish_user_revision(
                v_recipient,
                'chat_members_changed',
                jsonb_build_object(
                    'chat_id', v_chat_id,
                    'user_id', CASE WHEN v_recipient = ANY (v_seats) THEN v_recipient ELSE v_seats[1] END,
                    'kind', 'roster'
                ),
                false
            );
        END LOOP;
    END LOOP;
    RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION chat.publish_roster_revisions() FROM PUBLIC, anon, authenticated;

-- A topic's new seats tell its source line once per statement.
CREATE FUNCTION chat.publish_topic_roster_to_source_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'public', 'pg_catalog'
AS $function$
DECLARE
    v_topic TEXT;
    v_source TEXT;
BEGIN
    FOR v_topic, v_source IN
        SELECT c.id, c.source_chat_id
          FROM chat.chats c
         WHERE c.id IN (SELECT n.chat_id FROM changed_seats n)
           AND c.kind = 'topic'
           AND c.source_chat_id IS NOT NULL
         ORDER BY c.id
    LOOP
        PERFORM chat.broadcast_to_chat_member_user_events(
          v_source,
          'chat_changed',
          jsonb_build_object('op', 'update', 'topic_of_source_chat', v_source, 'chat_id', v_topic)
        );
    END LOOP;
    RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION chat.publish_topic_roster_to_source_line() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER chat_members_publish_account_revision
  AFTER DELETE OR UPDATE ON chat.chat_members
  FOR EACH ROW EXECUTE FUNCTION chat.publish_membership_revision();
CREATE TRIGGER chat_members_publish_roster_inserted
  AFTER INSERT ON chat.chat_members
  REFERENCING NEW TABLE AS changed_seats
  FOR EACH STATEMENT EXECUTE FUNCTION chat.publish_roster_revisions();
CREATE TRIGGER chat_members_publish_roster_updated
  AFTER UPDATE ON chat.chat_members
  REFERENCING OLD TABLE AS previous_seats NEW TABLE AS changed_seats
  FOR EACH STATEMENT EXECUTE FUNCTION chat.publish_roster_revisions();
CREATE OR REPLACE TRIGGER chat_members_publish_topic_summary
  AFTER DELETE ON chat.chat_members
  FOR EACH ROW EXECUTE FUNCTION chat.publish_topic_membership_to_source_line();
CREATE TRIGGER chat_members_publish_topic_summary_inserted
  AFTER INSERT ON chat.chat_members
  REFERENCING NEW TABLE AS changed_seats
  FOR EACH STATEMENT EXECUTE FUNCTION chat.publish_topic_roster_to_source_line();

-- Initial members are checked one by one, then seated in one statement.
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
    member_denial  TEXT;
    seat_user_ids  TEXT[] := '{}';
    seat_roles     TEXT[] := '{}';
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

    -- The owner's seat first: group_add_denial judges each addition as this owner.
    INSERT INTO chat.chat_members (chat_id, user_id, role)
    VALUES (p_chat_id, p_owner_user_id, 'owner');

    FOR m IN SELECT * FROM jsonb_array_elements(p_initial_members) LOOP
        member_user_id := m ->> 'user_id';
        member_role    := COALESCE(m ->> 'role', 'member');
        -- A repeated id keeps its first role, as the first insert of it used to.
        IF member_user_id IS NULL OR member_user_id = p_owner_user_id OR member_user_id = ANY (seat_user_ids) THEN
            CONTINUE;
        END IF;
        -- 群只有一个 owner(= 创建者);初始成员只能是 member/admin。
        IF member_role NOT IN ('member', 'admin') THEN
            RAISE EXCEPTION 'initial member % cannot have role %', member_user_id, member_role;
        END IF;
        -- 与其余入口同一道「能否加此人」(调用者就是 owner:拦的是身份存在、别人名下的 agent ——
        -- 别人的 agent 要走 agent 群邀请,由它的主人接受)。人数上限由入席触发器
        -- enforce_group_member_limit 逐行把关(同一条语句里先入席的行它看得见)。
        IF NOT chat.group_related(p_owner_user_id, member_user_id) THEN
            RAISE EXCEPTION 'initial_member_requires_invitation';
        END IF;
        member_denial := chat.group_add_denial(p_chat_id, member_user_id, p_owner_user_id);
        IF member_denial IS NOT NULL THEN
            RAISE EXCEPTION 'cannot add % to group %: %', member_user_id, p_chat_id, member_denial;
        END IF;
        seat_user_ids := seat_user_ids || member_user_id;
        seat_roles    := seat_roles || member_role;
    END LOOP;

    INSERT INTO chat.chat_members (chat_id, user_id, role)
    SELECT p_chat_id, seat.user_id, seat.role
      FROM unnest(seat_user_ids, seat_roles) WITH ORDINALITY AS seat(user_id, role, position)
     ORDER BY seat.position;

    RETURN inserted;
END;
$function$;
REVOKE ALL ON FUNCTION chat.create_gugu_group(text, text, text, jsonb, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.create_gugu_group(text, text, text, jsonb, text, text) TO authenticated;
