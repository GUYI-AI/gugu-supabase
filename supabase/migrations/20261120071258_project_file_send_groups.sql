-- #2581: native project-file sends keep the same group as cloud attachment commits.
-- Keep the RPC signature, authorization, revision publication and per-file message rows unchanged.
-- The existing BEFORE INSERT trigger applies metadata only to the named message. Its returned row
-- already carries the group, before publication events and receipts are read. No post-insert repair.

CREATE OR REPLACE FUNCTION chat.file_device_publish(p_item uuid, p_chat text, p_device text, p_path text, p_sha text, p_size bigint, p_filename text, p_type text, p_expected integer DEFAULT NULL::integer, p_parent uuid DEFAULT NULL::uuid, p_message jsonb DEFAULT NULL::jsonb, p_project text DEFAULT NULL::text, p_width integer DEFAULT NULL::integer, p_height integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE revision jsonb; message jsonb; sender text;
    send_group uuid; send_size integer;
BEGIN
    IF p_message IS NOT NULL THEN
        IF jsonb_typeof(p_message) IS DISTINCT FROM 'object' OR COALESCE((p_message->>'is_whisper')::boolean,false) THEN
            RAISE EXCEPTION 'A local project publication cannot be a whisper' USING HINT='file_transfer_denied';
        END IF;
        sender:=COALESCE(NULLIF(p_message->>'sender_user_id',''),auth.uid()::text);
        IF NOT chat.can_act_as(sender,p_chat) THEN
            RAISE EXCEPTION 'A project file can be sent only as yourself or your own agent in this chat' USING ERRCODE='42501',HINT='file_transfer_denied';
        END IF;
        -- The native publisher receives the same send metadata as attachment_commit. Validate it before
        -- publishing a revision; never leave an indexed file behind for an invalid message.
        IF p_message->>'send_group_id' IS NOT NULL OR p_message->>'send_group_size' IS NOT NULL THEN
            IF jsonb_typeof(p_message->'send_group_id') IS DISTINCT FROM 'string'
               OR jsonb_typeof(p_message->'send_group_size') IS DISTINCT FROM 'number' THEN
                RAISE EXCEPTION 'A send needs its UUID and a file count from 2 to 10' USING HINT='send_group_invalid';
            END IF;
            BEGIN
                send_group := (p_message->>'send_group_id')::uuid;
                send_size := (p_message->>'send_group_size')::integer;
            EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
                RAISE EXCEPTION 'A send needs its UUID and a file count from 2 to 10' USING HINT='send_group_invalid';
            END;
            IF send_size NOT BETWEEN 2 AND 10 THEN
                RAISE EXCEPTION 'A send needs its UUID and a file count from 2 to 10' USING HINT='send_group_invalid';
            END IF;
        END IF;
    END IF;
    revision:=file_private.publish_revision(p_item,p_chat,p_device,p_project,p_path,p_sha,p_size,p_filename,p_type,p_expected,p_parent,p_width,p_height);
    IF p_message IS NOT NULL THEN
        IF send_group IS NOT NULL THEN
            PERFORM pg_catalog.set_config('chat.send_group_message', p_message->>'message_id', true);
            PERFORM pg_catalog.set_config('chat.send_group', send_group::text || ':' || send_size::text, true);
        END IF;
        SELECT to_jsonb(sent) INTO message FROM chat.send_message_idempotent(
            p_message->>'message_id',p_chat,sender,ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_message->'to_user_ids','[]'::jsonb))),
            (revision->>'envelope')||chat.attachment_caption_suffix(p_message->>'caption'),
            'attachment',p_message->>'reply_to_message_id',p_message->>'thread_root_id',COALESCE((p_message->>'is_thread_root')::boolean,false),
            false,p_message->>'via_app',p_item,(revision->>'version')::integer
        ) AS sent;
        IF send_group IS NOT NULL THEN
            PERFORM pg_catalog.set_config('chat.send_group_message', '', true);
            PERFORM pg_catalog.set_config('chat.send_group', '', true);
        END IF;
        PERFORM file_private.link_project_message(p_item,message->>'id');
    END IF;
    RETURN (revision-'envelope')||CASE WHEN message IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('message',message) END;
END $function$;

-- The installation DDL event trigger closes replaced functions to API roles. Restore only
-- the existing authenticated entry point; PostgreSQL's own ACL preservation is not sufficient.
REVOKE ALL ON FUNCTION chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb,text,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb,text,integer,integer) TO authenticated;
NOTIFY pgrst, 'reload schema';
