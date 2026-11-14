import { Client } from 'pg'
import { randomUUID, createHash } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let db: Client
const scalar = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0]!.v
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('tests:file_blob_gc',0))")
  // The real collector deliberately yields when another fixture holds quota.
  // Hold its existing lock here so the five-of-six assertion tests the bound.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0))")
})
afterEach(async () => { await db.query('ROLLBACK') })
const configure = (enabled: boolean, limit = 5) => scalar('SELECT chat.configure_file_blob_gc($1,$2,$3,$4) AS v',
  ['http://127.0.0.1:1/functions/v1/attachments/gc', 'synthetic-test-capability', enabled, limit])
const begin = () => scalar('SELECT chat.file_blob_gc_run_begin() AS v')
const end = (token: string) => scalar('SELECT chat.file_blob_gc_run_end($1) AS v', [token])
it('installs closed with five candidates and one consumer, without Vault access from the kick', async () => {
  expect(await scalar('SELECT chat.file_blob_gc_control_status() AS v')).toMatchObject({ enabled: false, batch_limit: 5, concurrency: 1, inflight: 0 })
  await db.query("DELETE FROM vault.secrets WHERE name IN ('attachments_gc_url','attachments_gc_key')")
  expect(await scalar('SELECT chat.file_blob_gc_kick() AS v')).toBeNull()
  expect(await begin()).toMatchObject({ acquired: false })
})
it('configures both names without returning their contents and admits one five-candidate batch only', async () => {
  const status = await configure(true)
  expect(status).toMatchObject({ configured: true, enabled: true, batch_limit: 5, concurrency: 1 })
  expect(JSON.stringify(status)).not.toContain('synthetic-test-capability')
  const user = randomUUID()
  await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [user, user+'@gc-control.invalid'])
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','GC fixture') ON CONFLICT(id) DO NOTHING", [user])
  for (let n=0; n<6; n++) {
    const digest=createHash('sha256').update(randomUUID()).digest('hex')
    const blob=await scalar('SELECT blob_id AS v FROM chat.file_blob_register($1,$2,$3,10,$4)', [user,'staging/'+user+'/'+randomUUID(),digest,'image/png'])
    await db.query('DELETE FROM chat.file_blob_uploads WHERE blob_id=$1',[blob])
    expect(await scalar('SELECT chat.file_blob_held_until($1) IS NULL AS v',[blob])).toBe(true)
    await db.query("INSERT INTO chat.file_blob_gc(blob_id,next_attempt_at) VALUES($1,now()-interval '1 second') ON CONFLICT(blob_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at",[blob])
  }
  const run = await begin()
  expect(run).toMatchObject({ acquired: true, batch_limit: 5 })
  expect(await begin()).toMatchObject({ acquired: false })
  expect(await scalar('SELECT chat.file_blob_gc_run_renew($1) AS v', [run.token])).toBe(true)
  expect((await db.query('SELECT * FROM chat.file_blob_gc_run_claim($1)', [run.token])).rows).toHaveLength(5)
  await db.query('SAVEPOINT expected')
  await expect(db.query('SELECT * FROM chat.file_blob_gc_run_claim($1)', [run.token])).rejects.toThrow('no longer permitted')
  await db.query('ROLLBACK TO SAVEPOINT expected')
  expect(await end(run.token)).toBe(true)
  expect(await begin()).toMatchObject({ acquired: false })
})
it('keeps fifty-candidate normal operation sequential and revokes an active run on disable', async () => {
  await configure(true, 50)
  const run = await begin()
  expect(await begin()).toMatchObject({ acquired: false })
  await db.query("UPDATE chat.file_blob_gc_control SET run_until=now()-interval '1 second' WHERE singleton")
  expect(await begin()).toMatchObject({ acquired: false })
  expect(await configure(false, 50)).toMatchObject({ enabled: false, inflight: 1 })
  expect(await scalar('SELECT chat.file_blob_gc_run_renew($1) AS v', [run.token])).toBe(false)
  expect(await end(run.token)).toBe(true)
  await configure(true, 50)
  const next = await begin(); await end(next.token)
  expect(await begin()).toMatchObject({ acquired: true, batch_limit: 50 })
})
it('restricts all new capabilities to the service and preserves the ten-minute cron', async () => {
  for (const signature of ['chat.file_blob_gc_control_status()', 'chat.configure_file_blob_gc(text,text,boolean,integer)',
    'chat.file_blob_gc_run_begin()', 'chat.file_blob_gc_run_renew(uuid)', 'chat.file_blob_gc_run_claim(uuid)', 'chat.file_blob_gc_run_end(uuid)']) {
    expect(await scalar("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS v", [signature])).toBe(false)
    expect(await scalar("SELECT has_function_privilege('anon',$1,'EXECUTE') AS v", [signature])).toBe(false)
    expect(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS v", [signature])).toBe(true)
  }
  expect(await scalar("SELECT schedule AS v FROM cron.job WHERE jobname='file-blob-gc-kick'")).toBe('*/10 * * * *')
})
