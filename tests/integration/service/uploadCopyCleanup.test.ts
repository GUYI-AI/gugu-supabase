// Upload copies the attachments GC removes from the ledger (20261120190000): abandoned, registered and orphaned copies.
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const settings = {
  inventory_ready: true,
  storage_global_bytes: 100000, storage_account_bytes: 100000, storage_group_bytes: 100000,
  download_global_bytes: 100000, download_account_bytes: 100000, download_group_bytes: 100000,
  upload_permit_seconds: 120, upload_edge_seconds: 400, upload_sign_seconds: 900, upload_inflight_seconds: 600,
  sign_window_seconds: 60, sign_account_count: 100, sign_group_count: 100, file_max_bytes: 1000,
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
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','copies',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [group, owner])
  const global = Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings", [{ ...settings, storage_global_bytes: global + settings.storage_global_bytes }])
  // Only this test's rows are candidates.
  await db.query("UPDATE chat.file_transfer_uploads SET staging_deleted=true WHERE NOT staging_deleted")
})
afterEach(async () => { await db.query('ROLLBACK') })

const sha = () => randomBytes(32).toString('hex')
async function staging(bytes = 60) {
  const id = randomUUID()
  await user(owner)
  const key = (await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,$4) AS r', [id, group, owner, bytes])).rows[0].r.staging_key as string
  await service()
  return { key, id }
}
async function registerStaging(key: string, digest = sha(), bytes = 60) {
  const blob = (await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)', [owner, key, digest, bytes, 'application/octet-stream'])).rows[0]
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)', [key, owner])
  return blob as { blob_id: string; object_name: string }
}
const expire = (id: string) => db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE id=$1", [id])
const release = (id: string) => db.query("UPDATE chat.file_transfer_reservations SET release_at=now()-interval '1 second' WHERE id=$1", [id])
const claim = async (limit = 50, registered = true) => (await db.query('SELECT * FROM chat.file_upload_cleanup_claim($1,$2)', [limit, registered])).rows
const audit = async (after: string | null = null, limit = 50) => (await db.query('SELECT * FROM chat.file_upload_cleanup_audit($1,$2)', [after, limit])).rows
const ledger = async (key: string) => (await db.query('SELECT staging_deleted,close_evidence FROM chat.file_transfer_uploads WHERE staging_key=$1', [key])).rows[0]

describe('upload copy cleanup', () => {
  it('hands a registered staging copy over only after its permit expired, with the object to verify it against', async () => {
    const up = await staging()
    const blob = await registerStaging(up.key)
    expect(await claim()).toEqual([])
    await expire(up.id)
    expect(await claim()).toEqual([{ staging_key: up.key, kind: 'registered', copy_key: up.key, upload_id: null, object_owned: false,
      blob_object: blob.object_name, blob_size: '60' }])
    // A store that cannot verify a copy is never handed one.
    await db.query('UPDATE chat.file_transfer_uploads SET cleanup_tried_at=NULL WHERE staging_key=$1', [up.key])
    expect(await claim(50, false)).toEqual([])
    await db.query("SELECT chat.file_upload_cleanup_done($1,'copy:verified-deleted')", [up.key])
    expect(await ledger(up.key)).toEqual({ staging_deleted: true, close_evidence: 'registered:' + blob.blob_id })
    expect(await claim()).toEqual([])
  })

  it('hands an abandoned staging copy over once its hold is released', async () => {
    const up = await staging()
    expect(await claim()).toEqual([])
    await release(up.id)
    expect(await claim()).toEqual([{ staging_key: up.key, kind: 'abandoned', copy_key: up.key, upload_id: null, object_owned: false,
      blob_object: null, blob_size: null }])
    await db.query("SELECT chat.file_upload_cleanup_done($1,'abandoned:staging-deleted')", [up.key])
    expect(await ledger(up.key)).toEqual({ staging_deleted: true, close_evidence: 'abandoned:staging-deleted' })
  })

  it('hands over the staging copy of a blob collected since its registration', async () => {
    const up = await staging()
    const blob = await registerStaging(up.key)
    await expire(up.id)
    // Collected as GC would: its upload receipt is gone first, then the blob row.
    await db.query('DELETE FROM chat.file_blob_uploads WHERE blob_id=$1', [blob.blob_id])
    await db.query('DELETE FROM chat.file_blobs WHERE id=$1', [blob.blob_id])
    expect(await claim()).toEqual([{ staging_key: up.key, kind: 'orphaned', copy_key: up.key, upload_id: null, object_owned: false,
      blob_object: null, blob_size: null }])
  })

  it('claims a kept copy again only after every other candidate', async () => {
    const a = await staging(), b = await staging()
    await release(a.id); await release(b.id)
    const [first] = await claim(1)
    const [second] = await claim(1)
    expect(second.staging_key).not.toBe(first.staging_key)
    expect((await claim(1))[0].staging_key).toBe(first.staging_key)
  })

  it('lists the same candidates read-only, in key order, page by page', async () => {
    const keys = []
    for (let i = 0; i < 3; i++) { const up = await staging(); await release(up.id); keys.push(up.key) }
    keys.sort()
    const page = await audit(null, 2)
    expect(page.map(r => r.staging_key)).toEqual(keys.slice(0, 2))
    expect((await audit(page[1].staging_key, 2)).map(r => r.staging_key)).toEqual(keys.slice(2))
    expect((await db.query('SELECT count(*)::int AS n FROM chat.file_transfer_uploads WHERE cleanup_tried_at IS NOT NULL AND staging_key = ANY($1)', [keys])).rows[0].n).toBe(0)
  })

  it('records only a known outcome, once, and only for the service', async () => {
    const up = await staging()
    await release(up.id)
    expect((await reject("SELECT chat.file_upload_cleanup_done($1,'gone')", [up.key])).message).toBe('Invalid upload cleanup evidence')
    await db.query("SELECT chat.file_upload_cleanup_done($1,'abandoned:staging-deleted')", [up.key])
    expect((await reject("SELECT chat.file_upload_cleanup_done($1,'abandoned:staging-deleted')", [up.key])).message).toMatch(/not pending/)
    await user(owner)
    for (const sql of ['SELECT * FROM chat.file_upload_cleanup_claim(50,true)', 'SELECT * FROM chat.file_upload_cleanup_audit(NULL,50)']) {
      expect((await reject(sql)).code).toBe('42501')
    }
    await service()
  })
})
