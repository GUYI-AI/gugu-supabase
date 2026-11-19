# Archived agents leave their groups

Rule: when an agent's session is archived (`identity.users.session_archived_at` is set), the agent has left every group and topic it was in. It holds no seat, is not listed and is not counted. Restoring the session brings it back with its original seat, role, read state and history. Direct and AI chats are unchanged.

## Projections

- `chat.active_members` hides session-archived agents in group and topic chats, in addition to removed identities. Member lists, member counts, every `max_members` capacity check (including the official help group) and topic participation read it, so they all follow the rule.
- `identity.member_liveness.in_groups` is the derived fact, maintained by the same identity trigger as `is_live`.
- Direct reads of `chat.chat_members` follow the same rule: the `members_select_peer` policy uses `chat_private.member_seat_visible(chat_id, user_id)`, the view's predicate, instead of `identity.user_is_live(user_id)`.
- `chat_private.is_direct_chat(text)` supplies the chat kind to the invoker view and policy, because not every reader (`gugu_files`) can read `chat.chats`. `chat_private` is not exposed by the Data API, so neither helper can be called as an RPC; the reader roles have only USAGE and EXECUTE.
- `chat.live_identity_members` keeps every seat of a live identity, including archived agents. It has no grants for any API role. Only these definer functions read it:
  - `identity.set_agent_session_archival` and `identity.publish_identity_display_revision`: archive and restore lock and notify the same peers in both directions.
  - `chat.is_addressable_in`, `chat.enforce_whisper_rule` (through `chat.is_retained_member`) and `chat.record_message_agent_wakes`: a mention, reply or whisper to an archived agent is accepted for the other members and records the existing `agent_archived` refusal for its sender, instead of rejecting the whole message. The agent is not woken. Only these addressed routes (its id in `to_user_ids`, or a reply to its message) use the retained seat; active listening and `@all` use live membership, so an archived agent records nothing for ordinary group traffic.
  - `chat.remove_group_member_as`: refuses an archived agent's retained seat with `agent_archived` (see below).
- `identity.set_agent_session_archival` locks the agent's `member_liveness` row before the revision heads, the same order as member-row lockers such as `mark_read_on_deliver` and `remove_group_member_as`.
- `chat.chat_members` rows are never deleted or rewritten. Message history and sender display read `chat.messages` and `identity.users` and are unaffected.

## Revisions

Archive and restore reuse the existing `chat_members_changed` roster revision for every group or topic seat: a tombstone when the seat leaves, a plain revision when it returns. Account revisions are recorded only for human recipients (`chat.is_user_event_recipient`). The existing `agent_changed` display revision still reaches group peers. No new revision event.

The release sends the same tombstones once for agents that were already archived when it is installed, so cached member lists drop them. The rollback script sends the plain revision for them, so cached lists bring them back.

## Known edges

- Adding an archived agent to any group or topic is refused with `agent_archived` (`group_add_denial`); removing it is refused with `agent_archived` (`remove_group_member_as`). Neither reports a success that changes nothing; restore the session first. Changing its role returns `group_member_not_found`.

## Permanent effects while archived

These follow from the owner's rule (archived = left the group) and are accepted:

- When a human account is erased, archived agents are not counted as remaining members, so a group left with fewer than two live members is archived as before. Restoring the agent later does not bring that group back.
- File retention (`chat.conversation_gone`) likewise ignores archived agents' seats. Files reclaimed while the agent was archived do not come back when it is restored.

Rollback: `ops/rollback-archived-agents-leave-groups.sql`. Run it before any older rollback that drops `identity.member_liveness`.
