import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { auditConnectionInventory, compareConnectionInventories, connectionAuditLimits } from '../../scripts/platform-connection-audit.mjs'

const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../../scripts/platform-connection-audit.mjs', import.meta.url))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const owner = randomUUID(), assistant = randomUUID(), accountBody = randomUUID(), catalogBody = randomUUID()
  const account = new TextEncoder().encode(JSON.stringify({ version: 1, providerId: 'github', accountId: 'fixture', connectedAt: 1, updatedAt: 2, isDefault: true, login: 'fixture' }))
  const catalog = new TextEncoder().encode(JSON.stringify({ version: 1, en: { id: 'github' }, 'zh-CN': { id: 'github' } }))
  const base = { domain: 'integrations', owner_user_id: owner, assistant_user_id: assistant, device_id: 'device-fixture',
    revision: '5', deleted_at: null, stale_at: null, body_item_id: null, body_sha256: null,
    observed_at: '2026-11-06T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' }
  const source = { version: 1, complete: true, databaseDigest: 'b'.repeat(64), identityState: 'found', ownerId: owner, assistantId: assistant, headRevision: '9',
    items: [
      { ...base, resource_key: 'catalog:github', data: { providerId: 'github', configured: false, displayName: 'GitHub' }, body_item_id: catalogBody, body_sha256: sha256(catalog) },
      { ...base, resource_key: '["github","fixture"]', data: { providerId: 'github', accountId: 'fixture', configured: true, isDefault: true }, body_item_id: accountBody, body_sha256: sha256(account) },
      { ...base, resource_key: '["github","revoked"]', data: {}, revision: '7', deleted_at: '2026-11-06T00:01:00Z' },
      { ...base, resource_key: '__collection__:device-fixture', revision: '9', data: { state: 'ready', schemaVersion: 1, itemCount: 2 } },
    ], operations: [{ operation_id: randomUUID(), owner_user_id: owner, assistant_user_id: assistant,
      domain: 'integrations', resource_key: '["github","revoked"]', device_id: 'device-fixture', source: 'panel',
      operation: 'remove', revision: '7', expected_item_revision: '5', request_hash: 'a'.repeat(64), status: 'pending',
      payload: { before: { providerId: 'github', accountId: 'revoked' }, deviceId: 'device-fixture', deleted: true }, error_code: null, terminal_at: null }] }
  const bodies = new Map([[accountBody, account], [catalogBody, catalog]])
  return { source, bodies, accountBody, readBody: async id => bodies.get(id) }
}

test('audits full inventories without omitting tombstones or pending cleanup', async () => {
  const f = fixture(), audit = await auditConnectionInventory(f.source, f)
  assert.equal(audit.entries.length, 4)
  assert.equal(audit.operations.length, 1)
  assert.equal(audit.verifiedBodies, 2)
  assert.equal(audit.counts.find(row => row.scope[2] === 'revoked').count, 1)
  assert.equal(compareConnectionInventories(audit, audit).eligible, true)
  assert.equal(JSON.stringify(audit).includes('connectedAt'), false)
  assert.equal(JSON.stringify(audit).includes(f.source.items[2].resource_key), false)
})

test('normalizes row and public field order deterministically', async () => {
  const f = fixture(), before = await auditConnectionInventory(f.source, f)
  f.source.items.reverse()
  for (const item of f.source.items) item.data = Object.fromEntries(Object.entries(item.data).reverse())
  const after = await auditConnectionInventory(f.source, f)
  assert.equal(before.hash, after.hash)
})

test('a visible panel snapshot cannot stand in for a complete migration export', async () => {
  const f = fixture()
  delete f.source.complete
  await assert.rejects(auditConnectionInventory(f.source, f), /INCOMPLETE_SOURCE/)
})

test('requires verified body bytes rather than trusting a stored blob hash', async () => {
  const f = fixture()
  await assert.rejects(auditConnectionInventory(f.source), /BODY_BYTES_REQUIRED/)
  f.bodies.set(f.accountBody, new TextEncoder().encode('{}'))
  await assert.rejects(auditConnectionInventory(f.source, f), /BODY_HASH_MISMATCH/)
})

test('rejects account bodies containing secret or unknown fields', async () => {
  const f = fixture(), bytes = new TextEncoder().encode(JSON.stringify({ version: 1, providerId: 'github', accountId: 'fixture', apiKey: 'do-not-log-this-value' }))
  f.bodies.set(f.accountBody, bytes)
  f.source.items.find(item => item.body_item_id === f.accountBody).body_sha256 = sha256(bytes)
  await assert.rejects(auditConnectionInventory(f.source, f), error => error.message === 'CONNECTION_AUDIT_UNSUPPORTED_METADATA')
})

test('a provider directory row keeps its catalog (clients since 0.3.2); no other row may carry one', async () => {
  const directory = f => f.source.items.find(item => item.resource_key === 'catalog:github')
  const account = f => f.source.items.find(item => item.resource_key === '["github","fixture"]')
  for (const catalog of [{ categoryId: 'dev', aliases: ['GitHub', '代码托管'] }, { categoryId: 'dev' }, null]) {
    const f = fixture()
    directory(f).data = { ...directory(f).data, catalog }
    const audit = await auditConnectionInventory(f.source, f)
    assert.equal(audit.entries.length, 4)
    const plain = fixture()
    assert.notEqual(audit.hash, (await auditConnectionInventory(plain.source, plain)).hash, 'the catalog is part of the audited row')
  }
  const f = fixture()
  directory(f).data = { ...directory(f).data, catalog: { categoryId: 'dev' } }
  f.source.operations[0] = { ...f.source.operations[0], resource_key: 'catalog:github',
    payload: { data: { ...directory(f).data, enabled: false }, deviceId: 'device-fixture' } }
  assert.equal((await auditConnectionInventory(f.source, f)).operations.length, 1, 'a pending directory toggle keeps the catalog')
  for (const [label, mutate] of [
    ['account row', f => { account(f).data = { ...account(f).data, catalog: { categoryId: 'dev' } } }],
    ['account row null', f => { account(f).data = { ...account(f).data, catalog: null } }],
    ['account operation', f => { f.source.operations[0].payload.before = { providerId: 'github', catalog: { categoryId: 'dev' } } }],
    ['extra key', f => { directory(f).data = { ...directory(f).data, catalog: { categoryId: 'dev', icon: 'x' } } }],
    ['category missing', f => { directory(f).data = { ...directory(f).data, catalog: { aliases: ['GitHub'] } } }],
    ['category grammar', f => { directory(f).data = { ...directory(f).data, catalog: { categoryId: '../dev' } } }],
    ['catalog string', f => { directory(f).data = { ...directory(f).data, catalog: 'dev' } }],
    ['aliases not array', f => { directory(f).data = { ...directory(f).data, catalog: { categoryId: 'dev', aliases: 'GitHub' } } }],
    ['alias nested', f => { directory(f).data = { ...directory(f).data, catalog: { categoryId: 'dev', aliases: [{ name: 'GitHub' }] } } }],
    ['alias control', f => { directory(f).data = { ...directory(f).data, catalog: { categoryId: 'dev', aliases: ['Git\u0007Hub'] } } }],
    ['33 aliases', f => { directory(f).data = { ...directory(f).data, catalog: { categoryId: 'dev', aliases: Array.from({ length: 33 }, (_, i) => `a${i}`) } } }],
    ['other nested', f => { directory(f).data = { ...directory(f).data, permission: { scope: 'all' } } }],
  ]) {
    const f = fixture()
    mutate(f)
    await assert.rejects(auditConnectionInventory(f.source, f), error => error.message === 'CONNECTION_AUDIT_UNSUPPORTED_METADATA', label)
  }
})

test('rejects unprepared/error collections, wrong counts, duplicate keys and foreign rows', async () => {
  for (const mutate of [
    f => { f.source.items.pop() },
    f => { f.source.items.at(-1).data.state = 'error' },
    f => { f.source.items.at(-1).data.itemCount = 1 },
    f => { f.source.items.push(f.source.items[0]) },
    f => { f.source.items[0].owner_user_id = randomUUID() },
  ]) {
    const f = fixture(); mutate(f)
    await assert.rejects(auditConnectionInventory(f.source, f), /CONNECTION_AUDIT_/)
  }
})

test('accepts only bare account tombstones of listed removed assistants, without changing the manifest identity', async () => {
  const removed = randomUUID()
  const withTombstone = (f, item = {}) => {
    f.source.removedAssistants = { assistantIds: [removed], importedTombstones: 1, supersededTombstones: 0, excludedRows: 0, excludedOperations: 0 }
    f.source.items.push({ ...f.source.items[2], assistant_user_id: removed, resource_key: '["github","before-reinstall"]', ...item })
    return f
  }
  const f = withTombstone(fixture()), audit = await auditConnectionInventory(f.source, f)
  assert.equal(audit.counts.find(row => row.scope[2] === 'revoked').count, 2)
  // A prepared candidate carries each row's assistant but no list; it audits to the same manifest.
  delete f.source.removedAssistants
  assert.equal((await auditConnectionInventory(f.source, f)).hash, audit.hash)
  for (const [label, mutate] of [
    ['unlisted assistant', f => { f.source.removedAssistants.assistantIds = [] }],
    ['the source assistant listed as removed', f => { f.source.removedAssistants.assistantIds.push(f.source.assistantId) }],
    ['a live row', f => { f.source.items.at(-1).deleted_at = null; f.source.items.at(-1).data = { providerId: 'github', accountId: 'before-reinstall' } }],
    ['a catalog row', f => { f.source.items.at(-1).resource_key = 'catalog:gitlab' }],
    ['a collection marker', f => { f.source.items.at(-1).resource_key = '__collection__' }],
    ['a body reference', f => { f.source.items.at(-1).body_item_id = randomUUID(); f.source.items.at(-1).body_sha256 = 'c'.repeat(64) }],
    ['not an assistant id', f => { f.source.items.at(-1).assistant_user_id = 'not-a-uuid' }],
  ]) {
    const g = withTombstone(fixture()); mutate(g)
    await assert.rejects(auditConnectionInventory(g.source, g), /CONNECTION_AUDIT_/, label)
  }
})

test('detects a dropped tombstone, changed route and changed source revision', async () => {
  for (const mutate of [
    f => { f.source.items = f.source.items.filter(item => !item.deleted_at); f.source.operations = [] },
    f => { f.source.operations[0].payload.deviceId = 'another-device' },
    f => { f.source.headRevision = '10' },
  ]) {
    const f = fixture(), source = await auditConnectionInventory(f.source, f)
    mutate(f)
    const candidate = await auditConnectionInventory(f.source, f)
    assert.equal(compareConnectionInventories(source, candidate).eligible, false)
  }
})

test('distinguishes an account without an assistant from an empty prepared legacy collection', async () => {
  const source = { version: 1, complete: true, databaseDigest: 'b'.repeat(64), identityState: 'none', ownerId: randomUUID(), assistantId: null, headRevision: '0', items: [], operations: [] }
  const audit = await auditConnectionInventory(source)
  const comparison = compareConnectionInventories(audit, audit)
  assert.equal(comparison.eligible, false)
  assert.equal(comparison.nativeInitialization, true)
  source.headRevision = '1'
  await assert.rejects(auditConnectionInventory(source), /INVALID_IDENTITY/)
})

test('rejects large inventories before reading bodies instead of silently batching a handoff', async () => {
  const f = fixture()
  f.source.items = Array(connectionAuditLimits.items + 1).fill(f.source.items[0])
  await assert.rejects(auditConnectionInventory(f.source, { readBody: () => assert.fail('must not read bodies') }), /TOO_MANY_RECORDS/)
})

test('CLI writes a private manifest, refuses overwrite and does not log raw errors or bodies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'connection-audit-'))
  try {
    const f = fixture(), sourceFile = join(directory, 'source.json'), output = join(directory, 'report.json')
    await writeFile(sourceFile, JSON.stringify(f.source), { mode: 0o600 })
    for (const [id, bytes] of f.bodies) await writeFile(join(directory, id), bytes, { mode: 0o600 })
    const args = [cli, '--source', sourceFile, '--candidate', sourceFile, '--bodies-dir', directory, '--output', output]
    const result = await execute(process.execPath, args)
    assert.equal(result.stderr, '')
    assert.equal(JSON.parse(result.stdout).eligible, true)
    assert.equal((await stat(output)).mode & 0o777, 0o600)
    assert.equal(JSON.parse(await readFile(output, 'utf8')).source.verifiedBodies, 2)
    await assert.rejects(execute(process.execPath, args), error => error.stderr === 'CONNECTION_AUDIT_FAILED\n')
    await rm(join(directory, f.accountBody))
    await symlink(sourceFile, join(directory, f.accountBody))
    await assert.rejects(execute(process.execPath, [...args.slice(0, -1), join(directory, 'symlink-report.json')]),
      error => error.stderr === 'CONNECTION_AUDIT_BODY_UNAVAILABLE\n')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
