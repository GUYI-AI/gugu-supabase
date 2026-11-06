import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { inventory, migrate, readback, deleteCopies, validateApproval, parseArguments,
  sourceName, targetName, sha256, digest, missingResponse } from '../../scripts/migrate-legacy-feedback.mjs'

const scriptSha = sha256('fixed fixture script')
const copy = value => structuredClone(value)
function fixture() {
  const owner = randomUUID(), sourceBucket = randomUUID(), targetBucket = randomUUID()
  const publicRoot = ['https:', '', 'fixture.invalid', randomUUID(), ''].join('/')
  const config = { sourceBucket, targetBucket, publicRoot, maxBytes: 5242880, fingerprint: digest(randomUUID()) }
  const source = { id: randomUUID(), bucket_id: sourceBucket, name: `${owner}/feedback/evidence`,
    version: randomUUID(), updated_at: 'stable', metadata: { size: 4, mimetype: 'image/png' } }
  const row = { id: randomUUID(), user_id: owner, screenshot_urls: [publicRoot + source.name], screenshot_paths: [] }
  const sources = new Map([[source.id, source]]), targets = new Map(), rows = new Map([[row.id, row]])
  const calls = { reads: 0, uploads: 0, updates: 0, removes: 0 }
  let referenced = false, failUpdate = false
  const io = {
    maintenanceSha256: digest('scoped drained fixture window'),
    legacyRows: async () => [...rows.values()].filter(item => item.screenshot_urls.length).sort((a,b) => a.id.localeCompare(b.id)).map(copy),
    sourceByName: async name => copy([...sources.values()].find(item => item.name === name)),
    sourceById: async id => copy(sources.get(id)),
    sourceAbsent: async name => ![...sources.values()].some(item => item.name === name),
    row: async id => copy(rows.get(id)),
    targetExists: async name => targets.has(name),
    read: async (location) => {
      calls.reads++
      if (location.source) { assert.ok(sources.has(location.source.id)); return Buffer.from('data') }
      assert.ok(targets.has(location.target)); return Buffer.from(targets.get(location.target))
    },
    upload: async (name, bytes) => { calls.uploads++; assert.ok(!targets.has(name)); targets.set(name, Buffer.from(bytes)) },
    replaceRow: async (expected, paths) => {
      calls.updates++; assert.ok(!failUpdate)
      const actual = rows.get(expected.id); assert.ok(actual)
      if (actual.screenshot_urls.length === 0) assert.deepEqual(actual.screenshot_paths, paths)
      else {
        assert.equal(digest([actual.user_id, actual.screenshot_urls, actual.screenshot_paths]), expected.identity)
        actual.screenshot_paths = paths; actual.screenshot_urls = []
      }
    },
    referenced: async () => referenced,
    remove: async object => { calls.removes++; sources.delete(object.id) }
  }
  return { config, io, source, row, sources, targets, rows, calls,
    setReferenced: value => { referenced = value }, setFailUpdate: value => { failUpdate = value } }
}
async function prepared(multiple = false) {
  const f = fixture()
  if (multiple) {
    const second = { ...copy(f.source), id: randomUUID(), name: `${f.row.user_id}/feedback/second` }
    f.sources.set(second.id, second)
    f.row.screenshot_urls.unshift(f.config.publicRoot + second.name)
  }
  const state = await inventory(f.io, f.config, scriptSha)
  const checkpoints = [], save = async value => { checkpoints.push(copy(value)) }
  await migrate(f.io, state, save)
  const report = await readback(f.io, state)
  const approval = { schema: 1, run: state.run, scriptSha256: scriptSha, reportSha256: digest(report),
    maintenanceSha256: report.maintenanceSha256, rows: report.rows, objects: report.objects,
    bytes: report.bytes, approvedBy: 'fixture operator', maintenanceWindow: true }
  return { ...f, state, report, approval, save, checkpoints }
}

test('dry-run is the default and deletion requires every explicit gate', () => {
  assert.equal(parseArguments([]).mode, 'dry-run')
  for (const args of [['delete'], ['delete', '--state', 's', '--report', 'r', '--approval', 'a'],
    ['migrate', '--state', 's', '--execute-delete'], ['dry-run', '--state', 's'],
    ['delete', '--state', 's', '--report', 'r', '--approval', 'a', '--execute-delete', '--execute-delete']]) {
    assert.throws(() => parseArguments(args))
  }
})

test('CLI refusal never loads runtime credentials or opens a connection', () => {
  const script = new URL('../../scripts/migrate-legacy-feedback.mjs', import.meta.url)
  const result = spawnSync(process.execPath, [script.pathname, 'delete'], { env: {}, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.deepEqual(JSON.parse(result.stderr), { failed: true })
})

test('only explicit NoSuchKey is absence, including the deployed legacy status wrapper', () => {
  for (const status of [400, 404]) assert.equal(missingResponse(status, { code: 'NoSuchKey', statusCode: '404' }), true)
  for (const [status, body] of [[404, {}], [400, { code: 'NoSuchBucket', statusCode: '404' }],
    [403, { code: 'NoSuchKey', statusCode: '404' }], [500, { code: 'NoSuchKey', statusCode: '404' }],
    [400, { code: 'NoSuchKey', statusCode: '500' }]]) assert.equal(missingResponse(status, body), false)
})

test('inventory reads metadata only, deduplicates objects, and exposes numeric failures only', async () => {
  const f = fixture()
  const second = copy(f.row); second.id = randomUUID(); f.rows.set(second.id, second)
  const state = await inventory(f.io, f.config, scriptSha)
  assert.equal(state.rows.length, 2); assert.equal(state.objects.length, 1)
  assert.deepEqual(f.calls, { reads: 0, uploads: 0, updates: 0, removes: 0 })
  assert.equal(state.objects[0].bytes, 4)
  f.source.metadata.size = null
  const invalid = await inventory(f.io, f.config, scriptSha)
  assert.ok(invalid.failures.every(Number.isSafeInteger)); assert.equal(invalid.failures.length, 2)
})

test('foreign roots, query capabilities, cross-owner paths and duplicate references are rejected', async () => {
  const f = fixture()
  for (const address of [f.config.publicRoot + f.source.name + '?secret=x',
    f.config.publicRoot + `${randomUUID()}/feedback/evidence`, f.config.publicRoot + f.source.name + '/extra']) {
    assert.throws(() => sourceName(address, f.config.publicRoot, f.row.user_id))
  }
  f.row.screenshot_urls.push(f.row.screenshot_urls[0])
  assert.equal((await inventory(f.io, f.config, scriptSha)).failures.length, 1)
  assert.equal(f.calls.reads, 0)
})

test('checkpoint precedes upload; restart after row failure reuses the verified destination', async () => {
  const f = fixture(), state = await inventory(f.io, f.config, scriptSha), saved = []
  const upload = f.io.upload
  f.io.upload = async (...args) => { assert.equal(saved.at(-1).objects[0].hash, sha256('data')); await upload(...args) }
  f.setFailUpdate(true)
  const save = async value => { saved.push(copy(value)) }
  assert.equal((await migrate(f.io, state, save)).failedNumbers.length, 1)
  assert.equal(f.row.screenshot_urls.length, 1)
  f.setFailUpdate(false); state.failures = []
  assert.deepEqual((await migrate(f.io, state, save)).failedNumbers, [])
  assert.equal(f.calls.uploads, 1); assert.equal(f.calls.removes, 0)
  assert.deepEqual(f.row.screenshot_paths, [targetName(state.objects[0])])
})

test('conflicting target bytes never get overwritten or linked', async () => {
  const f = fixture(), state = await inventory(f.io, f.config, scriptSha)
  f.targets.set(targetName(state.objects[0]), Buffer.from('evil'))
  assert.equal((await migrate(f.io, state, async () => {})).failedNumbers.length, 1)
  assert.equal(f.calls.uploads, 0); assert.equal(f.calls.updates, 0)
  assert.equal(f.targets.get(targetName(state.objects[0])).toString(), 'evil')
})

test('changed feedback, deleted feedback and changed source fail without overwriting current rows', async () => {
  for (const change of ['row', 'deleted', 'source']) {
    const f = fixture(), state = await inventory(f.io, f.config, scriptSha)
    if (change === 'row') f.row.screenshot_urls = []
    if (change === 'deleted') f.rows.clear()
    if (change === 'source') f.source.version = randomUUID()
    assert.equal((await migrate(f.io, state, async () => {})).failedNumbers.length, 1)
    assert.equal(f.calls.removes, 0)
    assert.equal(f.row.screenshot_paths.length, 0)
  }
})

test('independent readback fails on destination corruption or missing feedback', async () => {
  for (const change of ['target', 'row']) {
    const f = await prepared()
    if (change === 'target') f.targets.set(targetName(f.state.objects[0]), Buffer.from('evil'))
    else f.rows.clear()
    const report = await readback(f.io, f.state)
    assert.equal(report.complete, false); assert.ok(report.failedNumbers.every(Number.isSafeInteger))
    assert.equal(f.calls.removes, 0)
    const text = JSON.stringify(report)
    for (const sensitive of [f.source.name, f.config.sourceBucket, f.config.publicRoot]) assert.ok(!text.includes(sensitive))
  }
})

test('each SHA, run, count, report, and maintenance mismatch independently denies deletion', async () => {
  const f = await prepared()
  for (const [key, value] of Object.entries({ scriptSha256: sha256('changed'), reportSha256: sha256('changed'),
    run: randomUUID(), rows: 2, objects: 2, bytes: 5, maintenanceWindow: false,
    maintenanceSha256: sha256('other window'), approvedBy: '' })) {
    const approval = { ...f.approval, [key]: value }
    assert.throws(() => validateApproval(f.state, f.report, approval, scriptSha))
  }
  assert.throws(() => validateApproval(f.state, f.report, f.approval, sha256('edited script')))
  assert.equal(f.calls.removes, 0)
})

test('full-set preflight protects every source when any target or reference check fails', async () => {
  for (const change of ['reference', 'target']) {
    const f = await prepared(true)
    if (change === 'reference') f.setReferenced(true)
    else f.targets.delete(targetName(f.state.objects.at(-1)))
    await assert.rejects(deleteCopies(f.io, f.state, f.report, f.approval, scriptSha, f.save))
    assert.equal(f.calls.removes, 0); assert.equal(f.sources.size, 2)
  }
})

test('multiple objects preserve display order, approve exact totals, and delete only once each', async () => {
  const f = await prepared(true)
  assert.deepEqual(f.row.screenshot_paths, f.state.objects.map(targetName))
  assert.equal(f.report.rows, 1); assert.equal(f.report.objects, 2); assert.equal(f.report.bytes, 8)
  const first = await deleteCopies(f.io, f.state, f.report, f.approval, scriptSha, f.save)
  assert.equal(first.deletedObjects, 2); assert.equal(first.deletedBytes, 8)
  const second = await deleteCopies(f.io, f.state, f.report, f.approval, scriptSha, f.save)
  assert.equal(second.deletedObjects, 2); assert.equal(f.calls.removes, 2)
  assert.equal(f.targets.size, 2)
})

test('approved deletion persists intent and resumes a crash after remote removal without repeating it', async () => {
  const f = await prepared(), saved = [], remove = f.io.remove
  f.io.remove = async source => {
    assert.equal(saved.at(-1).objects[0].deletion, 'intent')
    await remove(source); throw new Error('lost response')
  }
  const save = async value => { saved.push(copy(value)) }
  const first = await deleteCopies(f.io, f.state, f.report, f.approval, scriptSha, save)
  assert.equal(first.failedNumbers.length, 1); assert.equal(f.calls.removes, 1)
  const resumed = copy(saved.at(-1))
  const second = await deleteCopies(f.io, resumed, f.report, f.approval, scriptSha, save)
  assert.equal(second.deletedObjects, 1); assert.deepEqual(second.failedNumbers, [])
  assert.equal(f.calls.removes, 1); assert.equal(f.targets.size, 1)
})

test('unexplained missing source or replacement at the same name is never accepted as completed deletion', async () => {
  for (const change of ['missing', 'replacement']) {
    const f = await prepared(); f.sources.clear()
    if (change === 'replacement') {
      f.state.objects[0].deletion = 'intent'
      const replacement = { ...f.source, id: randomUUID() }; f.sources.set(replacement.id, replacement)
    }
    await assert.rejects(deleteCopies(f.io, f.state, f.report, f.approval, scriptSha, f.save))
    assert.equal(f.calls.removes, 0)
  }
})

test('changed private bytes after approval or a new maintenance window invalidate deletion', async () => {
  for (const change of ['target', 'window']) {
    const f = await prepared()
    if (change === 'target') f.targets.set(targetName(f.state.objects[0]), Buffer.from('evil'))
    else f.io.maintenanceSha256 = sha256('new window')
    await assert.rejects(deleteCopies(f.io, f.state, f.report, f.approval, scriptSha, f.save))
    assert.equal(f.calls.removes, 0)
  }
})

test('a successful removal response without observable absence is a failed deletion', async () => {
  const f = await prepared()
  f.io.remove = async () => { f.calls.removes++ }
  const result = await deleteCopies(f.io, f.state, f.report, f.approval, scriptSha, f.save)
  assert.equal(result.deletedObjects, 0); assert.equal(result.failedNumbers.length, 1)
  assert.equal(f.state.objects[0].deletion, 'intent')
})

test('missing metadata alone does not prove inaccessible source bytes', async () => {
  const f = await prepared(), remove = f.io.remove
  f.io.remove = async source => { await remove(source); f.io.sourceAbsent = async () => false }
  const result = await deleteCopies(f.io, f.state, f.report, f.approval, scriptSha, f.save)
  assert.equal(result.deletedObjects, 0); assert.equal(result.failedNumbers.length, 1)
})

test('a new window can re-report and reapprove an interrupted deletion without restoring public bytes', async () => {
  const f = await prepared(true), remove = f.io.remove
  f.io.remove = async source => { await remove(source); throw new Error('lost response') }
  const partial = await deleteCopies(f.io, f.state, f.report, f.approval, scriptSha, f.save)
  assert.equal(partial.failedNumbers.length, 1)
  f.io.maintenanceSha256 = sha256('new drained window')
  const report = await readback(f.io, f.state)
  assert.equal(report.complete, true); assert.equal(report.alreadyDeletedObjects, 1)
  assert.equal(report.sourceObjects, 1); assert.equal(report.verifiedBytes, 8)
  const approval = { ...f.approval, reportSha256: digest(report), maintenanceSha256: report.maintenanceSha256 }
  f.io.remove = remove
  const completed = await deleteCopies(f.io, f.state, report, approval, scriptSha, f.save)
  assert.equal(completed.deletedObjects, 2); assert.equal(f.calls.removes, 2)
})
