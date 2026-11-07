-- gugu:transaction off
-- Existing bucket values already satisfy the expanded CHECK.
ALTER TABLE chat.file_blobs VALIDATE CONSTRAINT file_blobs_bucket_id_check;
