BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
SELECT (SELECT count(*)::int FROM team_private.deployment) AS installation_rows,
       (SELECT count(*)::int FROM team_private.deployment WHERE region IS NOT NULL) AS open_regions,
       (SELECT count(*)::int FROM (
           SELECT id FROM auth.users WHERE COALESCE(raw_app_meta_data->>'gugu_account_kind','personal')<>'personal'
           UNION SELECT principal_user_id FROM team_private.members WHERE principal_user_id IS NOT NULL
       ) principals) AS team_principals,
       (SELECT count(*)::int FROM pg_db_role_setting s WHERE s.setrole='authenticator'::regrole
         AND s.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
         AND s.setconfig @> ARRAY['pgrst.db_pre_request=identity.team_request_gate']) AS hook_settings,
       (SELECT count(*)::int FROM pg_policy WHERE polname IN
         ('team_live_session_gate','team_realtime_fence','team_realtime_read')) AS gate_policies,
       (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname IN ('chat','identity','moments','public') AND p.prosrc LIKE '%identity.send_team_realtime(%'
           AND p.oid<>'public.team_publish_realtime(text,jsonb,text)'::regprocedure) AS wrapped_producers,
       (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND
         ((tgrelid='auth.sessions'::regclass AND tgname='team_file_session_closed')
           OR (tgrelid='auth.users'::regclass AND tgname='team_identity_erasure_guard'))) AS auth_triggers,
       (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgrelid='team_private.members'::regclass
         AND tgname IN ('team_member_principal_guard','team_member_gate_changed')) AS member_triggers;
ROLLBACK;
