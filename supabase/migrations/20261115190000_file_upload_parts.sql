-- Resumable multipart uploads keep their state here, not in the object store: the store's multipart upload id for a
-- staging key and the part numbers the client reported done. The runtime key then needs no listing permission, and
-- the expired uploads are abandoned by the existing gc from these rows (no bucket rule is relied on).
SET LOCAL lock_timeout = '5s';
ALTER TABLE chat.file_transfer_uploads
    ADD COLUMN upload_id text,
    ADD COLUMN parts_done integer[] NOT NULL DEFAULT '{}',
    ADD COLUMN abandon_tried_at timestamptz;

-- Records the upload id if the row has none (the first of two concurrent openers wins; both get the recorded one) and
-- merges the reported part numbers. Returns the row's id and parts. The caller has checked the key is the user's.
-- An upload that keeps reporting keeps its permit: each call moves a live, unused permit's expiry to one permit length
-- from now, at most a day after it was issued (the bucket abandons unfinished multipart uploads after a day). One that
-- stops reporting expires as before, and its reserved quota is released as before.
CREATE FUNCTION chat.file_managed_upload_parts(p_key text,p_user text,p_upload_id text,p_done integer[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u chat.file_transfer_uploads%ROWTYPE;
BEGIN
    SELECT * INTO u FROM chat.file_transfer_uploads WHERE staging_key=p_key AND account_id=p_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Upload has no quota reservation' USING HINT='file_transfer_denied'; END IF;
    UPDATE chat.file_transfer_reservations SET expires_at=greatest(expires_at,least(created_at+interval '1 day',
            now()+make_interval(secs=>chat.file_transfer_parameter(chat.file_transfer_settings(),'upload_permit_seconds')::integer)))
        WHERE id=u.reservation_id AND state<>'settled' AND expires_at>now();
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

-- Claims multipart uploads whose permit expired for the gc to abandon: never tried first, then the earliest tried, then
-- the earliest expired, each stamped as tried in the same statement. An abandon that keeps failing therefore moves behind
-- the others instead of holding the first places; one that succeeds is cleared and never claimed again. Two gc runs that
-- claim the same row are harmless: the second abandon finds the upload gone, which counts as abandoned.
CREATE FUNCTION chat.file_managed_upload_parts_claim(p_limit integer) RETURNS TABLE(staging_key text,account_id text,upload_id text)
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
    UPDATE chat.file_transfer_uploads u SET abandon_tried_at=now()
    FROM (SELECT c.staging_key FROM chat.file_transfer_uploads c
            JOIN chat.file_transfer_reservations r ON r.id=c.reservation_id
            WHERE c.upload_id IS NOT NULL AND r.expires_at<=now()
            ORDER BY c.abandon_tried_at NULLS FIRST,r.expires_at LIMIT greatest(p_limit,0)) picked
    WHERE u.staging_key=picked.staging_key
    RETURNING u.staging_key,u.account_id,u.upload_id;
$$;

ALTER FUNCTION chat.file_managed_upload_parts(text,text,text,integer[]) OWNER TO postgres;
ALTER FUNCTION chat.file_managed_upload_parts_clear(text,text,text) OWNER TO postgres;
ALTER FUNCTION chat.file_managed_upload_parts_claim(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION chat.file_managed_upload_parts(text,text,text,integer[]),chat.file_managed_upload_parts_clear(text,text,text),
    chat.file_managed_upload_parts_claim(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_parts(text,text,text,integer[]),chat.file_managed_upload_parts_clear(text,text,text),
    chat.file_managed_upload_parts_claim(integer) TO service_role;

NOTIFY pgrst,'reload schema';
