// An upload reservation stops counting at its release time (20261119160000): expiry plus three sourced write bounds.
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const bounds = { upload_edge_seconds: 400, upload_sign_seconds: 900, upload_inflight_seconds: 600 }
const settings = {
  inventory_ready: true,
  storage_global_bytes: 1000, storage_account_bytes: 800, storage_group_bytes: 700,
  download_global_bytes: 1000, download_account_bytes: 800, download_group_bytes: 700,
  upload_permit_seconds: 120, ...bounds,
  sign_window_seconds: 60, sign_account_count: 100, sign_group_count: 100,
  file_max_bytes: 600,
}
let db: pg.Client
let owner: string, group: string
async function user(id: string) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function service() { await db.query('RESET ROLE') }
async function reject(sql: string, args: unknown[] = []) {
  await db.query('SAVEPOINT denied')
  try { await db.query(sql, args) } catch (e) {
    await db.query('ROLLBACK TO SAVEPOINT denied')
    return e as pg.DatabaseError
  }
  throw new Error('Expected rejection: ' + sql)
}
beforeAll(async () => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('File policy tests require a disposable loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); group = randomUUID()
  await db.query('INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,\'authenticated\',\'authenticated\',$2,\'{"provider":"email"}\',\'{}\',now(),now())', [owner, owner + '@file-policy.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','upload release',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [group, owner])
  const global = Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings", [{ ...settings, storage_global_bytes: global + settings.storage_global_bytes }])
})
afterEach(async () => { await db.query('ROLLBACK') })

const ISSUE = 'SELECT chat.file_managed_upload_as($1,$2,$3,$4) AS r'
async function issue(bytes = 60) {
  const id = randomUUID()
  await user(owner)
  const permit = (await db.query(ISSUE, [id, group, owner, bytes])).rows[0].r
  await service()
  return { id, key: permit.staging_key as string }
}
const usage = async () => Number((await db.query("SELECT chat.file_transfer_usage('upload','account',$1) AS n", [owner])).rows[0].n)
const reservation = async (id: string) => (await db.query(
  "SELECT state,expires_at,release_at,extract(epoch FROM release_at-expires_at)::int AS bound FROM chat.file_transfer_reservations WHERE id=$1", [id])).rows[0]

describe('upload reservation release', () => {
  it('writes the release time at issue from the three bounds', async () => {
    const { id } = await issue()
    const r = await reservation(id)
    expect(r.state).toBe('issued')
    expect(r.bound).toBe(400 + 900 + 600)
  })

  for (const key of Object.keys(bounds)) {
    it(`refuses to issue without ${key} and creates no reservation`, async () => {
      await db.query("UPDATE chat.file_transfer_limits SET settings=settings-$1::text WHERE scope='global' AND scope_id='*'", [key])
      const id = randomUUID()
      await user(owner)
      const error = await reject(ISSUE, [id, group, owner, 60])
      await service()
      expect(error.hint).toBe('file_transfer_not_configured')
      expect(error.message).toContain(key)
      expect((await db.query('SELECT 1 FROM chat.file_transfer_reservations WHERE id=$1', [id])).rowCount).toBe(0)
    })
  }

  it('counts an abandoned upload until its release time and nothing after, with no job', async () => {
    const before = await usage()
    const { id } = await issue()
    expect(await usage()).toBe(before + 120)
    // Expired but not yet released: a late signed write is still possible, so the hold stays.
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE id=$1", [id])
    expect(await usage()).toBe(before + 120)
    await db.query("UPDATE chat.file_transfer_reservations SET release_at=now()-interval '1 second' WHERE id=$1", [id])
    expect(await usage()).toBe(before)
    expect((await reservation(id)).state).toBe('issued')
  })

  it('moves the release time forward with a multipart permit extension and never back', async () => {
    const { id, key } = await issue()
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()+interval '5 seconds',release_at=now()+interval '1905 seconds' WHERE id=$1", [id])
    const first = await reservation(id)
    expect(first.bound).toBe(1900)
    await db.query('SELECT chat.file_managed_upload_parts($1,$2,$3,$4)', [key, owner, 'U1', [1]])
    const extended = await reservation(id)
    expect(extended.expires_at.getTime()).toBeGreaterThan(first.expires_at.getTime())
    expect(extended.bound).toBe(1900)
    // Still counted past the old release time, up to the new one.
    const before = await usage()
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=expires_at-interval '1 minute' WHERE id=$1", [id])
    expect((await reservation(id)).release_at).toEqual(extended.release_at)
    expect(await usage()).toBe(before)
  })

  async function register(key: string, digest: string, bytes = 60) {
    await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)', [owner, key, digest, bytes, 'application/octet-stream'])
    await db.query('SELECT chat.file_managed_upload_registered($1,$2)', [key, owner])
  }
  const ledger = async (key: string) => (await db.query(`SELECT r.state,r.actual_bytes::int,u.close_evidence,u.blob_id,u.staging_deleted
    FROM chat.file_transfer_uploads u JOIN chat.file_transfer_reservations r ON r.id=u.reservation_id WHERE u.staging_key=$1`, [key])).rows[0]

  it('settles a completed upload in its registration: usage grows by the stored bytes once', async () => {
    const before = await usage()
    const { key } = await issue()
    await register(key, randomBytes(32).toString('hex'), 50)
    const row = await ledger(key)
    expect(row).toMatchObject({ state: 'settled', actual_bytes: 50, close_evidence: 'registered:' + row.blob_id, staging_deleted: false })
    expect(await usage()).toBe(before + 50)
    // A replayed registration changes nothing.
    await db.query('SELECT chat.file_managed_upload_registered($1,$2)', [key, owner])
    expect(await ledger(key)).toEqual(row)
    expect(await usage()).toBe(before + 50)
    // The confirmed staging deletion keeps the registration as the evidence; the same id stays refused.
    await db.query("SELECT chat.file_managed_upload_closed($1,'staging-absent')", [key])
    expect(await ledger(key)).toEqual({ ...row, staging_deleted: true })
    await user(owner)
    expect((await reject(ISSUE, [(await db.query('SELECT reservation_id FROM chat.file_transfer_uploads WHERE staging_key=$1', [key])).rows[0].reservation_id, group, owner, 60])).hint).toBe('file_transfer_expired')
    await service()
  })

  it('adds nothing for the same bytes uploaded a second time', async () => {
    const digest = randomBytes(32).toString('hex')
    await register((await issue()).key, digest, 40)
    const before = await usage()
    const second = await issue()
    await register(second.key, digest, 40)
    expect((await ledger(second.key)).state).toBe('settled')
    expect(await usage()).toBe(before)
  })

  it('collects old community staging only once its hold no longer counts', async () => {
    const live = await issue(), released = await issue(), untracked = `staging/${owner}/${randomUUID()}`
    for (const name of [live.key, released.key, untracked]) {
      await db.query("INSERT INTO storage.objects(bucket_id,name,owner_id,created_at) VALUES('chat-media',$1,$2,now()-interval '2 days')", [name, owner])
    }
    // A multipart permit extended past a day keeps its staging while its hold counts.
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()+interval '1 hour' WHERE id=$1", [live.id])
    await db.query("UPDATE chat.file_transfer_reservations SET release_at=now()-interval '1 second' WHERE id=$1", [released.id])
    const names = (await db.query("SELECT name FROM chat.attachment_expired_staging('chat-media')")).rows.map(r => r.name)
    expect(names).toContain(released.key)
    expect(names).toContain(untracked)
    expect(names).not.toContain(live.key)
  })
})
