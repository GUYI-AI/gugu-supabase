import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const { Client } = createRequire(import.meta.url)('pg')
let db: InstanceType<typeof Client>
let alice: string
let bob: string
const bucket = 'feedback-screenshots'
async function role(user: string | null) {
  await db.query('RESET role')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify(user ? { sub: user, role: 'authenticated' } : { role: 'anon' })])
  await db.query(`SET LOCAL role TO ${user ? 'authenticated' : 'anon'}`)
}
async function admin() {
  await db.query('RESET role')
  await db.query("SELECT set_config('request.jwt.claims','{}',true)")
}
async function rejected(sql: string, args: unknown[], code: string) {
  await db.query('SAVEPOINT rejected')
  try { await expect(db.query(sql, args)).rejects.toMatchObject({ code }) }
  finally { await db.query('ROLLBACK TO SAVEPOINT rejected'); await db.query('RELEASE SAVEPOINT rejected') }
}
async function object(name: string) {
  return db.query("INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,'{\"size\":68,\"mimetype\":\"image/png\"}')", [bucket,name])
}
async function feedback(paths: string[], urls: string[] = []) {
  return db.query(`INSERT INTO identity.feedback(user_id,content,module,app_version,platform,screenshot_paths,screenshot_urls)
    VALUES($1,'Synthetic privacy test','other','test','test',$2,$3) RETURNING id`, [alice,paths,urls])
}
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Disposable loopback database required')
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN'); alice=randomUUID(); bob=randomUUID()
  for (const id of [alice,bob]) await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`, [id,`${id}@private-feedback.invalid`])
})
afterEach(async () => { await db.query('ROLLBACK') })

describe('private feedback evidence', () => {
  it('keeps its bucket private without changing shared media', async () => {
    const { rows } = await db.query("SELECT id,public,file_size_limit::int FROM storage.buckets WHERE id=ANY($1) ORDER BY id", [['chat-media',bucket]])
    expect(rows).toEqual([{id:'chat-media',public:true,file_size_limit:10485760},{id:bucket,public:false,file_size_limit:5242880}])
  })
  it('permits only the owner to upload and select; rejects anonymous and another user', async () => {
    const path=`${alice}/a.png`
    await role(alice); await object(path)
    expect((await db.query('SELECT name FROM storage.objects WHERE bucket_id=$1',[bucket])).rows).toEqual([{name:path}])
    await rejected('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)',[bucket,`${bob}/b.png`],'42501')
    await role(bob)
    expect((await db.query('SELECT name FROM storage.objects WHERE bucket_id=$1',[bucket])).rows).toEqual([])
    await role(null)
    expect((await db.query('SELECT name FROM storage.objects WHERE bucket_id=$1',[bucket])).rows).toEqual([])
  })
  it('rejects obsolete public uploads while preserving unrelated media uploads', async () => {
    await role(alice)
    await rejected('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)',['chat-media',`${alice}/feedback/a.png`],'42501')
    await db.query('INSERT INTO storage.objects(bucket_id,name) VALUES($1,$2)',['chat-media',`${alice}/moments/a.png`])
  })
  it('stores private references and protects saved evidence from orphan cleanup', async () => {
    const path=`${alice}/a.png`, orphan=`${alice}/b.png`
    await role(alice); await object(path); await object(orphan); await feedback([path])
    expect((await db.query('SELECT screenshot_paths,screenshot_urls FROM identity.feedback')).rows).toEqual([{screenshot_paths:[path],screenshot_urls:[]}])
    await db.query("SELECT set_config('storage.allow_delete_query','true',true)")
    expect((await db.query('DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2 RETURNING name',[bucket,path])).rowCount).toBe(0)
    expect((await db.query('DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2 RETURNING name',[bucket,orphan])).rowCount).toBe(1)
  })
  it('rejects public URLs, other-owner references, missing objects and duplicate references', async () => {
    await role(alice); await object(`${alice}/a.png`)
    const sql=`INSERT INTO identity.feedback(user_id,content,module,app_version,platform,screenshot_paths,screenshot_urls) VALUES($1,'test','other','test','test',$2,$3)`
    for (const [paths,urls] of [[[],['https://example.invalid/image']],[[`${bob}/a.png`],[]],[[`${alice}/missing.png`],[]],[[`${alice}/a.png`,`${alice}/a.png`],[]]]) {
      await rejected(sql,[alice,paths,urls],'22023')
    }
  })
  it('keeps migrated ownership and collection compatible with account erasure', async () => {
    const path=`${alice}/feedback/migrated.png`
    await admin(); await object(path); await feedback([path])
    await db.query('DELETE FROM auth.users WHERE id=$1',[alice])
    expect((await db.query('SELECT id FROM identity.feedback WHERE user_id=$1',[alice])).rowCount).toBe(0)
    expect((await db.query('SELECT b.id FROM chat.file_blobs b JOIN chat.file_blob_gc g ON g.blob_id=b.id WHERE b.bucket_id=$1 AND b.object_name=$2',[bucket,path])).rowCount).toBe(1)
  })
  it('retains referenced evidence in the collector and enqueues it when the feedback is deleted', async () => {
    const path=`${alice}/a.png`
    await role(alice); await object(path); const saved=await feedback([path]); await admin()
    const blob=(await db.query('SELECT chat.file_blob_for_object($1,$2) AS id',[bucket,path])).rows[0].id
    expect((await db.query('SELECT chat.file_blob_in_use($1) AS used',[blob])).rows[0].used).toBe(true)
    await db.query('DELETE FROM identity.feedback WHERE id=$1',[saved.rows[0].id])
    expect((await db.query('SELECT chat.file_blob_in_use($1) AS used',[blob])).rows[0].used).toBe(false)
    expect((await db.query('SELECT blob_id FROM chat.file_blob_gc WHERE blob_id=$1',[blob])).rowCount).toBe(1)
  })
})
