-- Old chat-media attachment cards are retired: their history is adopted into the one attachment model, writes are closed,
-- and the readers of the old shape are removed.
--
-- Two attachment models ran side by side. New attachments go through the attachments function: bytes are registered as a
-- blob, the file lands in the chat's 附件 folder, the message points at that file version (or, for a whisper, at the
-- blob), quotas and recall apply. Old cards were a member uploading to the public chat-media bucket and inserting a
-- message whose storage columns name the object (or whose text carries its public URL). Nothing closed that door: any
-- member or agent token could still post such a card, bypassing quota, size limit, the folder and recall, with a link
-- that stays public. So the readers kept a second format: attachment_legacy_source, the old branch of
-- attachment_forward (and the attachments function moving bytes on forward), the old union of file_urls_as, the message
-- arms of storage_object_is_referenced / file_blob_held_until / conversation_release, and the client's resolver.
--
-- Adoption (each card with storage_bucket_id = 'chat-media'), with the same rules a forward of one already used:
--   · visible (not deleted or recalled), its object still in Storage, in a chat that has a folder: the object is
--     registered as a blob where it lies (chat.file_blob_for_object, the one byte collector's door for existing Storage
--     objects), placed in the chat's 附件 folder exactly as attachment_item_for places an upload (same folder, same name
--     series, the same file when the same bytes under the same name are already there), and the message points at that
--     file version; its text becomes the file's envelope plus the card's caption (a voice note's line included).
--     From now on recall, deletion and the conversation's end release the bytes through the collector like any upload.
--   · a visible whisper: the message points at the blob (whispers never enter the folder everyone sees), as attachment_place
--     sends one;
--   · deleted, recalled, or its object already gone: the message becomes the deleted-file shape (file_version 1, no file)
--     with the envelope its own text described; a still existing object is handed to the collector.
-- Every adopted message is recorded in chat.legacy_attachment_adoptions (its text and object before, what was
-- created), which ops/rollback-legacy-chat-media-attachments-adopted.sql uses to restore them exactly.
-- An attachment keeps the file version it was sent with (messages_file_ref): that rule is relaxed for this one move only
-- while the adoption runs, and restored in the same transaction.
--
-- Closed: chat.validate_storage_reference_pair refuses any message naming a Storage object (or carrying a chat-media URL
-- card), and authenticated loses INSERT on the two storage columns. The table CHECK messages_storage_reference_chk keeps
-- its chat-media arm, now unreachable: rewriting it would take ACCESS EXCLUSIVE on chat.messages (see Locks).
-- send_friend_message_as_owner sends text only (files: send_friend_file_as_owner); its storage parameters are gone.
--
-- Locks: no column, trigger or constraint is added or changed on chat.messages; the adoption takes ROW EXCLUSIVE on
-- chat.messages and the file tables, as an upload does; replacing and dropping functions locks no table.
-- Rollback: ops/rollback-legacy-chat-media-attachments-adopted.sql.
SET LOCAL lock_timeout = '5s';

CREATE TABLE chat.legacy_attachment_adoptions (
    message_id text PRIMARY KEY,
    content text NOT NULL,
    storage_object_name text NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('file', 'whisper_blob', 'deleted_file')),
    blob_id uuid,
    blob_created boolean NOT NULL,
    item_id uuid,
    item_created boolean NOT NULL,
    adopted_at timestamptz NOT NULL DEFAULT now()
);
-- Kept beside the tables it describes, closed to every API role (as chat.project_groups is); not in chat_private, which
-- older operational rollbacks drop as a whole.
ALTER TABLE chat.legacy_attachment_adoptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat.legacy_attachment_adoptions FROM PUBLIC, anon, authenticated, service_role;

-- The legacy card's one move, allowed only while this release adopts them (restored below).
CREATE OR REPLACE FUNCTION chat.messages_file_ref()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_item chat.workspace_items%ROWTYPE;
    v_blob chat.file_blobs%ROWTYPE;
    v_source chat.messages%ROWTYPE;
    v_envelope TEXT;
    v_resource TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF 'chat-media' IN (OLD.storage_bucket_id, NEW.storage_bucket_id) AND OLD.storage_bucket_id IS DISTINCT FROM NEW.storage_bucket_id THEN
            RETURN NEW;
        END IF;
        -- 发出去以后不能改指向;删文件时外键把 file_item_id 清空(墓碑)是唯一的变化。
        IF NEW.file_version IS DISTINCT FROM OLD.file_version
           OR (NEW.file_item_id IS DISTINCT FROM OLD.file_item_id AND NEW.file_item_id IS NOT NULL)
           -- ◇ 悄悄话附件指着的那份字节也不能改。
           OR NEW.file_blob_id IS DISTINCT FROM OLD.file_blob_id THEN
            RAISE EXCEPTION USING HINT = 'message_file_fixed', MESSAGE = 'an attachment keeps the file version it was sent with';
        END IF;
        -- 正文和类型也不能改(墓碑也一样):authenticated 本来就能改自己消息的正文(编辑),而老客户端照正文画名字、大小和 [URL],
        -- 新客户端照条目读字节 —— 改了正文,同一条消息两边看到两样东西。撤回只写 retracted_at,不经过这里。
        IF (OLD.file_item_id IS NOT NULL OR OLD.file_version IS NOT NULL OR OLD.file_blob_id IS NOT NULL)
           AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.content_type IS DISTINCT FROM OLD.content_type) THEN
            RAISE EXCEPTION USING HINT = 'message_file_fixed', MESSAGE = 'an attachment''s text is fixed once it is sent';
        END IF;
        RETURN NEW;
    END IF;
    -- ◇ 悄悄话附件:消息直接指字节。形状(悄悄话、没有条目)由 CHECK messages_file_blob_shape 管。
    IF NEW.file_blob_id IS NOT NULL THEN
        -- 先锁住、核它没在回收(同条目那一路的 file_blob_take)。
        PERFORM chat.file_blob_take(NEW.file_blob_id);
        -- 字节从哪来:这条消息自己消费的那次上传,或者发送者读得到、指着同一份字节的源消息。
        IF NOT EXISTS (SELECT 1 FROM chat.file_blob_uploads u WHERE u.message_id = NEW.id AND u.blob_id = NEW.file_blob_id) THEN
            IF NEW.forwarded_from_message_id IS NOT NULL
               AND chat.can_read_message(NEW.forwarded_from_message_id, NEW.sender_user_id) THEN
                SELECT * INTO v_source FROM chat.messages s WHERE s.id = NEW.forwarded_from_message_id AND s.retracted_at IS NULL;
            END IF;
            IF v_source.id IS NULL
               OR COALESCE(v_source.file_blob_id, chat.workspace_version_blob(v_source.file_item_id, v_source.file_version))
                  IS DISTINCT FROM NEW.file_blob_id THEN
                RAISE EXCEPTION USING HINT = 'message_file_not_here',
                    MESSAGE = 'a whisper attachment carries bytes uploaded for it, or forwards the bytes of an unretracted message its sender can read';
            END IF;
        END IF;
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = NEW.file_blob_id;
        IF NEW.content_type IS DISTINCT FROM 'attachment'
           OR chat.attachment_envelope_name(chat.attachment_text_envelope(NEW.content), v_blob.size_bytes, v_blob.content_type) IS NULL THEN
            RAISE EXCEPTION USING HINT = 'message_file_envelope',
                MESSAGE = format('an attachment''s text is its file''s envelope: %s',
                                 chat.attachment_envelope('<name>', v_blob.size_bytes, v_blob.content_type));
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.file_item_id IS NULL THEN
        IF NEW.file_version IS NOT NULL THEN
            RAISE EXCEPTION USING HINT = 'message_file_not_here', MESSAGE = 'an attachment''s version needs its file';
        END IF;
        RETURN NEW;
    END IF;
    -- FOR SHARE:换版本那边(workspace_replace_file_as)先对条目拿 FOR UPDATE、修剪历史;这里排在它后面,拿到锁时它已提交,
    -- 下一句用新快照,看得到修剪以后的历史 —— 钉的那一版已经裁掉就拒。只靠外键的 KEY SHARE 不排队:两边都成功,
    -- 消息钉着一版历史里已经没有的字节,回收随后把它删掉(复核 L11 两个连接实测)。反过来这边先到,修剪等这边提交、看得见钉住。
    v_resource := chat.workspace_require_room_member(NEW.chat_id, NEW.sender_user_id);
    SELECT * INTO v_item FROM chat.workspace_items w WHERE w.id = NEW.file_item_id FOR SHARE;
    IF NOT FOUND OR v_item.chat_id IS DISTINCT FROM v_resource OR v_item.kind = 'folder' THEN
        RAISE EXCEPTION USING HINT = 'message_file_not_here',
            MESSAGE = 'an attachment points at a file in its source chat''s folder';
    END IF;
    NEW.file_version := COALESCE(NEW.file_version, v_item.version);
    v_envelope := chat.workspace_version_envelope(v_item.id, NEW.file_version);
    IF v_envelope IS NULL THEN
        RAISE EXCEPTION USING HINT = 'message_file_not_here',
            MESSAGE = format('version %s of that file has no bytes to send', NEW.file_version);
    END IF;
    IF NEW.content_type IS DISTINCT FROM 'attachment' OR chat.attachment_text_envelope(NEW.content) IS DISTINCT FROM v_envelope THEN
        RAISE EXCEPTION USING HINT = 'message_file_envelope',
            MESSAGE = format('an attachment''s text is its file''s envelope: %s', v_envelope);
    END IF;
    -- ◇ 钉住条目现在那一版:写进历史(还没有的话)。改名、移动只升版本、不写历史,不记的话那一版的字节就只挂在条目上,
    -- 下一次改名以后 chat.workspace_version_blob 找不到它。写法同 workspace_replace_file_as 补旧版本那一句。
    IF NEW.file_version = v_item.version THEN
        INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by, made_at)
        SELECT v_item.id, v_item.version, v_item.blob_id, v_item.content_type, v_item.size_bytes, v_item.created_by, v_item.updated_at
     WHERE NOT EXISTS(SELECT 1 FROM chat.workspace_item_versions x WHERE x.item_id = v_item.id AND x.n = v_item.version)
        ON CONFLICT ON CONSTRAINT workspace_item_versions_pkey DO NOTHING;
    END IF;
    RETURN NEW;
END;
$function$;

DO $adopt$
DECLARE
    m chat.messages%ROWTYPE;
    v_header TEXT;
    v_match TEXT[];
    v_name TEXT;
    v_type TEXT;
    v_size BIGINT;
    v_caption TEXT;
    v_resource TEXT;
    v_object RECORD;
    v_found BOOLEAN;
    v_blob UUID;
    v_blob_created BOOLEAN;
    v_folder UUID;
    v_stored TEXT;
    v_item chat.workspace_items%ROWTYPE;
    v_item_created BOOLEAN;
BEGIN
    FOR m IN SELECT * FROM chat.messages WHERE storage_bucket_id = 'chat-media' ORDER BY created_at, id FOR UPDATE LOOP
        -- The card's own words, as attachment_legacy_source read them: 「[附件] 名字 (类型)」, the type may be absent.
        v_header := split_part(m.content, E'\n', 1);
        v_match := regexp_match(v_header, '^\[附件\] (.+) \(([^()]*)\)$');
        v_name := CASE WHEN left(v_header, 5) = '[附件] ' THEN COALESCE(v_match[1], NULLIF(substr(v_header, 6), '')) END;
        v_name := COALESCE(v_name, regexp_replace(m.storage_object_name, '^.*/', ''));
        -- The caption a forward of this card carried (attachment_forward): [Caption], or a voice note's duration line.
        v_caption := chat.attachment_caption_of(m.content);
        IF v_caption = '' AND split_part(m.content, E'\n', 2) LIKE '[语音] durationMs=%' THEN
            v_caption := chat.attachment_caption_suffix(substr(m.content, strpos(m.content, E'\n') + 1));
        END IF;
        SELECT o.metadata INTO v_object FROM storage.objects o WHERE o.bucket_id = 'chat-media' AND o.name = m.storage_object_name;
        v_found := FOUND;
        v_type := COALESCE(NULLIF(v_match[2], ''), NULLIF(btrim(v_object.metadata ->> 'mimetype'), ''));
        v_size := COALESCE(NULLIF(v_object.metadata ->> 'size', '')::BIGINT,
                           NULLIF(substring(m.content FROM E'\n\\[Size\\] ([0-9]{1,18})(\n|$)'), '')::BIGINT);
        SELECT r.id INTO v_resource FROM chat.chats c JOIN chat.chats r ON r.id = COALESCE(c.source_chat_id, c.id)
         WHERE c.id = m.chat_id AND c.kind IN ('group', 'topic', 'dm', 'ai') AND r.kind IN ('group', 'dm', 'ai');
        v_blob := NULL; v_blob_created := false; v_item := NULL; v_item_created := false;
        IF v_found THEN
            v_blob_created := NOT EXISTS (SELECT 1 FROM chat.file_blobs b WHERE b.bucket_id = 'chat-media' AND b.object_name = m.storage_object_name);
            v_blob := chat.file_blob_for_object('chat-media', m.storage_object_name);
        END IF;
        IF v_blob IS NOT NULL AND m.deleted_at IS NULL AND m.retracted_at IS NULL AND m.is_whisper THEN
            -- A whisper's bytes stay outside the folder everyone sees: the message points at the blob (attachment_place).
            PERFORM chat.file_blob_take(v_blob);
            UPDATE chat.messages
               SET file_blob_id = v_blob,
                   content = (SELECT chat.attachment_envelope(chat.workspace_stored_name(v_name), b.size_bytes, b.content_type)
                                FROM chat.file_blobs b WHERE b.id = v_blob) || v_caption,
                   storage_bucket_id = NULL, storage_object_name = NULL
             WHERE id = m.id;
        ELSIF v_blob IS NOT NULL AND m.deleted_at IS NULL AND m.retracted_at IS NULL AND v_resource IS NOT NULL THEN
            -- As chat.attachment_item_for places an upload, without asking the sender to still be a member: this is history.
            PERFORM chat.file_blob_take(v_blob);
            v_folder := chat.workspace_system_folder(v_resource, 'attachments');
            v_stored := chat.workspace_stored_name(v_name);
            SELECT * INTO v_item FROM chat.workspace_items w
             WHERE w.chat_id = v_resource AND w.parent_id = v_folder AND w.kind IN ('file', 'document')
               AND chat.workspace_version_blob(w.id, w.version) = v_blob AND chat.workspace_same_series(w.name_key, v_stored)
             ORDER BY w.created_at, w.id LIMIT 1 FOR UPDATE;
            IF FOUND THEN
                UPDATE chat.workspace_items w SET source_message_ids = array_append(w.source_message_ids, m.id)
                 WHERE w.id = v_item.id AND NOT m.id = ANY (w.source_message_ids);
            ELSE
                INSERT INTO chat.workspace_items AS w (chat_id, parent_id, kind, filename, content_type, size_bytes, blob_id,
                                                       source_message_ids, created_by, version)
                SELECT v_resource, v_folder, 'file', v_stored, b.content_type, b.size_bytes, b.id, ARRAY[m.id],
                       (SELECT u.id FROM identity.users u WHERE u.id = m.sender_user_id), 1
                  FROM chat.file_blobs b WHERE b.id = v_blob
                RETURNING * INTO v_item;
                v_item_created := true;
            END IF;
            -- The pinned version is in the history, as messages_file_ref records it for a new attachment message.
            INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by, made_at)
            VALUES (v_item.id, v_item.version, v_item.blob_id, v_item.content_type, v_item.size_bytes, v_item.created_by, v_item.updated_at)
            ON CONFLICT ON CONSTRAINT workspace_item_versions_pkey DO NOTHING;
            UPDATE chat.messages
               SET file_item_id = v_item.id, file_version = v_item.version,
                   content = chat.workspace_version_envelope(v_item.id, v_item.version) || v_caption,
                   storage_bucket_id = NULL, storage_object_name = NULL
             WHERE id = m.id;
        ELSE
            -- Deleted, recalled, or its bytes are gone: the deleted-file shape, described by the card's own text.
            IF v_blob IS NOT NULL THEN
                PERFORM chat.file_blob_enqueue(v_blob);
            END IF;
            UPDATE chat.messages
               SET file_version = 1,
                   content = chat.attachment_envelope(chat.workspace_stored_name(v_name), v_size, v_type) || v_caption,
                   storage_bucket_id = NULL, storage_object_name = NULL
             WHERE id = m.id;
        END IF;
        INSERT INTO chat.legacy_attachment_adoptions
            (message_id, content, storage_object_name, outcome, blob_id, blob_created, item_id, item_created)
        VALUES (m.id, m.content, m.storage_object_name,
                CASE WHEN v_item.id IS NOT NULL THEN 'file'
                     WHEN m.is_whisper AND m.deleted_at IS NULL AND m.retracted_at IS NULL AND v_blob IS NOT NULL THEN 'whisper_blob'
                     ELSE 'deleted_file' END,
                v_blob, v_blob_created, v_item.id, v_item_created);
    END LOOP;
    IF EXISTS (SELECT 1 FROM chat.messages WHERE storage_bucket_id IS NOT NULL OR storage_object_name IS NOT NULL) THEN
        RAISE EXCEPTION 'legacy attachment adoption left a message naming a Storage object';
    END IF;
END $adopt$;

-- messages_file_ref as it was: an attachment keeps the file version it was sent with.
CREATE OR REPLACE FUNCTION chat.messages_file_ref()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_item chat.workspace_items%ROWTYPE;
    v_blob chat.file_blobs%ROWTYPE;
    v_source chat.messages%ROWTYPE;
    v_envelope TEXT;
    v_resource TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- 发出去以后不能改指向;删文件时外键把 file_item_id 清空(墓碑)是唯一的变化。
        IF NEW.file_version IS DISTINCT FROM OLD.file_version
           OR (NEW.file_item_id IS DISTINCT FROM OLD.file_item_id AND NEW.file_item_id IS NOT NULL)
           -- ◇ 悄悄话附件指着的那份字节也不能改。
           OR NEW.file_blob_id IS DISTINCT FROM OLD.file_blob_id THEN
            RAISE EXCEPTION USING HINT = 'message_file_fixed', MESSAGE = 'an attachment keeps the file version it was sent with';
        END IF;
        -- 正文和类型也不能改(墓碑也一样):authenticated 本来就能改自己消息的正文(编辑),而老客户端照正文画名字、大小和 [URL],
        -- 新客户端照条目读字节 —— 改了正文,同一条消息两边看到两样东西。撤回只写 retracted_at,不经过这里。
        IF (OLD.file_item_id IS NOT NULL OR OLD.file_version IS NOT NULL OR OLD.file_blob_id IS NOT NULL)
           AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.content_type IS DISTINCT FROM OLD.content_type) THEN
            RAISE EXCEPTION USING HINT = 'message_file_fixed', MESSAGE = 'an attachment''s text is fixed once it is sent';
        END IF;
        RETURN NEW;
    END IF;
    -- ◇ 悄悄话附件:消息直接指字节。形状(悄悄话、没有条目)由 CHECK messages_file_blob_shape 管。
    IF NEW.file_blob_id IS NOT NULL THEN
        -- 先锁住、核它没在回收(同条目那一路的 file_blob_take)。
        PERFORM chat.file_blob_take(NEW.file_blob_id);
        -- 字节从哪来:这条消息自己消费的那次上传,或者发送者读得到、指着同一份字节的源消息。
        IF NOT EXISTS (SELECT 1 FROM chat.file_blob_uploads u WHERE u.message_id = NEW.id AND u.blob_id = NEW.file_blob_id) THEN
            IF NEW.forwarded_from_message_id IS NOT NULL
               AND chat.can_read_message(NEW.forwarded_from_message_id, NEW.sender_user_id) THEN
                SELECT * INTO v_source FROM chat.messages s WHERE s.id = NEW.forwarded_from_message_id AND s.retracted_at IS NULL;
            END IF;
            IF v_source.id IS NULL
               OR COALESCE(v_source.file_blob_id, chat.workspace_version_blob(v_source.file_item_id, v_source.file_version))
                  IS DISTINCT FROM NEW.file_blob_id THEN
                RAISE EXCEPTION USING HINT = 'message_file_not_here',
                    MESSAGE = 'a whisper attachment carries bytes uploaded for it, or forwards the bytes of an unretracted message its sender can read';
            END IF;
        END IF;
        SELECT * INTO v_blob FROM chat.file_blobs b WHERE b.id = NEW.file_blob_id;
        IF NEW.content_type IS DISTINCT FROM 'attachment'
           OR chat.attachment_envelope_name(chat.attachment_text_envelope(NEW.content), v_blob.size_bytes, v_blob.content_type) IS NULL THEN
            RAISE EXCEPTION USING HINT = 'message_file_envelope',
                MESSAGE = format('an attachment''s text is its file''s envelope: %s',
                                 chat.attachment_envelope('<name>', v_blob.size_bytes, v_blob.content_type));
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.file_item_id IS NULL THEN
        IF NEW.file_version IS NOT NULL THEN
            RAISE EXCEPTION USING HINT = 'message_file_not_here', MESSAGE = 'an attachment''s version needs its file';
        END IF;
        RETURN NEW;
    END IF;
    -- FOR SHARE:换版本那边(workspace_replace_file_as)先对条目拿 FOR UPDATE、修剪历史;这里排在它后面,拿到锁时它已提交,
    -- 下一句用新快照,看得到修剪以后的历史 —— 钉的那一版已经裁掉就拒。只靠外键的 KEY SHARE 不排队:两边都成功,
    -- 消息钉着一版历史里已经没有的字节,回收随后把它删掉(复核 L11 两个连接实测)。反过来这边先到,修剪等这边提交、看得见钉住。
    v_resource := chat.workspace_require_room_member(NEW.chat_id, NEW.sender_user_id);
    SELECT * INTO v_item FROM chat.workspace_items w WHERE w.id = NEW.file_item_id FOR SHARE;
    IF NOT FOUND OR v_item.chat_id IS DISTINCT FROM v_resource OR v_item.kind = 'folder' THEN
        RAISE EXCEPTION USING HINT = 'message_file_not_here',
            MESSAGE = 'an attachment points at a file in its source chat''s folder';
    END IF;
    NEW.file_version := COALESCE(NEW.file_version, v_item.version);
    v_envelope := chat.workspace_version_envelope(v_item.id, NEW.file_version);
    IF v_envelope IS NULL THEN
        RAISE EXCEPTION USING HINT = 'message_file_not_here',
            MESSAGE = format('version %s of that file has no bytes to send', NEW.file_version);
    END IF;
    IF NEW.content_type IS DISTINCT FROM 'attachment' OR chat.attachment_text_envelope(NEW.content) IS DISTINCT FROM v_envelope THEN
        RAISE EXCEPTION USING HINT = 'message_file_envelope',
            MESSAGE = format('an attachment''s text is its file''s envelope: %s', v_envelope);
    END IF;
    -- ◇ 钉住条目现在那一版:写进历史(还没有的话)。改名、移动只升版本、不写历史,不记的话那一版的字节就只挂在条目上,
    -- 下一次改名以后 chat.workspace_version_blob 找不到它。写法同 workspace_replace_file_as 补旧版本那一句。
    IF NEW.file_version = v_item.version THEN
        INSERT INTO chat.workspace_item_versions (item_id, n, blob_id, content_type, size_bytes, made_by, made_at)
        SELECT v_item.id, v_item.version, v_item.blob_id, v_item.content_type, v_item.size_bytes, v_item.created_by, v_item.updated_at
     WHERE NOT EXISTS(SELECT 1 FROM chat.workspace_item_versions x WHERE x.item_id = v_item.id AND x.n = v_item.version)
        ON CONFLICT ON CONSTRAINT workspace_item_versions_pkey DO NOTHING;
    END IF;
    RETURN NEW;
END;
$function$;

-- Writes are closed: a message never names a Storage object.
CREATE OR REPLACE FUNCTION chat.validate_storage_reference_pair()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chat', 'storage', 'public', 'pg_catalog'
AS $function$
DECLARE
    bucket_value TEXT;
    name_value TEXT;
    presentation_value TEXT;
    presentation_lines TEXT[];
    presentation_url TEXT;
    request_host TEXT := lower(COALESCE(
        NULLIF(current_setting('request.headers', true), '')::jsonb ->> 'host', ''
    ));
    legacy_match TEXT[];
BEGIN
    IF TG_TABLE_NAME = 'messages' THEN
        -- Old chat-media cards are retired (20261110053000): a message never names a Storage object; files are sent through
        -- the attachments function, which puts them in the chat's folder.
        IF NEW.storage_bucket_id IS NOT NULL OR NEW.storage_object_name IS NOT NULL
           OR (NEW.content_type = 'attachment' AND NEW.content LIKE E'%\n[URL] %/storage/v1/object/public/chat-media/%') THEN
            RAISE EXCEPTION USING ERRCODE = '22023', HINT = 'legacy_attachment_retired',
                MESSAGE = 'a message cannot name a Storage object: send files through the attachments function';
        END IF;
        RETURN NEW;
    ELSIF TG_TABLE_NAME = 'chats' THEN
        bucket_value := NEW.avatar_storage_bucket_id;
        name_value := NEW.avatar_storage_object_name;
        presentation_value := NEW.avatar_url;
        IF bucket_value IS NULL AND presentation_value IS NOT NULL THEN
            legacy_match := regexp_match(
                presentation_value,
                '^https?://([A-Za-z0-9.-]+(?::[0-9]{1,5})?)/storage/v1/object/public/(avatars|chat-media)/([A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)$'
            );
            IF legacy_match IS NOT NULL THEN
                IF request_host = '' OR lower(legacy_match[1]) <> request_host THEN
                    RAISE EXCEPTION 'chat avatar requires an explicit canonical storage reference';
                END IF;
                NEW.avatar_storage_bucket_id := legacy_match[2];
                NEW.avatar_storage_object_name := legacy_match[3];
                bucket_value := NEW.avatar_storage_bucket_id;
                name_value := NEW.avatar_storage_object_name;
            ELSIF presentation_value LIKE '%/storage/v1/object/public/%' THEN
                RAISE EXCEPTION 'unparseable chat avatar cannot omit its canonical storage reference';
            END IF;
        END IF;
    ELSIF TG_TABLE_NAME = 'group_outputs' THEN
        bucket_value := NEW.storage_bucket_id;
        name_value := NEW.storage_object_name;
        presentation_value := NEW.url;
        IF bucket_value IS NULL AND presentation_value IS NOT NULL THEN
            legacy_match := regexp_match(
                presentation_value,
                '^https?://([A-Za-z0-9.-]+(?::[0-9]{1,5})?)/storage/v1/object/public/(avatars|chat-media)/([A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)$'
            );
            IF legacy_match IS NOT NULL THEN
                IF request_host = '' OR lower(legacy_match[1]) <> request_host THEN
                    RAISE EXCEPTION 'group output requires an explicit canonical storage reference';
                END IF;
                NEW.storage_bucket_id := legacy_match[2];
                NEW.storage_object_name := legacy_match[3];
                bucket_value := NEW.storage_bucket_id;
                name_value := NEW.storage_object_name;
            ELSIF presentation_value LIKE '%/storage/v1/object/public/%' THEN
                RAISE EXCEPTION 'unparseable group output cannot omit its canonical storage reference';
            END IF;
        END IF;
    ELSE
        RAISE EXCEPTION 'unsupported storage reference table %', TG_TABLE_NAME;
    END IF;

    IF (bucket_value IS NULL) <> (name_value IS NULL) THEN
        RAISE EXCEPTION 'storage reference pair must be both null or both set';
    END IF;
    IF bucket_value IS NOT NULL THEN
        PERFORM 1 FROM storage.objects o
        WHERE o.bucket_id = bucket_value AND o.name = name_value
        FOR KEY SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'storage reference target does not exist';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE INSERT (storage_bucket_id, storage_object_name) ON chat.messages FROM authenticated;

-- Readers of the old shape.
DROP FUNCTION chat.attachment_forward(text,text,text,text,text[],text,boolean,boolean,text);
CREATE OR REPLACE FUNCTION chat.attachment_forward(p_source_message_id text, p_message_id text, p_chat_id text, p_sender_user_id text, p_to_user_ids text[] DEFAULT '{}'::text[], p_thread_root_id text DEFAULT NULL::text, p_is_thread_root boolean DEFAULT false, p_is_whisper boolean DEFAULT false)
 RETURNS SETOF chat.messages_view
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
    v_existing chat.messages%ROWTYPE;
    v_placed RECORD;
    v_source_text TEXT;
    v_caption TEXT;
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chat.attachment_forward:' || p_message_id, 0));
    SELECT * INTO v_existing FROM chat.messages m WHERE m.id = p_message_id;
    IF FOUND THEN
        RETURN QUERY SELECT * FROM chat.send_message_idempotent(
            p_message_id, p_chat_id, p_sender_user_id, COALESCE(p_to_user_ids, '{}'), v_existing.content, 'attachment',
            NULL, p_thread_root_id, COALESCE(p_is_thread_root, false), COALESCE(p_is_whisper, false), NULL,
            v_existing.file_item_id, v_existing.file_version, p_source_message_id, v_existing.file_blob_id);
        RETURN;
    END IF;
    -- 先以调用者的身份读原消息(消息表的 RLS:看不到的历史、没发给你的悄悄话都读不到),与客户端 forwardCanonicalMessage
    -- 同一条判据(gugu apps/desktop/src/lib/chatCanonicalStorage.ts):读的是登录的那个人,以自己的 agent 转也一样。
    -- 撤回的由 definer 那一半拒。
    SELECT m.content INTO v_source_text FROM chat.messages m WHERE m.id = p_source_message_id AND m.deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING HINT = 'attachment_source_not_found',
            MESSAGE = format('message %s is not one you can read', p_source_message_id);
    END IF;
    SELECT * INTO v_placed FROM chat.attachment_place_forward(p_source_message_id, p_chat_id, p_sender_user_id, p_message_id, COALESCE(p_is_whisper, false));
    v_caption := chat.attachment_caption_of(v_source_text);
    RETURN QUERY
    SELECT * FROM chat.send_message_idempotent(
        p_message_id, p_chat_id, p_sender_user_id, COALESCE(p_to_user_ids, '{}'), v_placed.envelope || v_caption, 'attachment',
        NULL, p_thread_root_id, COALESCE(p_is_thread_root, false), COALESCE(p_is_whisper, false), NULL,
        v_placed.item_id, v_placed.item_version, p_source_message_id, v_placed.file_blob_id);
END;
$function$;

CREATE OR REPLACE FUNCTION chat.file_urls_as(p_refs jsonb, p_as_user_id text)
 RETURNS TABLE(item_id uuid, version integer, message_id text, current_version integer, chat_id text, file_name text, bucket_id text, object_name text, sha256 text, size_bytes bigint, content_type text, width integer, height integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor TEXT := chat.workspace_actor_for(p_as_user_id);
    v_messages TEXT[];
BEGIN
    IF jsonb_typeof(p_refs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_refs) > 200 THEN
        RAISE EXCEPTION 'file_urls_as: refs is an array of at most 200 {item_id, version} or {message_id}';
    END IF;
    SELECT array_agg(DISTINCT r.value ->> 'message_id') INTO v_messages
      FROM jsonb_array_elements(p_refs) AS r(value)
     WHERE r.value ->> 'message_id' IS NOT NULL
       AND chat.can_read_message(r.value ->> 'message_id', v_actor);
    RETURN QUERY
    WITH asked AS (
        SELECT CASE WHEN r.value ->> 'item_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN (r.value ->> 'item_id')::uuid END AS ref_item,
               CASE WHEN r.value ->> 'version' ~ '^[0-9]{1,9}$' THEN (r.value ->> 'version')::INTEGER END AS ref_version
          FROM jsonb_array_elements(p_refs) AS r(value)
    ), picked AS MATERIALIZED (
        -- Only the primary key can serve this filter, so the lookup stays bounded by the refs.
        SELECT m.id, m.chat_id, m.content, m.content_type, m.file_item_id, m.file_blob_id
          FROM chat.messages m
         WHERE m.id = ANY(v_messages) AND m.retracted_at IS NULL
    )
    SELECT DISTINCT w.id, COALESCE(a.ref_version, w.version), NULL::TEXT, w.version, w.chat_id, w.filename, b.bucket_id,
           b.object_name, b.sha256, b.size_bytes, b.content_type, size.width, size.height
      FROM asked a
      JOIN chat.workspace_items w ON w.id = a.ref_item
      JOIN chat.chats c ON c.id = w.chat_id AND c.kind IN ('group', 'topic', 'dm', 'ai')
      JOIN chat.file_blobs b ON b.id = chat.workspace_version_blob(w.id, COALESCE(a.ref_version, w.version))
      LEFT JOIN chat.file_contents size ON size.sha256 = b.sha256
     WHERE chat.is_chat_member(w.chat_id, v_actor)
    UNION
    SELECT NULL::UUID, NULL::INTEGER, m.id, NULL::INTEGER, m.chat_id,
           chat.attachment_envelope_name(m.content, b.size_bytes, b.content_type), b.bucket_id,
           b.object_name, b.sha256, b.size_bytes, b.content_type, size.width, size.height
      FROM picked m
      JOIN chat.file_blobs b ON b.id = m.file_blob_id
      LEFT JOIN chat.file_contents size ON size.sha256 = b.sha256;
END;
$function$;

DROP FUNCTION chat.attachment_legacy_source(text);
DROP FUNCTION chat.legacy_attachment_name(text);

DROP FUNCTION chat.send_friend_message_as_owner(text,text,text,text,text,text,text);
CREATE OR REPLACE FUNCTION chat.send_friend_message_as_owner(p_agent_user_id text, p_friend_user_id text, p_content text, p_request_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_owner TEXT := (SELECT auth.uid()::text);
    v_name TEXT;
    v_chat TEXT;
    v_id TEXT;
    v_existing chat.messages%ROWTYPE;
    v_source chat.message_agent_sends%ROWTYPE;
BEGIN
    IF v_owner IS NULL OR NOT EXISTS (SELECT 1 FROM identity.users WHERE id = v_owner AND type = 'human') THEN
        RAISE EXCEPTION 'Authenticated human owner is required' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(btrim(p_content), '') IS NULL OR NULLIF(btrim(p_request_id), '') IS NULL OR length(p_request_id) > 128 THEN
        RAISE EXCEPTION 'Message text and a request_id of at most 128 characters are required' USING ERRCODE = '22023';
    END IF;
    SELECT u.display_name INTO v_name FROM identity.users u
        WHERE u.id = p_agent_user_id AND u.type = 'agent' AND u.owner_user_id = v_owner FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Agent is not owned by this account' USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM identity.users WHERE id = p_friend_user_id AND type = 'human' AND id <> v_owner FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Selected person is not an owner friend' USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM identity.active_friendships WHERE user_a_id = LEAST(v_owner, p_friend_user_id)
        AND user_b_id = GREATEST(v_owner, p_friend_user_id) FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Selected person is not an owner friend' USING ERRCODE = '42501';
    END IF;

    -- Files go through send_friend_file_as_owner (the attachments function); this sends text only.

    -- Serialize the request before opening a DM: opening a new DM can already
    -- lock the owner's revision row, so taking this lock afterward could invert
    -- the order against a replay targeting a different DM.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('agent-owner-send:' || p_agent_user_id || ':' || p_request_id, 0));
    v_chat := chat.open_dm(p_friend_user_id);
    SELECT * INTO v_source FROM chat.message_agent_sends
        WHERE agent_user_id = p_agent_user_id AND request_id = p_request_id;
    IF FOUND THEN
        v_id := v_source.message_id;
        SELECT * INTO STRICT v_existing FROM chat.messages WHERE id = v_id;
        IF v_existing.chat_id IS DISTINCT FROM v_chat OR v_existing.sender_user_id IS DISTINCT FROM v_owner
           OR v_existing.content IS DISTINCT FROM p_content OR v_existing.content_type IS DISTINCT FROM 'text'
           OR v_source.agent_user_id IS DISTINCT FROM p_agent_user_id OR v_source.owner_user_id IS DISTINCT FROM v_owner THEN
            RAISE EXCEPTION 'Idempotency conflict: request_id was already used for a different send' USING ERRCODE = '23505';
        END IF;
    ELSE
        v_id := pg_catalog.gen_random_uuid()::text;
        SET CONSTRAINTS chat.message_agent_sends_message_id_fkey DEFERRED;
        INSERT INTO chat.message_agent_sends(message_id, owner_user_id, agent_user_id, request_id, agent_name)
            VALUES (v_id, v_owner, p_agent_user_id, p_request_id, v_name);
        INSERT INTO chat.messages(id, chat_id, sender_user_id, to_user_ids, content, content_type, client_message_id)
            VALUES (v_id, v_chat, v_owner, ARRAY[p_friend_user_id], p_content, 'text', v_id);
    END IF;
    RETURN jsonb_build_object('chat_id', v_chat, 'message_id', v_id, 'sender_user_id', v_owner, 'sent_by_agent', true);
END;
$function$;

CREATE OR REPLACE FUNCTION identity.storage_object_is_referenced(p_bucket_id text, p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT identity.feedback_screenshot_is_referenced(p_bucket_id, p_name)
        OR EXISTS (SELECT 1 FROM chat.file_blobs b WHERE b.bucket_id = p_bucket_id AND b.object_name = p_name AND chat.file_blob_in_use(b.id))
        OR EXISTS (SELECT 1 FROM chat.chats c WHERE c.avatar_storage_bucket_id = p_bucket_id AND c.avatar_storage_object_name = p_name)
        OR EXISTS (SELECT 1 FROM chat.group_outputs o WHERE o.storage_bucket_id = p_bucket_id AND o.storage_object_name = p_name);
$function$;

CREATE OR REPLACE FUNCTION chat.file_blob_held_until(p_blob_id uuid)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT CASE WHEN
        EXISTS(SELECT 1 FROM chat.file_temporary_transfers t WHERE t.blob_id=p_blob_id AND t.state='ready'
            AND t.serve_until>now() AND t.created_at>now()-interval '30 days' AND chat.file_temporary_current(t))
        OR EXISTS(SELECT 1 FROM chat.workspace_items w WHERE w.blob_id=p_blob_id
            AND NOT chat.file_transfer_reference_expired(p_blob_id,w.chat_id))
        OR EXISTS(SELECT 1 FROM chat.workspace_item_versions v JOIN chat.workspace_items w ON w.id=v.item_id
            WHERE v.blob_id=p_blob_id AND NOT chat.file_transfer_reference_expired(p_blob_id,w.chat_id))
        OR EXISTS(SELECT 1 FROM chat.file_blob_uploads u WHERE u.blob_id=p_blob_id AND u.expires_at>now())
        OR EXISTS(SELECT 1 FROM chat.messages m WHERE m.file_blob_id=p_blob_id
            AND NOT chat.file_transfer_reference_expired(p_blob_id,m.chat_id))
        OR EXISTS(SELECT 1 FROM chat.session_attachments a WHERE a.blob_id=p_blob_id AND a.revoked_at IS NULL)
        OR EXISTS(SELECT 1 FROM chat.file_blobs b WHERE b.id=p_blob_id AND (
            EXISTS(SELECT 1 FROM chat.chats c WHERE c.avatar_storage_bucket_id=b.bucket_id AND c.avatar_storage_object_name=b.object_name
                AND NOT chat.file_transfer_reference_expired(p_blob_id,c.id))
            OR EXISTS(SELECT 1 FROM chat.group_outputs o WHERE o.storage_bucket_id=b.bucket_id AND o.storage_object_name=b.object_name
                AND NOT chat.file_transfer_reference_expired(p_blob_id,o.chat_id))))
    OR EXISTS (SELECT 1 FROM chat.file_blobs b WHERE b.id=p_blob_id AND identity.feedback_screenshot_is_referenced(b.bucket_id,b.object_name)) THEN 'infinity'::timestamptz ELSE (
        -- Signed upload and download capabilities: the bytes must outlive them, and nothing fires when they lapse.
        SELECT max(v.expires_at) FROM chat.file_transfer_reservations v
         WHERE v.state IN ('reserved','issued') AND v.expires_at>now() AND (
            v.kind='upload' AND v.subject=(SELECT b.object_name FROM chat.file_blobs b WHERE b.id=p_blob_id AND b.bucket_id='temporary')
            OR v.kind='download' AND v.subject IN (SELECT 'object:'||o.id::text FROM chat.file_transfer_storage o WHERE o.blob_id=p_blob_id)))
    END
$function$;

CREATE OR REPLACE FUNCTION chat.conversation_release(p_chat text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE b uuid; n integer:=0;
BEGIN
    IF chat.file_transfer_group(p_chat) IS DISTINCT FROM p_chat OR NOT chat.conversation_gone(p_chat) THEN RETURN 0; END IF;
    FOR b IN
        WITH rooms AS (SELECT p_chat AS id UNION SELECT c.id FROM chat.chats c WHERE c.source_chat_id=p_chat)
        SELECT w.blob_id FROM chat.workspace_items w WHERE w.chat_id IN (SELECT id FROM rooms) AND w.blob_id IS NOT NULL
        UNION SELECT v.blob_id FROM chat.workspace_item_versions v JOIN chat.workspace_items w ON w.id=v.item_id
            WHERE w.chat_id IN (SELECT id FROM rooms) AND v.blob_id IS NOT NULL
        UNION SELECT m.file_blob_id FROM chat.messages m WHERE m.chat_id IN (SELECT id FROM rooms) AND m.file_blob_id IS NOT NULL
        UNION SELECT chat.file_blob_for_object(x.bucket_id,x.object_name) FROM (
            SELECT c.avatar_storage_bucket_id AS bucket_id,c.avatar_storage_object_name AS object_name FROM chat.chats c
             WHERE c.id IN (SELECT id FROM rooms) AND c.avatar_storage_object_name IS NOT NULL
            UNION SELECT o.storage_bucket_id,o.storage_object_name FROM chat.group_outputs o
             WHERE o.chat_id IN (SELECT id FROM rooms) AND o.storage_object_name IS NOT NULL) x
    LOOP
        CONTINUE WHEN b IS NULL;
        PERFORM chat.file_blob_enqueue(b);
        n:=n+1;
    END LOOP;
    RETURN n;
END $function$;

REVOKE ALL ON FUNCTION chat.messages_file_ref() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION chat.validate_storage_reference_pair() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION chat.attachment_forward(text,text,text,text,text[],text,boolean,boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.attachment_forward(text,text,text,text,text[],text,boolean,boolean) TO authenticated;
REVOKE ALL ON FUNCTION chat.file_urls_as(jsonb,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.file_urls_as(jsonb,text) TO authenticated;
REVOKE ALL ON FUNCTION chat.send_friend_message_as_owner(text,text,text,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION chat.send_friend_message_as_owner(text,text,text,text) TO authenticated;
REVOKE ALL ON FUNCTION identity.storage_object_is_referenced(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION identity.storage_object_is_referenced(text,text) TO service_role;
REVOKE ALL ON FUNCTION chat.file_blob_held_until(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION chat.conversation_release(text) FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
