-- Operational rollback of the Data API hook, added policies and rewritten
-- community producers. Keep the region closed; do not erase identities or data
-- to satisfy this precondition. Existing team principals require a separately
-- reviewed deny-team fallback, not this full restoration.
BEGIN;
SET LOCAL lock_timeout='500ms';
SET LOCAL statement_timeout='15s';
SET LOCAL search_path=pg_catalog;

DO $rollback$
DECLARE
    local_region text;
    r record;
    setting text;
    definition text;
    restored_body text;
    hooks integer:=0;
    policies integer:=0;
    producers integer:=0;
BEGIN
    IF current_user<>'postgres' THEN
        RAISE EXCEPTION 'Privileged operational rollback is required' USING ERRCODE='42501';
    END IF;
    -- Prevent a concurrent Auth creation, metadata update, session or principal
    -- binding from passing between the zero-principal check and the COMMIT.
    LOCK TABLE auth.users,auth.sessions,team_private.members IN SHARE MODE;
    SELECT region INTO STRICT local_region FROM team_private.deployment WHERE singleton FOR UPDATE;
    IF local_region IS NOT NULL THEN
        RAISE EXCEPTION 'Close the deployment region before restoring the personal path' USING ERRCODE='55000';
    END IF;
    IF EXISTS(SELECT 1 FROM auth.users
        WHERE COALESCE(raw_app_meta_data->>'gugu_account_kind','personal')<>'personal')
      OR EXISTS(SELECT 1 FROM team_private.members WHERE principal_user_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Full gate rollback requires zero team principals; preserve the deny-team fence'
            USING ERRCODE='55000';
    END IF;

    -- The forward migration refused an unrelated nonempty hook. Refuse one
    -- here too; only our own value may be reset to the prior empty semantics.
    FOR r IN SELECT s.setdatabase,s.setconfig,d.datname FROM pg_db_role_setting s
        LEFT JOIN pg_database d ON d.oid=s.setdatabase
        WHERE s.setrole='authenticator'::regrole
          AND s.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
    LOOP
        FOREACH setting IN ARRAY r.setconfig LOOP
            IF setting LIKE 'pgrst.db_pre_request=%'
              AND setting NOT IN ('pgrst.db_pre_request=','pgrst.db_pre_request=identity.team_request_gate') THEN
                RAISE EXCEPTION 'An independent Data API hook must not be overwritten' USING ERRCODE='55000';
            END IF;
        END LOOP;
    END LOOP;

    FOR r IN SELECT p.*,n.nspname,c.relname FROM pg_policy p
        JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE p.polname='team_live_session_gate'
          AND n.nspname IN ('identity','chat','moments','public','storage')
          AND (n.nspname<>'storage' OR c.relname IN ('objects','buckets'))
    LOOP
        IF r.polpermissive OR r.polcmd<>'*' OR r.polroles<>ARRAY['authenticated'::regrole::oid]
          OR COALESCE(regexp_replace(pg_get_expr(r.polqual,r.polrelid),'[[:space:]]+',' ','g'),'') NOT IN
            ('identity.team_session_is_active()','( SELECT identity.team_session_is_active() AS team_session_is_active)')
          OR COALESCE(regexp_replace(pg_get_expr(r.polwithcheck,r.polrelid),'[[:space:]]+',' ','g'),'') NOT IN
            ('identity.team_session_is_active()','( SELECT identity.team_session_is_active() AS team_session_is_active)') THEN
            RAISE EXCEPTION 'An unexpected gate policy must not be removed' USING ERRCODE='55000';
        END IF;
        EXECUTE format('DROP POLICY %I ON %I.%I',r.polname,r.nspname,r.relname);
        policies:=policies+1;
    END LOOP;
    FOR r IN SELECT p.* FROM pg_policy p
        WHERE p.polrelid='realtime.messages'::regclass AND p.polname IN ('team_realtime_fence','team_realtime_read')
    LOOP
        IF r.polroles<>ARRAY['authenticated'::regrole::oid]
          OR (r.polname='team_realtime_fence' AND (r.polpermissive OR r.polcmd<>'*'
            OR COALESCE(regexp_replace(pg_get_expr(r.polqual,r.polrelid),'[[:space:]]+',' ','g'),'')
              !~ '^\( SELECT identity\.team_realtime_fence\((messages\.)?topic, false\) AS team_realtime_fence\)$'
            OR COALESCE(regexp_replace(pg_get_expr(r.polwithcheck,r.polrelid),'[[:space:]]+',' ','g'),'')
              !~ '^\( SELECT identity\.team_realtime_fence\((messages\.)?topic, true\) AS team_realtime_fence\)$'))
          OR (r.polname='team_realtime_read' AND (NOT r.polpermissive OR r.polcmd<>'r'
            OR COALESCE(regexp_replace(pg_get_expr(r.polqual,r.polrelid),'[[:space:]]+',' ','g'),'')
              !~ '^\( SELECT identity\.team_realtime_access\((messages\.)?topic, false\) AS team_realtime_access\)$')) THEN
            RAISE EXCEPTION 'An unexpected Realtime policy must not be removed' USING ERRCODE='55000';
        END IF;
        EXECUTE format('DROP POLICY %I ON realtime.messages',r.polname);
        policies:=policies+1;
    END LOOP;

    -- Invert only the call substitution made by 071511, retaining every other
    -- byte of each body and its installed security/ACL attributes. The new
    -- gated client publisher is not an original community producer.
    FOR r IN SELECT p.*,p.oid::regprocedure signature FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('chat','identity','moments','public')
          AND p.prosrc LIKE '%identity.send_team_realtime(%'
          AND p.oid<>'public.team_publish_realtime(text,jsonb,text)'::regprocedure
    LOOP
        definition:=pg_get_functiondef(r.oid);
        restored_body:=replace(r.prosrc,'identity.send_team_realtime(','realtime.send(');
        EXECUTE replace(definition,r.prosrc,restored_body);
        IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=r.oid
          AND (p.proowner,p.proacl,p.prosecdef,p.proconfig,p.provolatile,p.proparallel,p.proleakproof)
              IS DISTINCT FROM
              (r.proowner,r.proacl,r.prosecdef,r.proconfig,r.provolatile,r.proparallel,r.proleakproof)) THEN
            RAISE EXCEPTION 'Producer security attributes changed during rollback' USING ERRCODE='55000';
        END IF;
        producers:=producers+1;
    END LOOP;

    FOR r IN SELECT s.setdatabase,s.setconfig,d.datname FROM pg_db_role_setting s
        LEFT JOIN pg_database d ON d.oid=s.setdatabase
        WHERE s.setrole='authenticator'::regrole
          AND s.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
          AND s.setconfig @> ARRAY['pgrst.db_pre_request=identity.team_request_gate']
    LOOP
        IF r.setdatabase=0 THEN ALTER ROLE authenticator RESET pgrst.db_pre_request;
        ELSE EXECUTE format('ALTER ROLE authenticator IN DATABASE %I RESET pgrst.db_pre_request',r.datname);
        END IF;
        hooks:=hooks+1;
    END LOOP;
    PERFORM set_config('gugu.team_rollback_hooks',hooks::text,true);
    PERFORM set_config('gugu.team_rollback_policies',policies::text,true);
    PERFORM set_config('gugu.team_rollback_producers',producers::text,true);
END $rollback$;
NOTIFY pgrst,'reload config';
SELECT current_setting('gugu.team_rollback_hooks')::int AS hook_settings_reset,
       current_setting('gugu.team_rollback_policies')::int AS policies_removed,
       current_setting('gugu.team_rollback_producers')::int AS producers_restored,
       0::int AS team_principals;
COMMIT;
