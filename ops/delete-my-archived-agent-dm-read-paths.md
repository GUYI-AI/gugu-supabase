# Personal DM deletion: read-path audit

The deletion field is personal conversation-list state. It must not enter the membership or file authorization predicate. The companion client is OpenDCAI/gugu#1479.

| Read path | Result after personal deletion |
| --- | --- |
| `chat.list_my_chats_as(text)` | Excludes the requested actor's deleted list entries. Delegating an agent read does not inherit the owner's personal deletion. |
| `chat.sync_snapshot()` | Its conversation CTE excludes the caller's deleted entries. Dependent memberships and previews cannot reintroduce them. Surviving memberships include the additive field. Identity history remains retained. |
| `chat.list_unread_locators(text)` | All three stream sources exclude the caller's deleted list entries. Existing read cursors and stream rows are unchanged. |
| `chat.sync_since(bigint,integer)` | Returns a contiguous account revision journal, not conversation-list rows. The existing `chat_members_changed` key carries `kind: own`, with `tombstone: false`. It must remain in the journal so the other device learns the deletion. No revision is filtered or renumbered. |
| Incremental membership projection (`chat.active_members`) | Returns the canonical `conversation_deleted_at` value. The client rereads that key, excludes the row during assembly and clears active/optimistic list state. Preserved membership is not reported as revoked. |
| `chat.list_owner_groups_as`, `chat.list_topics_of_chat`, `chat.search_discoverable_groups`, `chat.lookup_public_group`, group invitation/join-request lists | These return groups/topics or invitations; they cannot return an ordinary DM. Their behavior remains unchanged. |
| `chat.chat_facts`, `chat.list_member_ids`, `chat.historical_dm_peer`, message/history views and file RPCs | Explicit history/resource reads remain authorized by the retained membership. They are not the caller's conversation list and intentionally stay readable. |
| `chat.open_dm` / `chat.get_or_create_dm` | Explicit identity resolution does not clear the personal deletion timestamp. Subsequent messages likewise do not restore it. |

The client cold account path (`accountSyncSnapshot.ts`) consumes `sync_snapshot`. Its live and refresh list paths (`chatProjection.ts`, `chatListProjection.ts`, `store/chat.tsx`) consume the canonical membership state and use a separate list-deletion fact to clear selection. They do not synthesize a membership tombstone. The archive reader intentionally reads historical DMs independently of the conversation list.

Regression coverage runs an authenticated cold snapshot before and after deletion, reads the real incremental deletion operation and its authoritative membership value, then writes a later message and verifies that cold/list/unread results still exclude the DM. The agent-side list and the owner's original historical sender remain intact. The rollback test restores snapshot/list access and authenticated EXECUTE without erasing personal timestamps.
