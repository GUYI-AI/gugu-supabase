-- The release installer owns the transaction, including its migration ledger.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION chat.message_preview(p_content text, p_content_type text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
    SELECT CASE
        WHEN p_content_type = 'widget' THEN
            CASE WHEN pg_input_is_valid(p_content, 'jsonb') THEN
                CASE WHEN jsonb_typeof(p_content::jsonb -> 'text') = 'string'
                          AND length(p_content::jsonb ->> 'text') > 0
                    THEN left(p_content::jsonb ->> 'text', 100)
                    ELSE '[Widget]'
                END
            ELSE '[Widget]' END
        WHEN p_content_type = 'attachment' AND split_part(p_content, E'\n', 1) LIKE '[附件] %'
            THEN COALESCE(
                NULLIF(btrim(regexp_replace(substr(split_part(p_content, E'\n', 1), 6), ' \([^()]+\)$', '')), ''),
                left(p_content, 100))
        ELSE left(coalesce(p_content, ''), 100)
    END;
$_$;

-- The function-DDL guard also closes authenticated access on replacement.
REVOKE ALL ON FUNCTION chat.message_preview(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.message_preview(text, text) TO authenticated, service_role;

COMMENT ON FUNCTION chat.message_preview(text, text) IS
    'Shared list and notification preview: widget text, attachment filename, otherwise the first 100 characters.';

-- Only the numeric v=2 marker opts into the new contract. Legacy messages must
-- remain deletable, retractable and editable, even though CHECK runs on UPDATE.
-- Match JavaScript's numeric version comparison, including float rounding.
-- CASE guards every cast; IS TRUE closes missing fields within the v2 shape.
ALTER TABLE chat.messages ADD CONSTRAINT messages_widget_shape CHECK (
    CASE
        WHEN content_type <> 'widget' THEN true
        WHEN pg_input_is_valid(content, 'jsonb') THEN CASE
          WHEN CASE
            WHEN jsonb_typeof(content::jsonb -> 'v') = 'number'
              AND pg_input_is_valid(content::jsonb ->> 'v', 'double precision')
              THEN (content::jsonb ->> 'v')::double precision = 2
            ELSE false END THEN (
            octet_length(content) <= 6144
            AND jsonb_typeof(content::jsonb) = 'object'
            AND jsonb_typeof(content::jsonb -> 'text') = 'string'
            AND length(content::jsonb ->> 'text') BETWEEN 1 AND 200
            AND jsonb_typeof(content::jsonb -> 'app') = 'string'
            AND length(content::jsonb ->> 'app') > 0
            AND jsonb_typeof(content::jsonb -> 'view') = 'string'
            AND length(content::jsonb ->> 'view') > 0
            AND NOT (content::jsonb ?| ARRAY['id', 'title'])
            AND (NOT (content::jsonb ? 'data') OR (
                jsonb_typeof(content::jsonb -> 'data') = 'object'
                AND octet_length((content::json -> 'data')::text) <= 4096
            ))
        ) IS TRUE
          ELSE true END
        WHEN pg_input_is_valid(content, 'json') THEN false
        ELSE true
    END
) NOT VALID;
