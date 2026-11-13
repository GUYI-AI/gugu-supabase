-- Collected attachments have no bytes left to enqueue. Keep the ordinary
-- lost-reference protocol, including revocation of an attachment with live bytes.
CREATE OR REPLACE FUNCTION chat.session_attachment_lost_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF OLD.blob_id IS NOT NULL
       AND (TG_OP='DELETE' OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)) THEN
        PERFORM chat.file_blob_enqueue(OLD.blob_id);
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION chat.session_attachment_lost_reference() FROM PUBLIC,anon,authenticated,service_role;

-- This is deliberately a fixed inventory, not a catalog-driven DELETE. Only
-- the auth erasure transaction can use its private lifecycle context.
CREATE FUNCTION identity.erase_account_references(p_ids text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE erased_actor text := 'erased:' || gen_random_uuid()::text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.account_lifecycle_context c
        WHERE c.transaction_id=pg_current_xact_id() AND c.operation='privacy_erasure'
          AND c.delete_user_ids=p_ids) THEN
        RAISE EXCEPTION 'Account reference erasure requires the auth deletion transaction' USING ERRCODE='42501';
    END IF;
    UPDATE chat.file_transfer_uploads SET
        actor_id=CASE WHEN actor_id=ANY(p_ids) THEN erased_actor ELSE actor_id END,
        account_id=CASE WHEN account_id=ANY(p_ids) THEN erased_actor ELSE account_id END
    WHERE actor_id=ANY(p_ids) OR account_id=ANY(p_ids);
    UPDATE chat.file_transfer_reservations SET account_id=erased_actor WHERE account_id=ANY(p_ids);
    UPDATE chat.file_transfer_storage_refs SET account_id=erased_actor WHERE account_id=ANY(p_ids);
    DELETE FROM chat.file_transfer_limits WHERE scope='account' AND scope_id=ANY(p_ids);
    UPDATE chat.file_transfer_storage SET owner_account=NULL WHERE owner_account=ANY(p_ids);
    UPDATE chat.file_temporary_transfers SET
        reader_actor=CASE WHEN reader_actor=ANY(p_ids) THEN erased_actor ELSE reader_actor END,
        reader_account=CASE WHEN reader_account=ANY(p_ids) THEN erased_actor ELSE reader_account END
    WHERE reader_actor=ANY(p_ids) OR reader_account=ANY(p_ids);
    UPDATE chat.workspace_items SET updated_by=NULL WHERE updated_by=ANY(p_ids);
    -- A delivery to no surviving recipient no longer grants access to a file.
    DELETE FROM chat.session_attachments WHERE recipient_user_ids <@ p_ids;
    UPDATE chat.session_attachments SET recipient_user_ids=ARRAY(
        SELECT id FROM unnest(recipient_user_ids) id WHERE NOT id=ANY(p_ids))
    WHERE recipient_user_ids && p_ids;
    DELETE FROM chat.presence_wake_throttles WHERE viewer_user_id=ANY(p_ids);
    DELETE FROM chat.message_agent_delivery_blocks WHERE agent_user_id=ANY(p_ids);
    DELETE FROM identity.gugu_device_removals WHERE user_id::text=ANY(p_ids);
    -- Adoption-only historical tables are absent from a fresh installation.
    IF to_regclass('chat_private.removed_agent_dm_close_backup') IS NOT NULL THEN
        EXECUTE 'DELETE FROM chat_private.removed_agent_dm_close_backup WHERE agent_user_id=ANY($1)' USING p_ids;
    END IF;
    IF to_regclass('file_private.backfill_20261106_local_file_updated_at') IS NOT NULL THEN
        EXECUTE 'DELETE FROM file_private.backfill_20261106_local_file_updated_at WHERE updated_by=ANY($1)' USING p_ids;
    END IF;
    -- Last: cascades and shared-content updates can publish revisions themselves.
    DELETE FROM chat.account_revisions WHERE user_id=ANY(p_ids);
    DELETE FROM chat.account_revision_heads WHERE user_id=ANY(p_ids);
END;
$$;
REVOKE ALL ON FUNCTION identity.erase_account_references(text[]) FROM PUBLIC,anon,authenticated,service_role;

DO $upgrade$
DECLARE definition text;
    anchor text := '    DELETE FROM identity.account_lifecycle_context';
BEGIN
    SELECT pg_get_functiondef('identity.erase_human_account(text)'::regprocedure) INTO definition;
    IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected account erasure predecessor'; END IF;
    EXECUTE replace(definition,anchor,
        '    PERFORM identity.erase_account_references(delete_user_ids);' || chr(10) || anchor);

    -- Preserve content time and version history. Only allow this exact metadata
    -- redaction under the private transaction context, never a caller-set flag.
    SELECT pg_get_functiondef('chat.set_workspace_item_updated_at()'::regprocedure) INTO definition;
    IF position('NEW.updated_by:=OLD.updated_by;' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected workspace content timestamp predecessor';
    END IF;
    EXECUTE replace(definition,'NEW.updated_by:=OLD.updated_by;', $redact$
        IF NOT (NEW.updated_by IS NULL AND EXISTS (
            SELECT 1 FROM identity.account_lifecycle_context c
            WHERE c.transaction_id=pg_current_xact_id() AND c.operation='privacy_erasure'
              AND OLD.updated_by=ANY(c.delete_user_ids))
            -- Stored generated columns have not been computed in a BEFORE trigger.
            AND (to_jsonb(NEW)-ARRAY['updated_by','name_key'])=(to_jsonb(OLD)-ARRAY['updated_by','name_key'])) THEN
            NEW.updated_by:=OLD.updated_by;
        END IF;$redact$);
END $upgrade$;
REVOKE ALL ON FUNCTION identity.erase_human_account(text),chat.set_workspace_item_updated_at()
    FROM PUBLIC,anon,authenticated,service_role;
