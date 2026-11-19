-- A topic message takes the topic's chats row before it inserts a topic membership.
--
-- Speaking in a topic or being mentioned there joins the topic: join_topic_participants (BEFORE INSERT on messages)
-- inserts the chat_members row, and that row's AFTER trigger (auto_passive_on_agent_flood -> apply_agent_flood_rule)
-- only then locks the topic's chats row. So a message could hold a new membership and wait for the topic row while
-- another message, whose own join had already taken the topic row, inserted the same membership (a mention of that
-- speaker) and waited on the first one's uncommitted row: 40P01, the waiter in apply_agent_flood_rule
-- ("while locking tuple ... in relation chats"), seen under concurrent topic sends.
--
-- apply_agent_flood_rule already locks the chat row as its first statement; the membership row is simply older than
-- that. The fix is where the transaction first touches the topic: join_topic_participants already reads the topic's
-- chats row to find its source line, and now locks it there (FOR NO KEY UPDATE, the lock mode of the seq allocation and
-- of apply_agent_flood_rule). It is the same row the message's seq allocation locks a moment later, so nothing waits
-- longer than before; non-topic chats are unaffected (the read matches no row). Same rule as
-- 20261105161000_file_message_lock_order: take the row the message will need before touching rows others wait on.
--
-- The function below is its current definition (20261023131000_topic_source_resources) with that clause added.

CREATE OR REPLACE FUNCTION chat.join_topic_participants()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'identity', 'public', 'pg_catalog'
AS $function$
DECLARE
    v_source_chat_id TEXT;
    v_join JSONB;
BEGIN
    SELECT c.source_chat_id INTO v_source_chat_id
    FROM chat.chats c
    WHERE c.id = NEW.chat_id AND c.kind = 'topic'
    -- The topic row before any membership row (see file header). A message insert locks it next anyway (seq).
    FOR NO KEY UPDATE;

    IF v_source_chat_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- 说话就是参与
    IF NEW.sender_user_id IS NOT NULL THEN
        IF NOT chat.is_chat_member(v_source_chat_id, NEW.sender_user_id)
           AND EXISTS (SELECT 1 FROM identity.users u WHERE u.id = NEW.sender_user_id AND u.type = 'agent') THEN
            v_join := chat.add_group_agent(v_source_chat_id, NEW.sender_user_id, NULL, NEW.sender_user_id);
            IF v_join->>'status' NOT IN ('joined','already_member') THEN
                RAISE EXCEPTION 'agent_join_requires_manager: join the source before speaking in this topic';
            END IF;
        END IF;
        INSERT INTO chat.chat_members (chat_id, user_id, role, joined_ingest_seq)
        VALUES (NEW.chat_id, NEW.sender_user_id, 'member', NEW.ingest_seq - 1)
        ON CONFLICT (chat_id, user_id) DO NOTHING;
    END IF;

    -- 被 @ 就是被拉进来(只限来源线里已有的人/agent:agent 能拉不能加,见 agent-social)。
    -- 在这条消息入群(界 = NEW.ingest_seq - 1,门 `>`):拉你进来的这一条,你收得到(#6405)。
    IF NEW.to_user_ids IS NOT NULL THEN
        INSERT INTO chat.chat_members (chat_id, user_id, role, joined_ingest_seq)
        SELECT NEW.chat_id, target.user_id, 'member', NEW.ingest_seq - 1
        FROM unnest(NEW.to_user_ids) AS target(user_id)
        WHERE target.user_id <> '*'
          AND chat.is_chat_member(v_source_chat_id, target.user_id)
        ON CONFLICT (chat_id, user_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$function$
;

REVOKE ALL ON FUNCTION chat.join_topic_participants() FROM PUBLIC;
