-- Business conflicts answer 409 instead of being retried forever.
--
-- Four stale-revision refusals raised SQLSTATE 40001 (serialization_failure). PostgREST treats 40001 as a
-- transient conflict and retries the whole request; a stale revision never resolves by retrying, so the
-- request looped server-side, logging dozens of errors a second and saturating the database CPU.
-- PT409 is PostgREST's pass-through code: it answers HTTP 409 with code PT409 once and does not retry.
--
-- The functions are rewritten from their current installed definitions, changing only the ERRCODE of those
-- refusals, so later edits to their bodies are kept and an installation that already carries the same
-- change (a hotfix) ends in the same state. Re-creating a function fires gg_revoke_public_execute_on_functions,
-- which revokes API execution, so each function's EXECUTE grants are captured first and restored after.
DO $pt409$
DECLARE r record; def text; permission record;
BEGIN
  FOR r IN SELECT p.oid,p.oid::regprocedure AS signature,COALESCE(p.proacl,acldefault('f',p.proowner)) AS acl
    FROM pg_proc p WHERE p.oid IN (
      'identity.assistant_panel_commit(text,uuid,text,text,bigint,text,jsonb,uuid,text,text,text)'::regprocedure,
      'identity.assistant_panel_admit(text,text,bigint)'::regprocedure,
      'identity.set_agent_session_archival(text,text,uuid,bigint,timestamp with time zone,jsonb)'::regprocedure)
  LOOP
    def := pg_get_functiondef(r.oid);
    IF position('ERRCODE = ''40001''' IN def) > 0 THEN
      EXECUTE replace(def, 'ERRCODE = ''40001''', 'ERRCODE = ''PT409''');
      FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable
        FROM aclexplode(r.acl) WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',r.signature,
          CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
          CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      END LOOP;
    END IF;
    IF position('40001' IN pg_get_functiondef(r.oid)) > 0 OR position('PT409' IN pg_get_functiondef(r.oid)) = 0 THEN
      RAISE EXCEPTION '% still raises 40001 or never raises PT409', r.signature;
    END IF;
    IF NOT has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% lost its authenticated EXECUTE grant', r.signature;
    END IF;
  END LOOP;
END
$pt409$;
