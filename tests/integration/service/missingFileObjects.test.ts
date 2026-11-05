import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let db: pg.Client, owner: string, outsider: string, group: string, message: string, object: string
beforeAll(async () => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw Error('Requires a disposable loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); outsider = randomUUID(); group = randomUUID(); message = randomUUID(); object = `${owner}/${randomUUID()}.png`
  for (const id of [owner, outsider]) await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())", [id, id + '@missing-file.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','missing file',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [group, owner])
  await db.query("INSERT INTO storage.objects(bucket_id,name,owner,owner_id,metadata) VALUES('chat-media',$1,$2::uuid,$2::text,jsonb_build_object('size',123,'mimetype','image/png'))", [object, owner])
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content_type,content,storage_bucket_id,storage_object_name) VALUES($1,$2,$3,'attachment',$4,'chat-media',$5)",
    [message, group, owner, `[附件] missing.png (image/png)\n[URL] https://fixture.invalid/storage/v1/object/public/chat-media/${object}\n[Size] 123\n[Kind] image`, object])
  await db.query("INSERT INTO chat.file_transfer_storage(bucket_id,object_name,size_bytes,state,owner_account) VALUES('chat-media',$1,123,'gone',$2)", [object, owner])
})
afterEach(async () => { await db.query('ROLLBACK') })
async function read(actor: string) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role: 'authenticated' })])
  const ref = { message_id: message }
  return {
    metadata: (await db.query('SELECT chat.file_resolve_as($1,$2) AS r', [ref, actor])).rows[0].r,
    download: (await db.query('SELECT chat.file_transfer_download_as($1,$2,$3) AS r', [ref, actor, randomUUID()])).rows[0].r,
  }
}
describe('operator-confirmed missing objects', () => {
  it('returns an explicit missing code through both entry points before reserving any download quota', async () => {
    expect(await read(owner)).toEqual({ metadata: { status: 'missing', code: 'object_not_found', sha256: null }, download: { status: 'missing', code: 'object_not_found', sha256: null } })
    await db.query('RESET ROLE')
    expect((await db.query('SELECT count(*)::int AS n FROM chat.file_transfer_reservations WHERE account_id=$1', [owner])).rows[0].n).toBe(0)
  })
  it('preserves the exact-reference ACL instead of revealing absence to a nonmember', async () => {
    expect(await read(outsider)).toEqual({ metadata: { status: 'gone' }, download: { status: 'gone' } })
  })
  it('preserves idle expiry after GC instead of classifying an expired reference as missing', async () => {
    await db.query(`INSERT INTO chat.file_transfer_storage_refs(storage_id,chat_id,account_id,expired_at)
      SELECT id,$2,$3,now() FROM chat.file_transfer_storage WHERE object_name=$1
      ON CONFLICT(storage_id,chat_id) DO UPDATE SET expired_at=excluded.expired_at`, [object, group, owner])
    const result = await read(owner)
    expect(result.metadata.status).toBe('expired'); expect(result.download.status).toBe('expired')
    expect(result.metadata.code).toBeUndefined(); expect(result.download.url).toBeUndefined()
    await db.query('RESET ROLE')
    expect((await db.query('SELECT count(*)::int AS n FROM chat.file_transfer_reservations WHERE account_id=$1', [owner])).rows[0].n).toBe(0)
    await db.query('UPDATE chat.file_transfer_storage_refs SET expired_at=NULL WHERE chat_id=$1', [group])
    expect(await read(owner)).toEqual({ metadata: { status: 'missing', code: 'object_not_found', sha256: null }, download: { status: 'missing', code: 'object_not_found', sha256: null } })
  })
  it('does not infer physical absence from an unmarked object or an in-progress deletion', async () => {
    for (const state of ['ready', 'deleting']) {
      await db.query('RESET ROLE')
      await db.query('UPDATE chat.file_transfer_storage SET state=$1 WHERE object_name=$2', [state, object])
      await db.query('SET LOCAL ROLE authenticated')
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
      expect((await db.query('SELECT chat.file_resolve_as($1,$2) AS r', [{ message_id: message }, owner])).rows[0].r.status).toBe('ready')
    }
  })
})
