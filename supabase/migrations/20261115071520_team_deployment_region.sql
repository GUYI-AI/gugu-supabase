-- The deployment region is installation data, never a request parameter or a
-- copied team's region. Only the normal privileged deployment may configure it.
CREATE TABLE team_private.deployment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  region text CHECK(region IN ('cn','hk'))
);
INSERT INTO team_private.deployment(singleton) VALUES(true);
ALTER TABLE team_private.deployment OWNER TO postgres;
ALTER TABLE team_private.deployment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON team_private.deployment FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION identity.team_deployment_region() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result text;
BEGIN
  SELECT region INTO result FROM team_private.deployment WHERE singleton;
  IF result IS NULL THEN
    RAISE EXCEPTION 'team_region_unconfigured' USING ERRCODE='55000';
  END IF;
  RETURN result;
END $$;
ALTER FUNCTION identity.team_deployment_region() OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.team_deployment_region() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.team_deployment_region() TO service_role;

