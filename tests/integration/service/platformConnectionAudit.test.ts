import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { auditConnectionInventory, compareConnectionInventories } from '../../../scripts/platform-connection-audit.mjs'
import { cutoverConnectionAccount } from '../../../scripts/platform-connection-cutover.mjs'
import { prepareConnectionCandidate, readConnectionInventory } from '../../../scripts/platform-connection-prepare.mjs'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const owner = randomUUID(), assistant = randomUUID(), chat = randomUUID(), provision = randomUUID(), operation = randomUUID()
const device = `connection-audit-${randomUUID()}`, instance = randomUUID()
const bodies = new Map<string, Uint8Array>()
let db: pg.Client

async function asOwner<T>(action: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
  await db.query('SET ROLE authenticated')
  try { return await action() } finally { await db.query('RESET ROLE') }
}

async function body(data: object) {
  const id = randomUUID(), blob = randomUUID(), bytes = new TextEncoder().encode(JSON.stringify(data))
  const hash = createHash('sha256').update(bytes).digest('hex')
  await db.query(`INSERT INTO chat.file_blobs(id,bucket_id,object_name,sha256,size_bytes,content_type,created_by)
    VALUES($1,'workspace',$2,$3,$4,'application/json',$5)`, [blob,`${chat}/${blob}`,hash,bytes.byteLength,owner])
  await db.query(`INSERT INTO chat.workspace_items(id,chat_id,kind,filename,blob_id,created_by)
    VALUES($1,$2,'file',$3,$4,$5)`, [id,chat,`${id}.json`,blob,owner])
  bodies.set(id, bytes)
  return { id, hash }
}

async function commit(key: string, data: object, file: { id: string; hash: string } | null,
  revision = '0', action = 'save', runtime: string | null = instance) {
  return asOwner(async () => (await db.query(`SELECT identity.assistant_panel_commit(
    $1,$2,'integrations',$3,$4,$5,$6,$7,$8,$9,$10) AS receipt`,
  [assistant,randomUUID(),key,revision,action,JSON.stringify(data),file?.id ?? null,file?.hash ?? null,device,runtime])).rows[0].receipt)
}

beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Connection audit tests require a disposable loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
  await db.query('BEGIN')
  try {
    await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
      confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
      VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,
      '{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`, [owner,`${owner}@connection-audit.invalid`])
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Connection audit fixture') ON CONFLICT DO NOTHING", [owner])
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", [device,owner])
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Connection audit assistant',$2,$3)", [assistant,owner,device])
    await db.query("INSERT INTO chat.chats(id,kind,creator_user_id) VALUES($1,'dm',$2)", [chat,owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')", [chat,owner,assistant])
    await db.query(`INSERT INTO identity.agent_provision_operations(id,owner_user_id,device_id,kind,payload_hash,blueprint,phase)
      VALUES($1,$2,$3,'single','fixture','{}','completed')`, [operation,owner,device])
    await db.query(`INSERT INTO identity.agent_provisions(id,owner_user_id,operation_id,member_key,device_id,display_name,agent_type,
      inherit_memory,history_import_required,payload_hash,agent_user_id,provisioned_agent_user_id,dm_chat_id,phase)
      VALUES($1,$2,$3,'assistant',$4,'Connection audit assistant','claude-code',false,false,'fixture',$5::text,$5::text::uuid,$6,'completed')`,
    [provision,owner,operation,device,assistant,chat])
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)', [instance,device,owner])
    const catalog = await body({ version: 1, en: { id: 'github', name: owner }, 'zh-CN': { id: 'github', name: owner } })
    await commit('catalog:github', { providerId: 'github', configured: false, displayName: 'GitHub' }, catalog)
    for (const account of ['live', 'removed']) {
      const file = await body({ version: 1, providerId: 'github', accountId: account, displayName: owner, connectedAt: 1, updatedAt: 2, isDefault: account === 'live' })
      const saved = await commit(JSON.stringify(['github',account]), { providerId: 'github', accountId: account, configured: true }, file)
      if (account === 'removed') await commit(JSON.stringify(['github',account]), {}, null, saved.revision, 'remove', null)
    }
    await commit(`__collection__:${device}`, { state: 'ready', schemaVersion: 1, itemCount: 2 }, null, '0', 'prepared')
    await db.query('COMMIT')
  } catch (error) { await db.query('ROLLBACK'); throw error }
})

afterAll(async () => {
  if (!db) return
  try {
    await db.query('RESET ROLE')
    await db.query('BEGIN')
    await db.query('DELETE FROM identity.connection_heads WHERE owner_user_id=$1', [owner])
    await db.query('DELETE FROM identity.assistant_panel_changes WHERE owner_user_id=$1', [owner])
    await db.query('DELETE FROM identity.assistant_panel_items WHERE owner_user_id=$1', [owner])
    await db.query('DELETE FROM chat.chats WHERE id=$1', [chat])
    await db.query('DELETE FROM identity.agent_provisions WHERE id=$1', [provision])
    await db.query('DELETE FROM identity.agent_provision_operations WHERE id=$1', [operation])
    await db.query('DELETE FROM identity.runtime_instances WHERE instance_id=$1', [instance])
    await db.query('DELETE FROM identity.users WHERE id=$1', [assistant])
    await db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1', [device])
    await db.query('DELETE FROM auth.users WHERE id=$1', [owner])
    expect((await db.query('SELECT count(*)::int AS n FROM identity.users WHERE id=$1', [owner])).rows[0].n).toBe(0)
    await db.query('COMMIT')
  } finally { await db.end() }
})

// The inventory exactly as the cutover tool reads it and preparation rechecks it: one reader, maintenance scope.
const inventory = () => readConnectionInventory(db, owner)

it('exports the installed legacy schema read-only, including revoked rows and unapplied cleanup', async () => {
  const source = await inventory()
  expect(source).toMatchObject({ complete: true, identityState: 'found', ownerId: owner, assistantId: assistant })
  expect(source.databaseDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(source.items).toHaveLength(4)
  expect(source.operations).toHaveLength(1)
  expect(source.operations[0]).toMatchObject({ operation: 'remove', status: 'pending', device_id: device,
    payload: { before: { providerId: 'github', accountId: 'removed' }, deviceId: device, deleted: true } })
  const audited = await auditConnectionInventory(source, { readBody: async (id: string) => bodies.get(id) })
  expect(audited.verifiedBodies).toBe(2)
  expect(compareConnectionInventories(audited, audited).eligible).toBe(true)
  // The regular visible snapshot intentionally omits the tombstone. It must not
  // replace the complete inventory used for a migration decision.
  const visible = await asOwner(async () => (await db.query('SELECT identity.assistant_panel_snapshot($1) AS value', [assistant])).rows[0].value)
  expect(visible.items).toHaveLength(3)
})

it('dry-runs without a candidate and atomically verifies stored bodies, tombstones and original operation identities', async () => {
  const source = await inventory()
  // The digest the tool's dry run records is the one preparation accepts below and rechecks under its locks.
  const dryRun = await cutoverConnectionAccount(db, owner)
  expect(dryRun).toMatchObject({ result: 'kept-legacy', code: 'CONNECTION_CUTOVER_UNFINISHED_OPERATIONS', databaseDigest: source.databaseDigest })
  const options = { readBody: async (id: string) => bodies.get(id) }
  expect(await prepareConnectionCandidate(db, source, options)).toMatchObject({ dryRun: true, prepared: false, activated: false })
  expect((await db.query('SELECT count(*)::int AS n FROM identity.connection_heads WHERE owner_user_id=$1', [owner])).rows[0].n).toBe(0)
  const prepared = await prepareConnectionCandidate(db, source, { ...options, apply: true })
  expect(prepared).toMatchObject({ prepared: true, activated: false, comparison: { eligible: true, differences: [] } })
  expect(prepared.comparison.candidate.operations).toEqual(prepared.comparison.source.operations)
  expect((await inventory()).databaseDigest).toBe(source.databaseDigest)
  const operation = (await db.query('SELECT operation_id,legacy_operation_id,source FROM identity.connection_operations WHERE owner_user_id=$1', [owner])).rows[0]
  expect(operation).toEqual({ operation_id: source.operations[0].operation_id, legacy_operation_id: source.operations[0].operation_id, source: 'legacy' })
  await expect(prepareConnectionCandidate(db, source, { apply: true, readBody: async () => new Uint8Array([1]) })).rejects.toMatchObject({ code: 'CONNECTION_AUDIT_BODY_HASH_MISMATCH' })
  await db.query("UPDATE identity.assistant_panel_items SET stale_at=now() WHERE assistant_user_id=$1 AND resource_key='catalog:github'", [assistant])
  try {
    await expect(prepareConnectionCandidate(db, source, { ...options, apply: true })).rejects.toMatchObject({ code: 'CONNECTION_PREPARE_SOURCE_CHANGED' })
  } finally {
    await db.query("UPDATE identity.assistant_panel_items SET stale_at=NULL WHERE assistant_user_id=$1 AND resource_key='catalog:github'", [assistant])
  }
})

it('bounds a larger complete inventory and measures held-lock time through the pre-commit verification', async () => {
  await db.query(`INSERT INTO identity.assistant_panel_items(assistant_user_id,owner_user_id,domain,resource_key,device_id,revision,data,deleted_at)
    SELECT $1,$2,'integrations','revoked-fixture-'||n,$3,1,'{}',now() FROM generate_series(1,1800) n`, [assistant,owner,device])
  await db.query(`INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,domain,resource_key,device_id,
    source,operation,expected_item_revision,request_hash,payload,status)
    SELECT gen_random_uuid(),$1,$2,'integrations','revoked-fixture-'||n,$3,'panel','remove',1,repeat('f',64),'{}','pending'
    FROM generate_series(1,1000) n`, [assistant,owner,device])
  // Fixture inserts bypass normal revision allocation; model the resulting head.
  await db.query(`UPDATE identity.assistant_panel_items SET revision=(SELECT max(revision) FROM identity.assistant_panel_changes WHERE assistant_user_id=$1)
    WHERE assistant_user_id=$1 AND domain='control' AND resource_key='__head__'`, [assistant])
  try {
    const source = await inventory()
    const report = await prepareConnectionCandidate(db, source, { apply: true, readBody: async (id: string) => bodies.get(id) })
    expect(source.items).toHaveLength(1804)
    expect(source.operations).toHaveLength(1001)
    expect(report.comparison.eligible).toBe(true)
    expect(report.measuredLockMsBeforeCommit).toBeGreaterThanOrEqual(0)
    // PostgreSQL's transaction_timeout bounds the entire locked transaction;
    // this is a diagnostic observation, not a wall-clock scheduling assertion.
    console.info(JSON.stringify({ connectionPreparationSample: { items: source.items.length, operations: source.operations.length,
      measuredLockMsBeforeCommit: report.measuredLockMsBeforeCommit, transactionTimeoutMs: 2000 } }))
  } finally {
    await db.query("DELETE FROM identity.assistant_panel_changes WHERE assistant_user_id=$1 AND starts_with(resource_key,'revoked-fixture-')", [assistant])
    await db.query("DELETE FROM identity.assistant_panel_items WHERE assistant_user_id=$1 AND starts_with(resource_key,'revoked-fixture-')", [assistant])
  }
})

it('refuses an unbounded caller and a contended old control lock without changing the previous candidate', async () => {
  const source = await inventory()
  const before = (await db.query('SELECT source_digest FROM identity.connection_heads WHERE owner_user_id=$1', [owner])).rows[0]
  await expect(db.query('SELECT identity.connection_prepare_import($1,$2,$3,$4)', [owner,source.databaseDigest,'f'.repeat(64),'{}']))
    .rejects.toMatchObject({ code: '22023' })
  const blocker = new pg.Client({ connectionString: url })
  await blocker.connect()
  try {
    await blocker.query('BEGIN')
    await blocker.query("SELECT 1 FROM identity.assistant_panel_items WHERE assistant_user_id=$1 AND domain='control' AND resource_key='__head__' FOR UPDATE", [assistant])
    await expect(prepareConnectionCandidate(db, source, { apply: true, readBody: async (id: string) => bodies.get(id) }))
      .rejects.toMatchObject({ code: '55P03' })
    expect((await db.query('SELECT source_digest FROM identity.connection_heads WHERE owner_user_id=$1', [owner])).rows[0]).toEqual(before)
  } finally { await blocker.query('ROLLBACK'); await blocker.end() }
})
