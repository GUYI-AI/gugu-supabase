-- Additive release after the current inbox/preview and per-reference visibility releases.
SET LOCAL lock_timeout = '5s';

-- Reuse the authorized file projection on the message's pinned reference. The
-- commit reply, sync_since arrival and history then carry the same dimensions
-- and SHA without another metadata round trip or a changed attachment envelope.
-- These are display hints, never a signed URL or a download capability.
-- The project-revision replacement omitted the metadata reader's original
-- STABLE attribute. Keep this read-only projection eligible for query folding.
ALTER FUNCTION chat.file_resolve_as(jsonb,text) STABLE;

DO $projection$
DECLARE
    definition text:=pg_get_viewdef('chat.messages_view'::regclass,true);
    signature constant text:='chat.send_message_idempotent(text,text,text,text[],text,text,text,text,boolean,boolean,text,uuid,integer,text,uuid)';
    sender_definition text; sender_result text; sender_acl aclitem[]; sender_owner oid; sender_comment text; permission record;
BEGIN
    -- The sender selected mv.* but declared a fixed TABLE result. Use the same
    -- view row type as attachment_commit/forward, retaining its body and access.
    SELECT pg_get_functiondef(p.oid),pg_get_function_result(p.oid),COALESCE(p.proacl,acldefault('f',p.proowner)),
        p.proowner,obj_description(p.oid,'pg_proc')
      INTO sender_definition,sender_result,sender_acl,sender_owner,sender_comment
      FROM pg_proc p WHERE p.oid=signature::regprocedure;
    IF sender_result NOT LIKE 'TABLE(%' OR position('RETURNS '||sender_result IN sender_definition)=0 THEN
        RAISE EXCEPTION 'Unexpected message sender result predecessor';
    END IF;
    EXECUTE 'DROP FUNCTION '||signature;
    EXECUTE replace(sender_definition,'RETURNS '||sender_result,'RETURNS SETOF chat.messages_view');
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I',signature,pg_get_userbyid(sender_owner));
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',signature);
    FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable
        FROM aclexplode(sender_acl) WHERE privilege_type='EXECUTE' GROUP BY grantee LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',signature,
            CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
            CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
    IF sender_comment IS NOT NULL THEN
        EXECUTE format('COMMENT ON FUNCTION %s IS %L',signature,sender_comment);
    END IF;
    -- Keep every published column in place, including columns added by earlier
    -- releases. Expand the prior definition, rather than selecting this view.
    EXECUTE 'CREATE OR REPLACE VIEW chat.messages_view WITH (security_invoker=true) AS
        SELECT m.*,
            CASE WHEN m.content_type=''attachment''
                AND (m.file_version IS NOT NULL OR m.file_blob_id IS NOT NULL)
                AND (SELECT auth.uid()) IS NOT NULL
            THEN chat.file_resolve_as(jsonb_build_object(''message_id'',m.id),(SELECT auth.uid())::text)
                - ARRAY[''bucket_id'',''object_name'']
            END AS file_metadata
        FROM ('||regexp_replace(definition,';[[:space:]]*$','')||') m';
END $projection$;

COMMENT ON COLUMN chat.messages_view.file_metadata IS
    'Current authorized file metadata for display, resolved from the immutable message reference. Original reads still use the file reader.';
NOTIFY pgrst,'reload schema';
