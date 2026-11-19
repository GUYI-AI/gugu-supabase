# Separate principal classification

Auth can persist server app metadata after the initial insert in the same transaction. Consumers must reselect the final row after Auth commits; an insert event's captured metadata is insufficient. Editable user metadata never grants team membership or changes identity classification.

The reserved `team.gugu.invalid` routing domain requires both the exact private planned/bound principal UUID and the canonical member alias. Public registration cannot choose a planned identity by claiming the domain. The guard does not set team markers, bind membership, or modify an existing personal account.

`identity.personal_principal_is_eligible(uuid)` is a service-only classification query with a fixed search path and `postgres` ownership. Team aliases, private planned/bound members, non-personal server markers, partial team markers and deleted/missing Auth rows return false. An ordinary personal account remains eligible; this result is not a membership, access or financial authorization.

Forward migration `20261119132100` follows the queued identity-cleanup releases. The paired private consumer release must separately defer signup admission, guard all admissions and recheck before side effects. Installing either half first must preserve ordinary personal registration; a half deployment does not establish completion of the paired boundary. Deployment and release numbering need the final ordered queue, not an insertion into an already-installed ledger. No existing identity or external mapping is rewritten.

Disposable tests cover exact plans and random UUIDs, ordinary signup, editable metadata, committed Auth creation, public reserved-domain rejection and permissions. Real invitation/login workflows continue through the ordinary service-only provisioning path. Pair-order validation and private side-effect checks belong to the paired release; no shared or production deployment is claimed here.
