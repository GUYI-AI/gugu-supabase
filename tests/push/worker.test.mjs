import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runPushBatch } from '../../services/push/src/worker.mjs'

function fixture({ live = true, sendThrows = false, commitThrows = false } = {}) {
  let reserved = false; let admitted = false; let requests = 0
  const commands = []; const logs = []
  const db = { async query(sql, values) {
    commands.push({ sql, values })
    if (sql.includes('mobile_push_reserve')) {
      const rows = reserved ? [] : [{ id: 'notification-fixture' }]; reserved = true; return { rows }
    }
    if (sql.includes('mobile_push_admit')) { const first = !admitted; admitted = true; return { rows: [{ admitted: first }] } }
    if (sql.includes('mobile_push_prepare')) return { rows: [{ endpoint: live ? { token: 'PRIVATE_TOKEN_CANARY' } : null }] }
    if (sql === 'COMMIT' && commitThrows) throw new Error('PRIVATE_DATABASE_CANARY')
    return { rows: [] }
  } }
  const provider = { async send() {
    requests++
    if (sendThrows) throw new Error('PRIVATE_TOKEN_CANARY')
    return { outcome: 'accepted', invalidBefore: null }
  } }
  return { db, provider, commands, logs, log: x => logs.push(x), requests: () => requests }
}

test('commits the admission before transport and holds the preparation transaction through completion', async () => {
  const f = fixture()
  assert.equal(await runPushBatch(f.db, f.provider, 'production', f.log), 1)
  assert.equal(f.requests(), 1)
  assert.deepEqual(f.commands.map(x => x.sql), [
    'SELECT identity.mobile_push_reserve($1,20) AS id', 'SELECT identity.mobile_push_admit($1) AS admitted',
    'BEGIN', 'SELECT identity.mobile_push_prepare($1) AS endpoint',
    'SELECT identity.mobile_push_finish($1,$2,$3)', 'COMMIT',
  ])
  await runPushBatch(f.db, f.provider, 'production', f.log)
  assert.equal(f.requests(), 1)
})

test('revocation or permission change between reservation and dispatch suppresses transport', async () => {
  const f = fixture({ live: false })
  await runPushBatch(f.db, f.provider, 'production', f.log)
  assert.equal(f.requests(), 0)
  assert.equal(f.logs[0].outcome, 'suppressed')
})

for (const failure of [{ sendThrows: true }, { commitThrows: true }]) {
  test(`does not resend an uncertain side effect: ${Object.keys(failure)[0]}`, async () => {
    const f = fixture(failure)
    await runPushBatch(f.db, f.provider, 'production', f.log)
    await runPushBatch(f.db, f.provider, 'production', f.log)
    assert.equal(f.requests(), 1)
    assert.equal(f.logs[0].outcome, 'unknown')
    assert.equal(f.commands.some(x => x.sql === 'ROLLBACK'), true)
    assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_|token/i)
  })
}

test('duplicate admission is rejected before prepare or send', async () => {
  const f = fixture()
  const db = { async query(sql, values) {
    if (sql.includes('mobile_push_reserve')) return { rows: [{ id: 'same' }, { id: 'same' }] }
    return f.db.query(sql, values)
  } }
  await runPushBatch(db, f.provider, 'production', f.log)
  assert.equal(f.requests(), 1)
})
