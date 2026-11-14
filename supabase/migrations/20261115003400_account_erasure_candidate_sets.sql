-- Keep erasure behavior and lock order. Restrict expensive reference work to
-- materialized owned objects; use reference-only indexes without trusting live
-- membership as a complete history of recipients.
DO $upgrade$
DECLARE definition text; before_chunks text[] := ARRAY[
$old$    PERFORM 1 FROM identity.gugu_device_commands c
    WHERE c.user_id = p_user_id::uuid
       OR c.payload->>'agent_user_id' = ANY(delete_user_ids)
       OR (c.type IN ('agent.deliver', 'agent.wake')
           AND c.payload->>'sender_user_id' = ANY(delete_user_ids))
       OR c.payload->>'reply_to_sender_user_id' = ANY(delete_user_ids)
       OR (jsonb_typeof(c.payload->'to_user_ids') = 'array' AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(c.payload->'to_user_ids') AS recipient(value)
            WHERE recipient.value = ANY(delete_user_ids)
       ))
    ORDER BY c.id FOR UPDATE;
    DELETE FROM identity.gugu_device_commands c
    WHERE c.user_id = p_user_id::uuid
       OR c.payload->>'agent_user_id' = ANY(delete_user_ids)
       OR (c.type IN ('agent.deliver', 'agent.wake')
           AND c.payload->>'sender_user_id' = ANY(delete_user_ids));
    UPDATE identity.gugu_device_commands c
    SET payload = (c.payload - 'reply_to_sender_user_id')
                  || jsonb_build_object('reply_to_sender_name', '已注销用户')
    WHERE c.payload->>'reply_to_sender_user_id' = ANY(delete_user_ids);
    UPDATE identity.gugu_device_commands c
    SET payload = jsonb_set(c.payload, '{to_user_ids}', COALESCE((
            SELECT jsonb_agg(recipient.value ORDER BY recipient.ordinality)
            FROM jsonb_array_elements_text(c.payload->'to_user_ids')
                 WITH ORDINALITY AS recipient(value, ordinality)
            WHERE recipient.value = '*'
               OR NOT (recipient.value = ANY(delete_user_ids))
        ), '[]'::jsonb), true)
    WHERE jsonb_typeof(c.payload->'to_user_ids') = 'array'
      AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.payload->'to_user_ids') AS recipient(value)
          WHERE recipient.value = ANY(delete_user_ids)
      );

$old$,
$old$    UPDATE chat.messages m
    SET to_user_ids = ARRAY(
            SELECT recipient_id FROM unnest(m.to_user_ids) AS recipient_id
            WHERE NOT (recipient_id = ANY(delete_user_ids))
        )
    WHERE m.to_user_ids && delete_user_ids;
    UPDATE chat.messages m
    SET deleted_for_user_ids = m.deleted_for_user_ids - delete_user_ids
    WHERE m.deleted_for_user_ids ?| delete_user_ids;
$old$,
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
$new$    PERFORM 1 FROM identity.gugu_device_commands c
    WHERE (c.user_id = p_user_id::uuid
       OR c.payload->>'agent_user_id' = ANY(delete_user_ids)
       OR (c.type IN ('agent.deliver', 'agent.wake')
           AND c.payload->>'sender_user_id' = ANY(delete_user_ids))
       OR c.payload->>'reply_to_sender_user_id' = ANY(delete_user_ids)
       OR (jsonb_typeof(c.payload->'to_user_ids') = 'array' AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(c.payload->'to_user_ids') AS recipient(value)
            WHERE recipient.value = ANY(delete_user_ids)
       )))
      AND (c.user_id=p_user_id::uuid OR account_erasure_private.command_reference_user_ids(c.payload) && delete_user_ids)
    ORDER BY c.id FOR UPDATE;
    DELETE FROM identity.gugu_device_commands c
    WHERE (c.user_id = p_user_id::uuid
       OR c.payload->>'agent_user_id' = ANY(delete_user_ids)
       OR (c.type IN ('agent.deliver', 'agent.wake')
           AND c.payload->>'sender_user_id' = ANY(delete_user_ids)))
      AND (c.user_id=p_user_id::uuid OR account_erasure_private.command_reference_user_ids(c.payload) && delete_user_ids);
    UPDATE identity.gugu_device_commands c
    SET payload = (c.payload - 'reply_to_sender_user_id')
                  || jsonb_build_object('reply_to_sender_name', '已注销用户')
    WHERE (c.payload->>'reply_to_sender_user_id' = ANY(delete_user_ids))
      AND (c.user_id=p_user_id::uuid OR account_erasure_private.command_reference_user_ids(c.payload) && delete_user_ids);
    UPDATE identity.gugu_device_commands c
    SET payload = jsonb_set(c.payload, '{to_user_ids}', COALESCE((
            SELECT jsonb_agg(recipient.value ORDER BY recipient.ordinality)
            FROM jsonb_array_elements_text(c.payload->'to_user_ids')
                 WITH ORDINALITY AS recipient(value, ordinality)
            WHERE recipient.value = '*'
               OR NOT (recipient.value = ANY(delete_user_ids))
        ), '[]'::jsonb), true)
    WHERE (jsonb_typeof(c.payload->'to_user_ids') = 'array'
      AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.payload->'to_user_ids') AS recipient(value)
          WHERE recipient.value = ANY(delete_user_ids)
      ))
      AND (c.user_id=p_user_id::uuid OR account_erasure_private.command_reference_user_ids(c.payload) && delete_user_ids);

$new$,
$new$    UPDATE chat.messages m
    SET to_user_ids = ARRAY(
            SELECT recipient_id FROM unnest(m.to_user_ids) AS recipient_id
            WHERE NOT (recipient_id = ANY(delete_user_ids))
        )
    WHERE cardinality(m.to_user_ids)>0 AND m.to_user_ids && delete_user_ids;
    UPDATE chat.messages m
    SET deleted_for_user_ids = m.deleted_for_user_ids - delete_user_ids
    WHERE m.deleted_for_user_ids<>'[]'::jsonb AND m.deleted_for_user_ids<>'{}'::jsonb
      AND m.deleted_for_user_ids ?| delete_user_ids;
$new$,
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
            RAISE EXCEPTION 'Unexpected account erasure predecessor at section %',i;
        END IF;
        definition:=replace(definition,before_chunks[i],after_chunks[i]);
    END LOOP;
    EXECUTE definition;
END $upgrade$;
REVOKE ALL ON FUNCTION identity.erase_human_account(text) FROM PUBLIC,anon,authenticated,service_role;
