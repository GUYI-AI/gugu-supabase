-- Pure application-object names and owners. No rows, ACLs or function bodies.
WITH namespaces AS MATERIALIZED (
 SELECT n.* FROM pg_catalog.pg_namespace n
 WHERE n.nspname<>ALL(ARRAY['pg_catalog','information_schema','pg_toast','auth','storage','realtime','_realtime',
   'extensions','graphql','graphql_public','vault','pgsodium','net','supabase_functions','_analytics',
   'pgbouncer','supabase_migrations','cron']::text[]) AND n.nspname!~'^pg_'
), objects AS (
 SELECT 'database/current'::text object,pg_catalog.pg_get_userbyid(datdba)::text owner
 FROM pg_catalog.pg_database WHERE datname=current_database()
 UNION ALL
 SELECT 'schema/'||quote_ident(n.nspname),pg_catalog.pg_get_userbyid(n.nspowner) FROM namespaces n
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d
   WHERE d.classid='pg_catalog.pg_namespace'::regclass AND d.objid=n.oid AND d.deptype='e')
 UNION ALL
 SELECT 'relation/'||format('%I.%I',n.nspname,c.relname),pg_catalog.pg_get_userbyid(c.relowner)
 FROM pg_catalog.pg_class c JOIN namespaces n ON n.oid=c.relnamespace
 WHERE c.relkind IN ('r','v','m','p','S') AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d
   WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
 UNION ALL
 SELECT 'routine:'||p.prokind::text||'/'||format('%I.%I(%s)',n.nspname,p.proname,COALESCE((
   SELECT string_agg(format('%I.%I',tn.nspname,t.typname),',' ORDER BY a.n)
   FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY a(type_oid,n)
   JOIN pg_catalog.pg_type t ON t.oid=a.type_oid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace),'')),
   pg_catalog.pg_get_userbyid(p.proowner)
 FROM pg_catalog.pg_proc p JOIN namespaces n ON n.oid=p.pronamespace
 WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d
   WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
)
SELECT COALESCE(jsonb_agg(jsonb_build_object('object',object,'owner',owner) ORDER BY object COLLATE "C"),'[]'::jsonb)
FROM (SELECT object,owner FROM objects ORDER BY object COLLATE "C" LIMIT 20001) bounded;
