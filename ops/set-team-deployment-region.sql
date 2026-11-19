-- Run only through the normal privileged deployment configuration step.
-- The deployment supplies gugu.deployment_region=cn|hk on this connection.
-- Never infer the local region from a team, Auth metadata or a request body.
DO $$ DECLARE requested text:=current_setting('gugu.deployment_region',true); existing text; BEGIN
  IF current_user<>'postgres' OR requested IS NULL OR requested NOT IN ('cn','hk') THEN
    RAISE EXCEPTION 'Privileged deployment region configuration is required' USING ERRCODE='42501';
  END IF;
  SELECT region INTO STRICT existing FROM team_private.deployment WHERE singleton FOR UPDATE;
  IF existing IS NOT NULL AND existing<>requested THEN
    RAISE EXCEPTION 'An existing deployment region cannot be changed by normal configuration' USING ERRCODE='55000';
  END IF;
  UPDATE team_private.deployment SET region=requested WHERE singleton;
END $$;
