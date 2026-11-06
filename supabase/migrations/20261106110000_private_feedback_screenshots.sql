-- Feedback evidence has a separate private boundary from shared public media.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('feedback-screenshots', 'feedback-screenshots', false, 5242880, ARRAY['image/*']);

DO $constraints$
DECLARE previous_lock_timeout text := current_setting('lock_timeout');
BEGIN
    PERFORM set_config('lock_timeout', '1s', true);
    ALTER TABLE identity.feedback
        ADD COLUMN screenshot_paths text[] NOT NULL DEFAULT '{}',
        ADD CONSTRAINT feedback_screenshot_paths_count CHECK (cardinality(screenshot_paths) <= 4) NOT VALID;
    ALTER TABLE chat.file_blobs DROP CONSTRAINT file_blobs_bucket_id_check;
    ALTER TABLE chat.file_blobs ADD CONSTRAINT file_blobs_bucket_id_check
        CHECK (bucket_id IN ('oss','temporary','workspace','avatars','chat-media','attachments','feedback-screenshots')) NOT VALID;
    PERFORM set_config('lock_timeout', previous_lock_timeout, true);
END $constraints$;
GRANT INSERT (screenshot_paths) ON identity.feedback TO authenticated;

CREATE FUNCTION identity.validate_feedback_screenshots() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE object_path text;
BEGIN
    IF auth.role() IN ('anon', 'authenticated') THEN
        IF auth.uid() IS NULL OR NEW.user_id <> auth.uid() THEN
            RAISE EXCEPTION 'Feedback must belong to the submitting user' USING ERRCODE = '42501';
        END IF;
        IF cardinality(NEW.screenshot_urls) <> 0 THEN
            RAISE EXCEPTION 'Update the client to submit private feedback screenshots' USING ERRCODE = '22023';
        END IF;
    END IF;
    IF cardinality(NEW.screenshot_paths) > 0 AND cardinality(NEW.screenshot_urls) > 0 THEN
        RAISE EXCEPTION 'Feedback screenshots cannot mix references and URLs' USING ERRCODE = '22023';
    END IF;
    IF array_ndims(NEW.screenshot_paths) > 1 OR EXISTS (
        SELECT 1 FROM unnest(NEW.screenshot_paths) p GROUP BY p HAVING p IS NULL OR count(*) > 1
    ) THEN
        RAISE EXCEPTION 'Invalid feedback screenshot references' USING ERRCODE = '22023';
    END IF;
    FOREACH object_path IN ARRAY NEW.screenshot_paths LOOP
        IF object_path !~ ('^' || NEW.user_id::text || '/(feedback/)?[A-Za-z0-9][A-Za-z0-9._-]*$')
           OR length(object_path) > 1024 THEN
            RAISE EXCEPTION 'Invalid feedback screenshot reference' USING ERRCODE = '22023';
        END IF;
        PERFORM 1 FROM storage.objects o
         WHERE o.bucket_id = 'feedback-screenshots' AND o.name = object_path FOR KEY SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Feedback screenshot is unavailable' USING ERRCODE = '22023';
        END IF;
        -- Share the collector's lock and reject objects whose byte deletion was claimed.
        PERFORM chat.file_blob_take(chat.file_blob_for_object('feedback-screenshots', object_path));
    END LOOP;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION identity.validate_feedback_screenshots() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER validate_feedback_screenshots
BEFORE INSERT OR UPDATE OF user_id, screenshot_paths, screenshot_urls ON identity.feedback
FOR EACH ROW EXECUTE FUNCTION identity.validate_feedback_screenshots();

CREATE POLICY feedback_screenshot_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'feedback-screenshots'
    AND name ~ ('^' || (SELECT auth.uid())::text || '/[A-Za-z0-9][A-Za-z0-9._-]*$'));
CREATE POLICY feedback_screenshot_select ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'feedback-screenshots' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND identity.storage_actor_is_live());
CREATE POLICY feedback_screenshot_delete ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'feedback-screenshots' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND NOT EXISTS (SELECT 1 FROM identity.feedback f WHERE f.screenshot_paths @> ARRAY[objects.name]));

-- Older clients must fail explicitly before publishing more feedback evidence.
CREATE POLICY feedback_legacy_upload_closed ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (bucket_id <> 'chat-media' OR (storage.foldername(name))[2] IS DISTINCT FROM 'feedback');

-- Keep retained evidence and abandoned uploads in the existing collection system.
CREATE FUNCTION identity.feedback_screenshot_is_referenced(p_bucket text, p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM identity.feedback f WHERE
        (p_bucket = 'feedback-screenshots' AND f.screenshot_paths @> ARRAY[p_name])
        OR (p_bucket = 'chat-media' AND EXISTS (SELECT 1 FROM unnest(f.screenshot_urls) u
            WHERE right(u, length('/storage/v1/object/public/chat-media/' || p_name)) = '/storage/v1/object/public/chat-media/' || p_name)));
$$;
REVOKE ALL ON FUNCTION identity.feedback_screenshot_is_referenced(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.feedback_screenshot_is_referenced(text,text) TO service_role;

CREATE OR REPLACE FUNCTION identity.storage_object_is_referenced(p_bucket_id text, p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT identity.feedback_screenshot_is_referenced(p_bucket_id, p_name)
        OR EXISTS (SELECT 1 FROM chat.file_blobs b WHERE b.bucket_id = p_bucket_id AND b.object_name = p_name AND chat.file_blob_in_use(b.id))
        OR EXISTS (SELECT 1 FROM chat.messages m WHERE m.storage_bucket_id = p_bucket_id AND m.storage_object_name = p_name)
        OR EXISTS (SELECT 1 FROM chat.chats c WHERE c.avatar_storage_bucket_id = p_bucket_id AND c.avatar_storage_object_name = p_name)
        OR EXISTS (SELECT 1 FROM chat.group_outputs o WHERE o.storage_bucket_id = p_bucket_id AND o.storage_object_name = p_name);
$$;
GRANT EXECUTE ON FUNCTION identity.storage_object_is_referenced(text,text) TO service_role;

DO $upgrade$
DECLARE definition text;
BEGIN
    SELECT pg_get_functiondef('chat.file_blob_held_until(uuid)'::regprocedure) INTO definition;
    IF position('THEN ''infinity''' IN definition) = 0 THEN
        RAISE EXCEPTION 'Unexpected collector predecessor';
    END IF;
    definition := replace(definition, 'THEN ''infinity''',
        'OR EXISTS (SELECT 1 FROM chat.file_blobs b WHERE b.id=p_blob_id AND identity.feedback_screenshot_is_referenced(b.bucket_id,b.object_name)) THEN ''infinity''');
    EXECUTE definition;

    SELECT pg_get_functiondef('identity.erase_human_account(text)'::regprocedure) INTO definition;
    IF position('o.bucket_id = ''chat-media''' IN definition) = 0 THEN
        RAISE EXCEPTION 'Unexpected erasure predecessor';
    END IF;
    EXECUTE replace(definition, 'o.bucket_id = ''chat-media''', 'o.bucket_id IN (''chat-media'', ''feedback-screenshots'')');
END $upgrade$;

CREATE FUNCTION identity.feedback_screenshots_released() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE object_path text;
BEGIN
    FOREACH object_path IN ARRAY OLD.screenshot_paths LOOP
        IF TG_OP = 'DELETE' OR NOT (NEW.screenshot_paths @> ARRAY[object_path]) THEN
            PERFORM chat.file_blob_enqueue(chat.file_blob_for_object('feedback-screenshots', object_path));
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION identity.feedback_screenshots_released() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER feedback_screenshots_released AFTER DELETE OR UPDATE OF screenshot_paths ON identity.feedback
FOR EACH ROW EXECUTE FUNCTION identity.feedback_screenshots_released();
