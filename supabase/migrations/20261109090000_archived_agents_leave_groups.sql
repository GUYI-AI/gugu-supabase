-- A session-archived agent has left its groups and topics: it holds no seat, is not
-- listed and is not counted. Its physical membership row, read state and history stay,
-- so restoring the session brings it back unchanged. Direct and AI chats are unchanged.
-- Message sender display reads identity.users and is unaffected.
SET LOCAL lock_timeout = '5s';
-- The trigger below needs this lock anyway. Take it first so session archival writes
-- cannot slip between the backfill and the trigger, and so this release locks
-- identity.users before identity.member_liveness, like every identity writer does.
LOCK TABLE identity.users IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE identity.member_liveness ADD COLUMN in_groups boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION identity.sync_member_liveness() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO identity.member_liveness(user_id, is_live, in_groups)
    VALUES (NEW.id, NEW.removed_at IS NULL, NEW.session_archived_at IS NULL)
    ON CONFLICT (user_id) DO UPDATE SET is_live = EXCLUDED.is_live, in_groups = EXCLUDED.in_groups;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.sync_member_liveness() FROM PUBLIC, anon, authenticated, service_role, gugu_files;
-- Sorts before users_publish_session_archival, so later triggers already read the new state.
CREATE TRIGGER users_00_member_liveness_session AFTER UPDATE OF session_archived_at ON identity.users
  FOR EACH ROW WHEN ((OLD.session_archived_at IS NULL) IS DISTINCT FROM (NEW.session_archived_at IS NULL))
  EXECUTE FUNCTION identity.sync_member_liveness();

-- Row locks only on currently archived identities.
UPDATE identity.member_liveness live SET in_groups = false
  FROM identity.users u WHERE u.id = live.user_id AND u.session_archived_at IS NOT NULL;

-- chat.chats is not readable by every role that reads active_members (gugu_files), and
-- the view is security_invoker, so the chat kind comes from this narrow definer helper.
CREATE FUNCTION chat.is_direct_chat(p_chat_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = p_chat_id AND c.kind IN ('dm', 'ai'));
$$;
REVOKE ALL ON FUNCTION chat.is_direct_chat(text) FROM PUBLIC, anon, authenticated, service_role, gugu_files;
GRANT EXECUTE ON FUNCTION chat.is_direct_chat(text) TO authenticated, service_role, gugu_files;

-- m.* keeps the installed column order. The helper runs only for archived agents' rows.
CREATE OR REPLACE VIEW chat.active_members WITH (security_invoker = true) AS
  SELECT m.* FROM chat.chat_members m
    JOIN identity.member_liveness live ON live.user_id = m.user_id
  WHERE live.is_live AND (live.in_groups OR chat.is_direct_chat(m.chat_id));

-- Retained seats of live identities, including session-archived agents. Only definer
-- functions that must still find an archived agent's own seats read it; no API role can.
CREATE VIEW chat.live_identity_members WITH (security_invoker = true) AS
  SELECT m.* FROM chat.chat_members m
    JOIN identity.member_liveness live ON live.user_id = m.user_id
  WHERE live.is_live;
REVOKE ALL ON chat.live_identity_members FROM PUBLIC, anon, authenticated, service_role, gugu_files;
CREATE FUNCTION chat.is_retained_member(p_chat_id text, p_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM chat.live_identity_members m WHERE m.chat_id = p_chat_id AND m.user_id = p_user_id);
$$;
REVOKE ALL ON FUNCTION chat.is_retained_member(text, text) FROM PUBLIC, anon, authenticated, service_role, gugu_files;

-- These readers look up the archived agent's own seats, which active_members no longer
-- returns while it is archived:
-- * archival/restore locks and notifies the same recipients in both directions;
-- * group peers still receive the archived display revision;
-- * a mention, reply or whisper to an archived agent is still accepted for the other
--   members and records the existing terminal refusal for its sender, instead of
--   rejecting the whole message (stale member caches, replies to its old messages).
-- Sending, reading and management permissions still require live membership.
DO $seats$
DECLARE
    target record;
    previous text;
    definition text;
    acl aclitem[];
    permission record;
BEGIN
    FOR target IN SELECT * FROM (VALUES
      ('identity.set_agent_session_archival(text,text,uuid,bigint,timestamp with time zone,jsonb)'::regprocedure,
       'FROM chat.active_members mine', 'FROM chat.live_identity_members mine', 2),
      ('identity.publish_identity_display_revision()'::regprocedure,
       'FROM chat.active_members mine', 'FROM chat.live_identity_members mine', 1),
      ('chat.record_message_agent_wakes()'::regprocedure,
       'JOIN chat.active_members cm ON cm.chat_id = c.id', 'JOIN chat.live_identity_members cm ON cm.chat_id = c.id', 1),
      ('chat.is_addressable_in(text,text)'::regprocedure,
       'chat.is_chat_member(', 'chat.is_retained_member(', 2),
      ('chat.enforce_whisper_rule()'::regprocedure,
       'chat.is_chat_member(NEW.chat_id, NEW.to_user_ids[1])', 'chat.is_retained_member(NEW.chat_id, NEW.to_user_ids[1])', 1)
    ) AS definitions(signature, prior_sql, replacement_sql, occurrences)
    LOOP
        SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl, acldefault('f', p.proowner))
          INTO previous, acl FROM pg_proc p WHERE p.oid = target.signature;
        IF array_length(string_to_array(previous, target.prior_sql), 1) <> target.occurrences + 1 THEN
            RAISE EXCEPTION 'Unexpected archived seat predecessor: %', target.signature;
        END IF;
        definition := replace(previous, target.prior_sql, target.replacement_sql);
        EXECUTE definition;
        -- CREATE OR REPLACE activates the installation's API execution guard.
        FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
          FROM aclexplode(acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', target.signature,
              CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
              CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
        END LOOP;
    END LOOP;
END $seats$;

-- Leaving and rejoining on archive/restore use the existing roster revision with its
-- existing meaning: a tombstone when the seat leaves, a plain revision when it returns.
-- set_agent_session_archival already holds these recipients' revision heads.
CREATE FUNCTION chat.publish_session_archival_roster() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    seat record;
BEGIN
    FOR seat IN
        SELECT DISTINCT mine.chat_id, recipient.user_id
          FROM chat.live_identity_members mine
          CROSS JOIN LATERAL (
            SELECT peer.user_id FROM chat.active_members peer WHERE peer.chat_id = mine.chat_id
            UNION SELECT NEW.id
          ) recipient
         WHERE mine.user_id = NEW.id AND NOT chat.is_direct_chat(mine.chat_id)
         ORDER BY recipient.user_id, mine.chat_id
    LOOP
        PERFORM chat.publish_user_revision(seat.user_id, 'chat_members_changed',
          jsonb_build_object('chat_id', seat.chat_id, 'user_id', NEW.id, 'kind', 'roster'),
          NEW.session_archived_at IS NOT NULL);
    END LOOP;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.publish_session_archival_roster() FROM PUBLIC, anon, authenticated, service_role, gugu_files;
CREATE TRIGGER users_publish_session_archival_roster AFTER UPDATE OF session_archived_at ON identity.users
  FOR EACH ROW WHEN (NEW.type = 'agent'
    AND (OLD.session_archived_at IS NULL) IS DISTINCT FROM (NEW.session_archived_at IS NULL))
  EXECUTE FUNCTION chat.publish_session_archival_roster();

NOTIFY pgrst, 'reload schema';
