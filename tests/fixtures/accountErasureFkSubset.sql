-- Community-only subset of the local verification fixture; unrelated controls are omitted.
\pset pager off
\echo PG16 isolated subset: real target table definitions/FKs; no foundation, platform hooks, RLS or erase function.
SELECT version(), inet_server_addr(), inet_server_port();
SHOW enable_seqscan;
SHOW random_page_cost;
SHOW plan_cache_mode;
CREATE SCHEMA identity;
CREATE SCHEMA chat;
CREATE SCHEMA auth;
CREATE SEQUENCE identity.mycel_id_seq;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE TABLE chat.messages(id text PRIMARY KEY);
CREATE TABLE chat.workspace_items(id uuid PRIMARY KEY);
CREATE TABLE chat.file_blobs(id uuid PRIMARY KEY);
CREATE FUNCTION identity.is_valid_avatar_url(p_avatar text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $_$
    SELECT p_avatar IS NOT NULL
       AND btrim(p_avatar) <> ''
       AND (
            btrim(p_avatar) ~ '^(\./|/)assets/app/(gugu-icon-512|gugu-mark-transparent)\.png$'
         OR btrim(p_avatar) ~ '^https?://'
       );
$_$;
CREATE TABLE identity.users (
    id text NOT NULL,
    type text DEFAULT 'human'::text NOT NULL,
    display_name text NOT NULL,
    avatar text,
    bio text,
    email text,
    mycel_id integer DEFAULT nextval('identity.mycel_id_seq'::regclass),
    owner_user_id text,
    agent_config_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    device_id text,
    local_path text,
    prompt_path text,
    desired_status text DEFAULT 'online'::text NOT NULL,
    agent_public boolean DEFAULT false NOT NULL,
    gugu_number integer GENERATED ALWAYS AS (mycel_id) STORED,
    category text,
    inherit_memory boolean DEFAULT true NOT NULL,
    special_focus text,
    onboarded_at timestamp with time zone,
    is_official boolean DEFAULT false NOT NULL,
    CONSTRAINT users_agent_device_required CHECK (((type <> 'agent'::text) OR (device_id IS NOT NULL))),
    CONSTRAINT users_agent_public_only_agents CHECK (((type = 'agent'::text) OR (agent_public = false))),
    CONSTRAINT users_avatar_required_chk CHECK (((avatar IS NULL) OR identity.is_valid_avatar_url(avatar))),
    CONSTRAINT users_category_chk CHECK (((category IS NULL) OR (category = ANY (ARRAY['ai-coding'::text, 'productivity'::text, 'writing'::text, 'finance'::text, 'lifestyle'::text, 'data'::text, 'integrations'::text, 'security'::text, 'utility'::text])))),
    CONSTRAINT users_desired_status_chk CHECK ((desired_status = ANY (ARRAY['online'::text, 'offline'::text]))),
    CONSTRAINT users_local_path_chk CHECK (((local_path IS NULL) OR ((length(local_path) <= 4096) AND (local_path !~ '\x00'::text) AND ((local_path = ''::text) OR (local_path ~ '^/'::text) OR (local_path ~ '^[A-Za-z]:[\\/]'::text) OR (local_path ~ '^\\\\[^\\/]+[\\/][^\\/]+'::text))))),
    CONSTRAINT users_prompt_path_chk CHECK (((prompt_path IS NULL) OR ((length(prompt_path) <= 4096) AND (prompt_path !~ '\x00'::text) AND ((prompt_path = ''::text) OR (prompt_path ~ '^/'::text) OR (prompt_path ~ '^[A-Za-z]:[\\/]'::text) OR (prompt_path ~ '^\\\\[^\\/]+[\\/][^\\/]+'::text))))),
    CONSTRAINT users_type_chk CHECK ((type = ANY (ARRAY['human'::text, 'agent'::text])))
);
ALTER TABLE identity.users ADD PRIMARY KEY(id), ADD COLUMN removed_at timestamptz;
CREATE TABLE chat.message_agent_wakes (
    message_id text NOT NULL,
    agent_user_id text NOT NULL
);
ALTER TABLE chat.message_agent_wakes ADD PRIMARY KEY(message_id,agent_user_id);
CREATE TABLE chat.workspace_item_versions (
    item_id uuid NOT NULL,
    n integer NOT NULL,
    inline_text text,
    content_type text NOT NULL,
    size_bytes bigint,
    made_by text,
    made_at timestamp with time zone DEFAULT now() NOT NULL,
    blob_id uuid,
    CONSTRAINT workspace_item_versions_one_body CHECK (((inline_text IS NULL) = (blob_id IS NOT NULL)))
);
ALTER TABLE chat.workspace_item_versions ADD PRIMARY KEY(item_id,n);
CREATE TABLE identity.assistant_panel_changes (
    operation_id uuid PRIMARY KEY,
    revision bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    assistant_user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    owner_user_id text NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    domain text NOT NULL,
    resource_key text NOT NULL,
    device_id text,
    source text NOT NULL CHECK (source IN ('panel','runtime')),
    operation text NOT NULL CHECK (operation IN ('save','remove','enable','disable','prepared','error','notice')),
    expected_item_revision bigint NOT NULL,
    request_hash text NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 263168),
    status text NOT NULL CHECK (status IN ('pending','applied','failed','superseded')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    applied_at timestamptz,
    applied_device_id text,
    cleanup_attempted_at timestamptz,
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
ALTER TABLE ONLY chat.message_agent_wakes
    ADD CONSTRAINT message_agent_wakes_agent_user_id_fkey FOREIGN KEY (agent_user_id) REFERENCES identity.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY chat.message_agent_wakes
    ADD CONSTRAINT message_agent_wakes_message_id_fkey FOREIGN KEY (message_id) REFERENCES chat.messages(id) ON DELETE CASCADE;
ALTER TABLE ONLY chat.workspace_item_versions
    ADD CONSTRAINT workspace_item_versions_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES chat.file_blobs(id);
ALTER TABLE ONLY chat.workspace_item_versions
    ADD CONSTRAINT workspace_item_versions_item_id_fkey FOREIGN KEY (item_id) REFERENCES chat.workspace_items(id) ON DELETE CASCADE;
ALTER TABLE ONLY chat.workspace_item_versions
    ADD CONSTRAINT workspace_item_versions_made_by_fkey FOREIGN KEY (made_by) REFERENCES identity.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY identity.users
    ADD CONSTRAINT users_owner_user_id_fk FOREIGN KEY (owner_user_id) REFERENCES identity.users(id) ON DELETE CASCADE;
CREATE INDEX workspace_item_versions_blob_idx ON chat.workspace_item_versions USING btree (blob_id) WHERE (blob_id IS NOT NULL);
CREATE INDEX idx_users_agent_config ON identity.users USING btree (agent_config_id) WHERE (agent_config_id IS NOT NULL);
CREATE INDEX idx_users_avatar ON identity.users USING btree (avatar) WHERE (avatar IS NOT NULL);
CREATE INDEX idx_users_device_id ON identity.users USING btree (device_id) WHERE (device_id IS NOT NULL);
CREATE INDEX idx_users_owner_agents ON identity.users USING btree (owner_user_id) WHERE ((type = 'agent'::text) AND (owner_user_id IS NOT NULL));
CREATE INDEX idx_users_public_agents ON identity.users USING btree (owner_user_id, display_name) WHERE ((type = 'agent'::text) AND (agent_public = true));
CREATE INDEX idx_users_type ON identity.users USING btree (type, created_at DESC);
CREATE INDEX idx_users_type_mycel_id ON identity.users USING btree (type, mycel_id);
CREATE UNIQUE INDEX users_email_normalized_key ON identity.users USING btree (lower(email)) WHERE (email IS NOT NULL);
CREATE INDEX assistant_panel_pending ON identity.assistant_panel_changes(assistant_user_id, revision)
    WHERE source = 'panel' AND status IN ('pending','failed');
CREATE INDEX assistant_panel_resource_history ON identity.assistant_panel_changes(assistant_user_id,domain,resource_key,revision);
CREATE INDEX assistant_panel_body_history ON identity.assistant_panel_changes((payload->>'bodyItemId'));

INSERT INTO auth.users SELECT md5(g::text)::uuid FROM generate_series(1,25000) g;
INSERT INTO identity.users(id,type,display_name)
SELECT md5(g::text)::uuid::text,'human','Fixture human '||g FROM generate_series(1,25000) g;
INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,removed_at)
SELECT md5('agent-'||g)::uuid::text,'agent','Fixture agent '||g,md5((((g-1)%1000)+1)::text)::uuid::text,
 'fixture-device',CASE WHEN g%2=0 THEN now() END FROM generate_series(1,2886) g;
INSERT INTO chat.messages SELECT 'message-'||g FROM generate_series(1,195717) g;
INSERT INTO chat.message_agent_wakes SELECT 'message-'||g,md5('agent-'||(((g-1)%2886)+1))::uuid::text FROM generate_series(1,195717) g;
INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,domain,resource_key,source,operation,expected_item_revision,request_hash,payload,status)
SELECT md5('op-'||g)::uuid,md5('agent-'||(((g-1)%2886)+1))::uuid::text,
 md5(((((g-1)%2886)%1000)+1)::text)::uuid::text,'personality','fixture-'||g,
 CASE WHEN g%2=0 THEN 'runtime' ELSE 'panel' END,'save',0,'fixture','{}',CASE WHEN g%2=0 THEN 'applied' ELSE 'pending' END
FROM generate_series(1,28375) g;
INSERT INTO chat.workspace_items SELECT md5('item-'||g)::uuid FROM generate_series(1,20914) g;
INSERT INTO chat.workspace_item_versions(item_id,n,inline_text,content_type,size_bytes,made_by)
SELECT md5('item-'||g)::uuid,1,'Retained history','text/markdown',16,
 CASE WHEN g%4=0 THEN NULL ELSE md5((((g-1)%1000)+1)::text)::uuid::text END FROM generate_series(1,20914) g;
ANALYZE identity.users;
ANALYZE chat.message_agent_wakes;
ANALYZE identity.assistant_panel_changes;
ANALYZE chat.workspace_item_versions;
SELECT 'identity.users' AS relation,count(*) FROM identity.users
UNION ALL SELECT 'chat.message_agent_wakes',count(*) FROM chat.message_agent_wakes
UNION ALL SELECT 'identity.assistant_panel_changes',count(*) FROM identity.assistant_panel_changes
UNION ALL SELECT 'chat.workspace_item_versions',count(*) FROM chat.workspace_item_versions;
\echo BEFORE (plain EXPLAIN, no ANALYZE or planner overrides)

EXPLAIN SELECT * FROM ONLY chat.message_agent_wakes WHERE agent_user_id=md5('agent-1')::uuid::text;
EXPLAIN SELECT * FROM ONLY identity.assistant_panel_changes WHERE owner_user_id=md5('1')::uuid::text;
EXPLAIN SELECT * FROM ONLY chat.workspace_item_versions WHERE made_by=md5('1')::uuid::text;
EXPLAIN SELECT * FROM ONLY identity.users WHERE owner_user_id=md5('1')::uuid::text;
-- gugu:transaction off
-- The primary key starts with message_id; account erasure cascades by agent_user_id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_message_agent_wakes_agent_user_id ON chat.message_agent_wakes USING btree (agent_user_id);

-- gugu:transaction off
-- Assistant-leading history indexes do not cover an owner-only foreign-key lookup.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assistant_panel_changes_owner_user_id ON identity.assistant_panel_changes USING btree (owner_user_id);

-- gugu:transaction off
-- Equality implies made_by IS NOT NULL, including the foreign key's SET NULL lookup.
CREATE INDEX CONCURRENTLY IF NOT EXISTS workspace_item_versions_made_by_idx ON chat.workspace_item_versions USING btree (made_by) WHERE made_by IS NOT NULL;

-- gugu:transaction off
-- The foreign-key cascade has no type predicate. Keep the agent-specific indexes
-- for their narrower queries; exclude only NULL owners from this lookup index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_owner_user_id ON identity.users USING btree (owner_user_id) WHERE owner_user_id IS NOT NULL;


\echo AFTER (same data and statistics)

EXPLAIN SELECT * FROM ONLY chat.message_agent_wakes WHERE agent_user_id=md5('agent-1')::uuid::text;
EXPLAIN SELECT * FROM ONLY identity.assistant_panel_changes WHERE owner_user_id=md5('1')::uuid::text;
EXPLAIN SELECT * FROM ONLY chat.workspace_item_versions WHERE made_by=md5('1')::uuid::text;
EXPLAIN SELECT * FROM ONLY identity.users WHERE owner_user_id=md5('1')::uuid::text;

\echo INDEX DEFINITIONS
SELECT pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready,pg_get_expr(i.indpred,i.indrelid) AS predicate
FROM pg_index i WHERE indexrelid IN('chat.idx_message_agent_wakes_agent_user_id'::regclass,
'identity.idx_assistant_panel_changes_owner_user_id'::regclass,'chat.workspace_item_versions_made_by_idx'::regclass,'identity.idx_users_owner_user_id'::regclass);
\echo DIRECT FK ACTION PLANS (not executed)
EXPLAIN DELETE FROM ONLY chat.message_agent_wakes WHERE md5('agent-1')::uuid::text=agent_user_id;
EXPLAIN DELETE FROM ONLY identity.assistant_panel_changes WHERE md5('1')::uuid::text=owner_user_id;
EXPLAIN UPDATE ONLY chat.workspace_item_versions SET made_by=NULL WHERE md5('1')::uuid::text=made_by;
EXPLAIN DELETE FROM ONLY identity.users WHERE md5('1')::uuid::text=owner_user_id;
\echo PARAMETERIZED EQUALITY (default plan_cache_mode, no forced plans)
PREPARE owner_fk(text) AS SELECT * FROM ONLY identity.users WHERE $1=owner_user_id;
PREPARE author_fk(text) AS SELECT * FROM ONLY chat.workspace_item_versions WHERE $1=made_by;
EXPLAIN EXECUTE owner_fk(md5('1')::uuid::text);
EXPLAIN EXECUTE owner_fk(md5('2')::uuid::text);
EXPLAIN EXECUTE owner_fk(md5('3')::uuid::text);
EXPLAIN EXECUTE owner_fk(md5('4')::uuid::text);
EXPLAIN EXECUTE owner_fk(md5('5')::uuid::text);
EXPLAIN EXECUTE owner_fk(md5('6')::uuid::text);
EXPLAIN EXECUTE author_fk(md5('1')::uuid::text);
EXPLAIN EXECUTE author_fk(md5('2')::uuid::text);
EXPLAIN EXECUTE author_fk(md5('3')::uuid::text);
EXPLAIN EXECUTE author_fk(md5('4')::uuid::text);
EXPLAIN EXECUTE author_fk(md5('5')::uuid::text);
EXPLAIN EXECUTE author_fk(md5('6')::uuid::text);

SELECT name,generic_plans,custom_plans FROM pg_prepared_statements ORDER BY name;
\echo LOCAL FK SEMANTICS (not the full erase function)
BEGIN;
INSERT INTO auth.users VALUES('20000000-0000-4000-8000-000000000001'),('20000000-0000-4000-8000-000000000002');
INSERT INTO identity.users(id,type,display_name) VALUES('20000000-0000-4000-8000-000000000001','human','Owner'),('20000000-0000-4000-8000-000000000002','human','Peer');
INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,removed_at) VALUES
 ('agent200-a','agent','A','20000000-0000-4000-8000-000000000001','fixture-device',NULL),
 ('agent200-b','agent','B','20000000-0000-4000-8000-000000000001','fixture-device',now()),
 ('agent200-peer','agent','Peer','20000000-0000-4000-8000-000000000002','fixture-device',NULL);
INSERT INTO chat.messages VALUES('message200');
INSERT INTO chat.message_agent_wakes VALUES('message200','agent200-a'),('message200','agent200-b'),('message200','agent200-peer');
INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,domain,resource_key,source,operation,expected_item_revision,request_hash,payload,status) VALUES
 ('20000000-0000-4000-8000-000000000011','agent200-a','20000000-0000-4000-8000-000000000001','personality','fixture','panel','save',0,'fixture','{}','pending'),
 ('20000000-0000-4000-8000-000000000012','agent200-b','20000000-0000-4000-8000-000000000001','personality','fixture','runtime','save',0,'fixture','{}','applied'),
 ('20000000-0000-4000-8000-000000000013','agent200-peer','20000000-0000-4000-8000-000000000002','personality','fixture','runtime','save',0,'fixture','{}','applied');
INSERT INTO chat.workspace_items VALUES('20000000-0000-4000-8000-000000000020');
INSERT INTO chat.workspace_item_versions(item_id,n,inline_text,content_type,size_bytes,made_by) VALUES
 ('20000000-0000-4000-8000-000000000020',1,'History','text/markdown',7,'20000000-0000-4000-8000-000000000001'),
 ('20000000-0000-4000-8000-000000000020',2,'History','text/markdown',7,'agent200-a'),
 ('20000000-0000-4000-8000-000000000020',3,'History','text/markdown',7,'agent200-b'),
 ('20000000-0000-4000-8000-000000000020',4,'History','text/markdown',7,'20000000-0000-4000-8000-000000000002'),
 ('20000000-0000-4000-8000-000000000020',5,'History','text/markdown',7,NULL);
DELETE FROM identity.users WHERE id='20000000-0000-4000-8000-000000000001';
DELETE FROM auth.users WHERE id='20000000-0000-4000-8000-000000000001';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM identity.users WHERE id IN('20000000-0000-4000-8000-000000000001','agent200-a','agent200-b')) THEN RAISE EXCEPTION 'Owned identity cascade failed'; END IF;
 IF (SELECT count(*) FROM chat.message_agent_wakes WHERE message_id='message200')<>1 OR NOT EXISTS(SELECT 1 FROM chat.message_agent_wakes WHERE message_id='message200' AND agent_user_id='agent200-peer') THEN RAISE EXCEPTION 'Wake cascade failed'; END IF;
 IF EXISTS(SELECT 1 FROM identity.assistant_panel_changes WHERE owner_user_id='20000000-0000-4000-8000-000000000001') OR NOT EXISTS(SELECT 1 FROM identity.assistant_panel_changes WHERE operation_id='20000000-0000-4000-8000-000000000013') THEN RAISE EXCEPTION 'Panel cascade failed'; END IF;
 IF (SELECT count(*) FROM chat.workspace_item_versions WHERE item_id='20000000-0000-4000-8000-000000000020')<>5 OR (SELECT count(*) FROM chat.workspace_item_versions WHERE item_id='20000000-0000-4000-8000-000000000020' AND made_by IS NULL)<>4 OR NOT EXISTS(SELECT 1 FROM chat.workspace_item_versions WHERE item_id='20000000-0000-4000-8000-000000000020' AND made_by='20000000-0000-4000-8000-000000000002') OR EXISTS(SELECT 1 FROM chat.workspace_item_versions WHERE item_id='20000000-0000-4000-8000-000000000020' AND inline_text<>'History') THEN RAISE EXCEPTION 'Version SET NULL/preservation failed'; END IF;
 RAISE NOTICE 'PASS: two owned agents (one removed), wakes/panel CASCADE, five retained versions with four NULL authors, unrelated peer rows preserved';
END $$;
ROLLBACK;
