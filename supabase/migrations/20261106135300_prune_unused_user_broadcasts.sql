-- Remove direct producers after checking every deployed client version.
-- Keep moments/agents compatibility; a main read needs only its read revision.
SET LOCAL lock_timeout = '5s';

DROP TRIGGER chat_members_broadcast_trg ON chat.chat_members;
DROP FUNCTION chat.chat_members_broadcast();
DROP TRIGGER chat_members_stream_read_broadcast_changed ON chat.chat_members;
DROP FUNCTION chat.broadcast_main_stream_read_changed();
DROP TRIGGER chat_member_stream_read_broadcast_changed ON chat.chat_member_stream_read_state;
DROP FUNCTION chat.broadcast_member_stream_read_changed();
DROP TRIGGER friend_requests_user_event_bus ON identity.friend_requests;
DROP FUNCTION identity.broadcast_friend_request_changed();

-- Retain the installed revision/whisper/points logic and exact EXECUTE ACLs,
-- using the same guarded definition edit as the human-user-events migration.
DO $prune$
DECLARE
  r record;
  definition text;
  grants aclitem[];
  permission record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('chat.broadcast_to_chat_member_user_events(text,text,jsonb)'::regprocedure, $topic$        -- Topic source-line notifications are a deliberately narrow legacy edge: the
        -- topic projection needs the source-line marker to refresh its anchor card.
        -- Keep this low-volume payload only for that shape; ordinary chat/message
        -- mutations use the durable revision wake above.
        IF p_event = 'chat_changed' AND p_payload ? 'topic_of_source_chat' THEN
            PERFORM chat.send_user_event(
                p_payload,
                p_event,
                'gugu:user:' || target_user_id || ':events',
                true
            );
        END IF;
$topic$, ''),
    ('public.forum_points_apply()'::regprocedure, $points$    PERFORM chat.send_user_event(
        jsonb_build_object('event', 'forum_points_changed', 'entity_id', NEW.user_id),
        'forum_points_changed',
        'gugu:user:' || NEW.user_id || ':events',
        true
    );
$points$, ''),
    ('chat.publish_membership_revision()'::regprocedure, $old$    IF TG_OP = 'UPDATE'
       AND (NEW.role, NEW.listen_mode, NEW.chat_id, NEW.user_id)
           IS NOT DISTINCT FROM (OLD.role, OLD.listen_mode, OLD.chat_id, OLD.user_id) THEN
$old$, $new$    IF TG_OP = 'UPDATE'
       AND (NEW.role, NEW.listen_mode, NEW.chat_id, NEW.user_id)
           IS NOT DISTINCT FROM (OLD.role, OLD.listen_mode, OLD.chat_id, OLD.user_id) THEN
      IF NEW.last_read_seq IS DISTINCT FROM OLD.last_read_seq
         AND (to_jsonb(NEW) - ARRAY['last_read_seq', 'is_marked_unread', 'version', 'updated_at'])
             IS NOT DISTINCT FROM
             (to_jsonb(OLD) - ARRAY['last_read_seq', 'is_marked_unread', 'version', 'updated_at']) THEN
        RETURN NEW;
      END IF;
$new$)
  ) edits(signature, previous, replacement) LOOP
    SELECT pg_get_functiondef(p.oid), COALESCE(p.proacl, acldefault('f',p.proowner))
      INTO definition, grants FROM pg_proc p WHERE p.oid=r.signature;
    IF length(definition)-length(replace(definition,r.previous,'')) <> length(r.previous) THEN
      RAISE EXCEPTION 'Unexpected legacy broadcaster predecessor: %', r.signature;
    END IF;
    EXECUTE replace(definition,r.previous,r.replacement);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',r.signature);
    FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable
      FROM aclexplode(grants) WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',r.signature,
        CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
        CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END;
$prune$;
