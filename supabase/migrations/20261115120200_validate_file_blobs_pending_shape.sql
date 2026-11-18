-- gugu:transaction off
-- Rows from before 20261115120000 have no declaration columns set, so they satisfy the pending shape.
ALTER TABLE chat.file_blobs VALIDATE CONSTRAINT file_blobs_pending_shape;
