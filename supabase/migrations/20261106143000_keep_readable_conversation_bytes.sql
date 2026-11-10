-- Archival and personal list deletion do not revoke membership or historical file access.
-- A resource container is gone only when no live member can read it anymore, just as is_chat_member
-- reads active_members. Topics share their source container; removed identities cannot return.
CREATE OR REPLACE FUNCTION chat.conversation_gone(p_chat text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT EXISTS(SELECT 1 FROM chat.chats c WHERE c.id=chat.file_transfer_group(p_chat)
        AND NOT EXISTS(SELECT 1 FROM chat.active_members m WHERE m.chat_id=c.id))
$$;

-- Removal can end the last reader of any resource container, not only a DM.
-- Keep the existing status/list triggers: neither event alone now makes a readable container gone.
CREATE OR REPLACE FUNCTION chat.conversation_release_on_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF TG_TABLE_NAME='chats' THEN
        PERFORM chat.conversation_release(NEW.id);
    ELSIF TG_TABLE_NAME='chat_members' THEN
        PERFORM chat.conversation_release(NEW.chat_id);
    ELSE
        PERFORM chat.conversation_release(chat.file_transfer_group(m.chat_id))
          FROM chat.chat_members m WHERE m.user_id=NEW.id;
    END IF;
    RETURN NULL;
END $$;

-- Correct queued lost-reference decisions with the collector's own judgement. An independent idle
-- expiry still makes its reference expired; temporary transfers, uploads and signed capabilities
-- retain their existing rules. Do not infer that previously collected or in-flight bytes exist.
DELETE FROM chat.file_blob_gc g USING chat.file_blobs b
 WHERE b.id=g.blob_id AND b.state='live' AND g.status IN ('pending','failed')
   AND NOT EXISTS(SELECT 1 FROM chat.file_transfer_storage o WHERE o.blob_id=b.id AND o.state IN ('gone','deleting'))
   AND chat.file_blob_held_until(b.id)='infinity'::timestamptz;

-- Existing containers without any reader use the same release path as subsequent removal events.
SELECT chat.conversation_release(c.id) FROM chat.chats c
 WHERE c.source_chat_id IS NULL AND chat.conversation_gone(c.id);

REVOKE ALL ON FUNCTION chat.conversation_gone(text),chat.conversation_release_on_change() FROM PUBLIC,anon,authenticated;
