-- A refused transfer says the limit it hit, in bytes, so a client can pass the number on as it is.
-- 1. An upload over the configured size names `file_max_bytes`.
-- 2. A reader asking for a new transfer of a device file larger than what may pass through the server is refused when
--    it asks, with both numbers, instead of waiting for a holder whose acceptance is bound to be refused. The plaintext
--    size is compared: the holder's acceptance still checks the exact ciphertext length.
DO $limits$
DECLARE r record; definition text;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('chat.file_managed_upload_prepare(text,text,bigint,text)',
         $old$RAISE EXCEPTION 'File exceeds configured upload size' USING$old$,
         $new$RAISE EXCEPTION 'File exceeds configured upload size of % bytes',chat.file_transfer_parameter(cfg,'file_max_bytes') USING$new$),
        ('chat.file_temporary_request(jsonb,text,uuid)',
         $old$        IF t.id IS NULL THEN
$old$,
         $new$        IF t.id IS NULL THEN
            -- The holder's file-accept refuses above these three (temporary expiry checks the group's two, acceptance
            -- the global file size), so a new transfer that would be refused there is refused here. Reused copies are not.
            DECLARE most bigint:=least(chat.file_transfer_parameter(chat.file_transfer_settings('group',r->>'chat_id'),'temporary_group_bytes'),
                chat.file_transfer_parameter(chat.file_transfer_settings('group',r->>'chat_id'),'file_max_bytes'),
                chat.file_transfer_parameter(cfg,'file_max_bytes'));
            BEGIN
                IF (r->>'size_bytes')::bigint>most THEN
                    RAISE EXCEPTION 'File is % bytes; transfers through the server are at most % bytes',r->>'size_bytes',most
                        USING HINT='file_transfer_too_large';
                END IF;
            END;
$new$)
    ) AS patches(signature,before_text,after_text)
    LOOP
        SELECT pg_get_functiondef(r.signature::regprocedure) INTO definition;
        IF position(r.before_text IN definition)=0 THEN RAISE EXCEPTION 'Unexpected predecessor: %',r.signature; END IF;
        EXECUTE replace(definition,r.before_text,r.after_text);
    END LOOP;
END $limits$;

-- The installation DDL guard closes replaced functions too; restore only their existing API grants.
GRANT EXECUTE ON FUNCTION chat.file_managed_upload_prepare(text,text,bigint,text),chat.file_temporary_request(jsonb,text,uuid) TO authenticated;

NOTIFY pgrst,'reload schema';
