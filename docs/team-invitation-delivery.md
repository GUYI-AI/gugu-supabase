# Team invitation delivery: candidate deployment

Install the community migration `20261115083000_team_invitation_admission` after `080102` and before the later file/audit releases. Deploy the matching functions through the normal reviewed CD. The official function overlay must retain the same community identity RPCs. This candidate remains a draft until the complete checks and configured staging acceptance pass.

## Configuration and safe activation

`team_private.delivery_configuration.mail_policy` is the server-owned configuration, read on each admission. API roles cannot change it. Initial staging assumptions are: 100 live pending invitations; team 20/15 minutes and 100/24 hours; inviter 10/15 minutes and 50/24 hours; invitation recipient 60-second cooldown and 3/24 hours; combined global sends 50/15 minutes and 300/24 hours. `invitation_global_percent=60` reserves the remainder for OTP; invitation capacity is rounded down. OTP retains its separate 60-second/3-per-15-minute recipient bucket. Both kinds consume the combined global bucket. Review provider capacity and the separate personal-OTP traffic before production; a reviewed named CD repair changes policy data, not function code.

| Server setting | Requirement |
| --- | --- |
| `TEAM_INVITE_MAIL_ENABLED` | Defaults closed; only literal `true` enables invitation SMTP. |
| `TEAM_INVITE_SMTP_HOST`, `PORT`, `USER`, `PASSWORD`, `FROM` | Mandatory private transport settings, mapped through reviewed CD to the rotated existing transactional-mail account. |
| `TEAM_INVITE_SMTP_TLS_MODE` | `starttls` or `implicit_tls`; certificate verification stays enabled. |
| `TEAM_INVITE_TEST_RECIPIENT` | Mandatory operator-approved existing staging recipient. A different invitation is refused, never redirected to this address. Missing configuration produces no invitation SMTP traffic. |
| `TEAM_INVITE_XFF_FROM_RIGHT`, `TEAM_INVITE_XFF_MIN_HOPS` | Optional attested proxy-chain selection; both absent by default. Malformed/short chains produce no IP key. Mandatory non-IP admission remains active. |

Keep SMTP disabled while deploying. Configure the fixed invitation site through its reviewed, staging-only named repair. Review policy, then apply SMTP settings only after the credential rotation and authorized recipient are ready. Actual values belong in private configuration, never a PR, command argument, diagnostic, or invitation request. Enable optional IP admission only after operations attests the complete ingress chain and direct-bypass controls; do not infer trust from X-Real-IP or the first forwarded value. A firewall-rule readback is not an external reachability probe.

## Observable results

A replay keeps the original invitation, token, identity operation and unique mail key `team-invitation-v1:<invitation_id>`. Responses include `operation_id`, `invitation_created` and `delivery` with its operation ID/state/safe reason. `invitation_created=null` means the database acknowledgment is uncertain; retry the exact original intent/key. A known creation remains `true` even if binding, admission or SMTP later fails. A usable link is withheld until the recipient's identity prerequisite is established.

Mail states are `pending`, `sending`, `accepted`, `failed` and `unknown`. `accepted` means SMTP explicitly accepted the message, not that it reached an inbox. Active/expired sending leases and unknown outcomes never trigger automatic resend. A failed persistence acknowledgment after SMTP acceptance is reported as unknown. Limits refuse before Auth/SMTP side effects. Existing personal identities are not modified or adopted by email.

For an existing personal recipient, no anchor is created or adopted: GoTrue's duplicate-email result leaves the personal ID, email and metadata unchanged; email verification uses that existing account, while accepting the invitation provisions a separate team principal.

## Lock order and transaction boundaries

Each Edge RPC is a separate database transaction and commits before the next RPC or any Auth/SMTP network call. Creation/binding never retain their team lock across a mail claim.

| Path | Locks, in acquisition order |
| --- | --- |
| Member workflow, including invitation creation/binding | `team-members:<team>` advisory, then its operation/member/invitation rows; change-email additionally takes its existing email advisory before creating a challenge. The wrapper/base reuse the same team advisory. |
| Email challenge begin | Existing email advisory, optional invitation row, then new challenge; no mail-global advisory. |
| Invitation mail prepare/claim | Invitation row, delivery row and its FK key-share locks, then `team-mail-admission` advisory only for a fresh claim. Caller/context checks do not take the team advisory. |
| OTP mail prepare/claim | Challenge row, optional invitation row, delivery row/FK locks, then the same mail-global advisory only for a fresh claim. |
| Mail finish | Delivery row only; the private lease authorizes this in-flight result without taking team/global locks. |

After acquiring the mail-global advisory, admission reads policy/counters and updates only its already-locked delivery row; it does not acquire a team advisory or another subject row. Thus no implemented path reverses global-to-team. A caller composing multiple RPCs inside one SQL transaction must keep team-before-global order; normal Edge requests do not compose them. Existing invitation acceptance uses challenge → provision advisory/operation → invitation/member, with no mail-global acquisition. SMTP runs after commit, under the durable lease rather than database locks.

Staging acceptance uses the approved existing recipient, provider-backend delivered evidence and the official proof flow. Synthetic addresses and loopback SMTP tests do not prove delivery. New identities/resources and mail-state fields belong to the coordinated cleanup registry; hashes remain identifying data.

## Rollback and recovery

Disable invitation SMTP through reviewed configuration first. Restoring the previous functions stops this candidate's SMTP sender; retain installed migrations/ledger and the pending-cap guard. Do not drop identity/mail rows or erase unknown operations to force retries. Reconcile provider evidence before any separately approved recovery of an uncertain operation. Late finishes require their original private lease and cannot recreate an erased delivery row. The site repair's rollback closes its destination; it does not roll back identity or financial history.
