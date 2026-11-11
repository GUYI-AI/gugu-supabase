import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { connectionBodyStore } from '../../../scripts/platform-connection-bodies.mjs'
import { cutoverConnectionAccounts } from '../../../scripts/platform-connection-cutover.mjs'

// End to end against the disposable fixture: real legacy commits, body bytes in the
// real Storage bucket read back server-side with the service key, prepare and cutover.
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const endpoint = process.env.GUGU_INTEGRATION_SUPABASE_URL ?? ''
const serviceKey = process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY ?? ''
const execute = promisify(execFile)
const cli = fileURLToPath(new URL('../../../scripts/platform-connection-cutover.mjs', import.meta.url))
const sentinel = `body-sentinel-${randomUUID()}`
const storage = { SUPABASE_URL: endpoint, SUPABASE_SERVICE_ROLE_KEY: serviceKey }
// Declare a current client so a concurrently enabled version policy never refuses this fixture.
const headers = JSON.stringify({ 'x-gugu-connection-client-version': '999.0.0', 'x-gugu-connection-client-platform': 'desktop' })
type Legacy = { owner: string; assistant: string; device: string; instance: string; chat: string; provision: string; operation: string }
const legacy: Legacy[] = [], humans: string[] = [], objects: string[] = [], provisions: { id: string; operation: string }[] = []
let db: pg.Client, imported: Legacy, unfinished: Legacy, reinstalled: Legacy, reinstalledLive: Legacy, twoLive: Legacy, doubled: Legacy
let fresh: string, orphaned: string, earlier: string
const operator = 'ci-operator'

async function as<T>(owner: string, action: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claims',$1,false),set_config('request.headers',$2,false)",
    [JSON.stringify({ sub: owner, role: 'authenticated' }), headers])
  await db.query('SET ROLE authenticated')
  try { return await action() } finally { await db.query('RESET ROLE') }
}

async function human() {
  const id = randomUUID()
  await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
    confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
    VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,
    '{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`, [id, `${id}@connection-cutover.invalid`])
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Connection cutover fixture') ON CONFLICT DO NOTHING", [id])
  humans.push(id)
  return id
}

async function withAssistant(): Promise<Legacy> {
  const owner = await human(), assistant = randomUUID(), chat = randomUUID(), provision = randomUUID(), operation = randomUUID()
  const device = `connection-cutover-${randomUUID()}`, instance = randomUUID()
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", [device, owner])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Cutover assistant',$2,$3)", [assistant, owner, device])
  await db.query("INSERT INTO chat.chats(id,kind,creator_user_id) VALUES($1,'dm',$2)", [chat, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')", [chat, owner, assistant])
  await db.query(`INSERT INTO identity.agent_provision_operations(id,owner_user_id,device_id,kind,payload_hash,blueprint,phase)
    VALUES($1,$2,$3,'single','fixture','{}','completed')`, [operation, owner, device])
  await db.query(`INSERT INTO identity.agent_provisions(id,owner_user_id,operation_id,member_key,device_id,display_name,agent_type,
    inherit_memory,history_import_required,payload_hash,agent_user_id,provisioned_agent_user_id,dm_chat_id,phase)
    VALUES($1,$2,$3,'assistant',$4,'Cutover assistant','claude-code',false,false,'fixture',$5::text,$5::text::uuid,$6,'completed')`,
  [provision, owner, operation, device, assistant, chat])
  await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)', [instance, device, owner])
  const identities = { owner, assistant, device, instance, chat, provision, operation }
  legacy.push(identities)
  return identities
}

async function body(account: Legacy, data: object) {
  const id = randomUUID(), blob = randomUUID(), bytes = new TextEncoder().encode(JSON.stringify(data))
  const hash = createHash('sha256').update(bytes).digest('hex'), object = `${account.chat}/${blob}`
  const admin = createClient(endpoint, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const uploaded = await admin.storage.from('workspace').upload(object, bytes, { contentType: 'application/json' })
  if (uploaded.error) throw uploaded.error
  objects.push(object)
  await db.query(`INSERT INTO chat.file_blobs(id,bucket_id,object_name,sha256,size_bytes,content_type,created_by)
    VALUES($1,'workspace',$2,$3,$4,'application/json',$5)`, [blob, object, hash, bytes.byteLength, account.owner])
  await db.query("INSERT INTO chat.workspace_items(id,chat_id,kind,filename,blob_id,created_by) VALUES($1,$2,'file',$3,$4,$5)",
    [id, account.chat, `${id}.json`, blob, account.owner])
  return { id, hash }
}

// Another agent of the same owner. Removed agents have no execution device; a provisioned
// one also has a completed assistant provision (a double provision when the account has one).
async function agent(account: Legacy, { removed, provisioned = false }: { removed: boolean; provisioned?: boolean }) {
  const id = randomUUID()
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,removed_at)
    VALUES($1,'agent','Other assistant',$2,$3,CASE WHEN $4::boolean THEN now() END)`, [id, account.owner, removed ? null : account.device, removed])
  if (provisioned) {
    const provision = { id: randomUUID(), operation: randomUUID() }
    await db.query(`INSERT INTO identity.agent_provision_operations(id,owner_user_id,device_id,kind,payload_hash,blueprint,phase)
      VALUES($1,$2,$3,'single','fixture','{}','completed')`, [provision.operation, account.owner, account.device])
    await db.query(`INSERT INTO identity.agent_provisions(id,owner_user_id,operation_id,member_key,device_id,display_name,agent_type,
      inherit_memory,history_import_required,payload_hash,agent_user_id,provisioned_agent_user_id,phase)
      VALUES($1,$2,$3,'assistant',$4,'Other assistant','claude-code',false,false,'fixture',$5::text,$5::text::uuid,'completed')`,
    [provision.id, account.owner, provision.operation, account.device, id])
    provisions.push(provision)
  }
  return id
}

const panelRow = (assistant: string, account: Legacy, key: string, deleted: boolean) => db.query(`INSERT INTO identity.assistant_panel_items(
  assistant_user_id,owner_user_id,domain,resource_key,device_id,revision,data,deleted_at)
  VALUES($1,$2,'integrations',$3,$4,1,$5,CASE WHEN $6::boolean THEN now() END)`,
[assistant, account.owner, key, account.device, deleted ? {} : { providerId: 'github', accountId: JSON.parse(key)[1], configured: true }, deleted])

const commit = (account: Legacy, key: string, data: object, file: { id: string; hash: string } | null,
  revision = '0', action = 'save', runtime: string | null = account.instance, domain = 'integrations') =>
  as(account.owner, async () => (await db.query(`SELECT identity.assistant_panel_commit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS receipt`,
    [account.assistant, randomUUID(), domain, key, revision, action, JSON.stringify(data), file?.id ?? null, file?.hash ?? null,
      account.device, runtime])).rows[0].receipt)

beforeAll(async () => {
  for (const value of [url, endpoint]) if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname))
    throw new Error('Connection cutover tests require the disposable loopback fixture')
  db = new pg.Client({ connectionString: url }); await db.connect()
  imported = await withAssistant()
  const catalog = await body(imported, { version: 1, en: { id: 'github', name: sentinel }, 'zh-CN': { id: 'github', name: sentinel } })
  await commit(imported, 'catalog:github', { providerId: 'github', configured: false, displayName: 'GitHub' }, catalog)
  for (const account of ['live', 'removed']) {
    const file = await body(imported, { version: 1, providerId: 'github', accountId: account, displayName: sentinel, isDefault: account === 'live' })
    const saved = await commit(imported, JSON.stringify(['github', account]), { providerId: 'github', accountId: account, configured: true }, file)
    if (account === 'removed') {
      const removed = await commit(imported, JSON.stringify(['github', account]), {}, null, saved.revision, 'remove', null)
      // The old executor finished the cleanup: no unfinished legacy effect remains.
      await as(imported.owner, () => db.query('SELECT identity.assistant_panel_ack($1,$2,$3)', [imported.assistant, imported.instance, removed.operationId]))
    }
  }
  await commit(imported, `__collection__:${imported.device}`, { state: 'ready', schemaVersion: 1, itemCount: 2 }, null, '0', 'prepared')
  unfinished = await withAssistant()
  const pending = await body(unfinished, { version: 1, providerId: 'github', accountId: 'pending', displayName: sentinel })
  const saved = await commit(unfinished, JSON.stringify(['github', 'pending']), { providerId: 'github', accountId: 'pending', configured: true }, pending)
  await commit(unfinished, JSON.stringify(['github', 'pending']), {}, null, saved.revision, 'remove', null)
  fresh = await human()
  // Legacy rows whose assistant is no longer provisioned: neither importable nor empty.
  orphaned = await human()
  const orphanAgent = randomUUID()
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,removed_at) VALUES($1,'agent','Removed assistant',$2,now())", [orphanAgent, orphaned])
  await db.query(`INSERT INTO identity.assistant_panel_items(assistant_user_id,owner_user_id,domain,resource_key,revision,data,deleted_at)
    VALUES($1,$2,'integrations','["github","orphan"]',1,'{}',now())`, [orphanAgent, orphaned])
  // Reinstalled assistants: the removed earlier one's tombstone is imported, its live row is not.
  const ready = (account: Legacy) => commit(account, `__collection__:${account.device}`, { state: 'ready', schemaVersion: 1, itemCount: 0 }, null, '0', 'prepared')
  reinstalled = await withAssistant()
  await ready(reinstalled)
  earlier = await agent(reinstalled, { removed: true })
  await panelRow(earlier, reinstalled, '["github","before-reinstall"]', true)
  reinstalledLive = await withAssistant()
  await ready(reinstalledLive)
  await panelRow(await agent(reinstalledLive, { removed: true }), reinstalledLive, '["github","old-live"]', false)
  // A second assistant that is not removed could keep using its rows: refused.
  twoLive = await withAssistant()
  await ready(twoLive)
  await panelRow(await agent(twoLive, { removed: false }), twoLive, '["github","other-live"]', true)
  // Two completed assistant provisions, one of them removed: the live one is the source.
  doubled = await withAssistant()
  await ready(doubled)
  await agent(doubled, { removed: true, provisioned: true })
  await panelRow(doubled.assistant, doubled, '["github","revoked-here"]', true)
}, 60_000)

afterAll(async () => {
  if (!db) return
  try {
    await db.query('RESET ROLE')
    const owners = humans
    await db.query('DELETE FROM identity.connection_heads WHERE owner_user_id=ANY($1)', [owners])
    await db.query('DELETE FROM identity.assistant_panel_changes WHERE owner_user_id=ANY($1)', [owners])
    await db.query('DELETE FROM identity.assistant_panel_items WHERE owner_user_id=ANY($1)', [owners])
    for (const provision of provisions) {
      await db.query('DELETE FROM identity.agent_provisions WHERE id=$1', [provision.id])
      await db.query('DELETE FROM identity.agent_provision_operations WHERE id=$1', [provision.operation])
    }
    await db.query("DELETE FROM identity.users WHERE owner_user_id=ANY($1) AND type='agent' AND id<>ALL($2)", [owners, legacy.map(account => account.assistant)])
    for (const account of legacy) {
      await db.query('DELETE FROM chat.chats WHERE id=$1', [account.chat])
      await db.query('DELETE FROM identity.agent_provisions WHERE id=$1', [account.provision])
      await db.query('DELETE FROM identity.agent_provision_operations WHERE id=$1', [account.operation])
      await db.query('DELETE FROM identity.runtime_instances WHERE instance_id=$1', [account.instance])
      await db.query('DELETE FROM identity.users WHERE id=$1', [account.assistant])
      await db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1', [account.device])
    }
    await db.query("DELETE FROM identity.users WHERE owner_user_id=ANY($1) AND type='agent'", [owners])
    await db.query('DELETE FROM auth.users WHERE id=ANY($1)', [owners])
    if (objects.length) await createClient(endpoint, serviceKey, { auth: { persistSession: false } }).storage.from('workspace').remove(objects)
  } finally { await db.end() }
})


const heads = async () => (await db.query(`SELECT owner_user_id,authority_mode,authority_epoch::text AS epoch,authority_phase,
  native_initialized_at IS NOT NULL AS initialized FROM identity.connection_heads WHERE owner_user_id=ANY($1) ORDER BY owner_user_id`, [humans])).rows
const byOwner = (report: { accounts: { ownerId: string }[] }) => new Map(report.accounts.map(account => [account.ownerId, account as Record<string, unknown>]))
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const switchable = () => [imported.owner, fresh, reinstalled.owner, reinstalledLive.owner, doubled.owner]
const everyone = () => [imported.owner, fresh, unfinished.owner, orphaned, reinstalled.owner, reinstalledLive.owner, twoLive.owner, doubled.owner]
const keys = async (owner: string) => (await as(owner, async () => (await db.query('SELECT identity.connection_snapshot(NULL) AS v')).rows[0].v))
  .items.map((item: { resourceKey: string; deletedAt: string | null }) => [item.resourceKey, item.deletedAt !== null]).sort()

it('dry-runs every account without writing and classifies native, import and kept-legacy accounts', async () => {
  const readBody = (_id: string, location: unknown, limit: number) => connectionBodyStore(storage)(location, limit)
  const report = await cutoverConnectionAccounts(db, everyone(), { readBody })
  expect(await heads()).toEqual([])
  const accounts = byOwner(report)
  expect(report).toMatchObject({ dryRun: true, summary: { accounts: 8, eligible: 5, 'kept-legacy': 3, switched: 0, stranded: 0 } })
  expect(report.startedAt).toMatch(iso); expect(report.finishedAt).toMatch(iso)
  expect(report.startedAt <= report.finishedAt).toBe(true)
  for (const account of report.accounts) expect(account.readAt).toMatch(iso)
  // Connections apart from provider catalogs and collection markers.
  expect(accounts.get(imported.owner)).toMatchObject({ plan: 'import', result: 'eligible', inventory: {
    connections: { live: 1, retired: 0, revoked: 1 }, catalogs: 1, markers: 1, operations: 0, verifiedBodies: 2 } })
  expect(accounts.get(fresh)).toMatchObject({ plan: 'native', result: 'eligible', before: { mode: 'legacy', epoch: '0', legacyData: false } })
  expect(accounts.get(unfinished.owner)).toMatchObject({ plan: 'import', result: 'kept-legacy', code: 'CONNECTION_CUTOVER_UNFINISHED_OPERATIONS' })
  expect(accounts.get(orphaned)).toMatchObject({ plan: 'import', result: 'kept-legacy', code: 'CONNECTION_CUTOVER_NO_LEGACY_ASSISTANT' })
  expect(accounts.get(reinstalled.owner)).toMatchObject({ plan: 'import', result: 'eligible',
    removedAssistants: { importedTombstones: 1, supersededTombstones: 0, excludedRows: 0, excludedOperations: 0 },
    inventory: { connections: { live: 0, retired: 0, revoked: 1 }, catalogs: 0, markers: 1 } })
  expect(accounts.get(reinstalledLive.owner)).toMatchObject({ plan: 'import', result: 'eligible',
    removedAssistants: { importedTombstones: 0, supersededTombstones: 0, excludedRows: 1, excludedOperations: 0 },
    inventory: { connections: { live: 0, retired: 0, revoked: 0 }, markers: 1 } })
  expect(accounts.get(twoLive.owner)).toMatchObject({ plan: 'import', result: 'kept-legacy', code: 'CONNECTION_CUTOVER_SEVERAL_ASSISTANTS' })
  expect(accounts.get(doubled.owner)).toMatchObject({ plan: 'import', result: 'eligible', inventory: { connections: { revoked: 1 } } })
  await expect(cutoverConnectionAccounts(db, [fresh], { readBody, apply: true })).rejects.toMatchObject({ code: 'CONNECTION_CUTOVER_OPERATOR_REQUIRED' })
  expect(await heads()).toEqual([])
  expect(JSON.stringify(report)).not.toContain(sentinel)
  expect(JSON.stringify(report)).not.toContain(earlier)
  const missing = await cutoverConnectionAccounts(db, [imported.owner], {})
  expect(missing.accounts[0]).toMatchObject({ result: 'kept-legacy', code: 'CONNECTION_CUTOVER_BODY_SOURCE_REQUIRED' })
})

it('applies per account, hands over the audited candidate, refuses old integration writes and reruns as a no-op', async () => {
  const readBody = (_id: string, location: unknown, limit: number) => connectionBodyStore(storage)(location, limit)
  const owners = everyone()
  const report = await cutoverConnectionAccounts(db, owners, { readBody, apply: true, operator })
  expect(report).toMatchObject({ dryRun: false, operator, summary: { switched: 5, 'kept-legacy': 3, stranded: 0 } })
  expect(byOwner(report).get(twoLive.owner)).toMatchObject({ result: 'kept-legacy', code: 'CONNECTION_CUTOVER_SEVERAL_ASSISTANTS' })
  const recorded = (await db.query(`SELECT owner_user_id,path,operator_id FROM identity.connection_authority_switches
    WHERE owner_user_id=ANY($1)`, [owners])).rows
  expect(new Map(recorded.map((row: { owner_user_id: string }) => [row.owner_user_id, row]))).toEqual(new Map(switchable().map(owner =>
    [owner, { owner_user_id: owner, path: owner === fresh ? 'native' : 'import', operator_id: operator }])))
  for (const owner of switchable()) {
    const account = byOwner(report).get(owner)
    expect(account).toMatchObject({ result: 'switched', after: { mode: 'owner', epoch: '1', phase: 'stable', initialized: true } })
    expect(account?.switchedAt).toMatch(iso)
    expect(account?.code).toBeUndefined()
    expect(await as(owner, async () => (await db.query('SELECT identity.connection_authority() AS v')).rows[0].v))
      .toEqual({ version: 1, mode: 'owner', epoch: '1', phase: 'stable', acceptingNewOperations: true })
  }
  expect((await heads()).map(row => row.owner_user_id).sort()).toEqual(switchable().sort())
  expect(await keys(imported.owner)).toEqual([['["github","live"]', false], ['["github","removed"]', true],
    [`__collection__:${imported.device}`, false], ['catalog:github', false]].sort())
  // Reinstalled: the removed assistant's tombstone is present; its live row is not imported.
  expect(await keys(reinstalled.owner)).toEqual([['["github","before-reinstall"]', true], [`__collection__:${reinstalled.device}`, false]].sort())
  expect(await keys(reinstalledLive.owner)).toEqual([[`__collection__:${reinstalledLive.device}`, false]])
  expect(await keys(doubled.owner)).toEqual([['["github","revoked-here"]', true], [`__collection__:${doubled.device}`, false]].sort())
  // The imported revocation still blocks a plain re-add through the owner API.
  await db.query('UPDATE identity.runtime_instances SET last_heartbeat_at=now() WHERE instance_id=$1', [reinstalled.instance])
  await expect(as(reinstalled.owner, () => db.query('SELECT identity.connection_commit($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(),
    `device:${reinstalled.device}`, '["github","before-reinstall"]', 1, 'save', { providerId: 'github', accountId: 'before-reinstall', configured: true },
    JSON.stringify({ version: 1, providerId: 'github', accountId: 'before-reinstall' }), reinstalled.device, reinstalled.instance])))
    .rejects.toMatchObject({ code: 'PT409', message: 'Connection observation cannot clear a revocation' })
  const late = await commit(imported, JSON.stringify(['github', 'late']), { providerId: 'github', accountId: 'late', configured: true }, null)
    .catch(error => error)
  expect(late).toMatchObject({ code: 'PT409', message: 'Connection authority was switched to owner' })
  expect(JSON.parse(late.detail)).toEqual({ errorCode: 'CONNECTION_AUTHORITY_SWITCHED', feature: 'connection-management' })
  const before = await heads()
  const rerun = await cutoverConnectionAccounts(db, owners, { readBody, apply: true, operator })
  expect(rerun.summary).toMatchObject({ 'already-owner': 5, 'kept-legacy': 3, switched: 0, stranded: 0 })
  expect(await heads()).toEqual(before)
})

it('CLI writes a private report, prints only counts and never credentials or bodies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'connection-cutover-'))
  try {
    const ownersFile = join(directory, 'owners.txt'), output = join(directory, 'report.json')
    await writeFile(ownersFile, `# staged list\n${imported.owner}\n${unfinished.owner}\n`, { mode: 0o600 })
    const base = [cli, '--owners', ownersFile, '--database-url-env', 'GUGU_INTEGRATION_DATABASE_URL', '--bodies-from-storage']
    const args = [...base, '--output', output, '--operator', operator]
    const env = { ...process.env, ...storage }
    // No operator: refused before any report or database work.
    await expect(execute(process.execPath, [...base, '--output', join(directory, 'anonymous.json')], { env }))
      .rejects.toMatchObject({ code: 1, stderr: 'CONNECTION_CUTOVER_OPERATOR_REQUIRED\n' })
    await expect(stat(join(directory, 'anonymous.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const failure = await execute(process.execPath, args, { env }).catch(error => error)
    expect(failure.code).toBe(2)
    expect(failure.stderr).toBe('')
    expect(JSON.parse(failure.stdout)).toEqual({ dryRun: true, accounts: 2, switched: 0, 'already-owner': 1, eligible: 0,
      'kept-legacy': 1, failed: 0, 'not-attempted': 0, stranded: 0 })
    expect((await stat(output)).mode & 0o777).toBe(0o600)
    const text = await readFile(output, 'utf8')
    expect(JSON.parse(text)).toMatchObject({ version: 1, dryRun: true, operator, startedAt: expect.stringMatching(iso), finishedAt: expect.stringMatching(iso) })
    for (const secret of [serviceKey, sentinel, url]) expect(text).not.toContain(secret)
    // The report is claimed before the database is touched; an existing one is never replaced.
    await expect(execute(process.execPath, args, { env })).rejects.toMatchObject({ code: 1, stderr: 'CONNECTION_CUTOVER_REPORT_EXISTS\n' })
    expect(await readFile(output, 'utf8')).toBe(text)
    await expect(execute(process.execPath, [...base, '--output', join(directory, 'x.json'), '--operator', operator, '--bodies-dir', directory],
      { env })).rejects.toMatchObject({ code: 1, stderr: 'CONNECTION_CUTOVER_INVALID_ARGUMENTS\n' })
    // An unreachable database has its own code, on stderr and in the claimed report.
    const unreachable = join(directory, 'unreachable.json')
    await expect(execute(process.execPath, [cli, '--owners', ownersFile, '--database-url-env', 'GUGU_UNREACHABLE_DATABASE_URL',
      '--output', unreachable, '--operator', operator], { env: { ...env, GUGU_UNREACHABLE_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:1/postgres' } }))
      .rejects.toMatchObject({ code: 1, stderr: 'CONNECTION_CUTOVER_DATABASE_UNREACHABLE\n' })
    expect(JSON.parse(await readFile(unreachable, 'utf8'))).toMatchObject({ version: 1, dryRun: true, operator,
      startedAt: expect.stringMatching(iso), finishedAt: expect.stringMatching(iso), error: { code: 'CONNECTION_CUTOVER_DATABASE_UNREACHABLE' } })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
