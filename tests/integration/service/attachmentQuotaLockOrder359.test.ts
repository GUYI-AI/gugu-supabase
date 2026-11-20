import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// These transactions must commit so their competitors can see the same receipt.
// A controller holds the real quota lock, queues registration first, then queues
// the original writer. Releasing it exposes receipt -> quota / quota -> receipt
// on the predecessor. No RPC, row lock, quota check or trigger is mocked.
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const quota = "hashtextextended('gugu:file-transfer:quota',0)"
const clients: pg.Client[] = []
let monitor: pg.Client
const settings = {
  inventory_ready: true,
  storage_global_bytes: 1_000_000, storage_account_bytes: 1_000_000, storage_group_bytes: 1_000_000,
  download_global_bytes: 1_000_000, download_account_bytes: 1_000_000, download_group_bytes: 1_000_000,
  file_max_bytes: 1000, upload_permit_seconds: 120,
  upload_edge_seconds: 400, upload_sign_seconds: 900, upload_inflight_seconds: 600,
  sign_window_seconds: 60, sign_account_count: 100, sign_group_count: 100,
}
async function connect() {
  const client = new pg.Client({ connectionString: url, application_name: 'attachment-quota-359' })
  await client.connect()
  clients.push(client)
  await client.query("SET statement_timeout='10s'")
  return client
}
beforeAll(async () => {
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('attachmentQuotaLockOrder359 requires a disposable loopback PostgreSQL database')
  }
  monitor = await connect()
})
afterAll(async () => { await Promise.all(clients.map(client => client.end())) })

interface Failure { code?: string; hint?: string; message: string }
async function transaction(
  client: pg.Client, actor: string, role: 'authenticated' | 'service_role', sql: string, args: unknown[],
  beforeCommit?: () => Promise<void>,
) {
  await client.query('BEGIN')
  // Local to this disposable connection, before assuming the API role. The
  // registration victim reports the old cycle promptly; no retry is involved.
  await client.query("SET LOCAL deadlock_timeout='100ms'")
  await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role })])
  await client.query(`SET LOCAL ROLE ${role}`)
  try {
    const result = await client.query(sql, args)
    await beforeCommit?.()
    await client.query('COMMIT')
    return { rows: result.rows, error: null }
  } catch (error) {
    await client.query('ROLLBACK')
    const e = error as pg.DatabaseError
    return { rows: [], error: { code: e.code, hint: e.hint, message: e.message } as Failure }
  }
}
const pid = async (client: pg.Client) => Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
async function blockedBy(waiter: number, holder: number) {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    const result = await monitor.query<{ waiting: boolean }>(
      'SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS waiting', [waiter, holder])
    if (result.rows[0]?.waiting) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`RIG-FAIL: backend ${waiter} never queued behind controller ${holder}`)
}

interface Fixture {
  owner: string; stranger: string; chat: string; keys: string[]; reservations: string[]; blobs: string[]
}
async function fixture(body: (f: Fixture) => Promise<void>) {
  const f: Fixture = { owner: randomUUID(), stranger: randomUUID(), chat: randomUUID(), keys: [], reservations: [], blobs: [] }
  const previous = (await monitor.query("SELECT settings FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*'")).rows[0]?.settings
  try {
    const usage = Number((await monitor.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
    await monitor.query(`INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1)
      ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings`, [{ ...settings, storage_global_bytes: usage + settings.storage_global_bytes }])
    await monitor.query("INSERT INTO auth.users(id,email) SELECT x::uuid,x||'@attachment-quota-359.invalid' FROM unnest($1::text[]) x", [[f.owner, f.stranger]])
    await monitor.query("INSERT INTO identity.users(id,type,display_name) SELECT x,'human','quota lock fixture' FROM unnest($1::text[]) x ON CONFLICT(id) DO NOTHING", [[f.owner, f.stranger]])
    await monitor.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','quota lock fixture',$2)", [f.chat, f.owner])
    await monitor.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [f.chat, f.owner])
    await body(f)
  } finally {
    await monitor.query('ROLLBACK')
    await monitor.query('DELETE FROM chat.chats WHERE id=$1', [f.chat])
    await monitor.query('DELETE FROM chat.file_blob_uploads WHERE staging_key=ANY($1::text[])', [f.keys])
    await monitor.query('DELETE FROM chat.file_transfer_uploads WHERE account_id=$1 AND reservation_id=ANY($2::uuid[])', [f.owner, f.reservations])
    await monitor.query('DELETE FROM chat.file_transfer_reservations WHERE id=ANY($1::uuid[])', [f.reservations])
    await monitor.query('DELETE FROM chat.file_transfer_storage WHERE blob_id=ANY($1::uuid[])', [f.blobs])
    await monitor.query('DELETE FROM chat.file_blobs WHERE id=ANY($1::uuid[])', [f.blobs])
    await monitor.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[f.owner, f.stranger]])
    if (previous) await monitor.query("UPDATE chat.file_transfer_limits SET settings=$1 WHERE scope='global' AND scope_id='*'", [previous])
    else await monitor.query("DELETE FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*'")
  }
}
async function upload(f: Fixture, bytes: number) {
  const reservation = randomUUID()
  f.reservations.push(reservation)
  const permit = await transaction(monitor, f.owner, 'authenticated',
    'SELECT chat.file_managed_upload_as($1,$2,$3,$4) AS permit', [reservation, f.chat, f.owner, bytes])
  expect(permit.error).toBeNull()
  const key = permit.rows[0].permit.staging_key as string
  f.keys.push(key)
  const digest = randomBytes(32).toString('hex')
  const registered = await transaction(monitor, f.owner, 'service_role',
    "SELECT * FROM chat.file_blob_register($1,$2,$3,$4,'application/octet-stream')", [f.owner, key, digest, bytes])
  expect(registered.error).toBeNull()
  const blob = registered.rows[0].blob_id as string
  f.blobs.push(blob)
  return { key, digest, blob, bytes, reservation }
}
const register = 'SELECT chat.file_managed_upload_registered($1,$2,NULL)'
const commit = `SELECT id,file_item_id,file_version FROM chat.attachment_commit(
  p_staging_key:=$1,p_message_id:=$2,p_chat_id:=$3,p_sender_user_id:=$4,p_file_name:='lock-order.bin',
  p_item_id:=$5,p_expected_version:=$6)`

describe('quota admission before attachment receipt and file rows #359', () => {
  it.each(['new-file', 'version', 'settle-replay'] as const)('%s and registration complete in the established quota order', async mode => fixture(async f => {
    let item: string | null = null
    if (mode === 'version') {
      const first = await upload(f, 7)
      expect((await transaction(monitor, f.owner, 'service_role', register, [first.key, f.owner])).error).toBeNull()
      const initial = await transaction(monitor, f.owner, 'authenticated', commit, [first.key, randomUUID(), f.chat, f.owner, null, null])
      expect(initial.error).toBeNull()
      item = initial.rows[0].file_item_id
    }
    const next = await upload(f, 11), message = randomUUID()
    if (mode === 'settle-replay') {
      expect((await transaction(monitor, f.owner, 'service_role', register, [next.key, f.owner])).error).toBeNull()
    }
    const controller = await connect(), registration = await connect(), writer = await connect(), probe = await connect()
    const [controllerPid, registrationPid, writerPid] = await Promise.all([pid(controller), pid(registration), pid(writer)])
    await controller.query('BEGIN')
    await controller.query(`SELECT pg_advisory_xact_lock(${quota})`)
    const a = transaction(registration, f.owner, 'service_role', register, [next.key, f.owner])
    let b: ReturnType<typeof transaction> | undefined
    let receiptLocked = false
    let outcomes: Awaited<ReturnType<typeof transaction>>[] = []
    try {
      await blockedBy(registrationPid, controllerPid)
      b = mode === 'settle-replay'
        ? transaction(writer, f.owner, 'service_role', 'SELECT chat.file_blob_settle($1,$2,$2,$3,$4,$5) AS result',
          [f.owner, next.key, next.digest, next.bytes, 'application/octet-stream'])
        : transaction(writer, f.owner, 'authenticated', commit, [next.key, message, f.chat, f.owner, item, item ? 1 : null])
      await blockedBy(writerPid, controllerPid)
      await probe.query('BEGIN')
      try {
        await probe.query('SELECT 1 FROM chat.file_blob_uploads WHERE staging_key=$1 FOR UPDATE NOWAIT', [next.key])
      } catch (error) {
        expect((error as pg.DatabaseError).code).toBe('55P03')
        receiptLocked = true
      } finally { await probe.query('ROLLBACK') }
    } finally {
      // Always open the controller, including a broken rig, before awaiting the
      // competitors. Their own transaction wrappers roll back the losing side.
      await controller.query('ROLLBACK')
      outcomes = await Promise.all([a, ...(b ? [b] : [])])
      console.info(JSON.stringify({ mode, receiptLockedWhileWaitingForQuota: receiptLocked, outcomes }))
    }
    expect(outcomes.map(result => result.error)).toEqual([null, null])
    expect(receiptLocked).toBe(false)
    const receipt = (await monitor.query('SELECT blob_id,message_id,item_id,item_version FROM chat.file_blob_uploads WHERE staging_key=$1', [next.key])).rows[0]
    expect(receipt.blob_id).toBe(next.blob)
    expect((await monitor.query('SELECT state,actual_bytes::int AS actual_bytes FROM chat.file_transfer_reservations WHERE id=$1', [next.reservation])).rows)
      .toEqual([{ state: 'settled', actual_bytes: 11 }])
    if (mode === 'settle-replay') expect(receipt.message_id).toBeNull()
    else {
      expect(receipt.message_id).toBe(message)
      expect(receipt.item_version).toBe(item ? 2 : 1)
      expect((await monitor.query('SELECT count(*)::int AS n FROM chat.messages WHERE id=$1', [message])).rows).toEqual([{ n: 1 }])
      expect((await monitor.query('SELECT version,blob_id FROM chat.workspace_items WHERE id=$1', [receipt.item_id])).rows)
        .toEqual([{ version: item ? 2 : 1, blob_id: next.blob }])
      const replay = await transaction(monitor, f.owner, 'authenticated', commit, [next.key, message, f.chat, f.owner, item, item ? 1 : null])
      expect(replay.error).toBeNull()
      expect(replay.rows).toHaveLength(1)
    }
    expect(Number((await monitor.query("SELECT chat.file_transfer_usage('upload','account',$1) AS n", [f.owner])).rows[0].n))
      .toBe(mode === 'version' ? 18 : 11)
  }))

  it('retention release leaves copy rows unlocked while queued for quota', async () => fixture(async f => {
    const file = await upload(f, 11)
    expect((await transaction(monitor, f.owner, 'service_role', register, [file.key, f.owner])).error).toBeNull()
    const sent = await transaction(monitor, f.owner, 'authenticated', commit, [file.key, randomUUID(), f.chat, f.owner, null, null])
    expect(sent.error).toBeNull()
    const item = sent.rows[0].file_item_id
    const controller = await connect(), writer = await connect(), probe = await connect()
    const [controllerPid, writerPid] = await Promise.all([pid(controller), pid(writer)])
    await controller.query('BEGIN')
    await controller.query(`SELECT pg_advisory_xact_lock(${quota})`)
    // The predecessor uses pg_try_advisory_xact_lock and can return before
    // quota becomes available. Keep its real transaction open after that call:
    // its copy-row lock must remain observable until the probe has run.
    let releaseCommit!: () => void
    const commitBarrier = new Promise<void>(resolve => { releaseCommit = resolve })
    let callReturned = false, transactionFinished = false, quotaQueued = false
    const releasing = transaction(writer, f.owner, 'authenticated', 'SELECT chat.file_storage_mark_as($1,$2) AS n',
      [JSON.stringify([{ item_id: item }]), 'release'], async () => {
        callReturned = true
        await commitBarrier
      }).then(value => { transactionFinished = true; return value })
    let copyLocked = false
    let result: Awaited<ReturnType<typeof transaction>> | undefined
    try {
      const end = Date.now() + 5000
      while (!callReturned) {
        const waiting = await monitor.query<{ waiting: boolean }>(
          `SELECT $2::int=ANY(pg_blocking_pids($1::int)) AND EXISTS (
            SELECT 1 FROM pg_locks l WHERE l.pid=$1::int AND NOT l.granted
              AND l.locktype='advisory' AND l.mode='ExclusiveLock' AND l.objsubid=1
              AND l.classid=(((${quota}) >> 32) & 4294967295)::oid
              AND l.objid=((${quota}) & 4294967295)::oid
          ) AS waiting`, [writerPid, controllerPid])
        if (waiting.rows[0]?.waiting) { quotaQueued = true; break }
        if (transactionFinished) {
          expect((await releasing).error).toBeNull()
          throw new Error('RIG-FAIL: retention transaction finished without reaching its commit barrier')
        }
        if (Date.now() >= end) throw new Error('RIG-FAIL: retention call neither returned nor queued for the exact quota lock')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      await probe.query('BEGIN')
      try {
        const row = await probe.query(`SELECT 1 FROM chat.file_transfer_storage_refs
          WHERE storage_id=(SELECT id FROM chat.file_transfer_storage WHERE blob_id=$1)
            AND chat_id=$2 FOR UPDATE NOWAIT`, [file.blob, f.chat])
        expect(row.rows).toHaveLength(1)
      } catch (error) {
        expect((error as pg.DatabaseError).code).toBe('55P03')
        copyLocked = true
      } finally { await probe.query('ROLLBACK') }
    } finally {
      try { await controller.query('ROLLBACK') } finally { releaseCommit() }
      result = await releasing
      console.info(JSON.stringify({ retentionCopyLockedBeforeCommit: copyLocked, quotaQueued, result }))
    }
    expect(copyLocked).toBe(false)
    expect(quotaQueued).toBe(true)
    expect(result?.error).toBeNull()
    expect(result?.rows).toEqual([{ n: 1 }])
    expect((await monitor.query(`SELECT action,changed_copy_count FROM file_private.storage_action_audit
      WHERE actor_user_id=$1 ORDER BY occurred_at`, [f.owner])).rows).toEqual([{ action: 'release', changed_copy_count: 1 }])
    expect((await monitor.query('SELECT version,blob_id FROM chat.workspace_items WHERE id=$1', [item])).rows)
      .toEqual([{ version: 1, blob_id: file.blob }])
  }))

  it('keeps authorization and rolls back a refused version without consuming the receipt', async () => fixture(async f => {
    const first = await upload(f, 7)
    expect((await transaction(monitor, f.owner, 'service_role', register, [first.key, f.owner])).error).toBeNull()
    const initial = await transaction(monitor, f.owner, 'authenticated', commit, [first.key, randomUUID(), f.chat, f.owner, null, null])
    expect(initial.error).toBeNull()
    const item = initial.rows[0].file_item_id, next = await upload(f, 11), id = randomUUID()
    const before = (await monitor.query('SELECT * FROM chat.file_blob_uploads WHERE staging_key=$1', [next.key])).rows[0]
    const wrongVersion = await transaction(monitor, f.owner, 'authenticated', commit, [next.key, id, f.chat, f.owner, item, 99])
    expect(wrongVersion.error?.hint).toBe('workspace_version_conflict')
    expect((await monitor.query('SELECT * FROM chat.file_blob_uploads WHERE staging_key=$1', [next.key])).rows[0]).toEqual(before)
    expect((await monitor.query('SELECT id FROM chat.messages WHERE id=$1', [id])).rows).toEqual([])
    const denied = await transaction(monitor, f.stranger, 'authenticated', commit, [next.key, id, f.chat, f.stranger, item, 1])
    expect(denied.error).not.toBeNull()
    expect((await monitor.query('SELECT version,blob_id FROM chat.workspace_items WHERE id=$1', [item])).rows)
      .toEqual([{ version: 1, blob_id: first.blob }])
    expect((await monitor.query('SELECT * FROM chat.file_blob_uploads WHERE staging_key=$1', [next.key])).rows[0]).toEqual(before)
  }))
})
