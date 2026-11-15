# Team identity workflow: work in progress

This draft is not ready for deployment. The live-session/file/Realtime boundary has separate real-Auth coverage; it does not prove this member lifecycle or privacy handoff.

New transactional identity releases are `071507` (closed workflow state), `071508` (email/read RPCs), `071509` (provisioning and management). They follow identity contexts `071505`/`071506` and precede the gate releases and region configuration. New RPCs are postgres-owned, fixed-search-path, server-only. No financial implementation is copied here.

The Edge verifies current callers through Auth. Anonymous email verification and invitation capabilities remain separate from management authorization. Official OTP sessions are locally revoked; codes/tokens/receipts are not logged or stored verbatim. A new verification-only Auth anchor is marked before registration triggers, then OTP signup is disabled; an existing personal account is never relabeled. New team principals use a database-planned UUID and internal alias, so a lost Auth creation response can be reconciled without creating another principal.

Receipt expiry and rate/attempt limits are enforced in the database. A multi-team choice does not consume the receipt or extend its deadline. Provisioning retries retain the same operation/team/principal. Activation checks all Auth bindings and the authoritative region before making the member live. Profile exposes the real member email and an opaque session namespace; internal aliases are not display identities.

`team_private.delivery_configuration.site_origin` is a privileged CD-configured HTTPS origin for invitation links, not a client redirect parameter. API roles cannot write it. A missing value closes invitation creation without introducing a new mandatory Edge environment variable. Its CD configuration is still pending. Links keep the capability in the fragment, with region outside it. This draft does not attest invitation email delivery.

Management rechecks the current administrator after waiting for the team lock. Same-key disable replays the original operation before comparing the target's now-incremented revision; changed requests fail. The member gate closes first. Auth session revocation precedes banning, because the official global sign-out adapter uses a temporary session. Model revocation uses the existing server-only callback. Already-issued upstream requests may finish and settle; no forced process shutdown is introduced.

## Explicitly unfinished

- Google exchange and restore/email-change reconciliation are not complete; unsupported paths fail closed.
- `asset_custody` separates organization ownership from private-history authority. It currently does not capture all live resources or provide operational handoff. The draft never changes the legacy agent owner, grants the recipient chat membership or claims that custody metadata alone is a finished handoff.
- `handoff_complete` remains false. A pending revocation must not be reported complete merely because Auth/model credentials were revoked. The UI must retain its original operation rather than creating a second one.
- Workflow-state cleanup, expired challenge retention and the organization-principal erasure path must join the separately reviewed account-erasure policy before production.
- Installed-schema tests and a real Edge → official OTP → separate Auth session lifecycle still need to pass. SQL state-machine tests are not email/HTTP evidence.

The full create → invite → spend → cap → adjust → top-up → disable acceptance requires the completed member lifecycle and privacy handoff. Billing/gate fixtures can independently prove financial invariants and stale-session denial, but cannot replace those product paths.
