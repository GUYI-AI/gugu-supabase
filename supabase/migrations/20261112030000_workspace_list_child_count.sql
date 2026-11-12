-- A listed folder says how many items are directly in it (child_count), so a folder not opened yet can show its count without a
-- read of its own. It is counted with the page's rows through workspace_items_parent_idx, only for the folder rows of the page;
-- nothing is stored, so adding or removing an item writes no other row. Files and documents have NULL. Every existing column,
-- argument, order, path and total is unchanged.
-- The guard compares the whole definition, so a change anything else has made stops here instead of being overwritten.
DO $list$ DECLARE
    definition text := pg_get_functiondef('chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean)'::regprocedure);
BEGIN
    IF md5(definition) <> '454cdaa4b0c903b04f9b4dec6c74fdcc' THEN
        RAISE EXCEPTION 'Unexpected workspace list predecessor: %', md5(definition);
    END IF;
    definition := replace(replace(definition,
        'copy_account_id text, host_device_id text)', 'copy_account_id text, host_device_id text, child_count bigint)'),
        'ref.expired_at, ref.account_id, dev.host_device_id',
        $sel$ref.expired_at, ref.account_id, dev.host_device_id,
           CASE WHEN w.kind = 'folder' THEN (SELECT count(*) FROM chat.workspace_items c WHERE c.parent_id = w.id) END$sel$);
    DROP FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean);
    EXECUTE definition;
END $list$;
REVOKE ALL ON FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean) TO authenticated;

NOTIFY pgrst,'reload schema';
