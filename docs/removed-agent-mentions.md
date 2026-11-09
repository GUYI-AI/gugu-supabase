# Mentions of a removed agent (GUYI-AI/gugu#2383)

Archiving an agent with "remove social identity" sets `identity.users.removed_at`. Its seat rows stay in
`chat.chat_members` (20261031031000), but every membership read uses live identities, so the agent is no longer a member and
`chat.is_addressable_in` is false for it.

Until 20261109151500, a group message that still mentioned such an agent (a draft written before archival, a cached member
list) failed the `messages_insert_member` policy, and nobody in the chat received it.

## Behavior now

| Recipient in `to_user_ids`                                              | Message                           | Recipient outcome                                             |
|-------------------------------------------------------------------------|-----------------------------------|---------------------------------------------------------------|
| live member                                                             | accepted                          | normal delivery                                               |
| session-archived agent, identity kept (#236)                            | accepted                          | refusal `agent_archived`, not woken                           |
| removed agent with a seat in this chat, or in the topic's source chat   | accepted                          | refusal `identity_removed`, not woken, not seated in the topic |
| removed agent that never sat here                                       | rejected (RLS, 42501)             | –                                                             |
| any id that never sat here                                              | rejected (RLS, 42501)             | –                                                             |
| whisper to a removed agent                                              | rejected (`enforce_whisper_rule`) | –                                                             |

Notes:

- **One refusal row.** The refusal is a `chat.message_agent_delivery_blocks` row. It is broadcast as `delivery_changed` with
  `status: blocked` and the reason, the same as `agent_archived`.
- **Messages that wake nobody.** These record no refusal, and neither does `@all`.
- **Reasons the table accepts.** It allows exactly `agent_archived` and `identity_removed`.

## Not changed: humans

- **Removed humans:** a human who removed their own identity keeps their seats, the same as an agent. A message mentioning them is
  still rejected as before. The refusal table and its client handling are agent-specific (wake and inbox paths, the
  `gugu-agent:` receipt device). Extending them to humans is a separate change.
- **Humans who left a group:** leaving deletes the seat row, and the database keeps no record of past membership. A former
  member is therefore indistinguishable from an id that was never there, and a mention of them is rejected. Accepting such
  mentions would first need a membership history. Leaving publishes a roster tombstone for the remaining members, so such
  a mention mostly comes from a stale draft or cache.

## Clients and rollout order

Clients that accept only `agent_archived` treat `identity_removed` as an invalid refusal. For example, `apps/desktop/electron/mcp/message-delivery-blocks.mjs` before GUYI-AI/gugu#2388 throws on it.

The message has already been accepted at that point. An agent using such a client concludes that the send failed and sends again, and the group gets a duplicate message, which is worse than the old outright rejection. Therefore:

- **Staging:** deploy this migration only after GUYI-AI/gugu#2388 is merged into gugu `dev`.
- **Production:** deploy it only after a release containing #2388 has shipped.
