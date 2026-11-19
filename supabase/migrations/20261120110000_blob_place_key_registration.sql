-- Registration finds and creates managed blobs by their place, not by a global sha256.
--
-- chat.file_blobs was unique on sha256 across every bucket, and registration (file_blob_register, file_blob_settle)
-- resolved an uploaded file by `ON CONFLICT (sha256)` followed by `WHERE sha256 = <sha>` with no bucket filter. A
-- temporary relay blob records the sha256 of whatever bytes its host uploaded, so a host could upload a target file's
-- plaintext as its "ciphertext": any later upload of that file was then attached to the host's expiring relay object.
-- In the other order an honest relay commit failed on the global unique key.
--
-- A managed upload's identity is its place: bucket 'oss', object '<aa>/<sha256>' (file_blobs_oss_shape). The place key
-- (bucket_id, object_name) is already unique, so the global sha256 key goes and both registrations conflict on and read
-- by the place key. Temporary and other buckets keep their own places and no longer collide with managed files.
SET LOCAL lock_timeout = '5s';

DO $place$
DECLARE definition text;
    reg_conflict text := 'ON CONFLICT (sha256) DO NOTHING
    RETURNING b.* INTO v_blob;';
    reg_lookup text := 'SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.sha256 = v_sha;';
    settle_conflict text := 'ON CONFLICT (sha256) DO NOTHING RETURNING b.* INTO l;';
    settle_lookup text := 'IF NOT created THEN SELECT * INTO l FROM chat.file_blobs WHERE sha256=sha; END IF;';
BEGIN
    SELECT pg_get_functiondef('chat.file_blob_register(text,text,text,bigint,text,integer,integer)'::regprocedure) INTO definition;
    IF strpos(definition,reg_conflict)=0 OR strpos(definition,reg_lookup)=0 THEN
        RAISE EXCEPTION 'Unexpected file_blob_register definition; refusing a partial upgrade';
    END IF;
    definition:=replace(definition,reg_conflict,'ON CONFLICT ON CONSTRAINT file_blobs_place_key DO NOTHING
    RETURNING b.* INTO v_blob;');
    EXECUTE replace(definition,reg_lookup,
        'SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.bucket_id = ''oss'' AND b.object_name = substr(v_sha, 1, 2) || ''/'' || v_sha;');

    SELECT pg_get_functiondef('chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb)'::regprocedure) INTO definition;
    IF strpos(definition,settle_conflict)=0 OR strpos(definition,settle_lookup)=0 THEN
        RAISE EXCEPTION 'Unexpected file_blob_settle definition; refusing a partial upgrade';
    END IF;
    definition:=replace(definition,settle_conflict,'ON CONFLICT ON CONSTRAINT file_blobs_place_key DO NOTHING RETURNING b.* INTO l;');
    EXECUTE replace(definition,settle_lookup,
        'IF NOT created THEN SELECT * INTO l FROM chat.file_blobs WHERE bucket_id=''oss'' AND object_name=substr(sha,1,2)||''/''||sha; END IF;');
END $place$;

-- Both registrations now conflict on the place key; nothing else uses the global key.
ALTER TABLE chat.file_blobs DROP CONSTRAINT file_blobs_sha256_key;
-- Lookups by content hash (integrity checks, document import) keep an index.
CREATE INDEX file_blobs_sha256_idx ON chat.file_blobs(sha256) WHERE sha256 IS NOT NULL;

NOTIFY pgrst,'reload schema';
