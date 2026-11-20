// Direct upload to the owned final object 'u/<account>/<sha256>' (20261120140000): issue, stored, in progress, cleanup.
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
let owner: string, other: string, group: string, elsewhere: string
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
  owner = randomUUID(); other = randomUUID(); group = randomUUID(); elsewhere = randomUUID()
  for (const id of [owner, other]) {
    await db.query('INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,\'authenticated\',\'authenticated\',$2,\'{"provider":"email"}\',\'{}\',now(),now())', [id, id + '@file-policy.invalid'])
  }
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','direct',$2),($3,'group','not mine',$4)", [group, owner, elsewhere, other])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($4,$3,'owner')", [group, owner, other, elsewhere])
  const global = Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings", [{ ...settings, storage_global_bytes: global + settings.storage_global_bytes }])
})
afterEach(async () => { await db.query('ROLLBACK') })

const ISSUE = 'SELECT chat.file_managed_upload_direct_as($1,$2,$3,$4,$5,$6) AS r'
async function issue(sha: string, account = owner, bytes = 60, id = randomUUID()) {
  await user(account)
  const r = (await db.query(ISSUE, [id, group, account, bytes, 'application/octet-stream', sha])).rows[0].r
  await service()
  return { ...r, id }
}
async function register(key: string, sha: string, account = owner, bytes = 60) {
  const blob = (await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)', [account, key, sha, bytes, 'application/octet-stream'])).rows[0]
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)', [key, account])
  return blob as { blob_id: string; object_name: string; created: boolean }
}
const usage = async (account = owner) => Number((await db.query("SELECT chat.file_transfer_usage('upload','account',$1) AS n", [account])).rows[0].n)
const sha = () => randomBytes(32).toString('hex')

describe('direct upload', () => {
  it('issues a 1x permit for the owned final object and registers it there, settled', async () => {
    const digest = sha(), before = await usage()
    const permit = await issue(digest)
    expect(permit).toMatchObject({ status: 'upload', staging_key: 'direct/' + owner + '/' + permit.id, object_key: 'u/' + owner + '/' + digest, max_bytes: 60 })
    expect(await usage()).toBe(before + 60)
    const blob = await register(permit.staging_key, digest)
    expect(blob.object_name).toBe('u/' + owner + '/' + digest)
    expect((await db.query('SELECT r.state FROM chat.file_transfer_reservations r WHERE r.id=$1', [permit.id])).rows[0].state).toBe('settled')
    expect(await usage()).toBe(before + 60)
  })

  it('answers stored for bytes this account already keeps, with a receipt and no reservation', async () => {
    const digest = sha()
    const first = await issue(digest)
    const blob = await register(first.staging_key, digest)
    const before = await usage()
    const again = await issue(digest)
    expect(again).toEqual({ status: 'stored', staging_key: 'direct/' + owner + '/' + again.id, id: again.id })
    expect((await db.query('SELECT blob_id FROM chat.file_blob_uploads WHERE staging_key=$1', [again.staging_key])).rows[0].blob_id).toBe(blob.blob_id)
    expect((await db.query('SELECT count(*)::int AS n FROM chat.file_transfer_reservations WHERE id=$1', [again.id])).rows[0].n).toBe(0)
    expect((await db.query('SELECT count(*)::int AS n FROM chat.file_transfer_uploads WHERE staging_key=$1', [again.staging_key])).rows[0].n).toBe(0)
    expect(await usage()).toBe(before)
    // A repeated request answers the same.
    expect(await issue(digest, owner, 60, again.id)).toEqual({ status: 'stored', staging_key: again.staging_key, id: again.id })
  })

  it('gives another account the same bytes as its own object', async () => {
    const digest = sha()
    await register((await issue(digest)).staging_key, digest)
    const theirs = await issue(digest, other)
    expect(theirs).toMatchObject({ status: 'upload', object_key: 'u/' + other + '/' + digest })
    const blob = await register(theirs.staging_key, digest, other)
    expect(blob.object_name).toBe('u/' + other + '/' + digest)
    expect((await db.query("SELECT count(*)::int AS n FROM chat.file_blobs WHERE bucket_id='oss' AND sha256=$1", [digest])).rows[0].n).toBe(2)
  })

  it('refuses a second open permit for the same object until the first resolves', async () => {
    const digest = sha()
    const first = await issue(digest)
    await user(owner)
    const error = await reject(ISSUE, [randomUUID(), group, owner, 60, 'application/octet-stream', digest])
    await service()
    expect(error.hint).toBe('file_transfer_upload_in_progress')
    expect(Number.isNaN(Date.parse(error.detail ?? ''))).toBe(false)
    // Past its release time the abandoned permit is claimed for cleanup; once recorded, a new permit is issued.
    await db.query("UPDATE chat.file_transfer_reservations SET release_at=now()-interval '1 second' WHERE id=$1", [first.id])
    const claimed = (await db.query('SELECT * FROM chat.file_upload_cleanup_claim(50,true)')).rows.filter(r => r.staging_key === first.staging_key)
    expect(claimed).toEqual([{ staging_key: first.staging_key, kind: 'abandoned', copy_key: 'u/' + owner + '/' + digest, upload_id: null,
      object_owned: false, blob_object: null, blob_size: null }])
    await user(owner)
    expect((await reject(ISSUE, [randomUUID(), group, owner, 60, 'application/octet-stream', digest])).hint).toBe('file_transfer_upload_in_progress')
    await service()
    await db.query("SELECT chat.file_upload_cleanup_done($1,'abandoned:object-deleted')", [first.staging_key])
    expect((await db.query('SELECT staging_deleted,close_evidence FROM chat.file_transfer_uploads WHERE staging_key=$1', [first.staging_key])).rows[0])
      .toEqual({ staging_deleted: true, close_evidence: 'abandoned:object-deleted' })
    expect((await issue(digest)).status).toBe('upload')
  })

  it('holds a staging-path registration of the same object until an unresolved direct permit resolves', async () => {
    const digest = sha()
    const direct = await issue(digest)
    await db.query("UPDATE chat.file_transfer_reservations SET release_at=now()-interval '1 second' WHERE id=$1", [direct.id])
    expect((await db.query('SELECT * FROM chat.file_upload_cleanup_claim(50,true)')).rows.some(r => r.staging_key === direct.staging_key)).toBe(true)
    // An older client of the same account registers the same bytes through staging while the cleanup is deleting.
    await user(owner)
    const legacy = (await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,$4) AS r', [randomUUID(), group, owner, 60])).rows[0].r.staging_key
    await service()
    const refused = await reject('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)', [owner, legacy, digest, 60, 'application/octet-stream'])
    expect(refused.hint).toBe('file_transfer_upload_in_progress')
    expect((await db.query("SELECT count(*)::int AS n FROM chat.file_blobs WHERE bucket_id='oss' AND object_name=$1", ['u/' + owner + '/' + digest])).rows[0].n).toBe(0)
    await db.query("SELECT chat.file_upload_cleanup_done($1,'abandoned:object-deleted')", [direct.staging_key])
    const blob = await register(legacy, digest)
    expect(blob).toMatchObject({ object_name: 'u/' + owner + '/' + digest, created: true })
  })

  it('admits a stored key only where its actor may write', async () => {
    const digest = sha()
    await register((await issue(digest)).staging_key, digest)
    const stored = await issue(digest)
    expect(stored.status).toBe('stored')
    await user(owner)
    await db.query('SELECT chat.file_managed_upload_scope($1,$2,$3)', [stored.staging_key, owner, group])
    expect((await reject('SELECT chat.file_managed_upload_scope($1,$2,$3)', [stored.staging_key, owner, elsewhere])).hint).toBeTruthy()
    await user(other)
    expect((await reject('SELECT chat.file_managed_upload_scope($1,$2,$3)', [stored.staging_key, other, group])).hint).toBe('file_transfer_denied')
    await service()
  })

  it('keeps legacy managed rows updatable', async () => {
    const digest = sha()
    // A row from before owned names (inserting one is refused now, so as a restore would).
    await db.query('SET LOCAL session_replication_role = replica')
    const id = (await db.query("INSERT INTO chat.file_blobs(bucket_id,object_name,sha256,size_bytes,content_type) VALUES('oss',$1,$2,1,'image/png') RETURNING id",
      [digest.slice(0, 2) + '/' + digest, digest])).rows[0].id
    await db.query('SET LOCAL session_replication_role = origin')
    await db.query('UPDATE chat.file_blobs SET width=2,height=3 WHERE id=$1', [id])
    await db.query("UPDATE chat.file_blobs SET state='deleting' WHERE id=$1", [id])
    expect((await db.query('SELECT width,state FROM chat.file_blobs WHERE id=$1', [id])).rows[0]).toEqual({ width: 2, state: 'deleting' })
  })

  it('registers an owned row beside a legacy row of the same sha', async () => {
    const digest = sha()
    await db.query('SET LOCAL session_replication_role = replica')
    await db.query("INSERT INTO chat.file_blobs(bucket_id,object_name,sha256,size_bytes,content_type) VALUES('oss',$1,$2,60,'application/octet-stream')",
      [digest.slice(0, 2) + '/' + digest, digest])
    await db.query('SET LOCAL session_replication_role = origin')
    // The upsert's proposed row is always the owned name, so the insert trigger passes and the legacy row is never taken.
    const blob = await register((await issue(digest)).staging_key, digest)
    expect(blob).toMatchObject({ object_name: 'u/' + owner + '/' + digest, created: true })
    expect((await db.query("SELECT count(*)::int AS n FROM chat.file_blobs WHERE bucket_id='oss' AND sha256=$1", [digest])).rows[0].n).toBe(2)
  })

  it('freezes legacy managed names for new rows', async () => {
    const digest = sha()
    expect((await reject("INSERT INTO chat.file_blobs(bucket_id,object_name,sha256,size_bytes,content_type) VALUES('oss',$1,$2,1,'text/plain')",
      [digest.slice(0, 2) + '/' + digest, digest])).constraint).toBe('file_blobs_oss_owned')
  })
})
