# Migration version checks

New migration filenames use `supabase/migrations/<14 digits>_<lowercase_name>.sql`.
Versions do not have to be greater than the newest version on a branch.

On a pull request, the `migration-versions` CI job checks the complete head tree and
compares added, copied or renamed migrations with `dev`, `main` and every other open
pull request. Errors identify the version, filenames, and the conflicting branch
or PR number. A file already integrated at the same path with the same Git blob is
not a second migration. Modified or removed files do not reserve a new version.

The job runs under `pull_request`, with only `contents: read` and
`pull-requests: read`. It uses the ephemeral `GITHUB_TOKEN`, including for fork PRs;
it does not use repository secrets, `pull_request_target`, SQL execution, dependency
installation, or execution of another PR's code. Only public file/tree metadata is
retained. Pagination, tree truncation, API failures, and PR/branch changes detected
during the scan fail the check instead of treating an incomplete read as empty.

The result is a snapshot, not a version reservation. Before merging, rerun the
workflow on the PR's current head after any competing migration PR has changed or
merged. Maintainers can use **Re-run all jobs** on that head's workflow run; a run
for an older PR head refuses to pass. Both existing required jobs (`unit` and
`integration`) depend on `migration-versions`. The `unit` job always starts and
explicitly fails if that dependency did not succeed: a failed or cancelled check
cannot be hidden behind a skipped required job. Branch protection and merge
decisions remain with maintainers.

Pushes to `dev` and `main` also check the entire committed migration tree. This
detects a collision if two previously green PRs are merged from concurrent
snapshots. Push mode reads only the local Git tree and does not call the GitHub API.
Existing duplicate groups are listed by exact filenames in
`scripts/ci/migration-version-allowlist.json` for issue #91. Another file sharing a
listed version still fails. Removing these historical exceptions requires the
separate release-identity compatibility work; this check does not rename SQL,
rewrite installed ledgers, or execute an applied release again.

Run the offline tests with:

```sh
node --test tests/ci/migration-versions.test.mjs
node scripts/ci/migration-versions.mjs --tree "$(git rev-parse HEAD)"
```
