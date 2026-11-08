import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// Manual mutation proof on this checkout's dedicated disposable fixture only.
// Run without other suites: the ordinary integration test never changes a policy.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
const marker = JSON.parse(readFileSync(new URL('../../../.local/test-db/owner.json', import.meta.url), 'utf8'))
assert.equal(marker.root, root)
assert.equal(Number(url.port), marker.port)
const reports = mkdtempSync(path.join(tmpdir(), 'device-rpc-owner-'))
const db = new pg.Client({ connectionString: url.href })
await db.connect()
const policy = async () => (await db.query(`SELECT pg_get_expr(polwithcheck,polrelid) AS expression
  FROM pg_policy WHERE polrelid='realtime.messages'::regclass AND polname='gugu_rpc_events_insert'`)).rows[0]?.expression

function run(stage, passed, failed) {
  const output = path.join(reports, `${stage}.json`)
  const result = spawnSync(root + 'node_modules/.bin/vitest', ['run', '--project', 'integration',
    'tests/integration/service/deviceRpcTopicOwner.test.ts', '--reporter=default', '--reporter=json', '--outputFile=' + output],
  { cwd: root, env: { ...process.env, NO_COLOR: '1' }, stdio: 'inherit', timeout: 60_000 })
  assert.ifError(result.error)
  assert.equal(result.status, failed ? 1 : 0, 'The runner must finish normally')
  const report = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(report.numPassedTests, passed)
  assert.equal(report.numFailedTests, failed)
  for (const test of report.testResults.flatMap((suite) => suite.assertionResults).filter((test) => test.status === 'failed')) {
    assert.match(test.failureMessages.join('\n'), /AssertionError/)
    assert.doesNotMatch(test.failureMessages.join('\n'), /error:.*(?:permission denied|does not exist)/i)
  }
  console.log(`${stage}: ${passed} passed, ${failed} failed`)
}

try {
  const original = await policy()
  assert.equal(typeof original, 'string', 'The installed RPC INSERT policy must exist')
  run('baseline', 8, 0)
  try {
    // Keep the RPC topic shape but remove device ownership from this fixture's INSERT check.
    await db.query(`ALTER POLICY gugu_rpc_events_insert ON realtime.messages
      WITH CHECK (split_part(topic,':',1)='gugu' AND split_part(topic,':',3)='rpc')`)
    run('ownership-removed', 2, 6)
  } finally {
    await db.query(`ALTER POLICY gugu_rpc_events_insert ON realtime.messages WITH CHECK (${original})`)
    assert.equal(await policy(), original)
  }
  run('restored', 8, 0)
} finally {
  await db.end()
  rmSync(reports, { recursive: true, force: true })
}
