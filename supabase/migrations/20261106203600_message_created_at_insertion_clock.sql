-- #215: preserve past/imported timestamps while bounding new future values.
-- The default must use the insertion clock too: a BEFORE trigger sees defaults
-- after evaluation, so a transaction-start default would survive LEAST unchanged.
-- Apply through the transactional release installer as postgres.
ALTER TABLE chat.messages ALTER COLUMN created_at SET DEFAULT clock_timestamp();

CREATE FUNCTION chat.clamp_message_created_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
AS $$
BEGIN
    -- Keep the existing NOT NULL rejection for an explicitly supplied NULL.
    IF NEW.created_at IS NOT NULL THEN
        NEW.created_at := least(NEW.created_at, clock_timestamp());
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION chat.clamp_message_created_at() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER messages_clamp_created_at BEFORE INSERT ON chat.messages
    FOR EACH ROW EXECUTE FUNCTION chat.clamp_message_created_at();
