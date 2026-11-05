-- Parse the envelope consistently for captioned private attachments and forwards.
CREATE OR REPLACE FUNCTION chat.attachment_envelope_name(p_content text, p_size bigint, p_content_type text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
DECLARE
    v_head CONSTANT TEXT := '[附件] ';
    v_tail TEXT := substr(chat.attachment_envelope('', p_size, p_content_type), char_length(v_head) + 1);
    v_name TEXT;
BEGIN
    p_content := chat.attachment_text_envelope(p_content);
    IF p_content IS NULL OR char_length(p_content) <= char_length(v_head) + char_length(v_tail)
       OR left(p_content, char_length(v_head)) <> v_head OR right(p_content, char_length(v_tail)) <> v_tail THEN
        RETURN NULL;
    END IF;
    v_name := substr(p_content, char_length(v_head) + 1, char_length(p_content) - char_length(v_head) - char_length(v_tail));
    IF v_name ~ '[\n\r]' THEN
        RETURN NULL;
    END IF;
    RETURN v_name;
END;
$$;
