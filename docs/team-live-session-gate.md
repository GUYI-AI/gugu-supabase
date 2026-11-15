# Team live-session and Realtime boundary

This is part of #276/#277. Membership/Auth workflow and the official financial layer remain separate workstreams. No deployment is performed by this change.

## Data authorization

`identity.team_session_is_active()` takes no actor parameter. For a team identity it checks the verified JWT subject/session, the still-existing Auth session, current Auth metadata, active member/team state and the local deployment region. Missing, unbound, mismatched, disabled, expired or region-unconfigured team contexts fail closed. The existing personal path stays independent of team configuration.

The Data API pre-request hook runs before REST and SECURITY DEFINER RPC calls. Installation refuses an unknown existing pre-request hook instead of silently replacing it. Restrictive policies additionally intersect existing scopes on application RLS tables and Storage objects/buckets; they do not grant access to a row previously denied. Storage platform maintenance/catalog tables are not rewritten. The request hook does not cover Storage or Realtime, which is why those paths have their own live predicates. See [Supabase pre-request scope](https://supabase.com/docs/guides/api/securing-your-api).

The file server forwards the verified JWT `session_id` into its service-only four-argument `chat.files_authorize`. Team document connections retain that session separately in their authorization key, recheck new messages and use the existing LISTEN/periodic recheck to close revoked connections. A different live session cannot keep a revoked connection authorized merely because its user/item/actor match. Personal clients keep their existing behavior. Deploy the file-server source with these migrations before advertising complete team file access. Existing signed download capabilities retain the separate 60-second contract.

## Realtime contract

Realtime caches authorization for a connection, so a membership-policy update alone cannot revoke a subscribed reader. See [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization#updating-rls-policies) and [Auth session validation](https://supabase.com/docs/guides/auth/sessions).

The service-only RPC `identity.team_realtime_namespace_for(p_actor uuid,p_session_id uuid DEFAULT NULL)` returns an opaque prefix for one current member revision and live Auth session. Missing session/configuration returns NULL. Only the profile server may name the actor/session; clients consume the complete `realtime_namespace` string returned for their verified current session. They must not reconstruct it or fall back to an original personal topic.

Team subscriptions use `realtime_namespace + original_topic`, with `private:true`. Member revision changes move publishing away from the old prefix; disabling suppresses ordinary content; deleting one Auth session suppresses that session's topics while other live sessions continue. Original personal topics and their existing authorization remain unchanged. A stale namespace may receive only a content-free `team_context_changed` invalidation.

Team client broadcasts use authenticated `public.team_publish_realtime(p_topic text,p_payload jsonb,p_event text)`. Supply the original topic, existing payload and event. The server checks the existing write scope and derives the recipient's active namespaces; the sender never prepends its own prefix to a recipient's topic. Raw team WebSocket publishing is denied, including before revocation, so no cached write permission can bypass this live RPC gate. This covers device `rpc` and `rpc:<asker>` channels and shared preview channels. It does not grant clients a new ability to publish device-command or user-event topics. Database-origin device commands, user/agent events, previews, presence and public feed hints use the same publisher routing.

## Installation and configuration

Apply the identity releases first, then gate releases `071510`, `071511`, `071512` and deployment-region release `071520`. Earlier gates fail closed if the later region helper is absent or unconfigured. All new objects belong to postgres. Arbitrary actor/session resolution and all financial-independent private tables remain closed to ordinary API roles.

`team_private.deployment.region` starts NULL. The normal privileged CD configuration step must apply `ops/set-team-deployment-region.sql` with its authoritative `gugu.deployment_region` value, then read back service-only `identity.team_deployment_region()`. API roles cannot write this setting. A copied team's region or a client parameter is not the local authority. Normal configuration refuses changing an already-set deployment region.

Keep the region unconfigured until the session-aware file-server source has been deployed and verified. Region configuration is the final activation step for team contexts; an old file server does not forward Auth sessions. Personal access continues while team activation is closed.

## Validation scope

The targeted SQL cases exercise live sessions, old JWT claims, wrong/missing/cross-region metadata, state changes, ACLs and namespace movement. The HTTP integration path uses real Auth logins, a private Storage object, SECURITY DEFINER RPC calls and actual private WebSockets; it proves that old subscribed channels receive no new content after disable/revision change/sign-out, while a live sibling session and another member still work. Cross-session device RPC delivery uses the receiver's namespace, and a different member cannot publish into that device's topic. A database-broadcast roundtrip probe precedes assertions because a channel join does not attest lazy replication startup.

These backend tests do not attest the complete team creation/invitation/management UI or the official billing workflow. Those require the separately coordinated deployed-head acceptance.
