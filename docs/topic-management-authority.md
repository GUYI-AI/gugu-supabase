# Topic management authority

Group membership is the authority for a group's topics. Topic participation only stores the participants' local preferences and read state.

`chat.group_is_manager` accepts a group ID and checks the actual actor's group seat. `chat.management_authority` is the single resolver for group/topic management. For a group topic it delegates to the source group. For a topic inside a DM or AI conversation it preserves the human creator's authority, including the human owner of an Agent creator, while requiring source membership.

Rename, participant removal, topic archival and decision writes/cancellation consume this result. Every membership read in these functions uses `chat.active_members`, so a removed identity never holds authority; writes still target `chat.chat_members`. Agent archival still requires an exact match of the current topic name. Group dissolution remains restricted to the human group owner. Topic-local role promotion is rejected; creation and Agent-owner enrollment write member seats only. The migration retires existing topic roles without changing participation, listen mode, notification preferences or read boundaries.

`group_info_as` returns management and archival capabilities. `list_member_ids` returns the topic's participants and listen modes with roles projected from the same authority source. Callers must use these results rather than infer authority from physical topic member rows.

The human owner still changes their own Agent's listen mode through `set_agent_listen_mode_as`, regardless of their group role. A group manager cannot change another person's Agent settings using that management role. Personal pin and notification preferences retain their existing row policies.

Regression coverage is in `groupAdminAs.test.ts`, `topicArchival.test.ts` and `topicOwnerEnrollment.test.ts`. It includes stale topic roles, source-role revocation, nonparticipant source managers, owner-only Agent settings, personal preferences and private-source creator authority. Product acceptance additionally requires the real topic UI and a backend containing this release.
