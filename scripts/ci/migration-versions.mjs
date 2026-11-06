import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'

const directory = 'supabase/migrations/'
const filenamePattern = /^supabase\/migrations\/(\d{14})_[a-z0-9_]+\.sql$/
const changedStatuses = new Set(['added', 'renamed', 'copied'])
const fileStatuses = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged'])
const quote = value => JSON.stringify(value)

function version(path) {
  return filenamePattern.exec(path)?.[1] ?? null
}

export function checkTree(files, allowlist, source = 'tree') {
  assert.equal(allowlist.schema, 1, 'Invalid migration allowlist')
  const errors = []
  const groups = new Map()
  for (const file of files) {
    const id = version(file.path)
    if (!id) {
      errors.push(`Invalid migration filename ${quote(file.path)} in ${source}; expected <14 digits>_<lowercase_name>.sql`)
      continue
    }
    const paths = groups.get(id) ?? []
    paths.push(file.path)
    groups.set(id, paths)
  }
  for (const [id, paths] of groups) {
    if (paths.length < 2) continue
    const historical = allowlist.duplicates[id] ?? []
    if (paths.every(path => historical.includes(path))) continue
    errors.push(`Migration version ${id} conflicts in ${source}: ${paths.sort().map(quote).join(', ')}`)
  }
  return errors
}

export function introducedMigrations(files) {
  return files.filter(file => changedStatuses.has(file.status) && file.filename.startsWith(directory))
}

export function checkPullRequest({number, files, headFiles, branches, others, allowlist}) {
  const errors = checkTree(headFiles, allowlist, `PR #${number}`)
  const introduced = introducedMigrations(files)
  for (const file of introduced) {
    const current = headFiles.find(entry => entry.path === file.filename)
    assert(current, 'Changed migration missing from the PR head tree')
    const id = version(file.filename)
    if (!id) continue // The complete head tree already reports malformed names.
    for (const [branch, entries] of Object.entries(branches)) {
      // A stale PR may still list a file already integrated byte-for-byte.
      // Its historical siblings are not new collisions introduced by this PR.
      if (entries.some(other => current.path === other.path && current.sha === other.sha)) continue
      for (const other of entries) {
        if (version(other.path) !== id) continue
        errors.push(`Migration version ${id}: PR #${number} ${quote(file.filename)} conflicts with ${branch} ${quote(other.path)}`)
      }
    }
    for (const other of others) {
      for (const entry of introducedMigrations(other.files)) {
        if (version(entry.filename) === id) {
          errors.push(`Migration version ${id}: PR #${number} ${quote(file.filename)} conflicts with open PR #${other.number} ${quote(entry.filename)}`)
        }
      }
    }
  }
  return [...new Set(errors)].sort()
}

// Retain only metadata. Never execute SQL/code from a PR or log patches or PR titles.
export function githubReader({repository, token, fetchImpl = fetch}) {
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Invalid repository')
  assert(token, 'GITHUB_TOKEN is required for the PR metadata check')
  const get = async path => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28'},
      signal: AbortSignal.timeout(15000), redirect: 'error',
    })
    // Do not print API error bodies, request headers or transport error messages.
    if (!response.ok) throw Error(`GitHub metadata read failed (HTTP ${response.status})`)
    return response.json()
  }
  const pages = async path => {
    const all = []
    for (let page = 1; page <= 100; page++) {
      const rows = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      assert(Array.isArray(rows), 'Invalid GitHub list response')
      all.push(...rows)
      if (rows.length < 100) return all
    }
    throw Error('GitHub metadata pagination limit reached; refusing an incomplete check')
  }
  const files = async pr => {
    assert(Number.isInteger(pr.changed_files) && pr.changed_files <= 3000, 'PR file list exceeds the complete GitHub API limit')
    const rows = await pages(`pulls/${pr.number}/files`)
    assert.equal(rows.length, pr.changed_files, 'Incomplete PR file list')
    for (const file of rows) assert(typeof file.filename === 'string' && fileStatuses.has(file.status), 'Invalid PR file metadata')
    return rows
  }
  const tree = async sha => {
    assert(/^[a-f0-9]{40}$/.test(sha), 'Invalid tree commit')
    const result = await get(`git/trees/${sha}?recursive=1`)
    assert.equal(result.truncated, false, 'Truncated GitHub tree; refusing an incomplete check')
    assert(Array.isArray(result.tree), 'Invalid GitHub tree response')
    return result.tree.filter(entry => entry.path.startsWith(directory) && entry.type !== 'tree').map(entry => {
      assert(entry.type === 'blob' && /^[a-f0-9]{40}$/.test(entry.sha), 'Invalid migration tree entry')
      return {path: entry.path, sha: entry.sha}
    })
  }
  return {get, pages, files, tree}
}

const snapshot = pr => [pr.number, pr.state, pr.head.sha, pr.base.sha, pr.base.ref]
const openSnapshot = prs => JSON.stringify(prs.map(snapshot).sort((a, b) => a[0] - b[0]))

export async function checkGitHub({repository, number, expectedHead, token, allowlist, fetchImpl}) {
  assert(Number.isSafeInteger(number) && number > 0, 'Invalid PR number')
  const api = githubReader({repository, token, fetchImpl})
  const pr = await api.get(`pulls/${number}`)
  assert.equal(pr.state, 'open', 'PR is no longer open')
  assert.equal(pr.base.repo.full_name, repository, 'Unexpected PR repository')
  assert.equal(pr.head.sha, expectedHead, 'PR head changed; run the check on its latest head')
  const [files, headFiles, dev, main, open] = await Promise.all([
    api.files(pr), api.tree(pr.head.sha), api.get('git/ref/heads/dev'), api.get('git/ref/heads/main'), api.pages('pulls?state=open'),
  ])
  const [devFiles, mainFiles] = await Promise.all([api.tree(dev.object.sha), api.tree(main.object.sha)])
  const others = []
  if (introducedMigrations(files).length) {
    for (const item of open) {
      if (item.number === number) continue
      const other = await api.get(`pulls/${item.number}`)
      assert.equal(other.base.repo.full_name, repository, 'Unexpected open PR repository')
      assert.deepEqual(snapshot(other), snapshot(item), 'Open PR changed during the check; rerun')
      const otherFiles = await api.files(other)
      assert.deepEqual(snapshot(await api.get(`pulls/${other.number}`)), snapshot(other), 'Open PR changed during the check; rerun')
      others.push({number: other.number, files: otherFiles})
    }
  }
  const [finalPr, finalOpen, finalDev, finalMain] = await Promise.all([
    api.get(`pulls/${number}`), api.pages('pulls?state=open'), api.get('git/ref/heads/dev'), api.get('git/ref/heads/main'),
  ])
  assert.deepEqual(snapshot(finalPr), snapshot(pr), 'PR changed during the check; rerun')
  assert.equal(openSnapshot(finalOpen), openSnapshot(open), 'Open PR set changed during the check; rerun')
  assert.equal(finalDev.object.sha, dev.object.sha, 'dev changed during the check; rerun')
  assert.equal(finalMain.object.sha, main.object.sha, 'main changed during the check; rerun')
  return checkPullRequest({number, files, headFiles, branches: {dev: devFiles, main: mainFiles}, others, allowlist})
}

export function localTree(ref) {
  assert(/^[a-f0-9]{40}$/.test(ref), 'Use a full commit SHA for the tree check')
  return execFileSync('git', ['ls-tree', '-r', '-z', ref, '--', 'supabase/migrations'], {encoding: 'utf8'})
    .split('\0').filter(Boolean).map(line => {
      const match = /^\d+ blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(line)
      assert(match, 'Invalid migration tree entry')
      return {sha: match[1], path: match[2]}
    })
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const allowlist = JSON.parse(readFileSync(new URL('./migration-version-allowlist.json', import.meta.url), 'utf8'))
  let errors
  if (argv[0] === '--tree' && argv.length === 2) {
    errors = checkTree(localTree(argv[1]), allowlist)
  } else if (argv[0] === '--pull-request' && argv.length === 1) {
    assert.equal(env.GITHUB_EVENT_NAME, 'pull_request', 'PR metadata mode requires a pull_request event')
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    errors = await checkGitHub({repository: env.GITHUB_REPOSITORY, number: event.number, expectedHead: event.pull_request.head.sha, token: env.GITHUB_TOKEN, allowlist})
  } else throw Error('Usage: migration-versions.mjs --tree <commit SHA> | --pull-request')
  for (const error of errors) console.error(error)
  if (!errors.length) console.log('Migration version check passed.')
  return errors.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main() }
  catch (error) {
    // Assertion diagnostics contain only the public metadata compared above; network errors may not.
    console.error(error?.code === 'ERR_ASSERTION' ? `Migration metadata check failed: ${error.message}` : 'Migration metadata could not be read completely; rerun the check.')
    process.exitCode = 1
  }
}
