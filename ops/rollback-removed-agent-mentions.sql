-- Roll back 20261109150000_removed_agent_mentions_refused: a message mentioning a removed
-- agent is rejected again by messages_insert_member. Messages, seats, identities and the
-- installer ledger are not touched. The identity_removed refusal rows are deleted so the
-- reason constraint can return to agent_archived only; they only ever marked removed
-- agents, which are never woken or delivered to either way.
-- Run it before any older operational rollback that drops chat_private.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE chat.messages IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER messages_c_record_removed_agent_refusals ON chat.messages;
DROP FUNCTION chat.record_message_removed_agent_refusals();

DO $policy$
DECLARE
    previous text;
    prior_sql constant text := '(NOT chat.is_addressable_in(messages.chat_id, target.target_user_id))'
      || ' AND (NOT chat_private.is_removed_agent_recipient(messages.chat_id, target.target_user_id))';
    replacement_sql constant text := '(NOT chat.is_addressable_in(messages.chat_id, target.target_user_id))';
BEGIN
    SELECT pg_get_expr(p.polwithcheck, p.polrelid) INTO previous
      FROM pg_policy p WHERE p.polrelid = 'chat.messages'::regclass AND p.polname = 'messages_insert_member';
    IF array_length(string_to_array(previous, prior_sql), 1) <> 2 THEN
        RAISE EXCEPTION 'Unexpected messages_insert_member release body';
    END IF;
    EXECUTE format('ALTER POLICY messages_insert_member ON chat.messages WITH CHECK (%s)', replace(previous, prior_sql, replacement_sql));
END $policy$;

DROP FUNCTION chat_private.is_removed_agent_recipient(text, text);
DROP FUNCTION chat_private.is_removed_agent_seat(text, text);

DELETE FROM chat.message_agent_delivery_blocks WHERE reason = 'identity_removed';
ALTER TABLE chat.message_agent_delivery_blocks
  DROP CONSTRAINT message_agent_delivery_blocks_reason_check,
  ADD CONSTRAINT message_agent_delivery_blocks_reason_check CHECK (reason = 'agent_archived');

NOTIFY pgrst, 'reload schema';
COMMIT;
