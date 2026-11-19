-- Roll back 20261120020000_archived_agents_leave_directory: session-archived agents are listed in
-- identity.active_users again, their direct chats return to chat.active_members for every member,
-- and the account snapshot reads every owned identity again. Identities, seats, messages and the
-- installer ledger are not touched. Run it before rollback-archived-agents-leave-groups.sql, which
-- drops the chat_private schema.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE identity.users IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE VIEW identity.active_users WITH (security_invoker = true) AS
  SELECT id, type, display_name, avatar, bio, mycel_id, owner_user_id,
    agent_config_id, created_at, updated_at, device_id, local_path, prompt_path,
    desired_status, agent_public, gugu_number, category, inherit_memory,
    special_focus, onboarded_at, is_official, session_archived_at,
    session_lifecycle_revision, session_lifecycle_operation_id, removed_at, name_serial
  FROM identity.users WHERE removed_at IS NULL;
COMMENT ON FUNCTION identity.user_is_live(text) IS NULL;
COMMENT ON VIEW identity.active_users IS NULL;

CREATE OR REPLACE VIEW chat.active_members WITH (security_invoker = true) AS
  SELECT m.chat_id, m.user_id, m.role, m.last_read_seq, m.version, m.joined_at, m.updated_at,
    m.is_pinned, m.contract, m.triggers, m.notification_level, m.listen_mode, m.hide_history_before,
    m.is_marked_unread, m.inbox_published_at, m.join_context_shown_at, m.joined_ingest_seq,
    m.conversation_deleted_at
  FROM chat.chat_members m
    JOIN identity.member_liveness live ON live.user_id = m.user_id
  WHERE live.is_live AND (live.in_groups OR chat_private.is_direct_chat(m.chat_id));
CREATE OR REPLACE FUNCTION chat_private.member_seat_visible(p_chat_id text, p_user_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM identity.member_liveness live WHERE live.user_id = p_user_id
    AND live.is_live AND (live.in_groups OR chat_private.is_direct_chat(p_chat_id)));
$$;
GRANT EXECUTE ON FUNCTION chat_private.member_seat_visible(text, text) TO authenticated, service_role, gugu_files;

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
    RETURN NEW;
END;
$$;

-- The direct chats come back: tell those members so cached lists read their rows again.
DO $returned$
DECLARE seat record;
BEGIN
    FOR seat IN SELECT closed.chat_id, closed.user_id FROM chat_private.closed_direct_seats closed
                 ORDER BY closed.user_id, closed.chat_id
    LOOP
        PERFORM chat.publish_user_revision(seat.user_id, 'chat_members_changed',
          jsonb_build_object('chat_id', seat.chat_id, 'user_id', seat.user_id, 'kind', 'own'), false);
    END LOOP;
END $returned$;

DO $retained$
DECLARE
    target record;
    previous text;
    acl aclitem[];
    permission record;
BEGIN
    FOR target IN SELECT * FROM (VALUES
      ('chat.conversation_gone(text)'::regprocedure,
       'NOT EXISTS(SELECT 1 FROM chat.live_identity_members m WHERE m.chat_id=c.id)',
       'NOT EXISTS(SELECT 1 FROM chat.active_members m WHERE m.chat_id=c.id)', 1),
      ('identity.archive_user(text,boolean)'::regprocedure, 'chat.live_identity_members', 'chat.active_members', 3),
      ('identity.erase_human_account(text,text)'::regprocedure,
       'INTO locked_chat_ids FROM chat.live_identity_members cm', 'INTO locked_chat_ids FROM chat.active_members cm', 1),
      ('identity.erase_human_account(text,text)'::regprocedure,
       'SELECT 1 FROM chat.live_identity_members live_peer', 'SELECT 1 FROM chat.active_members live_peer', 1)
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

DROP TRIGGER users_01_closed_direct_seats ON identity.users;
DROP FUNCTION chat_private.sync_closed_direct_seats();
DROP FUNCTION chat_private.recompute_closed_direct_seats(text[]);
DROP TABLE chat_private.closed_direct_seats;

DO $memberships$
DECLARE
    previous text;
    current_sql CONSTANT text := 'WHERE c.id = ANY(p_chat_ids) AND (chat_private.member_seat_visible(m.chat_id, m.user_id)';
BEGIN
    SELECT pg_get_functiondef('chat.conversation_memberships_before_clear(text[])'::regprocedure) INTO previous;
    IF array_length(string_to_array(previous, current_sql), 1) <> 2 THEN
        RAISE EXCEPTION 'Unexpected chat.conversation_memberships_before_clear seat predicate';
    END IF;
    EXECUTE replace(previous, current_sql, 'WHERE c.id = ANY(p_chat_ids) AND (identity.user_is_live(m.user_id)');
END $memberships$;
REVOKE ALL ON FUNCTION chat.conversation_memberships_before_clear(text[]) FROM PUBLIC, anon, authenticated, service_role;

DO $snapshot$
DECLARE
    previous text;
    current_sql CONSTANT text := 'UNION SELECT u.id FROM identity.users u WHERE u.owner_user_id = viewer AND u.removed_at IS NULL AND u.session_archived_at IS NULL';
BEGIN
    SELECT pg_get_functiondef('chat.sync_snapshot()'::regprocedure) INTO previous;
    IF array_length(string_to_array(previous, current_sql), 1) <> 2 THEN
        RAISE EXCEPTION 'Unexpected chat.sync_snapshot owned-identity branch';
    END IF;
    EXECUTE replace(previous, current_sql, 'UNION SELECT u.id FROM identity.users u WHERE u.owner_user_id = viewer');
END $snapshot$;
GRANT EXECUTE ON FUNCTION chat.sync_snapshot() TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
