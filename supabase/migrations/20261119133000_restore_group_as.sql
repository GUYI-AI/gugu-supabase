-- Explicit recovery after a local project mapping failure. Local inventory
-- reconciliation does not authorize this operation; only the human owner does.
SET LOCAL lock_timeout = '5s';

-- Internal recovery evidence: only topics actually changed by a source's
-- archive are eligible for its later recovery. Previously archived topics stay so.
CREATE TABLE chat.group_archive_recovery_topics (
    group_id TEXT PRIMARY KEY REFERENCES chat.chats(id) ON DELETE CASCADE,
    topic_ids TEXT[] NOT NULL
);
ALTER TABLE chat.group_archive_recovery_topics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE chat.group_archive_recovery_topics FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION chat.archive_topics_with_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_topics TEXT[];
BEGIN
    -- Source archival already holds the parent lock; topic lifecycle operations
    -- acquire the same parent lock, so this snapshot and cascade are atomic.
    SELECT COALESCE(array_agg(t.id ORDER BY t.id), ARRAY[]::TEXT[]) INTO v_topics
    FROM chat.chats t WHERE t.kind = 'topic' AND t.source_chat_id = NEW.id AND t.status <> 'archived';
    IF NEW.kind = 'group' THEN
        INSERT INTO chat.group_archive_recovery_topics(group_id, topic_ids) VALUES(NEW.id, v_topics)
        ON CONFLICT(group_id) DO UPDATE SET topic_ids = EXCLUDED.topic_ids;
    END IF;
    UPDATE chat.chats SET status = 'archived'
    WHERE kind = 'topic' AND source_chat_id = NEW.id AND status <> 'archived';
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION chat.archive_topics_with_source() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION chat.restore_group_as(p_chat_id TEXT, p_as_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor TEXT := chat.require_group_actor(p_as_user_id); v_status TEXT; v_topics TEXT[];
BEGIN
    PERFORM 1 FROM chat.chats c
      JOIN chat.active_members m ON m.chat_id = c.id
      JOIN identity.users u ON u.id = m.user_id
    WHERE c.id = p_chat_id AND c.kind = 'group'
      AND m.user_id = v_actor AND m.role = 'owner' AND u.type = 'human'
    FOR UPDATE OF c;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'human_group_owner_required' USING ERRCODE = '42501';
    END IF;
    SELECT status INTO v_status FROM chat.chats WHERE id = p_chat_id;
    IF v_status = 'archived' THEN
        SELECT topic_ids INTO v_topics FROM chat.group_archive_recovery_topics WHERE group_id = p_chat_id;
        IF v_topics IS NULL AND EXISTS (
            SELECT 1 FROM chat.chats WHERE kind = 'topic' AND source_chat_id = p_chat_id AND status = 'archived'
        ) THEN
            -- Old archives did not record a cohort. Do not revive intentionally
            -- closed topics or claim a partial parent-only recovery succeeded.
            RAISE EXCEPTION 'group_recovery_requires_topic_evidence' USING ERRCODE = '55000';
        END IF;
        UPDATE chat.chats SET status = 'active' WHERE id = p_chat_id;
        UPDATE chat.chats SET status = 'active'
        WHERE kind = 'topic' AND source_chat_id = p_chat_id AND id = ANY(v_topics) AND status = 'archived';
        DELETE FROM chat.group_archive_recovery_topics WHERE group_id = p_chat_id;
    END IF;
    -- Already active means no parent/topic writes or new revisions. A later
    -- individual topic archive cannot be undone by repeating this call.
    RETURN jsonb_build_object('chat_id', p_chat_id, 'status', 'active');
END;
$$;
REVOKE ALL ON FUNCTION chat.restore_group_as(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION chat.restore_group_as(TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
