import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// A host refusal the same request cannot cure ends its reader's wait: the transfer turns `failed` with the server's code.
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let db: pg.Client, owner: string, member: string, outsider: string, group: string, device: string
const value = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0].v
const admin = () => db.query('RESET ROLE')
async function user(id = owner) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function reject(sql: string, args: unknown[] = []) {
  await db.query('SAVEPOINT refused')
  try { await db.query(sql, args) } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT refused'); return error as pg.DatabaseError
  }
  throw Error('Expected a refusal')
}
async function local() {
  await user()
  const item = randomUUID()
  await db.query('SELECT chat.file_device_publish(p_item=>$1,p_chat=>$2,p_device=>$3,p_path=>$4,p_sha=>$5,p_size=>60,p_filename=>$6,p_type=>$7,p_expected=>NULL,p_project=>$8)',
    [item, group, device, 'docs/refused.pdf', randomBytes(32).toString('hex'), 'refused.pdf', 'application/pdf', 'root'])
  await admin()
  return item
}
async function request(item: string, id: string, reader = member) {
  await user(reader)
  const r = await value('SELECT chat.file_temporary_request($1,$2,$3) AS v', [{ item_id: item }, reader, id])
  await admin()
  return r
}
// The host's accept as the edge runs it: the refused statement rolls back, then the service records the refusal.
async function accept(id: string, size = 128) {
  await user()
  const error = await reject('SELECT chat.file_temporary_accept($1,$2)', [id, size])
  await admin()
  return error.hint
}
const fail = (id: string, code: string, host = owner) => value('SELECT chat.file_temporary_fail($1,$2,$3) AS v', [id, host, code])
const row = (id: string) => db.query('SELECT state,failure_code FROM chat.file_temporary_transfers WHERE id=$1', [id]).then(r => r.rows[0])
async function pending() {
  await user()
  const rows = (await db.query('SELECT v->>\'id\' AS id FROM chat.file_temporary_pending($1) v', [device])).rows.map(r => r.id)
  await admin()
  return rows
}
const limit = (settings: Record<string, unknown>) => db.query("UPDATE chat.file_transfer_limits SET settings=settings||$1 WHERE scope='global' AND scope_id='*'", [settings])

beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw Error('Temporary failure tests require an owned loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); member = randomUUID(); outsider = randomUUID(); group = randomUUID(); device = randomUUID()
  for (const id of [owner, member, outsider]) await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())", [id, id + '@refusal.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','refusal fixture',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [group, owner, member])
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'host fixture','fixture','linux')", [device, owner])
  await db.query("INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id) VALUES($1,$2,'root','fixture','/private/fixture',now(),$3)", [device, owner, group])
  const baseline = Number(await value("SELECT chat.file_transfer_usage('upload','global','*') AS v"))
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings", [{
    inventory_ready: true, storage_global_bytes: baseline + 100000, storage_account_bytes: 100, storage_group_bytes: 100000,
    download_global_bytes: 100000, download_account_bytes: 100000, download_group_bytes: 100000, upload_permit_seconds: 120,
    sign_window_seconds: 60, sign_account_count: 1000, sign_group_count: 1000, file_max_bytes: 1000, temporary_group_bytes: 100000,
  }])
})
afterEach(async () => { await db.query('ROLLBACK') })

describe('a terminal relay refusal reaches the reader', () => {
  it('fails the reader\'s own row with the code and stops offering it to the host', async () => {
    const item = await local(), id = randomUUID()
    expect(await request(item, id)).toMatchObject({ transfer_id: id, transfer_status: 'requested', failure_code: null })
    expect(await pending()).toEqual([id])
    expect(await accept(id)).toBe('file_transfer_account_storage_full')
    expect(await row(id)).toEqual({ state: 'requested', failure_code: null })
    expect(await fail(id, 'account_storage_full')).toBe(true)
    expect(await request(item, id)).toMatchObject({ status: 'ready', transfer_id: id, transfer_status: 'failed', failure_code: 'account_storage_full' })
    expect(await pending()).toEqual([])
    expect(await fail(id, 'account_storage_full')).toBe(false)
  })

  it('moves a joined reader to its own generation, which fails again, and a fresh id succeeds once the quota is freed', async () => {
    const item = await local(), first = randomUUID(), joined = randomUUID()
    expect(await request(item, first)).toMatchObject({ transfer_id: first, transfer_status: 'requested' })
    expect(await request(item, joined)).toMatchObject({ transfer_id: first, transfer_status: 'requested' })
    expect(await accept(first)).toBe('file_transfer_account_storage_full')
    await fail(first, 'account_storage_full')
    // The failed generation is not reused: the joined id starts its own, under its own id.
    expect(await request(item, joined)).toMatchObject({ transfer_id: joined, transfer_status: 'requested', failure_code: null })
    expect(await accept(joined)).toBe('file_transfer_account_storage_full')
    await fail(joined, 'account_storage_full')
    expect(await request(item, joined)).toMatchObject({ transfer_id: joined, transfer_status: 'failed', failure_code: 'account_storage_full' })
    await limit({ storage_account_bytes: 100000 })
    const fresh = randomUUID()
    expect(await request(item, fresh)).toMatchObject({ transfer_id: fresh, transfer_status: 'requested' })
    await user(); await db.query('SELECT chat.file_temporary_accept($1,128)', [fresh]); await admin()
    await db.query('SELECT chat.file_temporary_commit($1,$2,$3,128,$4)', [fresh, owner, randomBytes(32).toString('hex'), Buffer.alloc(32, 7).toString('base64')])
    expect(await request(item, fresh)).toMatchObject({ transfer_id: fresh, transfer_status: 'ready', failure_code: null })
  })

  it('lets no one but the row\'s host fail it, and no client role call the recorder', async () => {
    const item = await local(), id = randomUUID()
    await request(item, id)
    await user(member)
    expect((await reject('SELECT chat.file_temporary_accept($1,128)', [id])).hint).toBe('file_transfer_denied')
    expect((await reject('SELECT chat.file_temporary_fail($1,$2,$3)', [id, member, 'account_storage_full'])).code).toBe('42501')
    await admin()
    for (const stranger of [member, outsider]) expect(await fail(id, 'account_storage_full', stranger)).toBe(false)
    expect(await row(id)).toEqual({ state: 'requested', failure_code: null })
  })

  it('refuses transient codes, including denied, and leaves the row alone', async () => {
    const item = await local(), id = randomUUID()
    await request(item, id)
    for (const code of ['denied', 'rate_limited', 'unavailable', 'not_configured', 'paused', 'conflict', 'expired']) {
      expect((await reject('SELECT chat.file_temporary_fail($1,$2,$3)', [id, owner, code])).hint).toBe('file_transfer_invalid')
    }
    // A stale permit is refused with denied; the host retries it as before and nothing is recorded.
    await db.query("UPDATE chat.file_temporary_transfers SET created_at=now()-interval '1 hour' WHERE id=$1", [id])
    expect(await accept(id)).toBe('file_transfer_denied')
    expect(await row(id)).toEqual({ state: 'requested', failure_code: null })
  })

  it('never lets a late accept-stage failure undo a later state', async () => {
    const item = await local(), id = randomUUID()
    await limit({ storage_account_bytes: 100000 })
    await request(item, id)
    await user(); await db.query('SELECT chat.file_temporary_accept($1,128)', [id]); await admin()
    expect(await fail(id, 'account_storage_full')).toBe(false)
    expect(await row(id)).toEqual({ state: 'uploading', failure_code: null })
    await db.query('SELECT chat.file_temporary_commit($1,$2,$3,128,$4)', [id, owner, randomBytes(32).toString('hex'), Buffer.alloc(32, 7).toString('base64')])
    for (const code of ['account_storage_full', 'too_large', 'upload_changed']) expect(await fail(id, code)).toBe(false)
    expect(await row(id)).toEqual({ state: 'ready', failure_code: null })
    await db.query("UPDATE chat.file_temporary_transfers SET state='retired' WHERE id=$1", [id])
    for (const code of ['account_storage_full', 'upload_changed']) expect(await fail(id, code)).toBe(false)
    expect(await row(id)).toEqual({ state: 'retired', failure_code: null })
  })

  it('fails a commit whose ciphertext changed and leaves the ledger byte-identical', async () => {
    const item = await local(), id = randomUUID()
    await limit({ storage_account_bytes: 100000 })
    await request(item, id)
    await user(); await db.query('SELECT chat.file_temporary_accept($1,128)', [id]); await admin()
    const ledger = () => db.query('SELECT to_jsonb(v) AS v FROM chat.file_transfer_reservations v WHERE id=$1 UNION ALL SELECT to_jsonb(u) FROM chat.file_transfer_uploads u WHERE reservation_id=$1 ORDER BY 1', [id]).then(r => r.rows)
    const before = await ledger()
    expect(before.length).toBeGreaterThan(0)
    expect(await fail(id, 'too_large')).toBe(false)
    expect(await fail(id, 'upload_changed')).toBe(true)
    expect(await ledger()).toEqual(before)
    expect(await request(item, id)).toMatchObject({ transfer_status: 'failed', failure_code: 'upload_changed' })
    expect(await pending()).toEqual([])
  })

  it('keeps the code through retirement and hands the bytes to the existing collector', async () => {
    const item = await local(), id = randomUUID()
    await limit({ storage_account_bytes: 100000 })
    await request(item, id)
    await user(); await db.query('SELECT chat.file_temporary_accept($1,128)', [id]); await admin()
    await fail(id, 'upload_changed')
    const blob = await value('SELECT blob_id AS v FROM chat.file_temporary_transfers WHERE id=$1', [id])
    await db.query("UPDATE chat.file_temporary_transfers SET created_at=now()-interval '1 hour' WHERE id=$1", [id])
    expect(await value('SELECT chat.file_temporary_expire(500) AS v')).toBeGreaterThanOrEqual(1)
    expect(await row(id)).toEqual({ state: 'retired', failure_code: 'upload_changed' })
    expect(await value('SELECT count(*)::int AS v FROM chat.file_blob_gc WHERE blob_id=$1', [blob])).toBe(1)
    expect(await request(item, id)).toMatchObject({ transfer_id: id, transfer_status: 'failed', failure_code: 'upload_changed' })
  })

  it('accepts a failure code only with failed or retired', async () => {
    const item = await local(), id = randomUUID()
    await request(item, id)
    expect((await reject("UPDATE chat.file_temporary_transfers SET failure_code='too_large' WHERE id=$1", [id])).code).toBe('23514')
    expect((await reject("UPDATE chat.file_temporary_transfers SET state='failed' WHERE id=$1", [id])).code).toBe('23514')
    expect((await reject("UPDATE chat.file_temporary_transfers SET state='failed',failure_code='denied' WHERE id=$1", [id])).code).toBe('23514')
  })
})
