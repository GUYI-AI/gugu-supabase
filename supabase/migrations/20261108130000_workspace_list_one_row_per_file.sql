-- 20261107220000 moved the stored-copy lookup after the page cut, and that lookup can return more than one row:
-- file_transfer_storage.blob_id is not unique. A second live copy would add a row after the cut and pass p_limit.
-- The guard compares the whole definition, so a change anything else has made stops here instead of being overwritten.
DO $list$ DECLARE
    definition text := pg_get_functiondef('chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean)'::regprocedure);
BEGIN
    IF md5(definition) <> '7fc781ae3d327057255850f5a6bb1658' THEN
        RAISE EXCEPTION 'Unexpected workspace list predecessor: %', md5(definition);
    END IF;
    EXECUTE replace(definition, 'r.expired_at IS NULL) copy ON true', 'r.expired_at IS NULL LIMIT 1) copy ON true');
END $list$;
REVOKE ALL ON FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean) TO authenticated;

NOTIFY pgrst,'reload schema';
