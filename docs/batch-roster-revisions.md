# Roster revisions: one per recipient per statement

Release `20261110062000_batch_roster_revisions`. Rollback: `ops/rollback-batch-roster-revisions.sql`.

## What a roster revision says

`chat_members_changed` with `kind: 'roster'` and resource key `{chat_id, user_id}` tells a recipient that
the members of `chat_id` changed, and names a seat that changed. A reader that does not know that seat
reads the chat's members again. Every client reader already does this:

| Reader | Seat it does not know | Its own seat |
|---|---|---|
| Chat projection (`operationKeys` → membership reader) | reads all of the chat's `active_members` rows | implies the chat row |
| Read-receipt denominator (`applyMemberRosterRevisions`) | reads the members' read positions again | skipped |
| App pages (`rosterMoved`) | reads `list_member_ids` again | — |
| Message access (`messageRevisionWrites`) | — | grants or revokes access to the chat |
| Room authority (`useRoomAuthorityRevision`) | refreshes the room | refreshes the viewer's authority too |

## Who gets what

One membership statement (an `INSERT`, or an `UPDATE` that changes `role` or `listen_mode`) sends each
recipient one revision per chat it touched. Recipients are the chat's current members plus the changed
seats. The named seat is:

- the recipient's own seat, when the statement changed it (the newcomer learns about its own access, and
  its membership read returns everyone else);
- otherwise the first changed seat by id (a seat the existing member does not know yet, so it reads the
  roster again).

With one changed seat this is the same revision the row trigger used to send. A topic's new seats send
one `chat_changed` to the source line per statement, not one per seat.

Deletes (`tombstone: true`) and private-state updates (`kind: 'own'`) are unchanged and row level.

## Cost

A statement that seats `k` people in a chat that ends with `n` members writes `n` revisions instead of
`k·n`, and a topic statement writes `S` source-line revisions instead of `k·S`. `create_gugu_group`
checks its initial members one by one and seats them in one `INSERT`, after the owner's own seat (so
`group_add_denial` can judge each addition as the owner): each recipient hears the owner's seat, the
initial members, and the agent flood rule's switch to passive when it trips. Only people receive
revisions, and initial members are the owner's agents, so today that is two or three revisions for the
owner however many agents join. The member limit is enforced per row by `enforce_group_member_limit`, so
creating a group past it fails with `member_limit_reached`.

## Known narrowing for clients

`agentPresenceStore` re-asks the presence of the named seat only. In a batch, a recipient no longer
hears about every other new seat one by one, so an agent whose presence it failed to read earlier is
re-asked on its next presence change instead. Single joins, where an agent is approved into a group
whose card already showed it, still name that agent.
