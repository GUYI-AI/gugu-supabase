-- DeepSeek Harness joins the agent types the client offers (agent type `dsh`).
-- Same enumeration as before plus one value; every existing row still satisfies it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE identity.agent_profiles DROP CONSTRAINT agent_profiles_agent_type_chk;
ALTER TABLE identity.agent_profiles ADD CONSTRAINT agent_profiles_agent_type_chk CHECK ((agent_type = ANY (ARRAY['claude-code'::text, 'codex'::text, 'gemini'::text, 'opencode'::text, 'hermes'::text, 'openclaw'::text, 'gugu-cloud'::text, 'grok'::text, 'devin'::text, 'qwen'::text, 'droid'::text, 'antigravity'::text, 'cursor'::text, 'copilot'::text, 'amp'::text, 'commandcode'::text, 'charm'::text, 'auggie'::text, 'goose'::text, 'kimi'::text, 'kilocode'::text, 'kiro'::text, 'rovo'::text, 'cline'::text, 'continue'::text, 'codebuff'::text, 'freebuff'::text, 'mistral'::text, 'jules'::text, 'junie'::text, 'oh-my-pi'::text, 'pi'::text, 'qoder'::text, 'letta'::text, 'autohand'::text, 'mimocode'::text, 'zero'::text, 'zcode'::text, 'codebuddy'::text, 'dsh'::text])));
