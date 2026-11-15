-- Resumable multipart uploads keep their state here, not in the object store: the store's multipart upload id for a
-- staging key and the part numbers the client reported done. The runtime key then needs no listing permission, and
-- the expired uploads are abandoned by the existing gc from these rows (no bucket rule is relied on).
ALTER TABLE chat.file_transfer_uploads
    ADD COLUMN upload_id text,
    ADD COLUMN parts_done integer[] NOT NULL DEFAULT '{}';

-- Records the upload id if the row has none (the first of two concurrent openers wins; both get the recorded one) and
-- merges the reported part numbers. Returns the row's id and parts. The caller has checked the key is the user's.
CREATE FUNCTION chat.file_managed_upload_parts(p_key text,p_user text,p_upload_id text,p_done integer[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u chat.file_transfer_uploads%ROWTYPE;
BEGIN
    SELECT * INTO u FROM chat.file_transfer_uploads WHERE staging_key=p_key AND account_id=p_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Upload has no quota reservation' USING HINT='file_transfer_denied'; END IF;
    UPDATE chat.file_transfer_uploads SET
        upload_id=COALESCE(upload_id,p_upload_id),
        parts_done=CASE WHEN COALESCE(upload_id,p_upload_id) IS NULL THEN '{}'
            ELSE ARRAY(SELECT DISTINCT n FROM unnest(parts_done||COALESCE(p_done,'{}')) n ORDER BY n) END
        WHERE staging_key=p_key RETURNING * INTO u;
    RETURN jsonb_build_object('upload_id',u.upload_id,'parts_done',to_jsonb(u.parts_done));
END $$;

-- Forgets one multipart upload (abandoned, or its parts did not add up), only if it is still the recorded one.
CREATE FUNCTION chat.file_managed_upload_parts_clear(p_key text,p_user text,p_upload_id text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
    UPDATE chat.file_transfer_uploads SET upload_id=NULL,parts_done='{}'
        WHERE staging_key=p_key AND account_id=p_user AND upload_id=p_upload_id;
$$;

-- Multipart uploads whose permit expired: the gc abandons each in the store, then clears it.
CREATE FUNCTION chat.file_managed_upload_parts_expired(p_limit integer) RETURNS TABLE(staging_key text,account_id text,upload_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT u.staging_key,u.account_id,u.upload_id FROM chat.file_transfer_uploads u
        JOIN chat.file_transfer_reservations r ON r.id=u.reservation_id
        WHERE u.upload_id IS NOT NULL AND r.expires_at<=now()
        ORDER BY r.expires_at LIMIT greatest(p_limit,0);
$$;

ALTER FUNCTION chat.file_managed_upload_parts(text,text,text,integer[]) OWNER TO postgres;
ALTER FUNCTION chat.file_managed_upload_parts_clear(text,text,text) OWNER TO postgres;
ALTER FUNCTION chat.file_managed_upload_parts_expired(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_managed_upload_parts(text,text,text,integer[]),chat.file_managed_upload_parts_clear(text,text,text),
    chat.file_managed_upload_parts_expired(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_parts(text,text,text,integer[]),chat.file_managed_upload_parts_clear(text,text,text),
    chat.file_managed_upload_parts_expired(integer) TO service_role;

NOTIFY pgrst,'reload schema';
