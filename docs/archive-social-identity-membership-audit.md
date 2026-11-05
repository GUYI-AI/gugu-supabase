# Membership read inventory

Backend baseline: `0bbb77dbdd268ff9211c10a78cfb62a72b3e7f87`. Client audit baseline: `90143d0fcaf0053a7fd1953c840bc8701a750fdb`.

Published migrations are immutable. The new release redirects installed function reads to `chat.active_members`, including definer functions, and replaces parsed RLS read references separately. It preserves function signatures, owners, volatility and ACLs. Membership DML targets remain the physical table; physical reads used only for group structure invariants remain physical. The topic live-participant half of the invariant is redirected. `chat.historical_dm_peer` is the explicit authorized historical display projection of retained DM seats, never membership permission.

This is a source inventory, not installation/runtime evidence. Catalog assertions in `archiveSocialIdentity.test.ts` independently reject surviving live-reader/policy bypasses after installation. Old migration occurrences below are historical definitions; later releases supersede them. Edge function and file-service source contain no direct `chat_members` reads on this baseline.

## Backend source occurrences

| Source | Owning function or DDL | Source read/write |
|---|---|---|
| `supabase/migrations/20261021000000_foundation.sql:131` | `chat.add_group_agent` | `INSERT INTO chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261021000000_foundation.sql:448` | `chat.apply_agent_flood_rule` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:463` | `chat.apply_agent_flood_rule` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:489` | `chat.apply_agent_flood_rule` | `UPDATE chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:1639` | `chat.broadcast_to_chat_member_user_events` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:1675` | `chat.caller_may_probe_chat` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:1682` | `chat.caller_may_probe_chat` | `JOIN chat.chat_members cm2 ON cm2.chat_id = t.source_chat_id` |
| `supabase/migrations/20261021000000_foundation.sql:1802` | `chat.can_see_delivery_of` | `JOIN chat.chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = v_me` |
| `supabase/migrations/20261021000000_foundation.sql:1833` | `DDL / policy / catalog patch` | `COMMENT ON FUNCTION chat.can_see_topic(p_chat_id text) IS '能看见来源线的人就看得见这条话题(spec:可见继承来源)。它只管「看得见」,不管「收不收通知」——通知只到 chat_members 里的参与者,两者严格分开。';` |
| `supabase/migrations/20261021000000_foundation.sql:1847` | `chat.can_see_topic_message` | `JOIN chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:1942` | `chat.chat_members_broadcast` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:2019` | `chat.chats_membership_invariants` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:2023` | `chat.chats_membership_invariants` | `FROM chat.chat_members WHERE chat_id = affected_chat_id;` |
| `supabase/migrations/20261021000000_foundation.sql:2092` | `chat.chats_status_invariants` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:2095` | `chat.chats_status_invariants` | `SELECT count(*) INTO member_count_val FROM chat.chat_members WHERE chat_id = NEW.id;` |
| `supabase/migrations/20261021000000_foundation.sql:2201` | `chat.cleanup_removed_group_agent` | `DELETE FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:2283` | `chat.create_gugu_group` | `INSERT INTO chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261021000000_foundation.sql:2306` | `chat.create_gugu_group` | `INSERT INTO chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261021000000_foundation.sql:2438` | `chat.create_topic` | `INSERT INTO chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261021000000_foundation.sql:2492` | `chat.current_user_group_role` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:2542` | `chat.decide_agent_group_invitation` | `SELECT 1 FROM chat.chat_members WHERE chat_id = v_group.id AND user_id = v_inv.inviter_owner_user_id AND role IN ('owner', 'admin')` |
| `supabase/migrations/20261021000000_foundation.sql:2548` | `chat.decide_agent_group_invitation` | `SELECT count(*) INTO v_count FROM chat.chat_members WHERE chat_id = v_group.id;` |
| `supabase/migrations/20261021000000_foundation.sql:2550` | `chat.decide_agent_group_invitation` | `SELECT 1 FROM chat.chat_members WHERE chat_id = v_group.id AND user_id = member.id` |
| `supabase/migrations/20261021000000_foundation.sql:2553` | `chat.decide_agent_group_invitation` | `INSERT INTO chat.chat_members(chat_id, user_id, role)` |
| `supabase/migrations/20261021000000_foundation.sql:2563` | `chat.decide_agent_group_invitation` | `-- 入群灰字由 chat_members 的语句级触发器在上面那条 INSERT 里先写,这一条排在它后面;` |
| `supabase/migrations/20261021000000_foundation.sql:2629` | `chat.decide_group_join` | `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES (v_req.chat_id, v_req.requester_user_id, 'member')` |
| `supabase/migrations/20261021000000_foundation.sql:2740` | `chat.enforce_agent_flood_passive` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:2754` | `chat.enforce_agent_flood_passive` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:2779` | `chat.enforce_agent_flood_passive` | `UPDATE chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:2828` | `chat.enforce_group_member_limit` | `IF EXISTS (SELECT 1 FROM chat.chat_members cm WHERE cm.chat_id = NEW.chat_id AND cm.user_id = NEW.user_id) THEN` |
| `supabase/migrations/20261021000000_foundation.sql:2831` | `chat.enforce_group_member_limit` | `SELECT count(*) INTO v_count FROM chat.chat_members cm WHERE cm.chat_id = NEW.chat_id;` |
| `supabase/migrations/20261021000000_foundation.sql:2911` | `chat.enqueue_agent_deliver_device_command` | `JOIN chat.chat_members cm ON cm.chat_id = c.id` |
| `supabase/migrations/20261021000000_foundation.sql:3730` | `chat.get_or_create_agent_social_group` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:3735` | `chat.get_or_create_agent_social_group` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:3741` | `chat.get_or_create_agent_social_group` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:3764` | `chat.get_or_create_agent_social_group` | `INSERT INTO chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261021000000_foundation.sql:3865` | `chat.get_or_create_dm` | `SELECT 1 FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:3870` | `chat.get_or_create_dm` | `SELECT 1 FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:3876` | `chat.get_or_create_dm` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:3895` | `chat.get_or_create_dm` | `INSERT INTO chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261021000000_foundation.sql:3938` | `chat.group_add_denial` | `IF EXISTS (SELECT 1 FROM chat.chat_members cm WHERE cm.chat_id = p_chat_id AND cm.user_id = p_user_id) THEN` |
| `supabase/migrations/20261021000000_foundation.sql:3943` | `chat.group_add_denial` | `FROM chat.chat_members cm WHERE cm.chat_id = p_chat_id AND cm.user_id = p_actor_user_id;` |
| `supabase/migrations/20261021000000_foundation.sql:3948` | `chat.group_add_denial` | `AND NOT EXISTS (SELECT 1 FROM chat.chat_members cm WHERE cm.chat_id = p_chat_id)) THEN` |
| `supabase/migrations/20261021000000_foundation.sql:3983` | `chat.group_add_denial` | `SELECT count(*) INTO v_count FROM chat.chat_members cm WHERE cm.chat_id = p_chat_id;` |
| `supabase/migrations/20261021000000_foundation.sql:4110` | `chat.gugu_can_send_as` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:4225` | `chat.gugu_decision_events_vote_scope_chk` | `SELECT 1 FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:4337` | `chat.history_floor` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:4341` | `chat.history_floor` | `JOIN chat.chat_members cm ON cm.chat_id = t.source_chat_id AND cm.user_id = p_actor` |
| `supabase/migrations/20261021000000_foundation.sql:4389` | `chat.import_agent_session_history` | `AND (SELECT count(*) FROM chat.chat_members cm WHERE cm.chat_id = c.id) = 2` |
| `supabase/migrations/20261021000000_foundation.sql:4439` | `chat.import_agent_session_history` | `UPDATE chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:4524` | `chat.is_chat_member` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:4575` | `chat.is_member` | `SELECT 1 FROM chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:4648` | `chat.join_public_group` | `-- #1240 fix：限定 chat_members.chat_id，避免与 RETURNS TABLE 的 OUT-col chat_id 歧义(42702)。` |
| `supabase/migrations/20261021000000_foundation.sql:4649` | `chat.join_public_group` | `select exists(select 1 from chat.chat_members where chat_members.chat_id = v_chat_id and user_id = v_current_user_id)` |
| `supabase/migrations/20261021000000_foundation.sql:4649` | `chat.join_public_group` | `select exists(select 1 from chat.chat_members where chat_members.chat_id = v_chat_id and user_id = v_current_user_id)` |
| `supabase/migrations/20261021000000_foundation.sql:4667` | `chat.join_public_group` | `-- #1240 fix：同上限定 chat_members.chat_id。` |
| `supabase/migrations/20261021000000_foundation.sql:4668` | `chat.join_public_group` | `select count(*) into v_count from chat.chat_members where chat_members.chat_id = v_chat_id;` |
| `supabase/migrations/20261021000000_foundation.sql:4668` | `chat.join_public_group` | `select count(*) into v_count from chat.chat_members where chat_members.chat_id = v_chat_id;` |
| `supabase/migrations/20261021000000_foundation.sql:4674` | `chat.join_public_group` | `insert into chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261021000000_foundation.sql:4707` | `chat.join_topic_participants` | `INSERT INTO chat.chat_members (chat_id, user_id, role, joined_ingest_seq)` |
| `supabase/migrations/20261021000000_foundation.sql:4715` | `chat.join_topic_participants` | `INSERT INTO chat.chat_members (chat_id, user_id, role, joined_ingest_seq)` |
| `supabase/migrations/20261021000000_foundation.sql:4744` | `chat.leave_topics_of_source_line` | `DELETE FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:4795` | `chat.list_agent_group_invitations` | `target.type = 'agent' AND NOT EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = i.chat_id AND m.user_id = i.decision_user_id),` |
| `supabase/migrations/20261021000000_foundation.sql:4867` | `chat.list_member_ids` | `FROM chat.chat_members cm WHERE cm.chat_id = p_chat_id;` |
| `supabase/migrations/20261021000000_foundation.sql:4916` | `chat.list_my_chats_as` | `FROM chat.chat_members mine` |
| `supabase/migrations/20261021000000_foundation.sql:4954` | `chat.list_owner_groups_as` | `(SELECT count(*)::INTEGER FROM chat.chat_members cm WHERE cm.chat_id = c.id),` |
| `supabase/migrations/20261021000000_foundation.sql:4955` | `chat.list_owner_groups_as` | `EXISTS (SELECT 1 FROM chat.chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = v_actor),` |
| `supabase/migrations/20261021000000_foundation.sql:4957` | `chat.list_owner_groups_as` | `FROM chat.chat_members mine` |
| `supabase/migrations/20261021000000_foundation.sql:5019` | `chat.list_topics_of_chat` | `(SELECT count(*) FROM chat.chat_members cm WHERE cm.chat_id = t.id),` |
| `supabase/migrations/20261021000000_foundation.sql:5064` | `chat.list_unread_locators` | `FROM chat.chat_members member` |
| `supabase/migrations/20261021000000_foundation.sql:5074` | `chat.list_unread_locators` | `JOIN chat.chat_members member` |
| `supabase/migrations/20261021000000_foundation.sql:5086` | `chat.list_unread_locators` | `JOIN chat.chat_members member ON member.chat_id = root.chat_id AND member.user_id = v_user` |
| `supabase/migrations/20261021000000_foundation.sql:5139` | `chat.list_unread_locators` | `JOIN chat.chat_members member` |
| `supabase/migrations/20261021000000_foundation.sql:5174` | `chat.lock_chat_revision_recipients` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:5215` | `chat.lookup_public_group` | `(select count(*)::integer from chat.chat_members cm_count where cm_count.chat_id = c.id),` |
| `supabase/migrations/20261021000000_foundation.sql:5221` | `chat.lookup_public_group` | `left join chat.chat_members cm_self on cm_self.chat_id = c.id and cm_self.user_id = v_current_user_id` |
| `supabase/migrations/20261021000000_foundation.sql:5295` | `chat.mark_read` | `UPDATE chat.chat_members AS member` |
| `supabase/migrations/20261021000000_foundation.sql:5332` | `chat.mark_stream_read` | `RETURN QUERY UPDATE chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:5402` | `chat.mark_unread` | `UPDATE chat.chat_members AS member` |
| `supabase/migrations/20261021000000_foundation.sql:5864` | `chat.notify_agent_of_reaction` | `JOIN chat.chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = m.sender_user_id` |
| `supabase/migrations/20261021000000_foundation.sql:5975` | `chat.open_dm` | `UPDATE chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:6115` | `chat.publish_group_join_request_revision` | `SELECT member.user_id AS id FROM chat.chat_members member` |
| `supabase/migrations/20261021000000_foundation.sql:6147` | `chat.publish_membership_revision` | `SELECT cm.user_id FROM chat.chat_members cm WHERE cm.chat_id = target_chat_id` |
| `supabase/migrations/20261021000000_foundation.sql:6477` | `chat.record_message_agent_wakes` | `JOIN chat.chat_members cm ON cm.chat_id = c.id` |
| `supabase/migrations/20261021000000_foundation.sql:6545` | `chat.request_agent_friend_contact` | `AND (SELECT count(*) FROM chat.chat_members m WHERE m.chat_id = c.id) = 3` |
| `supabase/migrations/20261021000000_foundation.sql:6546` | `chat.request_agent_friend_contact` | `AND NOT EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = c.id AND m.user_id <> ALL(ARRAY[v_me, p_agent_user_id, p_friend_user_id]))` |
| `supabase/migrations/20261021000000_foundation.sql:6547` | `chat.request_agent_friend_contact` | `AND EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = c.id AND m.user_id = v_me AND m.role = 'owner')` |
| `supabase/migrations/20261021000000_foundation.sql:6555` | `chat.request_agent_friend_contact` | `AND (SELECT count(*) FROM chat.chat_members m WHERE m.chat_id = c.id) = 2` |
| `supabase/migrations/20261021000000_foundation.sql:6556` | `chat.request_agent_friend_contact` | `AND NOT EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = c.id AND m.user_id <> ALL(ARRAY[v_me, p_agent_user_id]))` |
| `supabase/migrations/20261021000000_foundation.sql:6557` | `chat.request_agent_friend_contact` | `AND EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = c.id AND m.user_id = v_me AND m.role = 'owner')` |
| `supabase/migrations/20261021000000_foundation.sql:6568` | `chat.request_agent_friend_contact` | `INSERT INTO chat.chat_members(chat_id, user_id, role) VALUES (v_chat_id, v_me, 'owner'), (v_chat_id, p_agent_user_id, 'member');` |
| `supabase/migrations/20261021000000_foundation.sql:6607` | `chat.request_agent_group_invitation` | `IF EXISTS (SELECT 1 FROM chat.chat_members WHERE chat_id = v_group.id AND user_id = v_target.id) THEN` |
| `supabase/migrations/20261021000000_foundation.sql:6657` | `chat.request_group_join` | `if exists (select 1 from chat.chat_members where chat_id = v_chat_id and user_id = v_uid) then` |
| `supabase/migrations/20261021000000_foundation.sql:6674` | `chat.request_group_join` | `select count(*) into v_count from chat.chat_members where chat_id = v_chat_id;` |
| `supabase/migrations/20261021000000_foundation.sql:6676` | `chat.request_group_join` | `insert into chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261021000000_foundation.sql:6715` | `chat.request_group_join_by_id` | `if exists (select 1 from chat.chat_members cm where cm.chat_id = v_chat_id and cm.user_id = v_uid) then` |
| `supabase/migrations/20261021000000_foundation.sql:6753` | `chat.require_agent_group_inviter` | `OR NOT EXISTS (SELECT 1 FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = p_agent_id)` |
| `supabase/migrations/20261021000000_foundation.sql:6754` | `chat.require_agent_group_inviter` | `OR NOT EXISTS (SELECT 1 FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = p_owner_id) THEN` |
| `supabase/migrations/20261021000000_foundation.sql:6758` | `chat.require_agent_group_inviter` | `SELECT 1 FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = p_owner_id AND role IN ('owner', 'admin')` |
| `supabase/migrations/20261021000000_foundation.sql:6789` | `chat.search_discoverable_groups` | `(select count(*)::integer from chat.chat_members m where m.chat_id = c.id) as member_count,` |
| `supabase/migrations/20261021000000_foundation.sql:6798` | `chat.search_discoverable_groups` | `left join chat.chat_members cm_self` |
| `supabase/migrations/20261021000000_foundation.sql:6817` | `chat.search_discoverable_groups` | `from chat.chat_members m` |
| `supabase/migrations/20261021000000_foundation.sql:7530` | `chat.undo_agent_flood_adjustment` | `UPDATE chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:8062` | `chat.workspace_is_chat_admin` | `JOIN chat.chat_members m ON m.chat_id = g.id AND m.user_id = p_actor AND m.role IN ('owner', 'admin')` |
| `supabase/migrations/20261021000000_foundation.sql:8511` | `chat.workspace_placed_for` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:9203` | `identity.assert_device_command_post_context` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:9616` | `identity.can_view_agent_runtime_state` | `FROM chat.chat_members cm_self` |
| `supabase/migrations/20261021000000_foundation.sql:9617` | `identity.can_view_agent_runtime_state` | `JOIN chat.chat_members cm_agent ON cm_agent.chat_id = cm_self.chat_id` |
| `supabase/migrations/20261021000000_foundation.sql:10168` | `identity.complete_agent_provision_pre_adopt_7199` | `UPDATE chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:10272` | `identity.eject_agent_group_member_after_friendship_delete` | `DELETE FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:10337` | `identity.erase_human_account` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:10344` | `identity.erase_human_account` | `PERFORM 1 FROM chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:10352` | `identity.erase_human_account` | `SELECT 1 FROM chat.chat_members live_peer` |
| `supabase/migrations/20261021000000_foundation.sql:10363` | `identity.erase_human_account` | `FROM chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:10367` | `identity.erase_human_account` | `FROM chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:10373` | `identity.erase_human_account` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:10381` | `identity.erase_human_account` | `UPDATE chat.chat_members SET role = 'member', updated_at = now()` |
| `supabase/migrations/20261021000000_foundation.sql:10387` | `identity.erase_human_account` | `UPDATE chat.chat_members SET role = 'owner', updated_at = now()` |
| `supabase/migrations/20261021000000_foundation.sql:10389` | `identity.erase_human_account` | `UPDATE chat.chat_members SET role = 'member', updated_at = now()` |
| `supabase/migrations/20261021000000_foundation.sql:10583` | `identity.fan_agent_presence_to_viewers` | `FROM chat.chat_members cm_agent` |
| `supabase/migrations/20261021000000_foundation.sql:10584` | `identity.fan_agent_presence_to_viewers` | `JOIN chat.chat_members cm_self ON cm_self.chat_id = cm_agent.chat_id` |
| `supabase/migrations/20261021000000_foundation.sql:10740` | `identity.finalize_agent_team` | `UPDATE chat.chat_members SET listen_mode = r.listen_modes[1], updated_at = now()` |
| `supabase/migrations/20261021000000_foundation.sql:10819` | `identity.get_agent_join_context` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:10840` | `identity.get_agent_join_context` | `UPDATE chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:10847` | `identity.get_agent_join_context` | `UPDATE chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:10976` | `identity.get_thread_messages` | `SELECT 1 FROM chat.chat_members me` |
| `supabase/migrations/20261021000000_foundation.sql:11533` | `identity.mark_read_on_deliver` | `PERFORM 1 FROM chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:11560` | `identity.mark_read_on_deliver` | `FROM chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:11580` | `identity.mark_read_on_deliver` | `UPDATE chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:11802` | `identity.prepare_agent_provision_legacy_7199` | `PERFORM 1 FROM chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:12205` | `identity.provision_taskpage_agent` | `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode)` |
| `supabase/migrations/20261021000000_foundation.sql:12225` | `identity.provision_taskpage_agent` | `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode)` |
| `supabase/migrations/20261021000000_foundation.sql:12230` | `identity.provision_taskpage_agent` | `UPDATE chat.chat_members SET listen_mode = 'active'` |
| `supabase/migrations/20261021000000_foundation.sql:12372` | `identity.publish_identity_display_revision` | `FROM chat.chat_members mine` |
| `supabase/migrations/20261021000000_foundation.sql:12373` | `identity.publish_identity_display_revision` | `JOIN chat.chat_members peer` |
| `supabase/migrations/20261021000000_foundation.sql:12482` | `identity.pull_agent_inbox_v2` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:12925` | `identity.remove_owned_agent` | `FROM chat.chat_members cm_agent` |
| `supabase/migrations/20261021000000_foundation.sql:12926` | `identity.remove_owned_agent` | `JOIN chat.chat_members cm_self ON cm_self.chat_id = cm_agent.chat_id` |
| `supabase/migrations/20261021000000_foundation.sql:12975` | `identity.remove_owned_agent` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:12991` | `identity.remove_owned_agent` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:13047` | `identity.remove_owned_agent` | `DELETE FROM chat.chat_members WHERE chat_id = ANY(v_owned_agent_group_ids);` |
| `supabase/migrations/20261021000000_foundation.sql:13055` | `identity.remove_owned_agent` | `SELECT 1 FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:13059` | `identity.remove_owned_agent` | `SELECT count(*) FROM chat.chat_members cm2 WHERE cm2.chat_id = c.id` |
| `supabase/migrations/20261021000000_foundation.sql:13062` | `identity.remove_owned_agent` | `DELETE FROM chat.chat_members WHERE user_id = v_agent.id;` |
| `supabase/migrations/20261021000000_foundation.sql:15261` | `DDL / policy / catalog patch` | `COMMENT ON TABLE chat.app_enablements IS '谁(user_id)在哪个对话(chat_id:群或私聊;话题跟它所属的群走)启用了哪个 App(app_publisher + app_id,不带版本)。agent 的 App 工具 = 它所在的对话里、它的主人启用过的 App;右栏列出这个对话里有人启用的 App。人不在这个对话里了,行随 chat_members 级联删除。';` |
| `supabase/migrations/20261021000000_foundation.sql:15337` | `DDL / policy / catalog patch` | `-- Name: chat_members; Type: TABLE; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:15340` | `DDL / policy / catalog patch` | `CREATE TABLE chat.chat_members (` |
| `supabase/migrations/20261021000000_foundation.sql:15363` | `DDL / policy / catalog patch` | `ALTER TABLE ONLY chat.chat_members REPLICA IDENTITY FULL;` |
| `supabase/migrations/20261021000000_foundation.sql:15367` | `DDL / policy / catalog patch` | `-- Name: COLUMN chat_members.listen_mode; Type: COMMENT; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:15370` | `DDL / policy / catalog patch` | `COMMENT ON COLUMN chat.chat_members.listen_mode IS '两档(#5856):passive = 点名才回;active = 会被不点名的发言叫醒,回不回它自己判断。❌ 不要再加第三档 —— 三档里有两档行为一样,那是 2026-09-19 收掉的东西。';` |
| `supabase/migrations/20261021000000_foundation.sql:16572` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_pkey; Type: CONSTRAINT; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:16575` | `DDL / policy / catalog patch` | `ALTER TABLE ONLY chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:17424` | `DDL / policy / catalog patch` | `CREATE INDEX idx_chat_members_chat ON chat.chat_members USING btree (chat_id);` |
| `supabase/migrations/20261021000000_foundation.sql:17431` | `DDL / policy / catalog patch` | `CREATE INDEX idx_chat_members_published_inbox ON chat.chat_members USING btree (user_id, chat_id) WHERE (inbox_published_at IS NOT NULL);` |
| `supabase/migrations/20261021000000_foundation.sql:17438` | `DDL / policy / catalog patch` | `CREATE INDEX idx_chat_members_user ON chat.chat_members USING btree (user_id);` |
| `supabase/migrations/20261021000000_foundation.sql:18086` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_announce_group_joins; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18089` | `DDL / policy / catalog patch` | `CREATE TRIGGER chat_members_announce_group_joins AFTER INSERT ON chat.chat_members REFERENCING NEW TABLE AS new_members FOR EACH STATEMENT EXECUTE FUNCTION chat.announce_group_member_joins();` |
| `supabase/migrations/20261021000000_foundation.sql:18093` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_auto_passive_on_agent_flood; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18096` | `DDL / policy / catalog patch` | `CREATE TRIGGER chat_members_auto_passive_on_agent_flood AFTER INSERT ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.auto_passive_on_agent_flood();` |
| `supabase/migrations/20261021000000_foundation.sql:18100` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_broadcast_read_changed; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18103` | `DDL / policy / catalog patch` | `CREATE TRIGGER chat_members_broadcast_read_changed AFTER UPDATE OF last_read_seq ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.broadcast_member_read_changed();` |
| `supabase/migrations/20261021000000_foundation.sql:18107` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_broadcast_trg; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18110` | `DDL / policy / catalog patch` | `CREATE TRIGGER chat_members_broadcast_trg AFTER INSERT OR DELETE OR UPDATE ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.chat_members_broadcast();` |
| `supabase/migrations/20261021000000_foundation.sql:18114` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_enforce_group_member_limit; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18117` | `DDL / policy / catalog patch` | `CREATE TRIGGER chat_members_enforce_group_member_limit BEFORE INSERT ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.enforce_group_member_limit();` |
| `supabase/migrations/20261021000000_foundation.sql:18121` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_notify_files_removed; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18124` | `DDL / policy / catalog patch` | `CREATE TRIGGER chat_members_notify_files_removed AFTER DELETE ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.notify_files_member_removed();` |
| `supabase/migrations/20261021000000_foundation.sql:18128` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_publish_account_revision; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18131` | `DDL / policy / catalog patch` | `CREATE TRIGGER chat_members_publish_account_revision AFTER INSERT OR DELETE OR UPDATE ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.publish_membership_revision();` |
| `supabase/migrations/20261021000000_foundation.sql:18135` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_publish_topic_summary; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18138` | `DDL / policy / catalog patch` | `CREATE TRIGGER chat_members_publish_topic_summary AFTER INSERT OR DELETE ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.publish_topic_membership_to_source_line();` |
| `supabase/migrations/20261021000000_foundation.sql:18142` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_role_user_type_chk_trg; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18145` | `DDL / policy / catalog patch` | `CREATE TRIGGER chat_members_role_user_type_chk_trg BEFORE INSERT OR UPDATE ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.chat_members_role_user_type_chk();` |
| `supabase/migrations/20261021000000_foundation.sql:18149` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_stream_read_broadcast_changed; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18152` | `DDL / policy / catalog patch` | `CREATE TRIGGER chat_members_stream_read_broadcast_changed AFTER UPDATE OF last_read_seq, is_marked_unread, version ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.broadcast_main_stream_read_changed();` |
| `supabase/migrations/20261021000000_foundation.sql:18156` | `DDL / policy / catalog patch` | `-- Name: chat_members chats_membership_invariants_trg; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18159` | `DDL / policy / catalog patch` | `CREATE CONSTRAINT TRIGGER chats_membership_invariants_trg AFTER INSERT OR DELETE OR UPDATE ON chat.chat_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION chat.chats_membership_invariants();` |
| `supabase/migrations/20261021000000_foundation.sql:18261` | `DDL / policy / catalog patch` | `-- Name: chat_members guard_member_listen_mode_change; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18264` | `DDL / policy / catalog patch` | `CREATE TRIGGER guard_member_listen_mode_change BEFORE INSERT OR UPDATE OF listen_mode ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.guard_member_listen_mode_change();` |
| `supabase/migrations/20261021000000_foundation.sql:18268` | `DDL / policy / catalog patch` | `-- Name: chat_members guard_member_role_change; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18271` | `DDL / policy / catalog patch` | `CREATE TRIGGER guard_member_role_change BEFORE UPDATE ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.guard_member_role_change();` |
| `supabase/migrations/20261021000000_foundation.sql:18303` | `DDL / policy / catalog patch` | `-- Name: chat_members leave_topics_of_source_line; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18306` | `DDL / policy / catalog patch` | `CREATE TRIGGER leave_topics_of_source_line AFTER DELETE ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.leave_topics_of_source_line();` |
| `supabase/migrations/20261021000000_foundation.sql:18408` | `DDL / policy / catalog patch` | `-- Name: chat_members trg_chat_members_hide_history_before; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18411` | `DDL / policy / catalog patch` | `CREATE TRIGGER trg_chat_members_hide_history_before BEFORE INSERT ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.set_hide_history_before_on_join();` |
| `supabase/migrations/20261021000000_foundation.sql:18415` | `DDL / policy / catalog patch` | `-- Name: chat_members trg_chat_members_inbox_publication; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18418` | `DDL / policy / catalog patch` | `CREATE TRIGGER trg_chat_members_inbox_publication BEFORE INSERT ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.set_inbox_publication_on_membership_insert();` |
| `supabase/migrations/20261021000000_foundation.sql:18422` | `DDL / policy / catalog patch` | `-- Name: chat_members trg_chat_members_join_instant; Type: TRIGGER; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18425` | `DDL / policy / catalog patch` | `CREATE TRIGGER trg_chat_members_join_instant BEFORE INSERT ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.set_join_instant_on_membership_insert();` |
| `supabase/migrations/20261021000000_foundation.sql:18799` | `DDL / policy / catalog patch` | `ADD CONSTRAINT app_enablements_chat_id_user_id_fkey FOREIGN KEY (chat_id, user_id) REFERENCES chat.chat_members(chat_id, user_id) ON DELETE CASCADE;` |
| `supabase/migrations/20261021000000_foundation.sql:18847` | `DDL / policy / catalog patch` | `ADD CONSTRAINT chat_member_stream_read_state_chat_id_user_id_fkey FOREIGN KEY (chat_id, user_id) REFERENCES chat.chat_members(chat_id, user_id) ON DELETE CASCADE;` |
| `supabase/migrations/20261021000000_foundation.sql:18851` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_chat_id_fk; Type: FK CONSTRAINT; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18854` | `DDL / policy / catalog patch` | `ALTER TABLE ONLY chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:18859` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_user_id_fk; Type: FK CONSTRAINT; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:18862` | `DDL / policy / catalog patch` | `ALTER TABLE ONLY chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:19847` | `DDL / policy / catalog patch` | `-- Name: chat_members; Type: ROW SECURITY; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:19850` | `DDL / policy / catalog patch` | `ALTER TABLE chat.chat_members ENABLE ROW LEVEL SECURITY;` |
| `supabase/migrations/20261021000000_foundation.sql:19853` | `DDL / policy / catalog patch` | `-- Name: chat_members chat_members_files_select; Type: POLICY; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:19856` | `DDL / policy / catalog patch` | `CREATE POLICY chat_members_files_select ON chat.chat_members FOR SELECT TO gugu_files USING (true);` |
| `supabase/migrations/20261021000000_foundation.sql:19888` | `DDL / policy / catalog patch` | `FROM chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:19889` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = chats.id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))))) WITH CHECK ((chat.is_member(id) AND (EXISTS ( SELECT 1` |
| `supabase/migrations/20261021000000_foundation.sql:19889` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = chats.id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))))) WITH CHECK ((chat.is_member(id) AND (EXISTS ( SELECT 1` |
| `supabase/migrations/20261021000000_foundation.sql:19889` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = chats.id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))))) WITH CHECK ((chat.is_member(id) AND (EXISTS ( SELECT 1` |
| `supabase/migrations/20261021000000_foundation.sql:19890` | `DDL / policy / catalog patch` | `FROM chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:19891` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = chats.id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));` |
| `supabase/migrations/20261021000000_foundation.sql:19891` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = chats.id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));` |
| `supabase/migrations/20261021000000_foundation.sql:19891` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = chats.id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));` |
| `supabase/migrations/20261021000000_foundation.sql:19976` | `DDL / policy / catalog patch` | `FROM chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:19977` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = group_announcements.chat_id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));` |
| `supabase/migrations/20261021000000_foundation.sql:19977` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = group_announcements.chat_id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));` |
| `supabase/migrations/20261021000000_foundation.sql:19977` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = group_announcements.chat_id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));` |
| `supabase/migrations/20261021000000_foundation.sql:19985` | `DDL / policy / catalog patch` | `FROM chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:19986` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = group_announcements.chat_id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));` |
| `supabase/migrations/20261021000000_foundation.sql:19986` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = group_announcements.chat_id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));` |
| `supabase/migrations/20261021000000_foundation.sql:19986` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = group_announcements.chat_id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));` |
| `supabase/migrations/20261021000000_foundation.sql:20001` | `DDL / policy / catalog patch` | `FROM chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:20002` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = group_announcements.chat_id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))))) WITH CHECK ((chat.is_member(chat_id) AND (EXISTS ( SELECT 1` |
| `supabase/migrations/20261021000000_foundation.sql:20002` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = group_announcements.chat_id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))))) WITH CHECK ((chat.is_member(chat_id) AND (EXISTS ( SELECT 1` |
| `supabase/migrations/20261021000000_foundation.sql:20002` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = group_announcements.chat_id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))))) WITH CHECK ((chat.is_member(chat_id) AND (EXISTS ( SELECT 1` |
| `supabase/migrations/20261021000000_foundation.sql:20003` | `DDL / policy / catalog patch` | `FROM chat.chat_members` |
| `supabase/migrations/20261021000000_foundation.sql:20004` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = group_announcements.chat_id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));` |
| `supabase/migrations/20261021000000_foundation.sql:20004` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = group_announcements.chat_id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));` |
| `supabase/migrations/20261021000000_foundation.sql:20004` | `DDL / policy / catalog patch` | `WHERE ((chat_members.chat_id = group_announcements.chat_id) AND (chat_members.user_id = ( SELECT (auth.uid())::text AS uid)) AND (chat_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))));` |
| `supabase/migrations/20261021000000_foundation.sql:20125` | `DDL / policy / catalog patch` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:20127` | `DDL / policy / catalog patch` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:20136` | `DDL / policy / catalog patch` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:20145` | `DDL / policy / catalog patch` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:20150` | `DDL / policy / catalog patch` | `-- Name: chat_members members_delete_self; Type: POLICY; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:20153` | `DDL / policy / catalog patch` | `CREATE POLICY members_delete_self ON chat.chat_members FOR DELETE TO authenticated USING (((user_id = ( SELECT (auth.uid())::text AS uid)) OR chat.is_owned_agent_user(user_id) OR (chat.can_manage_group_members(chat_id) AND chat.is_agent_user(user_id)) OR (chat.can_manage_group_members(chat_id) AND (role <> 'owner'::text))));` |
| `supabase/migrations/20261021000000_foundation.sql:20157` | `DDL / policy / catalog patch` | `-- Name: chat_members members_insert_group_manager; Type: POLICY; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:20160` | `DDL / policy / catalog patch` | `CREATE POLICY members_insert_group_manager ON chat.chat_members FOR INSERT TO authenticated WITH CHECK (chat.can_add_group_member(chat_id, user_id, role));` |
| `supabase/migrations/20261021000000_foundation.sql:20164` | `DDL / policy / catalog patch` | `-- Name: chat_members members_select_peer; Type: POLICY; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:20167` | `DDL / policy / catalog patch` | `CREATE POLICY members_select_peer ON chat.chat_members FOR SELECT TO authenticated USING (chat.is_member(chat_id));` |
| `supabase/migrations/20261021000000_foundation.sql:20171` | `DDL / policy / catalog patch` | `-- Name: chat_members members_update_own; Type: POLICY; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:20174` | `DDL / policy / catalog patch` | `CREATE POLICY members_update_own ON chat.chat_members FOR UPDATE TO authenticated USING (((user_id = ( SELECT (auth.uid())::text AS uid)) OR chat.is_owned_agent_user(user_id) OR chat.can_manage_group_members(chat_id))) WITH CHECK (((user_id = ( SELECT (auth.uid())::text AS uid)) OR chat.is_owned_agent_user(user_id) OR chat.can_manage_group_members(chat_id)));` |
| `supabase/migrations/20261021000000_foundation.sql:20237` | `DDL / policy / catalog patch` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021000000_foundation.sql:20267` | `DDL / policy / catalog patch` | `JOIN chat.chat_members cm ON ((cm.chat_id = m.chat_id)))` |
| `supabase/migrations/20261021000000_foundation.sql:20277` | `DDL / policy / catalog patch` | `JOIN chat.chat_members cm ON ((cm.chat_id = m.chat_id)))` |
| `supabase/migrations/20261021000000_foundation.sql:24445` | `DDL / policy / catalog patch` | `-- Name: TABLE chat_members; Type: ACL; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:24448` | `DDL / policy / catalog patch` | `GRANT SELECT,INSERT,DELETE ON TABLE chat.chat_members TO authenticated;` |
| `supabase/migrations/20261021000000_foundation.sql:24449` | `DDL / policy / catalog patch` | `GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE chat.chat_members TO service_role;` |
| `supabase/migrations/20261021000000_foundation.sql:24450` | `DDL / policy / catalog patch` | `GRANT SELECT ON TABLE chat.chat_members TO gugu_files;` |
| `supabase/migrations/20261021000000_foundation.sql:24454` | `DDL / policy / catalog patch` | `-- Name: COLUMN chat_members.role; Type: ACL; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:24457` | `DDL / policy / catalog patch` | `GRANT UPDATE(role) ON TABLE chat.chat_members TO authenticated;` |
| `supabase/migrations/20261021000000_foundation.sql:24461` | `DDL / policy / catalog patch` | `-- Name: COLUMN chat_members.last_read_seq; Type: ACL; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:24464` | `DDL / policy / catalog patch` | `GRANT UPDATE(last_read_seq) ON TABLE chat.chat_members TO authenticated;` |
| `supabase/migrations/20261021000000_foundation.sql:24468` | `DDL / policy / catalog patch` | `-- Name: COLUMN chat_members.version; Type: ACL; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:24471` | `DDL / policy / catalog patch` | `GRANT UPDATE(version) ON TABLE chat.chat_members TO authenticated;` |
| `supabase/migrations/20261021000000_foundation.sql:24475` | `DDL / policy / catalog patch` | `-- Name: COLUMN chat_members.is_pinned; Type: ACL; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:24478` | `DDL / policy / catalog patch` | `GRANT UPDATE(is_pinned) ON TABLE chat.chat_members TO authenticated;` |
| `supabase/migrations/20261021000000_foundation.sql:24482` | `DDL / policy / catalog patch` | `-- Name: COLUMN chat_members.notification_level; Type: ACL; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:24485` | `DDL / policy / catalog patch` | `GRANT SELECT(notification_level),INSERT(notification_level),UPDATE(notification_level) ON TABLE chat.chat_members TO authenticated;` |
| `supabase/migrations/20261021000000_foundation.sql:24489` | `DDL / policy / catalog patch` | `-- Name: COLUMN chat_members.listen_mode; Type: ACL; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:24492` | `DDL / policy / catalog patch` | `GRANT UPDATE(listen_mode) ON TABLE chat.chat_members TO authenticated;` |
| `supabase/migrations/20261021000000_foundation.sql:24496` | `DDL / policy / catalog patch` | `-- Name: COLUMN chat_members.is_marked_unread; Type: ACL; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:24499` | `DDL / policy / catalog patch` | `GRANT SELECT(is_marked_unread) ON TABLE chat.chat_members TO authenticated;` |
| `supabase/migrations/20261021000000_foundation.sql:24503` | `DDL / policy / catalog patch` | `-- Name: COLUMN chat_members.inbox_published_at; Type: ACL; Schema: chat; Owner: -` |
| `supabase/migrations/20261021000000_foundation.sql:24506` | `DDL / policy / catalog patch` | `GRANT SELECT(inbox_published_at) ON TABLE chat.chat_members TO authenticated;` |
| `supabase/migrations/20261021000000_foundation.sql:25256` | `DDL / policy / catalog patch` | `ALTER PUBLICATION supabase_realtime ADD TABLE "chat"."chat_members";` |
| `supabase/migrations/20261021000000_foundation.sql:25334` | `DDL / policy / catalog patch` | `-- Data for Name: chat_members; Type: TABLE DATA; Schema: chat; Owner: -` |
| `supabase/migrations/20261021114907_presence_human_viewers.sql:41` | `identity.fan_agent_presence_to_viewers` | `FROM chat.chat_members cm_agent` |
| `supabase/migrations/20261021114907_presence_human_viewers.sql:42` | `identity.fan_agent_presence_to_viewers` | `JOIN chat.chat_members cm_self ON cm_self.chat_id = cm_agent.chat_id` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:21` | `chat.group_is_manager` | `SELECT 1 FROM chat.chats c JOIN chat.chat_members m ON m.chat_id = c.id` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:59` | `chat.group_info_as` | `SELECT role INTO v_role FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = v_actor;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:102` | `chat.remove_group_member_as` | `SELECT role INTO v_role FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = p_member_user_id FOR UPDATE;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:117` | `chat.remove_group_member_as` | `DELETE FROM chat.chat_members WHERE chat_id = ANY(v_rooms) AND user_id = p_member_user_id;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:133` | `chat.set_group_member_role_as` | `SELECT role INTO v_role FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = p_member_user_id FOR UPDATE;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:137` | `chat.set_group_member_role_as` | `UPDATE chat.chat_members SET role = p_role WHERE chat_id = p_chat_id AND user_id = p_member_user_id;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:157` | `chat.set_agent_listen_mode_as` | `UPDATE chat.chat_members SET listen_mode = p_mode WHERE chat_id = p_chat_id AND user_id = p_agent_user_id;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:220` | `chat.archive_group_as` | `PERFORM 1 FROM chat.chats c JOIN chat.chat_members m ON m.chat_id = c.id JOIN identity.users u ON u.id = m.user_id` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:283` | `DDL / policy / catalog patch` | `REVOKE INSERT, DELETE ON chat.chat_members FROM authenticated;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:284` | `DDL / policy / catalog patch` | `REVOKE UPDATE (role, listen_mode) ON chat.chat_members FROM authenticated;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:285` | `DDL / policy / catalog patch` | `DROP POLICY members_insert_group_manager ON chat.chat_members;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:286` | `DDL / policy / catalog patch` | `DROP POLICY members_delete_self ON chat.chat_members;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:287` | `DDL / policy / catalog patch` | `DROP POLICY members_update_own ON chat.chat_members;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:288` | `DDL / policy / catalog patch` | `CREATE POLICY members_update_own ON chat.chat_members FOR UPDATE TO authenticated` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:291` | `DDL / policy / catalog patch` | `DROP TRIGGER guard_member_role_change ON chat.chat_members;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:293` | `DDL / policy / catalog patch` | `DROP TRIGGER guard_member_listen_mode_change ON chat.chat_members;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:332` | `chat.chats_membership_invariants` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:336` | `chat.chats_membership_invariants` | `FROM chat.chat_members WHERE chat_id = affected_chat_id;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:378` | `chat.chats_status_invariants` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:381` | `chat.chats_status_invariants` | `SELECT count(*) INTO member_count_val FROM chat.chat_members WHERE chat_id = NEW.id;` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:473` | `chat.decide_group_join` | `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES (v_req.chat_id, v_req.requester_user_id, 'member')` |
| `supabase/migrations/20261021150000_group_admin_one_door.sql:549` | `chat.undo_agent_flood_adjustment` | `UPDATE chat.chat_members cm` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:39` | `chat.group_add_denial` | `SELECT role INTO v_role FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = p_actor_user_id;` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:43` | `chat.group_add_denial` | `AND NOT EXISTS (SELECT 1 FROM chat.chat_members WHERE chat_id = p_chat_id) THEN` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:62` | `chat.group_add_denial` | `SELECT count(*) INTO v_count FROM chat.chat_members WHERE chat_id = p_chat_id;` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:74` | `chat.insert_group_member` | `INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES (p_chat_id,p_user_id,'member')` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:194` | `chat.decide_group_invitation_as` | `SELECT count(*) INTO v_count FROM chat.chat_members WHERE chat_id=v_group.id;` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:260` | `chat.request_agent_friend_contact` | `AND (SELECT count(*) FROM chat.chat_members m WHERE m.chat_id = c.id) = 3` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:261` | `chat.request_agent_friend_contact` | `AND NOT EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = c.id AND m.user_id <> ALL(ARRAY[v_me, p_agent_user_id, p_friend_user_id]))` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:262` | `chat.request_agent_friend_contact` | `AND EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = c.id AND m.user_id = v_me AND m.role = 'owner')` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:270` | `chat.request_agent_friend_contact` | `AND (SELECT count(*) FROM chat.chat_members m WHERE m.chat_id = c.id) = 2` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:271` | `chat.request_agent_friend_contact` | `AND NOT EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = c.id AND m.user_id <> ALL(ARRAY[v_me, p_agent_user_id]))` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:272` | `chat.request_agent_friend_contact` | `AND EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id = c.id AND m.user_id = v_me AND m.role = 'owner')` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:285` | `chat.request_agent_friend_contact` | `INSERT INTO chat.chat_members(chat_id, user_id, role) VALUES (v_chat_id, v_me, 'owner'), (v_chat_id, p_agent_user_id, 'member');` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:370` | `chat.create_gugu_group` | `INSERT INTO chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:396` | `chat.create_gugu_group` | `INSERT INTO chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:479` | `identity.remove_owned_agent` | `FROM chat.chat_members cm_agent` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:480` | `identity.remove_owned_agent` | `JOIN chat.chat_members cm_self ON cm_self.chat_id = cm_agent.chat_id` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:529` | `identity.remove_owned_agent` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:545` | `identity.remove_owned_agent` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:601` | `identity.remove_owned_agent` | `DELETE FROM chat.chat_members WHERE chat_id = ANY(v_owned_agent_group_ids);` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:604` | `identity.remove_owned_agent` | `DELETE FROM chat.chat_members WHERE user_id = v_agent.id;` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:665` | `chat.list_owner_groups_as` | `(SELECT count(*)::INTEGER FROM chat.chat_members cm WHERE cm.chat_id = c.id),` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:666` | `chat.list_owner_groups_as` | `EXISTS (SELECT 1 FROM chat.chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = v_actor),` |
| `supabase/migrations/20261021150001_group_invitation_actor.sql:668` | `chat.list_owner_groups_as` | `FROM chat.chat_members mine` |
| `supabase/migrations/20261022061110_activity_metadata_as.sql:159` | `chat.list_topics_of_chat` | `(SELECT count(*) FROM chat.chat_members cm WHERE cm.chat_id = t.id),` |
| `supabase/migrations/20261022061110_activity_metadata_as.sql:194` | `chat.list_unread_locators` | `FROM chat.chat_members member` |
| `supabase/migrations/20261022061110_activity_metadata_as.sql:204` | `chat.list_unread_locators` | `JOIN chat.chat_members member` |
| `supabase/migrations/20261022061110_activity_metadata_as.sql:216` | `chat.list_unread_locators` | `JOIN chat.chat_members member ON member.chat_id = root.chat_id AND member.user_id = v_user` |
| `supabase/migrations/20261022061110_activity_metadata_as.sql:269` | `chat.list_unread_locators` | `JOIN chat.chat_members member` |
| `supabase/migrations/20261022061110_activity_metadata_as.sql:303` | `chat.mark_unread` | `JOIN chat.chat_members member ON member.chat_id = m.chat_id AND member.user_id = v_actor` |
| `supabase/migrations/20261022061110_activity_metadata_as.sql:316` | `chat.mark_unread` | `UPDATE chat.chat_members AS member` |
| `supabase/migrations/20261022061110_activity_metadata_as.sql:371` | `identity.get_agent_join_context` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261022061110_activity_metadata_as.sql:392` | `identity.get_agent_join_context` | `UPDATE chat.chat_members` |
| `supabase/migrations/20261022061110_activity_metadata_as.sql:399` | `identity.get_agent_join_context` | `UPDATE chat.chat_members` |
| `supabase/migrations/20261022061110_activity_metadata_as.sql:453` | `chat.activity_metadata_as` | `SELECT cm.chat_id FROM chat.chat_members cm` |
| `supabase/migrations/20261022105000_task_agent_passive_join.sql:7` | `DDL / policy / catalog patch` | `-- 「加入了群聊」从 chat_members 的语句级触发器搬进入群的唯一入口 chat.insert_group_member:#8 起客户端不能` |
| `supabase/migrations/20261022105000_task_agent_passive_join.sql:47` | `DDL / policy / catalog patch` | `DROP TRIGGER chat_members_announce_group_joins ON chat.chat_members;` |
| `supabase/migrations/20261022105000_task_agent_passive_join.sql:58` | `chat.insert_group_member` | `INSERT INTO chat.chat_members(chat_id, user_id, role, listen_mode)` |
| `supabase/migrations/20261022105000_task_agent_passive_join.sql:314` | `chat.record_message_agent_wakes` | `JOIN chat.chat_members cm ON cm.chat_id = c.id` |
| `supabase/migrations/20261022151000_reply_to_card_wakes_nobody.sql:53` | `chat.record_message_agent_wakes` | `JOIN chat.chat_members cm ON cm.chat_id = c.id` |
| `supabase/migrations/20261022151000_reply_to_card_wakes_nobody.sql:115` | `chat.enqueue_agent_deliver_device_command` | `JOIN chat.chat_members cm ON cm.chat_id = c.id` |
| `supabase/migrations/20261023054500_project_group_owner_only.sql:33` | `chat.group_add_denial` | `SELECT role INTO v_role FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = p_actor_user_id;` |
| `supabase/migrations/20261023054500_project_group_owner_only.sql:37` | `chat.group_add_denial` | `AND NOT EXISTS (SELECT 1 FROM chat.chat_members WHERE chat_id = p_chat_id) THEN` |
| `supabase/migrations/20261023054500_project_group_owner_only.sql:56` | `chat.group_add_denial` | `SELECT count(*) INTO v_count FROM chat.chat_members WHERE chat_id = p_chat_id;` |
| `supabase/migrations/20261023101500_account_sync_snapshot.sql:31` | `chat.sync_snapshot` | `JOIN chat.chat_members own ON own.chat_id = c.id AND own.user_id = viewer` |
| `supabase/migrations/20261023101500_account_sync_snapshot.sql:38` | `chat.sync_snapshot` | `FROM chat.chat_members m JOIN conversations c ON c.id = m.chat_id` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:106` | `chat.create_gugu_group` | `INSERT INTO chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:132` | `chat.create_gugu_group` | `INSERT INTO chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:214` | `chat.group_add_denial` | `SELECT role INTO v_role FROM chat.chat_members WHERE chat_id = p_chat_id AND user_id = p_actor_user_id;` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:218` | `chat.group_add_denial` | `AND NOT EXISTS (SELECT 1 FROM chat.chat_members WHERE chat_id = p_chat_id) THEN` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:233` | `chat.group_add_denial` | `SELECT count(*) INTO v_count FROM chat.chat_members WHERE chat_id = p_chat_id;` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:400` | `chat.create_topic` | `INSERT INTO chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:462` | `chat.join_topic_participants` | `INSERT INTO chat.chat_members (chat_id, user_id, role, joined_ingest_seq)` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:470` | `chat.join_topic_participants` | `INSERT INTO chat.chat_members (chat_id, user_id, role, joined_ingest_seq)` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:504` | `chat.chats_membership_invariants` | `SELECT 1 FROM chat.chat_members m` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:518` | `chat.chats_membership_invariants` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:522` | `chat.chats_membership_invariants` | `FROM chat.chat_members WHERE chat_id = affected_chat_id;` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:553` | `DDL / policy / catalog patch` | `FROM chat.chats t JOIN chat.chat_members m ON m.chat_id = t.id` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:1248` | `DDL / policy / catalog patch` | `SELECT 1 FROM chat.chats t JOIN chat.chat_members m ON m.chat_id = t.id` |
| `supabase/migrations/20261023131000_topic_source_resources.sql:1271` | `DDL / policy / catalog patch` | `COMMENT ON COLUMN chat.chats.source_chat_id IS 'For a topic: its source message stream and sole shared resource container. Topic chat_members are participation/subscription, not file membership.';` |
| `supabase/migrations/20261025154000_large_file_idle_expiry.sql:165` | `chat.file_transfer_group_usage` | `IF NOT EXISTS(SELECT 1 FROM chat.chat_members WHERE chat_id=g AND user_id=actor AND role IN ('owner','admin')) THEN` |
| `supabase/migrations/20261025154200_project_file_revisions.sql:50` | `chat.file_project_policy_as` | `IF NOT EXISTS(SELECT 1 FROM chat.chat_members WHERE chat_id=g AND user_id=auth.uid()::text AND role IN ('owner','admin'))` |
| `supabase/migrations/20261026041500_assistant_panel_state.sql:457` | `identity.assistant_panel_commit` | `JOIN chat.chat_members m ON m.chat_id = c.id AND m.user_id = v_owner` |
| `supabase/migrations/20261026041500_assistant_panel_state.sql:458` | `identity.assistant_panel_commit` | `JOIN chat.chat_members a ON a.chat_id = c.id AND a.user_id = p_assistant` |
| `supabase/migrations/20261026041500_assistant_panel_state.sql:460` | `identity.assistant_panel_commit` | `AND NOT EXISTS (SELECT 1 FROM chat.chat_members other WHERE other.chat_id = c.id AND other.user_id NOT IN (v_owner,p_assistant))` |
| `supabase/migrations/20261026064000_private_display_overrides.sql:73` | `chat.sync_snapshot` | `JOIN chat.chat_members own ON own.chat_id = c.id AND own.user_id = viewer` |
| `supabase/migrations/20261026064000_private_display_overrides.sql:80` | `chat.sync_snapshot` | `FROM chat.chat_members m JOIN conversations c ON c.id = m.chat_id` |
| `supabase/migrations/20261026093000_topic_archival.sql:17` | `chat.archive_topic_as` | `FROM chat.chats s JOIN chat.chat_members m ON m.chat_id = s.id` |
| `supabase/migrations/20261026093000_topic_archival.sql:95` | `chat.list_topics_of_chat` | `(SELECT count(*) FROM chat.chat_members cm WHERE cm.chat_id = t.id),` |
| `supabase/migrations/20261026114000_topic_owner_enrollment.sql:18` | `chat.enroll_topic_agent_owner` | `PERFORM 1 FROM chat.chat_members m JOIN identity.users u ON u.id = m.user_id AND u.type = 'human'` |
| `supabase/migrations/20261026114000_topic_owner_enrollment.sql:30` | `chat.enroll_topic_agent_owner` | `INSERT INTO chat.chat_members(chat_id,user_id,role,joined_ingest_seq)` |
| `supabase/migrations/20261026114000_topic_owner_enrollment.sql:38` | `DDL / policy / catalog patch` | `AFTER INSERT OR UPDATE OF chat_id, user_id ON chat.chat_members` |
| `supabase/migrations/20261026114000_topic_owner_enrollment.sql:50` | `chat.leave_topics_of_source_line` | `DELETE FROM chat.chat_members m USING identity.users a` |
| `supabase/migrations/20261026114000_topic_owner_enrollment.sql:59` | `chat.leave_topics_of_source_line` | `DELETE FROM chat.chat_members cm USING chat.chats t` |
| `supabase/migrations/20261027110000_project_file_storage_policy.sql:39` | `chat.file_project_policy_as` | `IF NOT EXISTS(SELECT 1 FROM chat.chat_members WHERE chat_id=g AND user_id=auth.uid()::text AND role IN ('owner','admin'))` |
| `supabase/migrations/20261027121000_pending_delivery_not_unread.sql:41` | `chat.list_unread_locators` | `FROM chat.chat_members member` |
| `supabase/migrations/20261027121000_pending_delivery_not_unread.sql:51` | `chat.list_unread_locators` | `JOIN chat.chat_members member` |
| `supabase/migrations/20261027121000_pending_delivery_not_unread.sql:63` | `chat.list_unread_locators` | `JOIN chat.chat_members member ON member.chat_id = root.chat_id AND member.user_id = v_user` |
| `supabase/migrations/20261027121000_pending_delivery_not_unread.sql:118` | `chat.list_unread_locators` | `JOIN chat.chat_members member` |
| `supabase/migrations/20261027121000_pending_delivery_not_unread.sql:160` | `chat.sync_snapshot` | `JOIN chat.chat_members own ON own.chat_id = c.id AND own.user_id = viewer` |
| `supabase/migrations/20261027121000_pending_delivery_not_unread.sql:167` | `chat.sync_snapshot` | `FROM chat.chat_members m JOIN conversations c ON c.id = m.chat_id` |
| `supabase/migrations/20261028070400_unread_addressed_count.sql:38` | `chat.list_unread_locators` | `FROM chat.chat_members member` |
| `supabase/migrations/20261028070400_unread_addressed_count.sql:48` | `chat.list_unread_locators` | `JOIN chat.chat_members member` |
| `supabase/migrations/20261028070400_unread_addressed_count.sql:60` | `chat.list_unread_locators` | `JOIN chat.chat_members member ON member.chat_id = root.chat_id AND member.user_id = v_user` |
| `supabase/migrations/20261028070400_unread_addressed_count.sql:117` | `chat.list_unread_locators` | `JOIN chat.chat_members member` |
| `supabase/migrations/20261028095412_session_agent_archival.sql:96` | `identity.set_agent_session_archival` | `UNION SELECT peer.user_id FROM chat.chat_members mine` |
| `supabase/migrations/20261028095412_session_agent_archival.sql:97` | `identity.set_agent_session_archival` | `JOIN chat.chat_members peer ON peer.chat_id = mine.chat_id` |
| `supabase/migrations/20261028095412_session_agent_archival.sql:99` | `identity.set_agent_session_archival` | `UNION SELECT peer.user_id FROM chat.chat_members mine` |
| `supabase/migrations/20261028095412_session_agent_archival.sql:101` | `identity.set_agent_session_archival` | `JOIN chat.chat_members peer ON peer.chat_id = c.source_chat_id` |
| `supabase/migrations/20261028095412_session_agent_archival.sql:203` | `chat.record_message_agent_wakes` | `JOIN chat.chat_members cm ON cm.chat_id = c.id` |
| `supabase/migrations/20261028095412_session_agent_archival.sql:266` | `chat.enqueue_agent_deliver_device_command` | `JOIN chat.chat_members cm ON cm.chat_id = c.id` |
| `supabase/migrations/20261028095412_session_agent_archival.sql:362` | `identity.pull_agent_inbox_v2` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261028095412_session_agent_archival.sql:517` | `chat.sync_snapshot` | `JOIN chat.chat_members own ON own.chat_id = c.id AND own.user_id = viewer` |
| `supabase/migrations/20261028095412_session_agent_archival.sql:524` | `chat.sync_snapshot` | `FROM chat.chat_members m JOIN conversations c ON c.id = m.chat_id` |
| `supabase/migrations/20261028095412_session_agent_archival.sql:751` | `identity.assert_device_command_post_context` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261029114000_project_first_file_policy.sql:22` | `chat.file_project_policy_for` | `JOIN chat.chat_members m ON m.chat_id=dp.chat_id AND m.user_id=dp.user_id::text AND m.role IN ('owner','admin')` |
| `supabase/migrations/20261029213000_inbox_and_preview_read_cost.sql:17` | `DDL / policy / catalog patch` | `-- 3. messages_select_member probed chat_members once per row, and that probe ran the chat_members row` |
| `supabase/migrations/20261029213000_inbox_and_preview_read_cost.sql:17` | `DDL / policy / catalog patch` | `-- 3. messages_select_member probed chat_members once per row, and that probe ran the chat_members row` |
| `supabase/migrations/20261029213000_inbox_and_preview_read_cost.sql:102` | `identity.pull_agent_inbox_v2` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261029213000_inbox_and_preview_read_cost.sql:202` | `DDL / policy / catalog patch` | `-- chat_members as the caller, and members_select_peer (chat.is_member) admits every committed row of` |
| `supabase/migrations/20261029213000_inbox_and_preview_read_cost.sql:210` | `chat.caller_member_chats_without_floor` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261029213000_inbox_and_preview_read_cost.sql:214` | `DDL / policy / catalog patch` | `COMMENT ON FUNCTION chat.caller_member_chats_without_floor() IS 'messages_select_member 的成员半边(无入群前历史门):调用者自己是成员、且没有 hide_history_before 的会话。每条查询算一次、由规划器哈希,❌ 逐行探 chat_members。';` |
| `supabase/migrations/20261029213000_inbox_and_preview_read_cost.sql:220` | `DDL / policy / catalog patch` | `-- The membership half is split on the floor. (chat_id, user_id) is the key of chat_members, so a caller` |
| `supabase/migrations/20261029213000_inbox_and_preview_read_cost.sql:227` | `DDL / policy / catalog patch` | `SELECT 1 FROM chat.chat_members cm` |
| `supabase/migrations/20261029213200_device_revision_lock_order.sql:55` | `identity.agent_presence_viewer_ids` | `FROM chat.chat_members cm_agent` |
| `supabase/migrations/20261029213200_device_revision_lock_order.sql:56` | `identity.agent_presence_viewer_ids` | `JOIN chat.chat_members cm_self ON cm_self.chat_id = cm_agent.chat_id` |
| `supabase/migrations/20261029213200_device_revision_lock_order.sql:111` | `chat.lock_message_agent_devices` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261030060000_addressed_excludes_owned_agent_reply.sql:38` | `chat.list_unread_locators` | `FROM chat.chat_members member` |
| `supabase/migrations/20261030060000_addressed_excludes_owned_agent_reply.sql:48` | `chat.list_unread_locators` | `JOIN chat.chat_members member` |
| `supabase/migrations/20261030060000_addressed_excludes_owned_agent_reply.sql:60` | `chat.list_unread_locators` | `JOIN chat.chat_members member ON member.chat_id = root.chat_id AND member.user_id = v_user` |
| `supabase/migrations/20261030060000_addressed_excludes_owned_agent_reply.sql:117` | `chat.list_unread_locators` | `JOIN chat.chat_members member` |
| `supabase/migrations/20261030140500_drop_agent_dm_grants.sql:78` | `chat.get_or_create_dm` | `SELECT 1 FROM chat.chat_members cm` |
| `supabase/migrations/20261030140500_drop_agent_dm_grants.sql:83` | `chat.get_or_create_dm` | `SELECT 1 FROM chat.chat_members cm` |
| `supabase/migrations/20261030140500_drop_agent_dm_grants.sql:89` | `chat.get_or_create_dm` | `FROM chat.chat_members cm` |
| `supabase/migrations/20261030140500_drop_agent_dm_grants.sql:108` | `chat.get_or_create_dm` | `INSERT INTO chat.chat_members (chat_id, user_id, role)` |
| `supabase/migrations/20261030140500_drop_agent_dm_grants.sql:126` | `DDL / policy / catalog patch` | `DELETE FROM chat.chat_members cm` |
| `supabase/migrations/20261030140500_drop_agent_dm_grants.sql:127` | `DDL / policy / catalog patch` | `USING identity.agent_dm_grants g, chat.chats c, chat.chat_members am` |

## Client direct table entry sites

Client implementation and complete read/write classification belong to the paired client PR. Reads switch to the canonical server view; mutations remain on the table/RPC. The imported DM-history lookup must use `historical_dm_peer`, not a live member list.

| Source | Source line |
|---|---|
| `apps/desktop/electron/session/main/core/extensions/app-given.ts:32` | `const mine = await chat.from('chat_members').select('chat_id').eq('user_id', userId);` |
| `apps/desktop/electron/session/main/core/extensions/app-given.ts:43` | `const { data, error } = await chat.from('chat_members').select('chat_id, user_id').in('chat_id', chunk);` |
| `apps/desktop/electron/sessionpage/emdash-agent-provisioning.ts:1465` | `.from('chat_members')` |
| `apps/desktop/electron/sessionpage/emdash-agent-provisioning.ts:1593` | `.from('chat_members')` |
| `apps/desktop/electron/sessionpage/emdash-agent-provisioning.ts:1627` | `.from('chat_members')` |
| `apps/desktop/electron/sessionpage/sessionpage-agent-reaper.ts:138` | `const { data: members, error } = await input.chat.from('chat_members').select('user_id').eq('chat_id', input.chatId)` |
| `apps/desktop/electron/sessionpage/sessionpage-agent-reaper.ts:553` | `.from('chat_members')` |
| `apps/desktop/electron/sessionpage/sessionpage-project-group-binding.ts:91` | `.from('chat_members')` |
| `apps/desktop/electron/sessionpage/sessionpage-project-group-binding.ts:114` | `.from('chat_members')` |
| `apps/desktop/electron/sessionpage/sessionpage-project-group-binding.ts:144` | `const membership = () => chat.from('chat_members').select('user_id').eq('chat_id', chatId).eq('user_id', agentUserId).maybeSingle()` |
| `apps/desktop/src/lib/chat.ts:97` | `.from('chat_members')` |
| `apps/desktop/src/lib/chat.ts:545` | `.from('chat_members')` |
| `apps/desktop/src/lib/chat.ts:554` | `.from('chat_members')` |
| `apps/desktop/src/lib/chat.ts:599` | `.from('chat_members')` |
| `apps/desktop/src/lib/chat.ts:655` | `.from('chat_members')` |
| `apps/desktop/src/lib/chat.ts:679` | `collabChatDb.from('chat_members').select('chat_id, user_id, role, listen_mode').eq('chat_id', chatId),` |
| `apps/desktop/src/lib/chat.ts:1012` | `.from('chat_members')` |
| `apps/desktop/src/lib/chat.ts:1021` | `.from('chat_members')` |
| `apps/desktop/src/lib/chat.ts:1048` | `.from('chat_members')` |
| `apps/desktop/src/lib/chat.ts:1068` | `.from('chat_members')` |
| `apps/desktop/src/lib/chat.ts:1089` | `.from('chat_members')` |
| `apps/desktop/src/lib/chat.ts:1112` | `const { error } = await chatDb.from('chat_members').insert(` |
| `apps/desktop/src/lib/chat.ts:1135` | `.from('chat_members')` |
| `apps/desktop/src/lib/chatProjection.ts:183` | `const { data, error } = await chatDb.from('chat_members')` |
| `apps/desktop/src/lib/chatProjection.ts:383` | `const { data, error } = await chatDb.from('chat_members')` |
| `apps/desktop/src/lib/contacts.ts:209` | `.from('chat_members')` |
| `apps/desktop/src/lib/contacts.ts:790` | `.from('chat_members')` |
| `apps/desktop/src/lib/contacts.ts:802` | `.from('chat_members')` |
| `apps/desktop/src/lib/groupAgentJoinService.ts:38` | `.from('chat_members')` |
| `apps/desktop/src/lib/importedHistoryReader.ts:157` | `.from('chat_members')` |
| `apps/desktop/src/session/shared/extensions/app-enablements-core.ts:50` | `.from('chat_members')` |
| `apps/desktop/src/session/shared/extensions/app-files-core.ts:319` | `const { data, error } = await chatClient(token).from('chat_members').select('chat_id, user_id').in('chat_id', chunk);` |
| `apps/desktop/src/session/shared/extensions/app-files-core.ts:354` | `const { data, error } = await chatClient(token).from('chat_members').select('user_id').eq('chat_id', row.id);` |
