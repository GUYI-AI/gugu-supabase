import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { prepareAuthAuditFixtureIndex } from '../../scripts/auth-audit-fixture-index.mjs'

function fixture(action) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'auth-audit-index-'))) + '/'
  const project = 'gugucommunitytest' + createHash('sha256').update(root).digest('hex').slice(0, 10)
  const owner = { root, project, port: 64322 }
  mkdirSync(root + '.local/test-db', { recursive: true }); mkdirSync(root + 'ops')
  writeFileSync(root + 'ops/auth-audit-retention-index.sql', readFileSync(new URL('../../ops/auth-audit-retention-index.sql', import.meta.url)))
  const save = () => writeFileSync(root + '.local/test-db/owner.json', JSON.stringify(owner))
  save()
  try { action({ root, owner, save }) } finally { rmSync(root, { recursive: true }) }
}
test('fixture preparation targets only its owned loopback platform owner, without psql -c or a transaction wrapper', () => fixture(({ root, owner }) => {
  const calls = []
  prepareAuthAuditFixtureIndex(root, (program, args, options) => {
    calls.push({ program, args, options })
    return args[0] === 'port' ? '127.0.0.1:' + owner.port : ''
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].program, 'docker')
  assert.deepEqual(calls[1].args.slice(0, 9), ['exec', '-i', 'supabase_db_' + owner.project, 'psql', '-X', '-U', 'supabase_admin', '-d', 'postgres'])
  assert.ok(!calls[1].args.includes('-c'))
  assert.equal(calls[1].options.stdio[2], 'pipe')
  const sql = calls[1].options.input
  assert.equal((sql.match(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS /gm) ?? []).length, 1)
  const topLevel = sql.replace(/\$(\w+)\$[\s\S]*?\$\1\$/g, '')
  assert.doesNotMatch(topLevel, /^\s*(BEGIN|COMMIT|DROP|ALTER|GRANT)\b/gmi)
  assert.match(sql, /indisvalid AND x.indisready/)
  assert.match(sql, /SET lock_timeout='100ms'/)
}))
test('foreign checkout identity and unsafe port fail before any Docker operation', () => fixture(({ root, owner, save }) => {
  for (const change of [{ project: 'shared' }, { root: '/elsewhere/' }, { port: 0 }]) {
    const original = { ...owner }; Object.assign(owner, change); save()
    let calls = 0
    assert.throws(() => prepareAuthAuditFixtureIndex(root, () => { calls++; return '' }))
    assert.equal(calls, 0); Object.assign(owner, original)
  }
}))
test('public or mismatched container bindings fail before platform SQL', () => fixture(({ root }) => {
  for (const binding of ['0.0.0.0:64322', '127.0.0.1:54322', '127.0.0.1:64322\n[::]:64322']) {
    let calls = 0
    assert.throws(() => prepareAuthAuditFixtureIndex(root, () => { calls++; return binding }))
    assert.equal(calls, 1)
  }
}))
test('a failed platform operation is reported without stderr, retry, DROP or reconstruction', () => fixture(({ root, owner }) => {
  let calls = 0
  assert.throws(() => prepareAuthAuditFixtureIndex(root, (_, args) => {
    calls++
    if (args[0] === 'port') return '127.0.0.1:' + owner.port
    throw Error('private driver stderr')
  }), error => !error.message.includes('private driver stderr') && error.message.includes('no automatic drop'))
  assert.equal(calls, 2)
}))
