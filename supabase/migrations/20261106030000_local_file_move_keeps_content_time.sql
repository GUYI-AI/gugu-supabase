-- A local file's content time (updated_at) moves when its bytes do, not when it is renamed or moved.
--
-- A project file whose bytes stay on its host has no blob: its content is the version's file_device_revisions row
-- (device, path, SHA-256). Renaming or moving it (workspace_move_as) makes the next version and carries the same SHA
-- to it (file_device_carry_revision, which fires before this trigger: triggers fire in name order). Counting every
-- next version as a content change put every file someone tidied today under 「今天」 in the folder App's recent sort
-- and day sections. The content changed exactly when the two versions' SHA-256 differ; a version with no revision row
-- (one the carry trigger did not write) is a change, as before.
-- It reads file_device_revisions whoever updates the file (a service role such as gugu_files cannot read that table), so
-- it runs as its owner (SECURITY DEFINER with an empty search_path), as file_device_carry_revision does.
CREATE OR REPLACE FUNCTION chat.set_workspace_item_updated_at() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF (NEW.inline_text IS DISTINCT FROM OLD.inline_text AND NOT
          (OLD.kind='file' AND NEW.kind='document' AND NEW.blob_id IS NOT NULL))
       OR NEW.blob_id IS DISTINCT FROM OLD.blob_id
       OR (NEW.kind='file' AND NEW.blob_id IS NULL AND NEW.version IS DISTINCT FROM OLD.version
           AND NOT EXISTS(SELECT 1 FROM chat.file_device_revisions n JOIN chat.file_device_revisions o
               ON o.item_id=OLD.id AND o.version=OLD.version AND o.sha256=n.sha256
               WHERE n.item_id=NEW.id AND n.version=NEW.version)) THEN
        NEW.updated_at:=now();
    ELSE
        NEW.updated_at:=OLD.updated_at;
        NEW.updated_by:=OLD.updated_by;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION chat.set_workspace_item_updated_at() FROM PUBLIC,anon,authenticated,service_role,gugu_files;
COMMENT ON FUNCTION chat.set_workspace_item_updated_at() IS 'F88: updated_at moves only when the content does (inline_text for documents, the blob for stored files, the SHA-256 of a local file''s version); a rename, a move and every other UPDATE keep it.';
