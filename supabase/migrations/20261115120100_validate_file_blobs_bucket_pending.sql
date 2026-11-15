-- gugu:transaction off
-- Existing bucket values already satisfy the expanded CHECK (20261115120000 only added 'pending').
ALTER TABLE chat.file_blobs VALIDATE CONSTRAINT file_blobs_bucket_id_check;
