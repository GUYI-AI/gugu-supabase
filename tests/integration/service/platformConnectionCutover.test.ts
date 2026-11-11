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
const legacy: Legacy[] = [], humans: string[] = [], objects: string[] = []
let db: pg.Client, imported: Legacy, unfinished: Legacy, fresh: string, orphaned: string

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
  const agent = randomUUID()
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,removed_at) VALUES($1,'agent','Removed assistant',$2,now())", [agent, orphaned])
  await db.query(`INSERT INTO identity.assistant_panel_items(assistant_user_id,owner_user_id,domain,resource_key,revision,data,deleted_at)
    VALUES($1,$2,'integrations','["github","orphan"]',1,'{}',now())`, [agent, orphaned])
}, 60_000)

afterAll(async () => {
  if (!db) return
  try {
    await db.query('RESET ROLE')
    const owners = humans
    await db.query('DELETE FROM identity.connection_heads WHERE owner_user_id=ANY($1)', [owners])
    await db.query('DELETE FROM identity.assistant_panel_changes WHERE owner_user_id=ANY($1)', [owners])
    await db.query('DELETE FROM identity.assistant_panel_items WHERE owner_user_id=ANY($1)', [owners])
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

it('dry-runs every account without writing and classifies native, import and kept-legacy accounts', async () => {
  const readBody = (_id: string, location: unknown, limit: number) => connectionBodyStore(storage)(location, limit)
  const report = await cutoverConnectionAccounts(db, [imported.owner, fresh, unfinished.owner, orphaned], { readBody })
  expect(await heads()).toEqual([])
  const accounts = byOwner(report)
  expect(report).toMatchObject({ dryRun: true, summary: { accounts: 4, eligible: 2, 'kept-legacy': 2, switched: 0 } })
  expect(accounts.get(imported.owner)).toMatchObject({ plan: 'import', result: 'eligible', inventory: { items: 4, operations: 0, verifiedBodies: 2 } })
  expect(accounts.get(fresh)).toMatchObject({ plan: 'native', result: 'eligible', before: { mode: 'legacy', epoch: '0', legacyData: false } })
  expect(accounts.get(unfinished.owner)).toMatchObject({ plan: 'import', result: 'kept-legacy', code: 'CONNECTION_CUTOVER_UNFINISHED_OPERATIONS' })
  expect(accounts.get(orphaned)).toMatchObject({ plan: 'import', result: 'kept-legacy', code: 'CONNECTION_CUTOVER_NO_LEGACY_ASSISTANT' })
  expect(JSON.stringify(report)).not.toContain(sentinel)
  const missing = await cutoverConnectionAccounts(db, [imported.owner], {})
  expect(missing.accounts[0]).toMatchObject({ result: 'kept-legacy', code: 'CONNECTION_CUTOVER_BODY_SOURCE_REQUIRED' })
})

it('applies per account, hands over the audited candidate, refuses old integration writes and reruns as a no-op', async () => {
  const readBody = (_id: string, location: unknown, limit: number) => connectionBodyStore(storage)(location, limit)
  const owners = [imported.owner, fresh, unfinished.owner, orphaned]
  const report = await cutoverConnectionAccounts(db, owners, { readBody, apply: true })
  expect(report).toMatchObject({ dryRun: false, summary: { switched: 2, 'kept-legacy': 2 } })
  for (const owner of [imported.owner, fresh]) {
    expect(byOwner(report).get(owner)).toMatchObject({ result: 'switched',
      after: { mode: 'owner', epoch: '1', phase: 'stable', initialized: true } })
    expect(await as(owner, async () => (await db.query('SELECT identity.connection_authority() AS v')).rows[0].v))
      .toEqual({ version: 1, mode: 'owner', epoch: '1', phase: 'stable', acceptingNewOperations: true })
  }
  expect((await heads()).map(row => row.owner_user_id).sort()).toEqual([imported.owner, fresh].sort())
  const snapshot = await as(imported.owner, async () => (await db.query('SELECT identity.connection_snapshot(NULL) AS v')).rows[0].v)
  expect(snapshot.state).toBe('ready')
  expect(snapshot.items.map((item: { resourceKey: string }) => item.resourceKey).sort())
    .toEqual(['["github","live"]', '["github","removed"]', `__collection__:${imported.device}`, 'catalog:github'].sort())
  await expect(commit(imported, JSON.stringify(['github', 'late']), { providerId: 'github', accountId: 'late', configured: true }, null))
    .rejects.toMatchObject({ code: 'PT409' })
  const before = await heads()
  const rerun = await cutoverConnectionAccounts(db, owners, { readBody, apply: true })
  expect(rerun.summary).toMatchObject({ 'already-owner': 2, 'kept-legacy': 2, switched: 0 })
  expect(await heads()).toEqual(before)
})

it('CLI writes a private report, prints only counts and never credentials or bodies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'connection-cutover-'))
  try {
    const ownersFile = join(directory, 'owners.txt'), output = join(directory, 'report.json')
    await writeFile(ownersFile, `# staged list\n${imported.owner}\n${unfinished.owner}\n`, { mode: 0o600 })
    const args = [cli, '--owners', ownersFile, '--output', output, '--database-url-env', 'GUGU_INTEGRATION_DATABASE_URL', '--bodies-from-storage']
    const env = { ...process.env, ...storage }
    const failure = await execute(process.execPath, args, { env }).catch(error => error)
    expect(failure.code).toBe(2)
    expect(failure.stderr).toBe('')
    expect(JSON.parse(failure.stdout)).toEqual({ dryRun: true, accounts: 2, switched: 0, 'already-owner': 1, eligible: 0,
      'kept-legacy': 1, failed: 0, 'not-attempted': 0 })
    expect((await stat(output)).mode & 0o777).toBe(0o600)
    const text = await readFile(output, 'utf8')
    for (const secret of [serviceKey, sentinel, url]) expect(text).not.toContain(secret)
    await expect(execute(process.execPath, args, { env })).rejects.toMatchObject({ code: 1, stderr: 'CONNECTION_CUTOVER_FAILED\n' })
    await expect(execute(process.execPath, [cli, '--owners', ownersFile, '--output', join(directory, 'x.json'), '--bodies-dir', directory,
      '--bodies-from-storage'], { env })).rejects.toMatchObject({ code: 1, stderr: 'CONNECTION_CUTOVER_INVALID_ARGUMENTS\n' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
