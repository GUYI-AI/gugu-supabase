-- Current database state also classifies a principal: JWT metadata cannot turn
-- a bound or orphaned team identity into a personal account.
CREATE FUNCTION team_private.principal_is_team(p_actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM team_private.members WHERE principal_user_id=p_actor)
    OR EXISTS(SELECT 1 FROM auth.users WHERE id=p_actor
      AND COALESCE(raw_app_meta_data->>'gugu_account_kind','personal')<>'personal')
$$;
CREATE FUNCTION team_private.principal_is_active(p_actor uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE local_region text;
BEGIN
  IF to_regprocedure('identity.team_deployment_region()') IS NULL THEN RETURN false; END IF;
  BEGIN local_region:=identity.team_deployment_region();
  EXCEPTION WHEN SQLSTATE '55000' THEN RETURN false; END;
  IF local_region IS NULL THEN RETURN false; END IF;
  RETURN EXISTS(SELECT 1 FROM auth.users a
    JOIN team_private.members m ON m.principal_user_id=a.id
    JOIN team_private.teams t ON t.id=m.team_id
    JOIN identity.users u ON u.id=a.id::text AND u.type='human' AND u.removed_at IS NULL
    WHERE a.id=p_actor AND a.deleted_at IS NULL AND a.email_confirmed_at IS NOT NULL
      AND (a.banned_until IS NULL OR a.banned_until<=now())
      AND a.raw_app_meta_data->>'gugu_account_kind'='team_member'
      AND a.raw_app_meta_data->>'gugu_team_id'=m.team_id::text
      AND a.raw_app_meta_data->>'gugu_member_id'=m.id::text
      AND a.raw_app_meta_data->>'gugu_team_region'=t.region
      AND m.state='active' AND t.state='active' AND t.region=local_region);
END $$;
ALTER FUNCTION team_private.principal_is_team(uuid) OWNER TO postgres;
ALTER FUNCTION team_private.principal_is_active(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION team_private.principal_is_team(uuid),team_private.principal_is_active(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.team_session_is_active() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid:=auth.uid(); claims jsonb:=auth.jwt(); sid text;
BEGIN
  -- Preserve community/personal behavior; a claimed team identity still fails
  -- when its authoritative Auth row or membership has disappeared.
  IF NOT team_private.principal_is_team(actor)
     AND COALESCE(claims#>>'{app_metadata,gugu_account_kind}','personal')='personal' THEN
    RETURN true;
  END IF;
  IF actor IS NULL OR NOT team_private.principal_is_active(actor) THEN RETURN false; END IF;
  IF claims#>>'{app_metadata,gugu_account_kind}' IS DISTINCT FROM 'team_member'
    OR NOT EXISTS(SELECT 1 FROM team_private.members m JOIN team_private.teams t ON t.id=m.team_id
      WHERE m.principal_user_id=actor AND claims#>>'{app_metadata,gugu_team_id}'=m.team_id::text
        AND claims#>>'{app_metadata,gugu_member_id}'=m.id::text
        AND claims#>>'{app_metadata,gugu_team_region}'=t.region) THEN RETURN false; END IF;
  sid:=claims->>'session_id';
  IF sid IS NULL OR sid!~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  RETURN EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=sid::uuid AND s.user_id=actor
    AND (s.not_after IS NULL OR s.not_after>now()));
END $$;
ALTER FUNCTION identity.team_session_is_active() OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.team_session_is_active() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION identity.team_session_is_active() TO authenticated,service_role;

CREATE FUNCTION identity.team_request_gate() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT identity.team_session_is_active() THEN
    RAISE EXCEPTION 'team_access_denied' USING ERRCODE='42501',HINT='membership_disabled';
  END IF;
END $$;
ALTER FUNCTION identity.team_request_gate() OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.team_request_gate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.team_request_gate() TO anon,authenticated,service_role;

-- SECURITY DEFINER RPCs can bypass table RLS. PostgREST's pre-request hook gates
-- the verified caller before any REST read/write/RPC, including such functions.
-- Never silently replace an installation's independent request hook.
DO $$ DECLARE setting text; BEGIN
  FOR setting IN SELECT unnest(s.setconfig) FROM pg_db_role_setting s
    WHERE s.setrole='authenticator'::regrole AND s.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
  LOOP
    IF setting LIKE 'pgrst.db_pre_request=%'
      AND setting NOT IN ('pgrst.db_pre_request=','pgrst.db_pre_request=identity.team_request_gate') THEN
      RAISE EXCEPTION 'team gate requires explicit composition with the existing Data API request hook' USING ERRCODE='55000';
    END IF;
  END LOOP;
  ALTER ROLE authenticator SET pgrst.db_pre_request='identity.team_request_gate';
END $$;
NOTIFY pgrst,'reload config';

-- Storage and postgres_changes do not execute the Data API request hook.
-- Restrictive policies intersect, rather than replace, existing row scopes.
-- The chats INSERT policy contains its own table subquery: another SELECT
-- sublink in an ALL restriction makes PostgreSQL recursively expand it. Use a
-- direct stable call there; other tables cache the caller check in an InitPlan.
DO $$ DECLARE r record; predicate text; BEGIN
  FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('identity','chat','moments','public','storage') AND c.relkind='r' AND c.relrowsecurity
      AND (n.nspname<>'storage' OR c.relname IN ('objects','buckets'))
  LOOP
    predicate:=CASE WHEN r.nspname='chat' AND r.relname='chats'
      THEN 'identity.team_session_is_active()' ELSE '(SELECT identity.team_session_is_active())' END;
    EXECUTE format('CREATE POLICY team_live_session_gate ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated
      USING (%s) WITH CHECK (%s)',r.nspname,r.relname,predicate,predicate);
  END LOOP;
END $$;

-- Trusted service aggregation must observe the local region too (billing is a
-- separate service caller). Retain the exact signatures, payload and privileges.
DO $$ DECLARE body text; definition text; anchor text:=E'    IF membership.state<>''active'' OR organization.state<>''active'''; BEGIN
  SELECT p.prosrc,pg_get_functiondef(p.oid) INTO STRICT body,definition
    FROM pg_proc p WHERE p.oid='identity.team_context_for(uuid,uuid)'::regprocedure;
  IF length(body)-length(replace(body,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'unexpected team context body; region gate was not installed';
  END IF;
  body:=replace(body,anchor,E'    IF to_regprocedure(''identity.team_deployment_region()'') IS NULL THEN\n'
    ||E'        RAISE EXCEPTION ''team_region_unconfigured'' USING ERRCODE=''55000'';\n    END IF;\n'
    ||E'    IF organization.region IS DISTINCT FROM identity.team_deployment_region() THEN\n'
    ||E'        RAISE EXCEPTION ''team_region_mismatch'' USING ERRCODE=''42501'',HINT=''region_mismatch'';\n    END IF;\n'||anchor);
  EXECUTE replace(definition,(SELECT prosrc FROM pg_proc WHERE oid='identity.team_context_for(uuid,uuid)'::regprocedure),body);
END $$;
ALTER FUNCTION identity.team_context_for(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.team_context_for(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.team_context_for(uuid,uuid) TO service_role;
