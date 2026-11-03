-- The room and actor are constant within this call. Resolve their existing
-- transfer identities after the original authorization and folder checks,
-- rather than repeating the same lookups for each enriched workspace row.
DO $list$ DECLARE
    definition text;
    group_init CONSTANT text := 'v_transfer_group := chat.file_transfer_group(p_chat_id);';
    account_init CONSTANT text := 'v_transfer_account := chat.file_transfer_account(v_actor);';
BEGIN
    SELECT pg_get_functiondef('chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean)'::regprocedure) INTO definition;
    IF position('v_parent UUID;' IN definition)=0
       OR position('    RETURN QUERY' || chr(10) || '    WITH RECURSIVE tree AS (' IN definition)=0
       OR position('chat.file_transfer_group(w.chat_id)' IN definition)=0
       OR position('chat.file_transfer_account(v_actor)' IN definition)=0 THEN
        RAISE EXCEPTION 'Unexpected workspace list predecessor';
    END IF;
    definition:=replace(definition,'v_parent UUID;',
        'v_parent UUID; v_transfer_group TEXT; v_transfer_account TEXT;');
    definition:=replace(definition,'chat.file_transfer_group(w.chat_id)','v_transfer_group');
    definition:=replace(definition,'chat.file_transfer_account(v_actor)','v_transfer_account');
    definition:=replace(definition,'    RETURN QUERY' || chr(10) || '    WITH RECURSIVE tree AS (',
        '    ' || group_init || chr(10) || '    ' || account_init || chr(10) ||
        '    RETURN QUERY' || chr(10) || '    WITH RECURSIVE tree AS (');
    EXECUTE definition;
    SELECT pg_get_functiondef('chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean)'::regprocedure) INTO definition;
    IF length(definition)-length(replace(definition,group_init,'')) <> length(group_init)
       OR length(definition)-length(replace(definition,account_init,'')) <> length(account_init)
       OR definition ~* '\m([a-z_][a-z_0-9]*)\s*:=\s*\1\M\s*;'
       OR position('chat.file_transfer_group(w.chat_id)' IN definition)>0
       OR position('copy.account_id = chat.file_transfer_account(v_actor)' IN definition)>0 THEN
        RAISE EXCEPTION 'Unexpected workspace list rewrite';
    END IF;
END $list$;
REVOKE ALL ON FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION chat.workspace_list_as(text,text,integer,integer,text,text,text,boolean) TO authenticated;

-- Reconnect and periodic file-service repair scan for this fixed marker. Keep
-- the existing query and its automatic index maintenance on text/state changes.
CREATE INDEX workspace_items_pending_marks_idx ON chat.workspace_items (id)
    WHERE kind = 'document' AND ystate IS NULL AND inline_text LIKE '%"$text"%';

NOTIFY pgrst,'reload schema';
