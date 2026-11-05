-- A chat folder's list (workspace_list_as) finds each stored file's live copy, else its latest reclaimed one, from the
-- file's blob: file_transfer_storage by blob_id, then its refs by (storage_id, chat_id). With no index on blob_id the
-- planner started from the group's refs instead and walked all of them for every stored file — 556 files × ~712 refs in a
-- 1414-item folder, 1.1 s of a list the folder waits on. Measured on the shared test database in a rolled-back
-- transaction: the full list 1027–1086 ms → 86–112 ms, buffer hits 1.28M → 24.8k; the function is unchanged.
CREATE INDEX IF NOT EXISTS file_transfer_storage_blob_idx ON chat.file_transfer_storage (blob_id) WHERE blob_id IS NOT NULL;
