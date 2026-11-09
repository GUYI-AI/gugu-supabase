# Archived agents leave their groups

Rule: when an agent's session is archived (`identity.users.session_archived_at` is set), the agent has left every group and topic it was in. It holds no seat, is not listed and is not counted. Restoring the session brings it back with its original seat, role, read state and history. Direct and AI chats are unchanged.

## Projections

- `chat.active_members` hides session-archived agents in group and topic chats, in addition to removed identities. Member lists, member counts, every `max_members` capacity check (including the official help group) and topic participation read it, so they all follow the rule.
- `identity.member_liveness.in_groups` is the derived fact, maintained by the same identity trigger as `is_live`. `chat.is_direct_chat(text)` supplies the chat kind to the invoker view, because not every reader of the view can read `chat.chats`.
- `chat.live_identity_members` keeps every seat of a live identity, including archived agents. It has no grants for any API role. Only these definer functions read it:
  - `identity.set_agent_session_archival` and `identity.publish_identity_display_revision`: archive and restore lock and notify the same peers in both directions.
  - `chat.is_addressable_in`, `chat.enforce_whisper_rule` (through `chat.is_retained_member`) and `chat.record_message_agent_wakes`: a mention, reply or whisper to an archived agent is accepted for the other members and records the existing `agent_archived` refusal for its sender, instead of rejecting the whole message. The agent is not woken.
- `chat.chat_members` rows are never deleted or rewritten. Message history and sender display read `chat.messages` and `identity.users` and are unaffected.

## Revisions

Archive and restore reuse the existing `chat_members_changed` roster revision for every group or topic seat, sent to its live human members: a tombstone when the seat leaves, a plain revision when it returns. The existing `agent_changed` display revision still reaches group peers. No new revision event.

## Known edges

- Adding an archived agent to a group it still has a seat in does not restore it: in a full group the add is refused with `member_limit_reached`; otherwise the insert is a no-op and the agent stays hidden until restore.
- Removing an archived agent from a group returns `already_absent` and keeps its retained seat; changing its role returns `group_member_not_found`. It is already out of the group; restore it first to manage its seat.
- When a human account is erased, archived agents are not counted as remaining members, so a group left with fewer than two live members is archived as before. File retention (`chat.conversation_gone`) likewise ignores archived agents' seats.

Rollback: `ops/rollback-archived-agents-leave-groups.sql`. Run it before any older rollback that drops `identity.member_liveness`.
