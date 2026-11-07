# Upgrade-first connection management

This release is dormant by default: the policy row is revision zero, enforcement
is false, and no minimum versions are selected. Installing it neither activates
owner authority nor grants the closed owner mutation APIs.

## Public read contract

Deploy and exercise both authenticated readers before shipping the first client:
`identity.connection_authority()` retains its original DTO;
`identity.connection_management_access()` independently reports availability.
It creates no assistant, connection head, receipt or queued work and works inside
a read-only transaction.

Only connection-management requests declare the actual packaged full SemVer in
`x-gugu-connection-client-version` and a platform in
`x-gugu-connection-client-platform` (`desktop|phone|server|web`).
The policy is an explicit platform-to-minimum map. An enabled policy must have at
least one valid entry; omitted or unknown platforms are denied with a null
minimum. Missing/invalid declarations are denied while enforcement is enabled.
Build metadata does not affect precedence; numeric prereleases compare
numerically. Versions are bounded to 128 characters and nine-digit core numbers.

The availability DTO is:
`{version:1, feature:'connection-management', policyRevision:string,
enforced:boolean, allowed:boolean, minimumVersion:string|null,
clientPlatform:string|null, errorCode:'CONNECTION_CLIENT_UPGRADE_REQUIRED'|null}`.

A blocked SQL call has SQLSTATE `PT426`, exact message
`CONNECTION_CLIENT_UPGRADE_REQUIRED`, and JSON DETAIL containing only feature,
minimumVersion, clientPlatform and policyRevision. Permission, missing-RPC and
transport failures are not upgrade decisions. The declaration is a rollout
compatibility signal; it never substitutes for owner/device authorization.

## Transaction boundaries

All management writes acquire the shared policy advisory lock, then the
owner-authority advisory/head lock, before existing owner/item/credential locks.
The closed policy setter takes the policy lock exclusively and requires the
expected policy revision. Enabling enforcement therefore waits for earlier
guarded database writes; later old-version writes fail before consuming UUIDs.
The reader is not permission to perform an effect.

Owner snapshot/resource reads apply the version policy without taking write
locks. Whole-head task admission (no operation UUID), existing acknowledgements,
the authority/access readers, mixed legacy snapshots and non-integrations
requests retain their original paths. After an owner switch the legacy
integrations commit refuses even a declaration claiming a new version. There
is no forwarding or second writable metadata source.

## Release and rollback

1. Merge the preparation and owner-runtime prerequisites in their reviewed order,
   retargeting/rechecking the stacked changes. Deploy both readers and this
   policy OFF through the approved CD workflow.
2. Deploy the matching platform management service increment before clients.
   Keep owner mutation grants/authority dormant; ordinary tasks and protocol-1
   authorization keep their existing behavior.
3. Publish and accept the actual owner-location-capable client for each supported
   platform. Only then choose its minimum. Recount versions and prepare the
   private notification list at cutover; do not infer readiness from old Betas.
4. Before the approved owner switch, drain existing credential HTTP/OAuth effects,
   verify bounded source migration/audit including tombstones and pending work,
   and apply policy/authority/grants under the documented policy/authority locks.
   A database lock cannot cancel an upstream request or an offline old binary.
   The deployment lead must fix and rehearse this CD transaction before use.
5. Verify explicit refusal, upgrade/re-read with the same identity, original
   authorization/credential custody, tombstones and original UUID receipts.
   No reset or reauthorization is part of upgrading.

Only the approved CD maintenance role may call
`identity.connection_management_set_policy(expectedRevision,enforced,minimums)`.
All API roles are denied this setter. Disabling the version policy retains both
readers, all data and the existing authority. It does not reopen legacy writes
after an owner switch. Reverting authority requires the separately reviewed
migration/rollback procedure; never point clients at an obsolete source or
restore revoked credentials. No rollback SQL here rewrites migration ledgers.
