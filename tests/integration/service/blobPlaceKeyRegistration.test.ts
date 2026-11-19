// Managed registration resolves a blob by its place ('oss', '<aa>/<sha>'), never by a sha256 another bucket also holds
// (20261120110000).
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
beforeAll(async () => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('File policy tests require a disposable loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); group = randomUUID()
  await db.query('INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,\'authenticated\',\'authenticated\',$2,\'{"provider":"email"}\',\'{}\',now(),now())', [owner, owner + '@file-policy.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','place key',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [group, owner])
  const global = Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings", [{ ...settings, storage_global_bytes: global + settings.storage_global_bytes }])
})
afterEach(async () => { await db.query('ROLLBACK') })

async function upload(sha: string, bytes = 60) {
  await user(owner)
  const permit = (await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,$4) AS r', [randomUUID(), group, owner, bytes])).rows[0].r
  await service()
  const blob = (await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)', [owner, permit.staging_key, sha, bytes, 'application/octet-stream'])).rows[0]
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)', [permit.staging_key, owner])
  return blob as { blob_id: string; object_name: string; created: boolean }
}
const relayBlob = async (sha: string, bytes = 60) => (await db.query(`INSERT INTO chat.file_blobs(bucket_id,object_name,sha256,size_bytes,content_type,created_by)
  VALUES('temporary',$1,$2,$3,'application/octet-stream',$4) RETURNING id`, ['temporary/relay/' + randomUUID(), sha, bytes, owner])).rows[0].id as string

describe('managed registration by place', () => {
  it('a relay blob that claims the same sha never captures a managed upload', async () => {
    const sha = randomBytes(32).toString('hex')
    await service()
    const relay = await relayBlob(sha)
    const stored = await upload(sha)
    expect(stored.created).toBe(true)
    expect(stored.blob_id).not.toBe(relay)
    expect((await db.query('SELECT bucket_id,object_name FROM chat.file_blobs WHERE id=$1', [stored.blob_id])).rows[0])
      .toEqual({ bucket_id: 'oss', object_name: sha.slice(0, 2) + '/' + sha })
    expect((await db.query('SELECT bucket_id,sha256,size_bytes::int FROM chat.file_blobs WHERE id=$1', [relay])).rows[0])
      .toEqual({ bucket_id: 'temporary', sha256: sha, size_bytes: 60 })
  })

  it('the same bytes uploaded twice still share one managed blob', async () => {
    const sha = randomBytes(32).toString('hex')
    const first = await upload(sha), second = await upload(sha)
    expect(first.created).toBe(true)
    expect(second).toMatchObject({ blob_id: first.blob_id, created: false })
    expect((await db.query("SELECT count(*)::int AS n FROM chat.file_blobs WHERE bucket_id='oss' AND sha256=$1", [sha])).rows[0].n).toBe(1)
  })
})
