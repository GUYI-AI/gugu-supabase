-- A session-archived agent leaves every list its owner and its peers read, not only its groups
-- (20261109090000). While archived it is not shown, and it is not read either: nothing fetches
-- its row, its conversations, their previews, unread counts or its presence. The identity, every
-- seat, every message and the read state stay; restoring the session (which clears
-- session_archived_at) brings it all back unchanged.
--
--   * identity.active_users, the live directory, omits session-archived agents.
--   * Its direct and AI chats leave chat.active_members for every member, as its group seats already
--     did. Every list reader (account snapshot, conversation memberships, previews, unread, the
--     client's key set) reads that view, so none of them needs its own filter.
--   * The account snapshot's owned-identity branch carries only identities that are neither removed
--     nor archived, so it no longer reads a presence row for each of them.
--
-- Readers that must find an archived identity by id (restore, session binding, historical sender
-- display) read identity.users. identity.user_is_live is unchanged (see its comment below).
SET LOCAL lock_timeout = '5s';
-- Same lock as 20261109090000: archival writes cannot slip between the backfill and the trigger.
LOCK TABLE identity.users IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE VIEW identity.active_users WITH (security_invoker = true) AS
  SELECT id, type, display_name, avatar, bio, mycel_id, owner_user_id,
    agent_config_id, created_at, updated_at, device_id, local_path, prompt_path,
    desired_status, agent_public, gugu_number, category, inherit_memory,
    special_focus, onboarded_at, is_official, session_archived_at,
    session_lifecycle_revision, session_lifecycle_operation_id, removed_at, name_serial
  FROM identity.users WHERE removed_at IS NULL AND session_archived_at IS NULL;

-- Two layers, kept apart on purpose: do not merge them into one predicate.
COMMENT ON FUNCTION identity.user_is_live(text) IS
  'Permission layer: the identity is not removed. Session-archived agents stay live here so they can be restored and still refuse messages addressed to them. Lists use identity.active_users and chat.active_members.';
COMMENT ON VIEW identity.active_users IS
  'List layer: neither removed nor session-archived. Permission checks use identity.user_is_live; lookups that must find an archived identity by id read identity.users.';

-- The other seats of a direct or AI chat whose agent is session-archived. A stored fact keyed like
-- the seat, so the hot view below pays one primary-key anti-join instead of a function call per row.
-- The archived agent's own seats are already hidden by member_liveness.in_groups.
CREATE TABLE chat_private.closed_direct_seats (
  chat_id text NOT NULL,
  user_id text NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
REVOKE ALL ON chat_private.closed_direct_seats FROM PUBLIC, anon, authenticated, service_role, gugu_files;
-- The invoker view and the member-row policy read it for every reader role; chat_private is not
-- exposed by the Data API.
GRANT SELECT ON chat_private.closed_direct_seats TO authenticated, service_role, gugu_files;

CREATE FUNCTION chat_private.recompute_closed_direct_seats(p_chat_ids text[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM chat_private.closed_direct_seats WHERE chat_id = ANY(p_chat_ids);
  INSERT INTO chat_private.closed_direct_seats(chat_id, user_id)
    SELECT m.chat_id, m.user_id FROM chat.chat_members m JOIN chat.chats c ON c.id = m.chat_id
     WHERE m.chat_id = ANY(p_chat_ids) AND c.kind IN ('dm', 'ai')
       AND EXISTS (SELECT 1 FROM chat.chat_members other JOIN identity.users u ON u.id = other.user_id
                    WHERE other.chat_id = m.chat_id AND other.user_id <> m.user_id AND u.type = 'agent'
                      AND u.session_archived_at IS NOT NULL AND u.removed_at IS NULL);
$$;
REVOKE ALL ON FUNCTION chat_private.recompute_closed_direct_seats(text[]) FROM PUBLIC, anon, authenticated, service_role, gugu_files;

CREATE FUNCTION chat_private.sync_closed_direct_seats() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM chat_private.recompute_closed_direct_seats(ARRAY(
    SELECT m.chat_id FROM chat.chat_members m JOIN chat.chats c ON c.id = m.chat_id
     WHERE m.user_id = NEW.id AND c.kind IN ('dm', 'ai')));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat_private.sync_closed_direct_seats() FROM PUBLIC, anon, authenticated, service_role, gugu_files;
-- Sorts after users_00_member_liveness_* and before users_publish_*, so the publishers below already
-- read the new seats. Removing an archived agent reopens the seats: its DMs then follow the removal
-- rule (closed as a personal delete by identity.archive_user), exactly as for an unarchived agent.
CREATE TRIGGER users_01_closed_direct_seats AFTER UPDATE OF session_archived_at, removed_at ON identity.users
  FOR EACH ROW WHEN (NEW.type = 'agent' AND (((OLD.session_archived_at IS NULL) IS DISTINCT FROM (NEW.session_archived_at IS NULL))
    OR ((OLD.removed_at IS NULL) IS DISTINCT FROM (NEW.removed_at IS NULL))))
  EXECUTE FUNCTION chat_private.sync_closed_direct_seats();

-- Agents already archived when this is installed.
SELECT chat_private.recompute_closed_direct_seats(ARRAY(
  SELECT DISTINCT m.chat_id FROM chat.chat_members m JOIN chat.chats c ON c.id = m.chat_id
    JOIN identity.users u ON u.id = m.user_id
   WHERE c.kind IN ('dm', 'ai') AND u.type = 'agent' AND u.session_archived_at IS NOT NULL AND u.removed_at IS NULL));

-- The view's installed column list, spelled out so no later chat_members column is exposed.
-- Previously: live.is_live AND (live.in_groups OR chat_private.is_direct_chat(m.chat_id)).
CREATE OR REPLACE VIEW chat.active_members WITH (security_invoker = true) AS
  SELECT m.chat_id, m.user_id, m.role, m.last_read_seq, m.version, m.joined_at, m.updated_at,
    m.is_pinned, m.contract, m.triggers, m.notification_level, m.listen_mode, m.hide_history_before,
    m.is_marked_unread, m.inbox_published_at, m.join_context_shown_at, m.joined_ingest_seq,
    m.conversation_deleted_at
  FROM chat.chat_members m
    JOIN identity.member_liveness live ON live.user_id = m.user_id
  WHERE live.is_live AND live.in_groups
    AND NOT EXISTS (SELECT 1 FROM chat_private.closed_direct_seats closed
                     WHERE closed.chat_id = m.chat_id AND closed.user_id = m.user_id);

-- Same predicate for direct reads of chat.chat_members (policy members_select_peer).
CREATE OR REPLACE FUNCTION chat_private.member_seat_visible(p_chat_id text, p_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM identity.member_liveness live WHERE live.user_id = p_user_id
      AND live.is_live AND live.in_groups)
    AND NOT EXISTS (SELECT 1 FROM chat_private.closed_direct_seats closed
                     WHERE closed.chat_id = p_chat_id AND closed.user_id = p_user_id);
$$;
-- A replaced function does not keep its grants through the installer; state them again.
GRANT EXECUTE ON FUNCTION chat_private.member_seat_visible(text, text) TO authenticated, service_role, gugu_files;

-- Archive and restore tell the people on the other side of its direct chats that their own row
-- left or returned, so a cached conversation list drops it or reads it back. Group seats keep the
-- roster revision they already had.
CREATE OR REPLACE FUNCTION chat.publish_session_archival_roster() RETURNS trigger
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
         WHERE mine.user_id = NEW.id AND NOT chat_private.is_direct_chat(mine.chat_id)
         ORDER BY recipient.user_id, mine.chat_id
    LOOP
        PERFORM chat.publish_user_revision(seat.user_id, 'chat_members_changed',
          jsonb_build_object('chat_id', seat.chat_id, 'user_id', NEW.id, 'kind', 'roster'),
          NEW.session_archived_at IS NOT NULL);
    END LOOP;
    FOR seat IN
        SELECT DISTINCT other.chat_id, other.user_id
          FROM chat.live_identity_members mine
          JOIN chat.chats c ON c.id = mine.chat_id AND c.kind IN ('dm', 'ai')
          JOIN chat.live_identity_members other ON other.chat_id = mine.chat_id AND other.user_id <> mine.user_id
         WHERE mine.user_id = NEW.id
         ORDER BY other.user_id, other.chat_id
    LOOP
        PERFORM chat.publish_user_revision(seat.user_id, 'chat_members_changed',
          jsonb_build_object('chat_id', seat.chat_id, 'user_id', seat.user_id, 'kind', 'own'),
          NOT EXISTS (SELECT 1 FROM chat.active_members a WHERE a.chat_id = seat.chat_id AND a.user_id = seat.user_id));
    END LOOP;
    RETURN NEW;
END;
$$;

-- Cached lists of the people whose direct chats were closed by an agent archived before this
-- release drop those rows once, newest state first in the revision-head lock order.
DO $closed$
DECLARE seat record;
BEGIN
    FOR seat IN SELECT closed.chat_id, closed.user_id FROM chat_private.closed_direct_seats closed
                 ORDER BY closed.user_id, closed.chat_id
    LOOP
        PERFORM chat.publish_user_revision(seat.user_id, 'chat_members_changed',
          jsonb_build_object('chat_id', seat.chat_id, 'user_id', seat.user_id, 'kind', 'own'), true);
    END LOOP;
END $closed$;

-- Conversation memberships (the snapshot's and the client's member rows) count the same seats as
-- chat.active_members; they read physical rows only to also return an owned agent's removed seat
-- as history. Previously the live seats were identity.user_is_live(m.user_id), which kept archived
-- agents' retained group seats.
DO $memberships$
DECLARE
    previous text;
    prior_sql CONSTANT text := 'WHERE c.id = ANY(p_chat_ids) AND (identity.user_is_live(m.user_id)';
BEGIN
    SELECT pg_get_functiondef('chat.conversation_memberships_before_clear(text[])'::regprocedure) INTO previous;
    IF array_length(string_to_array(previous, prior_sql), 1) <> 2 THEN
        RAISE EXCEPTION 'Unexpected chat.conversation_memberships_before_clear seat predicate';
    END IF;
    EXECUTE replace(previous, prior_sql,
      'WHERE c.id = ANY(p_chat_ids) AND (chat_private.member_seat_visible(m.chat_id, m.user_id)');
END $memberships$;
REVOKE ALL ON FUNCTION chat.conversation_memberships_before_clear(text[]) FROM PUBLIC, anon, authenticated, service_role;

-- Existence is not visibility. A closed DM still exists: its bytes are kept, removing its agent still
-- closes it for the other side, and erasing an account still sees the other side holding it. These
-- definer functions read retained seats (chat.live_identity_members, 20261109090000), like the
-- archival functions that must still find an archived agent's own seats.
DO $retained$
DECLARE
    target record;
    previous text;
    acl aclitem[];
    permission record;
BEGIN
    FOR target IN SELECT * FROM (VALUES
      ('chat.conversation_gone(text)'::regprocedure,
       'NOT EXISTS(SELECT 1 FROM chat.active_members m WHERE m.chat_id=c.id)',
       'NOT EXISTS(SELECT 1 FROM chat.live_identity_members m WHERE m.chat_id=c.id)', 1),
      ('identity.archive_user(text,boolean)'::regprocedure, 'chat.active_members', 'chat.live_identity_members', 3),
      ('identity.erase_human_account(text,text)'::regprocedure,
       'INTO locked_chat_ids FROM chat.active_members cm', 'INTO locked_chat_ids FROM chat.live_identity_members cm', 1),
      ('identity.erase_human_account(text,text)'::regprocedure,
       'SELECT 1 FROM chat.active_members live_peer', 'SELECT 1 FROM chat.live_identity_members live_peer', 1)
    ) AS definitions(signature, prior_sql, replacement_sql, occurrences)
    LOOP
        SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl, acldefault('f', p.proowner))
          INTO previous, acl FROM pg_proc p WHERE p.oid = target.signature;
        IF array_length(string_to_array(previous, target.prior_sql), 1) <> target.occurrences + 1 THEN
            RAISE EXCEPTION 'Unexpected retained-seat body: %', target.signature;
        END IF;
        EXECUTE replace(previous, target.prior_sql, target.replacement_sql);
        FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
          FROM aclexplode(acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', target.signature,
              CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
              CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
        END LOOP;
    END LOOP;
END $retained$;

-- The account snapshot reads only owned identities that are still listed.
DO $snapshot$
DECLARE
    previous text;
    prior_sql CONSTANT text := 'UNION SELECT u.id FROM identity.users u WHERE u.owner_user_id = viewer';
BEGIN
    SELECT pg_get_functiondef('chat.sync_snapshot()'::regprocedure) INTO previous;
    IF array_length(string_to_array(previous, prior_sql), 1) <> 2 THEN
        RAISE EXCEPTION 'Unexpected chat.sync_snapshot owned-identity branch';
    END IF;
    EXECUTE replace(previous, prior_sql,
      prior_sql || ' AND u.removed_at IS NULL AND u.session_archived_at IS NULL');
END $snapshot$;
GRANT EXECUTE ON FUNCTION chat.sync_snapshot() TO authenticated;

NOTIFY pgrst, 'reload schema';
