# Attachment quota release: body and ACL preservation

Installation CI captures the real `pg_proc` rows immediately before and after
`20261120060000_attachment_quota_lock_order`. It does not reconstruct old bodies
from migration source: this also covers functions amended or copied by previous
dynamic releases.

The reviewed inventory has 22 live functions and two retired API exclusions.
`20261030090000_project_files_peer` dropped `file_version_handoff_publish` and
`publish_revision_by`; both signatures must be absent before and after the release.
For each of the 22 live functions,
the verifier removes exactly one literal admission fragment from its permitted
entry position. The remaining UTF-8 bytes must equal the predecessor bytes,
without SQL, whitespace or Unicode normalization. Conditional file-message and
locking-workspace branches have their own exact allowed fragments/positions.
No other function in `chat` or `file_private` may be added, removed or changed.

Effective ACL tuples compare grantor, grantee, privilege and grant option, sorted
by PostgreSQL. Default ACLs are expanded before comparison. Function ownership,
security mode, settings and remaining catalog attributes must also match. Default
argument expressions are compared after deparsing because internal parser source
locations can change when PostgreSQL recreates an otherwise identical definition.
Function body bytes are never deparsed or normalized.

`pnpm test:installation` fails if this audit fails. CI uploads
`.local/verification/attachment-quota-359.json` even on failure; a missing artifact
is an error. It contains the release/SQL digest, CI source identity, all 24
reviewed signatures (22 body comparisons and two absence checks), original and installed body bytes in hex, allowed insertion bytes and
offset, before/after/restored SHA-256 digests, ACL tuples, metadata and any
unexpected catalog changes. It contains source/catalog information, not fixture
credentials or application data. A report with `passed: false` is not acceptance.

The offline verifier tests inject single-byte and Unicode body changes, moved or
duplicate admission, ACL/owner changes, missing targets and unrelated edits. Those
tests validate refusal behavior; they do not substitute for the real installation
comparison or the separate concurrent `40P01` regressions.
