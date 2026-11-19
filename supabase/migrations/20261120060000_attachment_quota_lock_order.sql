-- #359: storage admission precedes the receipt/item/blob rows that admission
-- itself may update. Registration already follows that order. A version send
-- used to hold file_blob_uploads while its version trigger waited for quota,
-- while registration held quota and waited for that same upload receipt.
--
-- Keep the existing quota lock, transaction boundaries, functions and API ACLs.
-- The file-message place functions still take their chat row before publishing
-- any line revision. No retry, new serialization lock or timeout change is used.
-- Pure file readers (including file_blob_take and unlocked workspace_item_for)
-- continue without storage admission. Downloads must not queue behind quota.
SET LOCAL lock_timeout = '5s';

DO $quota_before_file_rows$
DECLARE
    target regprocedure;
    previous text;
    changed text;
    definition text;
    prior_acl aclitem[];
    permission record;
    entry integer;
    admission text := E'    -- #359: quota admission before any file row lock.\n'
        || E'    PERFORM pg_catalog.pg_advisory_xact_lock(\n'
        || E'        pg_catalog.hashtextextended(''gugu:file-transfer:quota'',0));\n';
BEGIN
    -- Shared write frontiers, including the managed-settle replay and the old
    -- session/workspace APIs. Prepending to the installed body also preserves
    -- the later release amendments (version conflict handling and staging proof).
    FOREACH target IN ARRAY ARRAY[
        'chat.attachment_place(text,text,text,text,text,boolean)'::regprocedure,
        'chat.attachment_place_version(text,uuid,integer,text,text,text)'::regprocedure,
        'chat.attachment_place_forward(text,text,text,text,boolean)'::regprocedure,
        'chat.attachment_place_share(uuid,integer,text,text,text)'::regprocedure,
        'chat.attachment_item_for(text,uuid,text,text,text)'::regprocedure,
        'chat.file_replace_as(text,text,text,integer)'::regprocedure,
        'chat.file_upload_take(text)'::regprocedure,
        'chat.file_blob_register(text,text,text,bigint,text,integer,integer)'::regprocedure,
        'chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb)'::regprocedure,
        'chat.attachment_declare(text,text,bigint,text,integer,integer,text)'::regprocedure,
        'chat.workspace_create_file_as(text,text,text,text,bigint,text,text[],text)'::regprocedure,
        'chat.files_record_version(uuid,text,text)'::regprocedure,
        'chat.workspace_import_document(uuid,integer,uuid,jsonb)'::regprocedure,
        'chat.files_replace_stage(uuid,text,text,text,integer,jsonb,boolean)'::regprocedure,
        'file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid,integer,integer)'::regprocedure,
        'file_private.publish_revision_by(uuid,text,text,text,text,bigint,text,text,integer,uuid,text)'::regprocedure,
        'file_private.link_project_message(uuid,text)'::regprocedure,
        'chat.send_friend_file_as_owner(text,text,text,text,text,text)'::regprocedure,
        'chat.session_attachment_commit(text,uuid,text,text,text[],text)'::regprocedure,
        'chat.file_version_handoff_publish(uuid,text,text,bigint)'::regprocedure,
        -- Retention's audited wrapper keeps its identity-erasure guard outside
        -- this closed base. The base must admit quota before updating copy rows,
        -- rather than reaching file_transfer_expire only after those updates.
        'file_private.storage_mark_audit_base(jsonb,text,text)'::regprocedure,
        'chat.send_message_idempotent(text,text,text,text[],text,text,text,text,boolean,boolean,text,uuid,integer,text,uuid)'::regprocedure,
        'chat.workspace_item_for(text,text,boolean)'::regprocedure,
        'chat.messages_file_ref()'::regprocedure
    ] LOOP
        SELECT p.prosrc,pg_get_functiondef(p.oid),COALESCE(p.proacl,acldefault('f',p.proowner))
          INTO STRICT previous,definition,prior_acl FROM pg_proc p WHERE p.oid=target;
        IF strpos(previous,'#359: quota admission')<>0 THEN
            RAISE EXCEPTION 'Unexpected already-patched quota predecessor: %',target;
        END IF;
        IF target='chat.workspace_item_for(text,text,boolean)'::regprocedure THEN
            -- A read-only lookup does not lock the item and does not admit bytes.
            IF (length(previous)-length(replace(previous,E'    IF p_lock THEN\n','')))
                /length(E'    IF p_lock THEN\n')<>1 THEN
                RAISE EXCEPTION 'Unexpected workspace lock predecessor: %',target;
            END IF;
            changed:=replace(previous,E'    IF p_lock THEN\n',E'    IF p_lock THEN\n'||admission);
        ELSE
            entry:=strpos(previous,E'BEGIN\n');
            IF entry=0 THEN RAISE EXCEPTION 'Missing file writer entry: %',target; END IF;
            IF target='chat.messages_file_ref()'::regprocedure THEN
                -- Direct authenticated attachment INSERTs reach this existing
                -- BEFORE trigger before topic joins, sequence allocation and the
                -- AFTER storage-reference trigger. Plain text takes no quota lock.
                changed:=overlay(previous placing E'BEGIN\n'
                    || E'    IF TG_OP=''INSERT'' AND (NEW.content_type=''attachment''\n'
                    || E'        OR NEW.file_item_id IS NOT NULL OR NEW.file_blob_id IS NOT NULL) THEN\n'
                    || admission || E'    END IF;\n' from entry for length(E'BEGIN\n'));
            ELSIF target='chat.send_message_idempotent(text,text,text,text[],text,text,text,text,boolean,boolean,text,uuid,integer,text,uuid)'::regprocedure THEN
                -- File RPCs already admit quota before reaching message-id
                -- locks. A direct attachment send must use that same order.
                changed:=overlay(previous placing E'BEGIN\n'
                    || E'    IF p_content_type=''attachment'' OR p_file_item_id IS NOT NULL\n'
                    || E'        OR p_file_blob_id IS NOT NULL THEN\n'
                    || admission || E'    END IF;\n' from entry for length(E'BEGIN\n'));
            ELSE
                changed:=overlay(previous placing E'BEGIN\n'||admission from entry for length(E'BEGIN\n'));
            END IF;
        END IF;
        IF changed=previous OR strpos(definition,previous)=0 THEN
            RAISE EXCEPTION 'Missing quota writer predecessor: %',target;
        END IF;
        EXECUTE replace(definition,previous,changed);
        -- The installation CREATE FUNCTION guard closes replaced functions too.
        -- Restore the exact existing execute principals, never a new API grant.
        FOR permission IN
            SELECT grantee,bool_or(is_grantable) AS grantable FROM aclexplode(prior_acl)
             WHERE privilege_type='EXECUTE' GROUP BY grantee
        LOOP
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',target,
                CASE WHEN permission.grantee=0 THEN 'PUBLIC'
                     ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
                CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
        END LOOP;
    END LOOP;
END $quota_before_file_rows$;
