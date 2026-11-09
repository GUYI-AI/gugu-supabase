-- Roll back 20261109090000_archived_agents_leave_groups: archived agents count as group
-- members again. Seats, identities, history and the installer ledger are not touched.
-- Run it before any older operational rollback that drops identity.member_liveness.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE identity.users IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE VIEW chat.active_members WITH (security_invoker = true) AS
  SELECT m.* FROM chat.chat_members m
    JOIN identity.member_liveness live ON live.user_id = m.user_id
  WHERE live.is_live;
ALTER POLICY members_select_peer ON chat.chat_members
  USING (identity.user_is_live(user_id) AND chat.is_member(chat_id));

-- Archived agents are members again: tell the live human members, newest state first in
-- the revision-head lock order, so cached member lists bring them back.
DO $returned$
DECLARE seat record;
BEGIN
    FOR seat IN
        SELECT peer.user_id AS recipient, mine.chat_id, mine.user_id AS agent
          FROM chat.chat_members mine
          JOIN identity.member_liveness live ON live.user_id = mine.user_id AND live.is_live AND NOT live.in_groups
          JOIN chat.active_members peer ON peer.chat_id = mine.chat_id AND peer.user_id <> mine.user_id
          JOIN identity.users human ON human.id = peer.user_id AND human.type = 'human'
         WHERE NOT chat_private.is_direct_chat(mine.chat_id)
         ORDER BY peer.user_id, mine.chat_id, mine.user_id
    LOOP
        PERFORM chat.publish_user_revision(seat.recipient, 'chat_members_changed',
          jsonb_build_object('chat_id', seat.chat_id, 'user_id', seat.agent, 'kind', 'roster'), false);
    END LOOP;
END $returned$;

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
       'FROM chat.live_identity_members mine', 'FROM chat.active_members mine', 2),
      ('identity.set_agent_session_archival(text,text,uuid,bigint,timestamp with time zone,jsonb)'::regprocedure,
       '  PERFORM 1 FROM identity.member_liveness WHERE user_id = p_agent_user_id FOR NO KEY UPDATE;
', '', 1),
      ('identity.publish_identity_display_revision()'::regprocedure,
       'FROM chat.live_identity_members mine', 'FROM chat.active_members mine', 1),
      ('chat.record_message_agent_wakes()'::regprocedure,
       'JOIN chat.live_identity_members cm ON cm.chat_id = c.id AND (chat_private.member_seat_visible(c.id, cm.user_id)
      OR cm.user_id = ANY(COALESCE(NEW.to_user_ids, ARRAY[]::text[])) OR cm.user_id = reply_target)',
       'JOIN chat.active_members cm ON cm.chat_id = c.id', 1),
      ('chat.is_addressable_in(text,text)'::regprocedure,
       'chat.is_retained_member(', 'chat.is_chat_member(', 2),
      ('chat.enforce_whisper_rule()'::regprocedure,
       'chat.is_retained_member(NEW.chat_id, NEW.to_user_ids[1])', 'chat.is_chat_member(NEW.chat_id, NEW.to_user_ids[1])', 1),
      ('chat.group_add_denial(text,text,text,boolean,boolean)'::regprocedure,
       '
    IF EXISTS (SELECT 1 FROM identity.users u WHERE u.id = p_user_id AND u.session_archived_at IS NOT NULL) THEN RETURN ''agent_archived''; END IF;', '', 1),
      ('chat.remove_group_member_as(text,text,text)'::regprocedure,
       '    IF v_role IS NULL AND chat.is_retained_member(p_chat_id, p_member_user_id) THEN RAISE EXCEPTION ''agent_archived''; END IF;
', '', 1)
    ) AS definitions(signature, prior_sql, replacement_sql, occurrences)
    LOOP
        SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl, acldefault('f', p.proowner))
          INTO previous, acl FROM pg_proc p WHERE p.oid = target.signature;
        IF array_length(string_to_array(previous, target.prior_sql), 1) <> target.occurrences + 1 THEN
            RAISE EXCEPTION 'Unexpected archived seat release body: %', target.signature;
        END IF;
        definition := replace(previous, target.prior_sql, target.replacement_sql);
        EXECUTE definition;
        FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
          FROM aclexplode(acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', target.signature,
              CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
              CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
        END LOOP;
    END LOOP;
END $seats$;

DROP TRIGGER users_publish_session_archival_roster ON identity.users;
DROP FUNCTION chat.publish_session_archival_roster();
DROP FUNCTION chat.is_retained_member(text, text);
DROP VIEW chat.live_identity_members;
DROP FUNCTION chat_private.member_seat_visible(text, text);
DROP FUNCTION chat_private.is_direct_chat(text);
DROP SCHEMA chat_private;
DROP TRIGGER users_00_member_liveness_session ON identity.users;
CREATE OR REPLACE FUNCTION identity.sync_member_liveness() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO identity.member_liveness(user_id, is_live)
    VALUES (NEW.id, NEW.removed_at IS NULL)
    ON CONFLICT (user_id) DO UPDATE SET is_live = EXCLUDED.is_live;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.sync_member_liveness() FROM PUBLIC, anon, authenticated, service_role, gugu_files;
ALTER TABLE identity.member_liveness DROP COLUMN in_groups;
NOTIFY pgrst, 'reload schema';
COMMIT;
