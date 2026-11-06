-- Preserve original personal times and publish a separate, server-bounded sort tuple.
SET LOCAL ROLE postgres;
SET LOCAL lock_timeout = '5s';

-- Guard the known owners and FK parents before the ledger gate or any heads.
-- A newly discovered owner aborts this attempt instead of acquiring a late guard.
DO $clock_admission$
DECLARE owners text[]; conversations text[]; owner_id text;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT a.user_id ORDER BY a.user_id),ARRAY[]::text[]),
         COALESCE(array_agg(DISTINCT a.chat_id ORDER BY a.chat_id),ARRAY[]::text[])
    INTO owners,conversations FROM chat.native_personal_conversation_activity a;
  FOREACH owner_id IN ARRAY owners LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('identity:erase-human:' || owner_id,0));
  END LOOP;
  PERFORM 1 FROM identity.users u WHERE u.id=ANY(owners) ORDER BY u.id FOR KEY SHARE;
  PERFORM 1 FROM chat.chats c WHERE c.id=ANY(conversations) ORDER BY c.id FOR KEY SHARE;
  LOCK TABLE chat.native_conversation_publications IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM chat.native_personal_conversation_activity a
      WHERE NOT a.user_id=ANY(owners) OR NOT a.chat_id=ANY(conversations)) THEN
    RAISE EXCEPTION 'native_personal_clock_admission_changed' USING ERRCODE='40001';
  END IF;
  PERFORM chat.lock_revision_heads(ARRAY(SELECT DISTINCT a.user_id
    FROM chat.native_personal_conversation_activity a ORDER BY a.user_id));
  -- Do not wait for an old reader while holding heads. Abort the release cleanly.
  LOCK TABLE chat.native_personal_conversation_activity IN ACCESS EXCLUSIVE MODE NOWAIT;
END;
$clock_admission$;

ALTER TABLE chat.native_conversation_publications
  ADD COLUMN sort_at timestamptz CHECK (pg_catalog.isfinite(sort_at)),
  ADD COLUMN personal_activity_applied_revision bigint CHECK (personal_activity_applied_revision>0),
  ADD CONSTRAINT native_publication_activity_has_sort
    CHECK (personal_activity_applied_revision IS NULL OR sort_at IS NOT NULL);
ALTER TABLE chat.native_personal_conversation_activity
  ADD COLUMN native_personal_sort_at timestamptz CHECK (pg_catalog.isfinite(native_personal_sort_at)),
  ADD COLUMN legacy_personal_sort_at timestamptz CHECK (pg_catalog.isfinite(legacy_personal_sort_at)),
  ADD COLUMN legacy_sort_migrated_at timestamptz CHECK (pg_catalog.isfinite(legacy_sort_migrated_at)),
  ADD CONSTRAINT native_personal_legacy_sort_pair
    CHECK ((legacy_personal_sort_at IS NULL)=(legacy_sort_migrated_at IS NULL)),
  ADD CONSTRAINT native_personal_sort_original_bound
    CHECK (native_personal_sort_at<=native_personal_activity_at),
  ADD CONSTRAINT native_personal_legacy_sort_bound
    CHECK (legacy_personal_sort_at<=legacy_sort_migrated_at
      AND legacy_personal_sort_at<=native_personal_sort_at);
REVOKE ALL ON chat.native_conversation_publications,chat.native_personal_conversation_activity
  FROM PUBLIC,anon,authenticated,service_role,gugu_files;

-- All admission, parent, head and DDL waits are over. One clock value covers
-- only established old activity, never unknown ledger-only personal history.
DO $clock_legacy$
DECLARE cutoff timestamptz; old record; activity_revision bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM chat.native_personal_conversation_activity a
      WHERE a.native_personal_sort_at IS NULL) THEN RETURN; END IF;
  cutoff := clock_timestamp();
  FOR old IN SELECT a.user_id,a.chat_id,a.native_personal_activity_at
      FROM chat.native_personal_conversation_activity a
      WHERE a.native_personal_sort_at IS NULL ORDER BY a.user_id,a.chat_id LOOP
    activity_revision := chat.publish_user_revision(old.user_id,'chat_members_changed',
      jsonb_build_object('chat_id',old.chat_id,'user_id',old.user_id,'kind','own'),false);
    UPDATE chat.native_personal_conversation_activity a SET
      legacy_personal_sort_at=least(old.native_personal_activity_at,cutoff),
      legacy_sort_migrated_at=cutoff,
      native_personal_sort_at=least(old.native_personal_activity_at,cutoff),
      native_personal_activity_revision=activity_revision
      WHERE a.user_id=old.user_id AND a.chat_id=old.chat_id;
  END LOOP;
END;
$clock_legacy$;
ALTER TABLE chat.native_personal_conversation_activity
  ALTER COLUMN native_personal_sort_at SET NOT NULL;

CREATE FUNCTION chat.native_personal_sort_time(p_original timestamptz,p_received timestamptz)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN
  IF p_received IS NULL OR NOT pg_catalog.isfinite(p_received) THEN
    RAISE EXCEPTION 'native_personal_receive_time_invalid' USING ERRCODE='22023';
  END IF;
  RETURN least(chat.native_personal_activity_time(p_original),p_received);
END;
$$;
REVOKE ALL ON FUNCTION chat.native_personal_sort_time(timestamptz,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role,gugu_files;

-- A call can have compiled the old native body before waiting on its owner guard.
-- Reject a new old-body admission after cutover; its unchanged RPC is retryable.
-- Existing-key attempts still reach original deduplication/conflict checks.
-- Privileged history fixtures/operators without a caller cannot create activity
-- through this table; retained metadata is still not a personal admission.
CREATE FUNCTION chat.guard_native_personal_sort_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.sort_at IS NULL AND auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM chat.native_conversation_publications p
      WHERE (p.device_id,p.session_id,p.message_id)=(NEW.device_id,NEW.session_id,NEW.message_id)
  ) THEN
    RAISE EXCEPTION 'native_personal_clock_upgrade_retry' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION chat.guard_native_personal_sort_admission()
  FROM PUBLIC,anon,authenticated,service_role,gugu_files;
CREATE TRIGGER native_personal_sort_admission BEFORE INSERT ON chat.native_conversation_publications
  FOR EACH ROW EXECUTE FUNCTION chat.guard_native_personal_sort_admission();

CREATE OR REPLACE FUNCTION chat.publish_native_conversation_message(p_device_id text, p_agent_user_id text,
  p_session_id text, p_message_id text, p_chat_id text, p_occurred_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  caller text := auth.uid()::text;
  inserted boolean;
  prior chat.native_conversation_publications%ROWTYPE;
  activity_time timestamptz;
  activity_revision bigint;
  received_at timestamptz;
  sort_time timestamptz;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'native_conversation_publication_denied' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('identity:erase-human:' || caller,0));
  IF p_occurred_at IS NULL OR NOT EXISTS (
    SELECT 1 FROM identity.users a JOIN identity.gugu_devices d ON d.device_id = a.device_id
      JOIN identity.users owner ON owner.id = caller AND owner.type = 'human' AND owner.removed_at IS NULL
    WHERE a.id = p_agent_user_id AND a.type = 'agent' AND a.owner_user_id = caller AND a.removed_at IS NULL
      AND d.device_id = p_device_id AND d.user_id::text = caller
  ) OR NOT EXISTS (
    SELECT 1 FROM chat.chats c WHERE c.id = p_chat_id AND c.kind = 'dm' AND c.status = 'active'
      AND EXISTS (SELECT 1 FROM chat.active_members m WHERE m.chat_id = c.id AND m.user_id = caller)
      AND EXISTS (SELECT 1 FROM chat.active_members m WHERE m.chat_id = c.id AND m.user_id = p_agent_user_id)
      AND (SELECT count(*) FROM chat.chat_members m WHERE m.chat_id = c.id) = 2
  ) THEN RAISE EXCEPTION 'native_conversation_publication_denied' USING ERRCODE = '42501'; END IF;
  -- Keep the reviewed #201 admission order. Both new activity FKs have already
  -- taken their parent KEY SHARE before inbox/member admission can acquire heads.
  PERFORM 1 FROM identity.gugu_devices d WHERE d.device_id = p_device_id FOR KEY SHARE;
  PERFORM 1 FROM identity.users u WHERE u.id IN (caller,p_agent_user_id) ORDER BY u.id FOR KEY SHARE;
  PERFORM 1 FROM chat.chats c WHERE c.id = p_chat_id FOR KEY SHARE;
  received_at := clock_timestamp();
  sort_time := chat.native_personal_sort_time(p_occurred_at,received_at);
  INSERT INTO chat.native_conversation_publications(owner_user_id,device_id,session_id,message_id,agent_user_id,chat_id,occurred_at,published_at,sort_at)
    VALUES(caller,p_device_id,p_session_id,p_message_id,p_agent_user_id,p_chat_id,p_occurred_at,received_at,sort_time)
    ON CONFLICT (device_id,session_id,message_id) DO NOTHING;
  inserted := FOUND;
  IF inserted THEN
    UPDATE chat.chat_members m SET inbox_published_at = clock_timestamp()
      WHERE m.chat_id = p_chat_id AND m.user_id = caller AND m.inbox_published_at IS NULL;
    -- This helper first holds the complete existing recipient head set. Do not
    -- add member/chat locks or discover further FK parents after this point.
    PERFORM chat.restore_conversation_list_rows(p_chat_id, ARRAY[caller]);
    activity_time := chat.native_personal_activity_time(p_occurred_at);
    activity_revision := chat.publish_user_revision(caller,'chat_members_changed',
      jsonb_build_object('chat_id',p_chat_id,'user_id',caller,'kind','own'),false);
    INSERT INTO chat.native_personal_conversation_activity(user_id,chat_id,
      native_personal_activity_at,native_personal_activity_revision,native_personal_sort_at)
      VALUES(caller,p_chat_id,activity_time,activity_revision,sort_time)
      ON CONFLICT (user_id,chat_id) DO UPDATE SET
        native_personal_activity_at = greatest(chat.native_personal_conversation_activity.native_personal_activity_at,
          EXCLUDED.native_personal_activity_at),
        native_personal_activity_revision = EXCLUDED.native_personal_activity_revision,
        native_personal_sort_at = greatest(chat.native_personal_conversation_activity.native_personal_sort_at,
          EXCLUDED.native_personal_sort_at);
    UPDATE chat.native_conversation_publications p
      SET personal_activity_applied_revision=activity_revision
      WHERE (p.device_id,p.session_id,p.message_id)=(p_device_id,p_session_id,p_message_id);
  ELSE
    SELECT * INTO prior FROM chat.native_conversation_publications p
      WHERE p.device_id = p_device_id AND p.session_id = p_session_id AND p.message_id = p_message_id;
    IF (prior.owner_user_id,prior.agent_user_id,prior.chat_id,prior.occurred_at) IS DISTINCT FROM (caller,p_agent_user_id,p_chat_id,p_occurred_at) THEN
      RAISE EXCEPTION 'native_conversation_publication_conflict' USING ERRCODE = '23505';
    END IF;
  END IF;
  IF NOT identity.user_is_live(caller) OR NOT identity.user_is_live(p_agent_user_id) THEN
    RAISE EXCEPTION 'native_conversation_publication_denied' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object('chat_id',p_chat_id,'already',NOT inserted,
    'account_revision',COALESCE((SELECT h.revision FROM chat.account_revision_heads h WHERE h.user_id = caller),0)::text);
END;
$$;
REVOKE ALL ON FUNCTION chat.publish_native_conversation_message(text,text,text,text,text,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.publish_native_conversation_message(text,text,text,text,text,timestamptz) TO authenticated;

-- Append the C field while preserving every v1 TABLE column and grant.
DROP FUNCTION chat.list_conversation_memberships(text[]);
CREATE FUNCTION chat.list_conversation_memberships(p_chat_ids text[])
RETURNS TABLE(chat_id text,user_id text,last_read_seq bigint,is_marked_unread boolean,version integer,
  notification_level text,is_pinned boolean,updated_at timestamptz,joined_at timestamptz,
  inbox_published_at timestamptz,role text,conversation_deleted_at timestamptz,conversation_hidden_at timestamptz,historical_only boolean,
  native_personal_activity_at timestamptz,native_personal_activity_revision text,personal_state_observed_revision text,
  native_personal_sort_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE viewer text := auth.uid()::text;
BEGIN
  IF viewer IS NULL OR NOT identity.user_is_live(viewer) THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_chat_ids IS NULL THEN RAISE EXCEPTION 'chat ids are required' USING ERRCODE = '22023'; END IF;
  RETURN QUERY SELECT m.chat_id,m.user_id,m.last_read_seq,m.is_marked_unread,m.version,
      m.notification_level,m.is_pinned,m.updated_at,m.joined_at,m.inbox_published_at,m.role,
      CASE WHEN m.user_id = viewer THEN m.conversation_deleted_at END,
      CASE WHEN m.user_id = viewer THEN state.conversation_hidden_at END,
      NOT identity.user_is_live(m.user_id),
      CASE WHEN m.user_id = viewer THEN activity.native_personal_activity_at END,
      CASE WHEN m.user_id = viewer THEN COALESCE(activity.native_personal_activity_revision,0)::text END,
      CASE WHEN m.user_id = viewer THEN COALESCE((SELECT h.revision FROM chat.account_revision_heads h WHERE h.user_id = viewer),0)::text END,
      CASE WHEN m.user_id = viewer THEN activity.native_personal_sort_at END
    FROM chat.chat_members m JOIN chat.chats c ON c.id = m.chat_id
    JOIN chat.active_members own ON own.chat_id = c.id AND own.user_id = viewer
    LEFT JOIN chat.conversation_list_state state ON state.chat_id = m.chat_id AND state.user_id = viewer AND m.user_id = viewer
    LEFT JOIN chat.native_personal_conversation_activity activity
      ON activity.chat_id = m.chat_id AND activity.user_id = viewer AND m.user_id = viewer
    WHERE c.id = ANY(p_chat_ids) AND (identity.user_is_live(m.user_id)
      OR c.kind IN ('dm','ai') AND EXISTS (SELECT 1 FROM identity.users u WHERE u.id = m.user_id
        AND u.type = 'agent' AND u.owner_user_id = viewer));
END;
$$;
REVOKE ALL ON FUNCTION chat.list_conversation_memberships(text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION chat.list_conversation_memberships(text[]) TO authenticated;

DO $snapshot_clock$
DECLARE
  target regprocedure := 'chat.sync_snapshot()'::regprocedure;
  definition text;
  marker text := 'm.native_personal_activity_at, m.native_personal_activity_revision, m.personal_state_observed_revision';
  prior_acl aclitem[];
  permission record;
BEGIN
  SELECT pg_get_functiondef(p.oid),COALESCE(p.proacl,acldefault('f',p.proowner))
    INTO definition,prior_acl FROM pg_proc p WHERE p.oid = target;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker) <> 1 THEN
    RAISE EXCEPTION 'Unexpected native clock snapshot predecessor';
  END IF;
  definition := replace(definition,marker,
    marker || ', m.native_personal_sort_at');
  EXECUTE definition;
  FOR permission IN SELECT grantee,bool_or(is_grantable) AS grantable FROM aclexplode(prior_acl)
    WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s',target,
      CASE WHEN permission.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
      CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END;
$snapshot_clock$;

NOTIFY pgrst, 'reload schema';
