import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let db: pg.Client, owner: string, group: string
type Upload = { key: string; reservation: string; blob: string; expiry: string }
const admin = () => db.query('RESET ROLE')
const service = () => db.query('SET LOCAL ROLE service_role')
async function user() {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
}
async function reject(sql: string, args: unknown[] = []) {
  await db.query('SAVEPOINT expected_failure')
  try { await db.query(sql, args) } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT expected_failure')
    return error as pg.DatabaseError
  }
  throw Error('Expected database rejection')
}
const value = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0].v
async function upload(committed = true): Promise<Upload> {
  const reservation = randomUUID()
  await user()
  const permit = await value('SELECT chat.file_managed_upload_as($1,$2,$3,60) AS v', [reservation, group, owner])
  await admin()
  await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,60,$4)', [owner, permit.staging_key, randomBytes(32).toString('hex'), 'application/octet-stream'])
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)', [permit.staging_key, owner])
  const blob = (await db.query('SELECT blob_id FROM chat.file_transfer_uploads WHERE staging_key=$1', [permit.staging_key])).rows[0].blob_id
  if (committed) {
    await user()
    await db.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5)', [permit.staging_key, randomUUID(), group, owner, 'fixture.bin'])
    await admin()
  }
  const expiry = (await db.query("UPDATE chat.file_transfer_reservations SET expires_at=date_trunc('milliseconds',clock_timestamp())-interval '1 minute' WHERE id=$1 RETURNING expires_at", [reservation])).rows[0].expires_at.toISOString()
  return { key: permit.staging_key, reservation, blob, expiry }
}
async function evidence(u: Upload, legacy = false) {
  const at = await value("SELECT date_trunc('milliseconds',clock_timestamp()) AS v")
  return await value('SELECT chat.file_staging_cleanup_evidence($1,$2,$3,$4,$5,$6,$7,$8) AS v', [
    u.key, u.reservation, u.blob, u.expiry, at, 'a'.repeat(64), legacy ? 'b'.repeat(64) : null, legacy ? at : null,
  ])
}
const configure = (keys: string[] | null, once = true) => value('SELECT chat.configure_file_staging_cleanup(true,$1,$2) AS v', [once, keys])
const begin = () => value('SELECT chat.file_staging_cleanup_run_begin() AS v')
const claim = (run: string) => db.query('SELECT * FROM chat.file_staging_cleanup_claim($1)', [run])
const status = () => value('SELECT chat.file_staging_cleanup_status() AS v')
beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw Error('Staging cleanup requires a disposable loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); group = randomUUID()
  await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())", [owner, owner + '@staging-cleanup.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','cleanup fixture',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [group, owner])
  const baseline = Number(await value("SELECT chat.file_transfer_usage('upload','global','*') AS v"))
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings", [{
    inventory_ready: true, storage_global_bytes: baseline + 100000, storage_account_bytes: 100000, storage_group_bytes: 100000,
    download_global_bytes: 100000, download_account_bytes: 100000, download_group_bytes: 100000, upload_permit_seconds: 120,
    sign_window_seconds: 60, sign_account_count: 1000, sign_group_count: 1000, file_max_bytes: 600,
  }])
  await db.query('UPDATE chat.file_staging_cleanup_control SET enabled=false,single_batch=true,allowed_keys=NULL,run_token=NULL,run_until=NULL,run_permitted=false,run_claimed=false')
})
afterEach(async () => { await db.query('ROLLBACK') })

describe('durable committed staging cleanup', () => {
  it.each([
    { commitFirst: true, resumed: false }, { commitFirst: false, resumed: false },
    { commitFirst: true, resumed: true }, { commitFirst: false, resumed: true },
  ])('records declared publication when commitFirst=$commitFirst and resumed=$resumed', async ({ commitFirst, resumed }) => {
    const sha = randomBytes(32).toString('hex'), message = randomUUID()
    await user()
    const original = await value('SELECT chat.file_managed_upload_as($1,$2,$3,60) AS v', [randomUUID(), group, owner])
    await db.query('SELECT chat.attachment_declare($1,$2,60,$3)', [original.staging_key, sha, 'application/octet-stream'])
    const commit = async () => {
      await user()
      await db.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5)', [original.staging_key, message, group, owner, 'declared.bin'])
      await admin()
    }
    if (commitFirst) await commit()
    let permit = original
    if (resumed) {
      await user()
      permit = await value('SELECT chat.file_managed_upload_as($1,$2,$3,60) AS v', [randomUUID(), group, owner])
    }
    await admin()
    expect(await value('SELECT count(*)::int AS v FROM chat.file_staging_cleanup WHERE staging_key=$1', [permit.staging_key])).toBe(0)
    const settled = await value('SELECT chat.file_blob_settle($1,$2,$3,$4,60,$5) AS v', [owner, original.staging_key, permit.staging_key, sha, 'application/octet-stream'])
    if (!commitFirst) {
      expect(await value('SELECT count(*)::int AS v FROM chat.file_staging_cleanup WHERE staging_key=$1', [permit.staging_key])).toBe(0)
      await commit()
    }
    expect(await value('SELECT jsonb_build_object(\'blob\',registered_blob_id,\'proof\',publication_evidence) AS v FROM chat.file_staging_cleanup WHERE staging_key=$1', [permit.staging_key]))
      .toEqual({ blob: settled.blob_id, proof: 'database-commit' })
    await db.query('DELETE FROM chat.file_blob_uploads WHERE staging_key=$1', [original.staging_key])
    expect(await value('SELECT count(*)::int AS v FROM chat.file_staging_cleanup WHERE staging_key=$1', [permit.staging_key])).toBe(1)
  })
  it('defaults off and exposes counts only; API users cannot inspect queue identities or activate it', async () => {
    await service()
    expect(await status()).toMatchObject({ enabled: false, batch_limit: 5, concurrency: 1, inflight: 0 })
    expect(await begin()).toMatchObject({ admitted: false })
    expect((await reject('SELECT * FROM chat.file_staging_cleanup')).code).toBe('42501')
    await user()
    expect((await reject('SELECT chat.file_staging_cleanup_status()')).code).toBe('42501')
    expect((await reject('SELECT chat.configure_file_staging_cleanup(true,true,$1)', [[]])).code).toBe('42501')
  })
  it('records only a successful publication transaction and survives receipt sweeping', async () => {
    const u = await upload(false)
    expect(Number(await value('SELECT count(*) AS v FROM chat.file_staging_cleanup WHERE staging_key=$1', [u.key]))).toBe(0)
    await db.query('SAVEPOINT failed_publication')
    await db.query('UPDATE chat.file_blob_uploads SET message_id=$2 WHERE staging_key=$1', [u.key, randomUUID()])
    expect(Number(await value('SELECT count(*) AS v FROM chat.file_staging_cleanup WHERE staging_key=$1', [u.key]))).toBe(1)
    await db.query('ROLLBACK TO SAVEPOINT failed_publication')
    expect(Number(await value('SELECT count(*) AS v FROM chat.file_staging_cleanup WHERE staging_key=$1', [u.key]))).toBe(0)
    const committed = await upload()
    await db.query('DELETE FROM chat.file_blob_uploads WHERE staging_key=$1', [committed.key])
    expect(await value('SELECT publication_evidence AS v FROM chat.file_staging_cleanup WHERE staging_key=$1', [committed.key])).toBe('database-commit')
  })
  it('does not admit elapsed permits without terminal proof or registration-only rows without publication proof', async () => {
    const committed = await upload(), registered = await upload(false)
    await service()
    await configure([committed.key, registered.key])
    const run = await begin()
    expect((await claim(run.run_token)).rows).toHaveLength(0)
    expect((await reject('SELECT chat.file_staging_cleanup_evidence($1,$2,$3,$4,clock_timestamp(),$5)', [registered.key, registered.reservation, registered.blob, registered.expiry, 'a'.repeat(64)])).hint).toBe('file_transfer_conflict')
  })
  it('requires exact immutable evidence and supports explicitly evidenced historical publications', async () => {
    const committed = await upload(), historical = await upload(false)
    await service()
    expect(await evidence(committed)).toBe(true)
    const saved = await value('SELECT chat.file_staging_cleanup_scope_status($1) AS v', [[committed.key]])
    expect(saved).toMatchObject({ known: 1, eligible: 1, completed: 0 })
    expect((await reject('SELECT chat.file_staging_cleanup_evidence($1,$2,$3,$4,clock_timestamp(),$5)', [committed.key, committed.reservation, committed.blob, committed.expiry, 'c'.repeat(64)])).hint).toBe('file_transfer_conflict')
    expect(await evidence(historical, true)).toBe(true)
  })
  it('claims at most five once per global run, sequentially scoped and stops after the first batch', async () => {
    const uploads: Upload[] = []
    for (let n = 0; n < 7; n++) uploads.push(await upload())
    for (const u of uploads) await evidence(u)
    await service()
    expect((await reject('SELECT chat.configure_file_staging_cleanup(true,true)')).message).toContain('explicit approved scope')
    await configure(uploads.slice(0, 6).map(u => u.key))
    const run = await begin(), jobs = (await claim(run.run_token)).rows
    expect(jobs).toHaveLength(5)
    expect(jobs.every(row => uploads.slice(0, 6).some(u => u.key === row.staging_key))).toBe(true)
    expect(await begin()).toMatchObject({ admitted: false })
    expect((await reject('SELECT * FROM chat.file_staging_cleanup_claim($1)', [run.run_token])).message).toContain('not admitted')
    expect(await status()).toMatchObject({ enabled: false, single_batch: true, inflight: 1 })
  })
  it('retains capacity on failed deletion and closes the original hold only after confirmed finish', async () => {
    const u = await upload()
    await evidence(u)
    const usage = () => value("SELECT chat.file_transfer_usage('upload','account',$1) AS v", [owner]).then(Number)
    const before = await usage()
    await service(); await configure([u.key])
    let run = await begin(), job = (await claim(run.run_token)).rows[0]
    expect(await value('SELECT chat.file_staging_cleanup_fail($1,$2,$3,$4) AS v', [run.run_token, u.key, job.claim_token, 'storage_failed'])).toBe(true)
    await admin()
    expect(await usage()).toBe(before)
    expect(await value('SELECT staging_deleted AS v FROM chat.file_transfer_uploads WHERE staging_key=$1', [u.key])).toBe(false)
    expect(await value('SELECT next_attempt_at>now() AS v FROM chat.file_staging_cleanup WHERE staging_key=$1', [u.key])).toBe(true)
    await value('SELECT chat.file_staging_cleanup_run_end($1) AS v', [run.run_token])
    await db.query('UPDATE chat.file_staging_cleanup SET next_attempt_at=now() WHERE staging_key=$1', [u.key])
    await service(); await configure([u.key]); run = await begin(); job = (await claim(run.run_token)).rows[0]
    expect(job.attempt_count).toBe(2)
    expect(await value('SELECT chat.file_staging_cleanup_finish($1,$2,$3) AS v', [run.run_token, u.key, job.claim_token])).toBe(true)
    expect(await value('SELECT chat.file_staging_cleanup_finish($1,$2,$3) AS v', [run.run_token, u.key, job.claim_token])).toBe(false)
    await admin()
    expect(await usage()).toBe(before - 60)
    expect(await value('SELECT staging_deleted AS v FROM chat.file_transfer_uploads WHERE staging_key=$1', [u.key])).toBe(true)
    expect(await value('SELECT state AS v FROM chat.file_transfer_reservations WHERE id=$1', [u.reservation])).toBe('settled')
  })
  it('revokes a run without releasing storage and refuses a stale completion token', async () => {
    const u = await upload(); await evidence(u); await service(); await configure([u.key])
    const run = await begin(), job = (await claim(run.run_token)).rows[0]
    await value('SELECT chat.configure_file_staging_cleanup(false,true) AS v')
    expect(await value('SELECT chat.file_staging_cleanup_run_renew($1) AS v', [run.run_token])).toBe(false)
    expect((await reject('SELECT chat.file_staging_cleanup_finish($1,$2,$3)', [run.run_token, u.key, job.claim_token])).message).toContain('expired')
    await admin()
    expect(await value('SELECT staging_deleted AS v FROM chat.file_transfer_uploads WHERE staging_key=$1', [u.key])).toBe(false)
  })
})
