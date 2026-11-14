-- Materialize ownership before expensive reference checks. No new indexes,
-- write-path hooks, or global function-cost changes are introduced.
DO $upgrade$
DECLARE definition text; before_chunks text[] := ARRAY[
$old$    UPDATE storage.objects o
    SET owner = NULL, owner_id = NULL
    WHERE (
            o.owner::text = ANY(delete_user_ids)
            OR o.owner_id = ANY(delete_user_ids)
            OR (o.bucket_id = 'avatars' AND split_part(o.name, '.', 1) = ANY(delete_user_ids))
            OR (o.bucket_id IN ('chat-media', 'feedback-screenshots') AND (storage.foldername(o.name))[1] = ANY(delete_user_ids))
            OR (o.bucket_id = 'workspace' AND (storage.foldername(o.name))[2] = ANY(delete_user_ids))
        )
      AND identity.storage_object_is_referenced(o.bucket_id, o.name);

$old$,
$old$    PERFORM chat.file_blob_enqueue(chat.file_blob_for_object(o.bucket_id, o.name))
    FROM storage.objects o
    WHERE (
            o.owner::text = ANY(delete_user_ids)
            OR o.owner_id = ANY(delete_user_ids)
            OR (o.bucket_id = 'avatars' AND split_part(o.name, '.', 1) = ANY(delete_user_ids))
            OR (o.bucket_id IN ('chat-media', 'feedback-screenshots') AND (storage.foldername(o.name))[1] = ANY(delete_user_ids))
            OR (o.bucket_id = 'workspace' AND (storage.foldername(o.name))[2] = ANY(delete_user_ids))
        )
      AND NOT identity.storage_object_is_referenced(o.bucket_id, o.name);

$old$
]; after_chunks text[] := ARRAY[
$new$    WITH owned AS MATERIALIZED (
        SELECT o.id,o.bucket_id,o.name FROM storage.objects o
        WHERE (o.owner::text = ANY(delete_user_ids)
            OR o.owner_id = ANY(delete_user_ids)
            OR (o.bucket_id = 'avatars' AND split_part(o.name, '.', 1) = ANY(delete_user_ids))
            OR (o.bucket_id IN ('chat-media', 'feedback-screenshots') AND (storage.foldername(o.name))[1] = ANY(delete_user_ids))
            OR (o.bucket_id = 'workspace' AND (storage.foldername(o.name))[2] = ANY(delete_user_ids)))
    )
    UPDATE storage.objects o SET owner=NULL,owner_id=NULL
    FROM owned
    WHERE o.id=owned.id AND identity.storage_object_is_referenced(owned.bucket_id,owned.name);

$new$,
$new$    PERFORM chat.file_blob_enqueue(chat.file_blob_for_object(owned.bucket_id,owned.name))
    FROM (
    WITH owned AS MATERIALIZED (
        SELECT o.id,o.bucket_id,o.name FROM storage.objects o
        WHERE (o.owner::text = ANY(delete_user_ids)
            OR o.owner_id = ANY(delete_user_ids)
            OR (o.bucket_id = 'avatars' AND split_part(o.name, '.', 1) = ANY(delete_user_ids))
            OR (o.bucket_id IN ('chat-media', 'feedback-screenshots') AND (storage.foldername(o.name))[1] = ANY(delete_user_ids))
            OR (o.bucket_id = 'workspace' AND (storage.foldername(o.name))[2] = ANY(delete_user_ids)))
    )
        SELECT bucket_id,name FROM owned
    ) owned
    WHERE NOT identity.storage_object_is_referenced(owned.bucket_id,owned.name);

$new$
]; i integer;
BEGIN
    SELECT pg_get_functiondef('identity.erase_human_account(text)'::regprocedure) INTO definition;
    FOR i IN 1..array_length(before_chunks,1) LOOP
        IF length(definition)-length(replace(definition,before_chunks[i],''))<>length(before_chunks[i]) THEN
            RAISE EXCEPTION 'Unexpected account erasure storage predecessor at section %',i;
        END IF;
        definition:=replace(definition,before_chunks[i],after_chunks[i]);
    END LOOP;
    EXECUTE definition;
END $upgrade$;
REVOKE ALL ON FUNCTION identity.erase_human_account(text) FROM PUBLIC,anon,authenticated,service_role;
