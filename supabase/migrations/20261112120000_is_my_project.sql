-- identity.is_my_project(chat id): is this chat one of the caller's projects. One id, the same two cases
-- identity.list_my_projects lists: a recorded project group the caller owns, or a reserved id (no group yet) that one of
-- the caller's devices binds. The desktop asks it before it publishes a file into a chat its machine binds no project to;
-- it read the caller's whole project list (with every binding) for that one boolean.
-- New function only: locks no table.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION identity.is_my_project(p_chat_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE me text := auth.uid()::text;
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    RETURN EXISTS (SELECT 1 FROM chat.project_groups g WHERE g.chat_id = p_chat_id)
       AND CASE WHEN EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = p_chat_id)
                THEN EXISTS (SELECT 1 FROM chat.chats c WHERE c.id = p_chat_id AND c.kind = 'group') AND chat.is_project_owner(p_chat_id, me)
                ELSE EXISTS (SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id = p_chat_id AND dp.user_id::text = me)
           END;
END;
$$;
REVOKE ALL ON FUNCTION identity.is_my_project(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION identity.is_my_project(text) TO authenticated;
