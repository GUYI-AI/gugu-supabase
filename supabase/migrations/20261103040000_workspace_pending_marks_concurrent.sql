-- gugu:transaction off
-- Run this single statement outside a transaction, then verify validity before recording it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS workspace_items_pending_marks_idx ON chat.workspace_items (id)
    WHERE kind = 'document' AND ystate IS NULL AND inline_text LIKE '%"$text"%';
