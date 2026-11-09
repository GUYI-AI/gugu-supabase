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
      ('identity.publish_identity_display_revision()'::regprocedure,
       'FROM chat.live_identity_members mine', 'FROM chat.active_members mine', 1),
      ('chat.record_message_agent_wakes()'::regprocedure,
       'JOIN chat.live_identity_members cm ON cm.chat_id = c.id', 'JOIN chat.active_members cm ON cm.chat_id = c.id', 1),
      ('chat.is_addressable_in(text,text)'::regprocedure,
       'chat.is_retained_member(', 'chat.is_chat_member(', 2),
      ('chat.enforce_whisper_rule()'::regprocedure,
       'chat.is_retained_member(NEW.chat_id, NEW.to_user_ids[1])', 'chat.is_chat_member(NEW.chat_id, NEW.to_user_ids[1])', 1)
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
DROP FUNCTION chat.is_direct_chat(text);
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
