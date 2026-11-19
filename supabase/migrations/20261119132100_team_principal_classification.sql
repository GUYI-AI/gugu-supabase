-- Routing aliases identify a server-planned principal, never a public signup.
CREATE FUNCTION team_private.guard_auth_principal_alias() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF lower(btrim(NEW.email)) ~ '@team[.]gugu[.]invalid$' AND NOT EXISTS (
    SELECT 1 FROM team_private.members m
    WHERE (m.planned_principal_id=NEW.id OR m.principal_user_id=NEW.id)
      AND NEW.email='team-'||replace(m.id::text,'-','')||'@team.gugu.invalid'
  ) THEN
    RAISE EXCEPTION 'reserved_team_principal_alias' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION team_private.guard_auth_principal_alias() OWNER TO postgres;
REVOKE ALL ON FUNCTION team_private.guard_auth_principal_alias() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER team_reserved_auth_alias BEFORE INSERT OR UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION team_private.guard_auth_principal_alias();

-- Consumers call this in their own transaction after Auth commits. GoTrue may
-- persist app_metadata after INSERT; captured trigger NEW is not the final row.
-- This classifies identity only. It grants no membership, balance or access.
CREATE FUNCTION identity.personal_principal_is_eligible(p_actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id=p_actor AND u.deleted_at IS NULL
      AND COALESCE(u.raw_app_meta_data->>'gugu_account_kind','personal')='personal'
      AND NOT COALESCE(u.raw_app_meta_data ?| ARRAY['gugu_team_id','gugu_member_id','gugu_team_region'],false)
      AND COALESCE(lower(btrim(u.email)),'') !~ '@team[.]gugu[.]invalid$'
      AND NOT EXISTS (SELECT 1 FROM team_private.members m
        WHERE m.principal_user_id=u.id OR m.planned_principal_id=u.id)
  )
$$;
ALTER FUNCTION identity.personal_principal_is_eligible(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.personal_principal_is_eligible(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.personal_principal_is_eligible(uuid) TO service_role;
