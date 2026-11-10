import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { checkConnectionPredecessors } from '../../scripts/platform-connection-preflight.mjs'

const baseline = JSON.parse(await readFile(new URL('../../ops/platform-connections/legacy-functions.json', import.meta.url), 'utf8'))
const rows = () => baseline.functions.map(row => ({ ...row }))

test('predecessor check binds exact signatures and uses one catalog SELECT', async () => {
  const requests = []
  const result = await checkConnectionPredecessors(async (sql, values) => {
    requests.push({ sql, values }); return { rows: rows() }
  }, baseline)
  assert.equal(requests.length, 1)
  assert.match(requests[0].sql, /^SELECT /)
  assert.deepEqual(requests[0].values, [baseline.functions.map(row => row.signature)])
  assert.equal(result.matched, true)
})

test('any drift or missing function refuses migration eligibility', async () => {
  for (const replacement of ['0'.repeat(64), null]) {
    const observed = rows(); observed[2].sha256 = replacement
    const result = await checkConnectionPredecessors(async () => ({ rows: observed }), baseline)
    assert.equal(result.matched, false)
    assert.equal(result.differences.length, 1)
    assert.equal(result.differences[0].signature, baseline.functions[2].signature)
  }
})

test('partial/duplicated baselines and incomplete catalog results cannot pass', async () => {
  await assert.rejects(checkConnectionPredecessors(() => assert.fail('must not query'), { ...baseline, functions: baseline.functions.slice(1) }), /INVALID_BASELINE/)
  await assert.rejects(checkConnectionPredecessors(() => assert.fail('must not query'), { ...baseline, functions: Array(7).fill(baseline.functions[0]) }), /INVALID_BASELINE/)
  await assert.rejects(checkConnectionPredecessors(async () => ({ rows: rows().slice(1) }), baseline), /INCOMPLETE_RESPONSE/)
})
