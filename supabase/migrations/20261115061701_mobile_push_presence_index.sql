-- gugu:transaction off
CREATE INDEX CONCURRENTLY IF NOT EXISTS account_revisions_push_presence_idx ON chat.account_revisions (user_id, (resource_key ->> 'agent_user_id'), revision) WHERE event = 'presence_changed';
