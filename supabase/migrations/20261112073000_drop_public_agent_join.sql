-- identity.get_public_agent_join is dropped.
--
-- It read an agent's public card for the client's public agent page (/join/agent/<id>), anonymously (SECURITY
-- DEFINER, granted to anon). The client removed that page and its caller: invite and share links now all go through
-- the official site's /j/ short link, and a shared agent is reached by its contact code. No database function calls
-- it either, so it is an anonymous entry point nobody uses.
--
-- Locks: dropping a function locks no table. Rollback: ops/rollback-drop-public-agent-join.sql.
SET LOCAL lock_timeout = '5s';

DROP FUNCTION identity.get_public_agent_join(text);
