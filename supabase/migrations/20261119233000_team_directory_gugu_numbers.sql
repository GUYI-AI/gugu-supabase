-- The team directory exposes canonical Gugu numbers to all permitted members.
-- Email fields and email search remain administrator-only. Numeric lookup uses
-- the same exact 1-9 digit rule as identity.search_users; no private Auth alias.
CREATE OR REPLACE FUNCTION identity.team_directory_page_for(p_actor uuid,p_session uuid,p_team_id uuid DEFAULT NULL,
    p_query text DEFAULT NULL,p_cursor text DEFAULT NULL,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor team_private.members%ROWTYPE; query_text text:=lower(btrim(p_query)); cursor_id uuid; result jsonb;
    can_read_email boolean;
BEGIN
    actor:=team_private.caller(p_actor,p_session);
    can_read_email:=actor.role IN ('superadmin','admin');
    IF p_team_id IS NOT NULL AND p_team_id<>actor.team_id THEN PERFORM team_private.refuse('forbidden'); END IF;
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR length(p_query)>254
        OR p_cursor IS NOT NULL AND p_cursor !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        PERFORM team_private.refuse('invalid_request',400);
    END IF;
    cursor_id:=p_cursor::uuid;
    WITH visible AS MATERIALIZED (
        SELECT seat.id,seat.principal_user_id AS identity_id,u.display_name AS name,u.avatar,u.gugu_number,
            seat.email_normalized AS email,seat.role,seat.revision
        FROM team_private.members seat JOIN identity.users u ON u.id=seat.principal_user_id::text
        WHERE seat.team_id=actor.team_id AND seat.state='active' AND u.type='human' AND u.removed_at IS NULL
    ), matched AS MATERIALIZED (
        SELECT * FROM visible WHERE query_text IS NULL OR query_text=''
            OR strpos(lower(name),query_text)>0
            OR CASE WHEN query_text ~ '^[0-9]{1,9}$' THEN gugu_number=query_text::integer ELSE false END
            OR can_read_email AND strpos(email,query_text)>0
    ), selected AS MATERIALIZED (
        SELECT * FROM matched WHERE cursor_id IS NULL OR id>cursor_id ORDER BY id LIMIT p_limit+1
    ), page AS (
        SELECT * FROM selected ORDER BY id LIMIT p_limit
    )
    SELECT jsonb_build_object('team_id',actor.team_id,
        'total_count',(SELECT count(*) FROM visible),'matching_count',(SELECT count(*) FROM matched),
        'members',COALESCE(jsonb_agg(CASE WHEN can_read_email THEN to_jsonb(page)
            ELSE to_jsonb(page)-'email' END ORDER BY page.id),'[]'::jsonb),
        'next_cursor',CASE WHEN (SELECT count(*) FROM selected)>p_limit THEN (array_agg(page.id ORDER BY page.id DESC))[1]::text ELSE NULL END)
        INTO result FROM page;
    RETURN result;
END $$;
ALTER FUNCTION identity.team_directory_page_for(uuid,uuid,uuid,text,text,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION identity.team_directory_page_for(uuid,uuid,uuid,text,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION identity.team_directory_page_for(uuid,uuid,uuid,text,text,integer) TO service_role;

