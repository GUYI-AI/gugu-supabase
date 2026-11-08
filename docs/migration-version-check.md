# Migration version checks

New migration filenames use `supabase/migrations/<14 digits>_<lowercase_name>.sql`.
Versions do not have to be greater than the newest version on a branch.

On a pull request, the `migration-versions` CI job checks the complete head tree and
compares added, copied or renamed migrations with `dev`, `main` and every other open
pull request. Errors identify the version, filenames, and the conflicting branch
or PR number. A file already integrated at the same path with the same Git blob is
not a second migration. Modified or removed files do not reserve a new version.

The actual gate checks out the event's exact `pull_request.base.sha` from the base
repository into an independent `trusted/` directory and executes only that
commit's checker and allowlist. Candidate checker code runs only in the separate
offline unit tests. A PR cannot bypass its own check by changing its checker or
allowlist. Workflow changes still need independent review and repository policy.

The gate runs under `pull_request`, with only `contents: read` and
`pull-requests: read`. It uses the ephemeral `GITHUB_TOKEN`, including for fork PRs;
it does not use repository secrets, `pull_request_target`, SQL execution, dependency
installation, or another PR's code. Only public file/tree metadata is retained.
Pagination, tree truncation, API failures, and PR/branch changes detected during
the scan fail the check instead of treating an incomplete read as empty.

The result is a snapshot, not a version reservation. Before merging, rerun the
workflow on the PR's current head after any competing migration PR has changed or
merged. Maintainers can use **Re-run all jobs** on that head's workflow run; a run
for an older PR head refuses to pass. The existing required `unit` job always
starts and explicitly fails when the source lookup fails or an enforced gate
does not succeed. Failed or cancelled checks cannot hide behind a skipped job.

For the initial introducing PR, neither checker nor allowlist exists in the
base. `migration-source` reports **not enforced**, `migration-versions` is skipped,
and the ordinary candidate tests still run. A partially present checker is an
error. There is no candidate-source fallback or pinned bootstrap implementation.
The trust anchor for this one introducing PR is independent review of its final
commit; a skipped gate is not a successful collision scan. If an old event's base
has no checker but the current target branch already does, source lookup fails
and requires synchronization instead of silently remaining in bootstrap. That
lookup reads Git objects only; it never executes the newer target's code.

Repository administrator follow-up, after the introducing PR is merged:

- Make `migration-versions` a required check (not during bootstrap).
- Require review for `.github/**` and `scripts/ci/**`, using CODEOWNERS and the
  corresponding branch protection/review settings.

This PR does not change repository settings. Before rerunning a later PR, update
its base event by synchronizing the PR with the current target branch when the
trusted checker or allowlist has changed; rerunning an old event intentionally
continues to use that event's exact base SHA.

Pushes to `dev` and `main` use the reviewed pushed commit's checker and check its
entire committed migration tree. This
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
