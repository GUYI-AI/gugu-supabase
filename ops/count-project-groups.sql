-- Read-only: how 20261109210000_project_is_group classifies groups. Run before the release: `derived` is the number of
-- groups it will mark. After it: `SELECT count(*) FROM chat.chats WHERE is_project` must equal that number. Read-only.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SELECT 'derived' AS source, count(*) FROM chat.chats c
 WHERE c.kind = 'group' AND EXISTS (SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id = c.id);
SELECT 'reserved_without_group' AS source, count(DISTINCT dp.chat_id) FROM identity.device_projects dp
 WHERE dp.chat_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = dp.chat_id);
COMMIT;
