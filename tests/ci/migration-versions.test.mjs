import assert from 'node:assert/strict'
import {execFileSync, spawnSync} from 'node:child_process'
import {mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'
import {checkTree, checkPullRequest, githubReader, checkGitHub, localTree} from '../../scripts/ci/migration-versions.mjs'

const empty = {schema: 1, duplicates: {}}
const sha = n => n.toString(16).padStart(40, '0')
const migration = (version, name, blob = 1) => ({path: `supabase/migrations/${version}_${name}.sql`, sha: sha(blob)})
const added = file => ({filename: file.path, status: 'added'})
const one = migration('20261106110000', 'first')
const two = migration('20261106110000', 'second', 2)
const next = migration('20261106110100', 'next')
const check = overrides => checkPullRequest({number: 7, files: [added(one)], headFiles: [one], branches: {dev: [], main: []}, others: [], allowlist: empty, ...overrides})

test('two migrations with the same version in one PR fail with both paths', () => {
  const errors = check({files: [added(one), added(two)], headFiles: [one, two]})
  assert.equal(errors.length, 1)
  for (const text of ['20261106110000', 'PR #7', one.path, two.path]) assert(errors[0].includes(text))
})
for (const branch of ['dev', 'main']) test(`a version already on ${branch} fails`, () => {
  const errors = check({branches: {[branch]: [two]}})
  assert.equal(errors.length, 1)
  assert(errors[0].includes(branch) && errors[0].includes(two.path))
})
test('an added migration in another open PR fails with its number and path', () => {
  const errors = check({others: [{number: 8, files: [added(two)]}]})
  assert.equal(errors.length, 1)
  assert(errors[0].includes('open PR #8') && errors[0].includes(two.path))
})
test('unique versions pass without a chronological ordering requirement', () => {
  assert.deepEqual(check({branches: {dev: [next]}, others: [{number: 8, files: [added(next)]}]}), [])
})
test('a file already integrated at the same path and blob is not a second migration', () => {
  assert.deepEqual(check({branches: {dev: [one], main: [one]}}), [])
  assert.equal(check({branches: {dev: [{...one, sha: sha(99)}]}}).length, 1)
})
test('renames and copies reserve a version, while removals and modifications do not', () => {
  for (const status of ['renamed', 'copied']) assert.equal(check({files: [{...added(one), status}], branches: {dev: [two]}}).length, 1)
  for (const status of ['removed', 'modified']) assert.deepEqual(check({files: [{...added(one), status}], branches: {dev: [two]}}), [])
  assert.deepEqual(check({others: [{number: 8, files: [{filename: two.path, status: 'removed'}]}]}), [])
})
test('historical exceptions name exact files, not an entire version namespace', () => {
  const allowlist = {schema: 1, duplicates: {'20261106110000': [one.path, two.path]}}
  assert.deepEqual(checkTree([one, two], allowlist), [])
  assert.equal(checkTree([one, two, migration('20261106110000', 'third')], allowlist).length, 1)
  assert.deepEqual(check({allowlist, headFiles: [one, two], branches: {dev: [one, two], main: [one, two]}}), [])
})
test('malformed added or renamed migration names fail, including nested files', () => {
  for (const name of ['bad.sql', '2026110611000_short.sql', '20261106110000_Upper.sql', 'nested/20261106110000_file.sql']) {
    for (const status of ['added', 'renamed']) {
      const file = {path: `supabase/migrations/${name}`, sha: sha(1)}
      const errors = check({files: [{filename: file.path, status}], headFiles: [file]})
      assert.equal(errors.length, 1)
      assert(errors[0].includes('Invalid migration filename'))
    }
  }
})
test('public filenames are quoted so newline input cannot inject a workflow command', () => {
  const name = 'supabase/migrations/invalid\n::error::injected.sql'
  const [error] = checkTree([{path: name, sha: sha(1)}], empty)
  assert(!error.includes('\n'))
  assert(error.includes('\\n'))
})
test('the real #192/#193 filenames reproduce the collision', () => {
  const feedback = migration('20261106110000', 'private_feedback_screenshots')
  const recovery = migration('20261106110000', 'agent_turn_outcomes_restore_distinct_on')
  const errors = check({number: 192, files: [added(feedback)], headFiles: [feedback], branches: {dev: [recovery]}})
  assert.equal(errors.length, 1)
  for (const value of ['20261106110000', '#192', feedback.path, recovery.path]) assert(errors[0].includes(value))
  assert.equal(check({number: 192, files: [added(feedback)], headFiles: [feedback], others: [{number: 193, files: [added(recovery)]}]}).length, 1)
})

function server({otherCount = 1, currentFiles = [added(one)], currentTree = [one], otherFiles = [added(next)], devTree = [], mutate} = {}) {
  const repository = 'example/community'
  const pr = (number, commit) => ({number, state: 'open', changed_files: number === 7 ? currentFiles.length : otherFiles.length, head: {sha: commit, repo: {full_name: number === 7 ? 'contributor/fork' : repository}}, base: {sha: sha(100), ref: 'dev', repo: {full_name: repository}}})
  const current = pr(7, sha(7))
  const others = Array.from({length: otherCount}, (_, n) => pr(n + 8, sha(n + 8)))
  const calls = []
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.github.com')
    assert.equal(options.redirect, 'error')
    assert(options.signal)
    calls.push(url)
    const u = new URL(url), route = u.pathname.replace(`/repos/${repository}/`, ''), page = Number(u.searchParams.get('page') ?? 1)
    let body
    if (route === 'pulls') body = [current, ...others].slice((page - 1) * 100, page * 100)
    else if (route === 'pulls/7') body = current
    else if (/^pulls\/\d+\/files$/.test(route)) body = (route === 'pulls/7/files' ? currentFiles : otherFiles).slice((page - 1) * 100, page * 100)
    else if (/^pulls\/\d+$/.test(route)) body = others.find(p => p.number === Number(route.split('/')[1]))
    else if (route.startsWith('git/ref/heads/')) body = {object: {sha: route.endsWith('/dev') ? sha(101) : sha(102)}}
    else if (route.startsWith('git/trees/')) {
      const files = route.endsWith(sha(7)) ? currentTree : route.endsWith(sha(101)) ? devTree : []
      body = {truncated: false, tree: files.map(file => ({...file, type: 'blob'}))}
    } else throw Error(`Unexpected fixture route ${route}`)
    body = structuredClone(body)
    if (mutate) body = mutate({body, route, calls, page})
    return {ok: true, status: 200, json: async () => body}
  }
  return {repository, number: 7, expectedHead: sha(7), token: 'fixture-read-only-token', allowlist: empty, fetchImpl, calls}
}

test('fork PR metadata works with only a read-only token and no fork checkout', async () => {
  const fixture = server()
  assert.deepEqual(await checkGitHub(fixture), [])
  assert(fixture.calls.every(url => url.startsWith('https://api.github.com/repos/example/community/')))
})
test('open PR listing uses every page, including a conflicting PR after page one', async () => {
  const fixture = server({otherCount: 101, mutate: ({body, route}) => route === 'pulls/108/files' ? [added(two)] : body})
  const errors = await checkGitHub(fixture)
  assert(errors.some(error => error.includes('open PR #108')))
  assert(fixture.calls.some(url => url.includes('state=open&per_page=100&page=2')))
})
test('PR file listing uses every page', async () => {
  const files = Array.from({length: 100}, (_, n) => ({filename: `docs/${n}.md`, status: 'added'})).concat(added(one))
  const fixture = server({currentFiles: files, otherFiles: [added(two)]})
  assert((await checkGitHub(fixture)).some(error => error.includes('open PR #8')))
  assert(fixture.calls.some(url => url.includes('pulls/7/files?per_page=100&page=2')))
})
test('API failures and invalid JSON do not turn into an empty success', async () => {
  for (const fetchImpl of [async () => ({ok: false, status: 403}), async () => ({ok: true, json: async () => {throw Error('invalid JSON')}})]) {
    await assert.rejects(checkGitHub({...server(), fetchImpl}))
  }
})
test('truncated trees and incomplete or oversized file lists fail closed', async () => {
  const cases = [
    ({body, route}) => route.startsWith('git/trees/') ? {...body, truncated: true} : body,
    ({body, route}) => route === 'pulls/7/files' ? [] : body,
    ({body, route}) => route === 'pulls/7' ? {...body, changed_files: 3001} : body,
    ({body, route}) => route === 'pulls/7/files' ? [{filename: one.path, status: 'unknown'}] : body,
  ]
  for (const mutate of cases) await assert.rejects(checkGitHub(server({mutate})))
})
test('moving head, base branches and open PR snapshots fail instead of reporting stale success', async () => {
  const cases = [
    ({body, route}) => route === 'pulls/7' ? {...body, head: {sha: sha(99)}} : body,
    ({body, route, calls}) => route === 'git/ref/heads/dev' && calls.filter(c => c.endsWith(route)).length > 1 ? {object: {sha: sha(99)}} : body,
    ({body, route, calls}) => route === 'pulls' && calls.filter(c => new URL(c).pathname.endsWith('/pulls')).length > 1 ? body.slice(0, 1) : body,
    ({body, route}) => route === 'pulls/8' ? {...body, head: {sha: sha(99)}} : body,
  ]
  for (const mutate of cases) await assert.rejects(checkGitHub(server({mutate})))
})
test('the committed repository tree passes its exact historical allowlist', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim()
  const allowlist = JSON.parse(readFileSync(new URL('../../scripts/ci/migration-version-allowlist.json', import.meta.url), 'utf8'))
  assert.deepEqual(checkTree(localTree(head), allowlist), [])
})
test('the existing required unit gate fails on every unsuccessful migration outcome', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert(workflow.includes('  unit:\n    needs: migration-versions\n    if: always()'))
  const command = workflow.match(/run: (test "\$MIGRATION_CHECK_RESULT" = success)/)?.[1]
  assert(command)
  for (const outcome of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const result = spawnSync('/bin/sh', ['-c', command], {env: {MIGRATION_CHECK_RESULT: outcome}})
    assert.equal(result.status, outcome === 'success' ? 0 : 1)
  }
})
test('the real tree CLI exits nonzero on a new duplicate, without network access', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'migration-versions-'))
  try {
    const git = args => execFileSync('git', args, {cwd: temp, encoding: 'utf8'})
    git(['init', '-q'])
    mkdirSync(path.join(temp, 'supabase/migrations'), {recursive: true})
    for (const name of ['first', 'second']) writeFileSync(path.join(temp, `supabase/migrations/20261106110000_${name}.sql`), 'select 1;\n')
    git(['add', '.'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'])
    const ref = git(['rev-parse', 'HEAD']).trim()
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/ci/migration-versions.mjs', import.meta.url)), '--tree', ref], {cwd: temp, encoding: 'utf8', env: {PATH: process.env.PATH}})
    assert.equal(result.status, 1)
    assert(result.stderr.includes('20261106110000'))
    assert(!result.stdout.includes('passed'))
  } finally {rmSync(temp, {recursive: true, force: true})}
})
