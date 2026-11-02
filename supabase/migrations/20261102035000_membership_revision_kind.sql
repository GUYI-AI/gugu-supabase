-- Distinguish roster changes from private member state in the existing revision key.
-- Older revisions without kind retain roster semantics. Older clients ignore the new key.
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
          SELECT cm.user_id FROM chat.chat_members cm WHERE cm.chat_id = target_chat_id
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
