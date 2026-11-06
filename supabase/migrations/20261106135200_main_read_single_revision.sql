-- Main-stream read progress already publishes member_read_changed, whose
-- tuple invalidates the reader's membership and unread projection too. Keep
-- own revisions for every other field, including fields added in the future.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION chat.publish_membership_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'chat', 'public', 'pg_catalog'
AS $$
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
$$;
