# Team member directory

`team-accounts?action=directory` requires a verified team principal and its live
Auth session. Ordinary members and administrators see the same active people in
their own team. Administrative member operations remain separately authorized.

Optional parameters are `query`, `cursor` and `limit` (1–100, default 50). Search
matches literal substrings of display names or canonical member emails, without
case sensitivity. Empty or whitespace-only queries select all active people;
queries longer than 254 characters and invalid cursors/page sizes are refused.

The response retains `members` and `next_cursor` and adds `team_id`, `total_count`
and `matching_count`. Counts cover all visible/matching members, independent of
the current cursor. Each member retains `identity_id`, `name`, `avatar` and `role`
and additionally includes its membership `id`, `email` and `revision`. The email
is the person's canonical membership address, not an internal Auth alias.
Invited, disabled and removed identities are excluded. Financial usage and caps
are supplied by the separate billing service.

Pages sort by membership UUID. The opaque-to-clients `next_cursor` is present
only when at least one further matching member exists. Callers must preserve
the query while continuing a page and restart pagination when it changes. This
is a live directory: membership/profile changes can change subsequent pages.

The service-only helper
`identity.team_directory_page_for(actor, session, team, query, cursor, limit)`
provides the same projection for trusted service composition without access to
the private membership tables. An explicit team must match the caller. The
function is owned by `postgres`; `anon` and `authenticated` cannot execute it.
