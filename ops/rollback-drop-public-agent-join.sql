-- Roll back 20261112073000_drop_public_agent_join: identity.get_public_agent_join returns with the definition and
-- grants that release dropped.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION identity.get_public_agent_join(p_agent_id text) RETURNS TABLE(id text, display_name text, avatar text, bio text, category text, owner_display_name text, owner_avatar text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'identity', 'public', 'pg_catalog'
    AS $$
    SELECT
        u.id,
        COALESCE(ap.display_name, u.display_name) AS display_name,
        COALESCE(ap.avatar, u.avatar)             AS avatar,
        u.bio,
        u.category,
        owner.display_name                        AS owner_display_name,
        owner.avatar                              AS owner_avatar
    FROM identity.users u
    LEFT JOIN identity.agent_profiles ap ON ap.id::text = u.id
    LEFT JOIN identity.users owner       ON owner.id = u.owner_user_id
    WHERE u.id = p_agent_id
      AND u.type = 'agent'
      AND u.agent_public = true;
$$;
REVOKE ALL ON FUNCTION identity.get_public_agent_join(p_agent_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION identity.get_public_agent_join(p_agent_id text) TO anon;
GRANT ALL ON FUNCTION identity.get_public_agent_join(p_agent_id text) TO authenticated;

COMMIT;
