-- Add the team's display name for the caller-readable official context facade.
-- This is a forward release; the original context migration stays unchanged.
DO $upgrade$
DECLARE definition text; personal text; organization text;
BEGIN
    SELECT pg_get_functiondef('identity.team_context_for(uuid,uuid)'::regprocedure) INTO definition;
    personal:='jsonb_build_object(''kind'',''personal'',''team_id'',NULL,''member_id'',NULL,';
    organization:='jsonb_build_object(''kind'',''team'',''team_id'',membership.team_id,''member_id'',membership.id,';
    IF length(definition)-length(replace(definition,personal,''))<>length(personal)
       OR length(definition)-length(replace(definition,organization,''))<>length(organization) THEN
        RAISE EXCEPTION 'Unexpected team context predecessor';
    END IF;
    EXECUTE replace(replace(definition,personal,
        'jsonb_build_object(''kind'',''personal'',''team_id'',NULL,''team_name'',NULL,''member_id'',NULL,'),organization,
        'jsonb_build_object(''kind'',''team'',''team_id'',membership.team_id,''team_name'',organization.name,''member_id'',membership.id,');
END $upgrade$;
REVOKE ALL ON FUNCTION identity.team_context_for(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION identity.team_context_for(uuid,uuid) TO service_role;
