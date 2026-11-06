import { createHash, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const bucket = 'feedback-screenshots'
const gcLock = "hashtextextended('tests:file_blob_gc',0)"
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
let db: pg.Client, collector: pg.Client, monitor: pg.Client, storage: SupabaseClient
let owner: string, path: string, paths: string[], blob: string, writerPid: number, otherPid: number

async function submit(references = [path], connection = db) {
  await connection.query('BEGIN')
  await connection.query('SET LOCAL role TO authenticated')
  await connection.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
  return connection.query(`INSERT INTO identity.feedback(user_id,content,module,app_version,platform,screenshot_paths)
    VALUES($1,'Synthetic concurrent submission','other','test','test',$2) RETURNING id,screenshot_paths`, [owner, references])
}
async function queue() {
  blob = (await db.query('SELECT chat.file_blob_for_object($1,$2) AS id', [bucket, path])).rows[0].id
  await db.query('SELECT chat.file_blob_enqueue($1)', [blob])
  await db.query("UPDATE chat.file_blob_gc SET next_attempt_at=now()-interval '1 second' WHERE blob_id=$1", [blob])
}
async function claim() {
  await collector.query('BEGIN')
  await collector.query("SELECT pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0))")
  return (await collector.query('SELECT * FROM chat.file_blob_gc_claim(500,600)')).rows
}
async function waitingOn(pid: number, pending: Promise<unknown>): Promise<string> {
  let state = 'pending'
  void pending.then(() => { state = 'settled' }, () => { state = 'failed' })
  for (;;) {
    if (state !== 'pending') return state
    const { rows } = await monitor.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])
    if (rows[0]?.wait_event_type === 'Lock') return 'locked'
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
async function bytesStillMatch(name: string) {
  const downloaded = await storage.storage.from(bucket).download(name)
  expect(downloaded.error).toBeNull()
  expect(sha(new Uint8Array(await downloaded.data!.arrayBuffer()))).toBe(sha(bytes))
}
function settled(pending: ReturnType<typeof submit>) {
  return pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  const api = new URL(process.env.GUGU_INTEGRATION_SUPABASE_URL ?? '')
  for (const address of [url, api]) if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) throw Error('Disposable loopback services required')
  storage = createClient(api.href, process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
  ;[db, collector, monitor] = Array.from({ length: 3 }, () => new pg.Client({ connectionString: url.href }))
  await Promise.all([db.connect(), collector.connect(), monitor.connect()])
  for (const connection of [db, collector]) await connection.query("SET statement_timeout='15s'")
  writerPid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  otherPid = (await collector.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
})
beforeEach(async () => {
  await monitor.query(`SELECT pg_advisory_lock(${gcLock})`)
  owner = randomUUID()
  paths = [`${owner}/a-${randomUUID()}.png`, `${owner}/b-${randomUUID()}.png`]; path = paths[0]
  await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`, [owner, `${owner}@feedback-concurrency.invalid`])
  for (const name of paths) {
    const uploaded = await storage.storage.from(bucket).upload(name, bytes, { contentType: 'image/png' })
    if (uploaded.error) throw uploaded.error
  }
  // Real bytes exist, but neither object has a blob registration yet.
  expect((await db.query('SELECT id FROM chat.file_blobs WHERE bucket_id=$1 AND object_name=ANY($2)', [bucket, paths])).rows).toEqual([])
})
afterEach(async () => {
  await monitor.query('ROLLBACK')
  // Cancel only this suite's connections if an assertion interrupted an interleaving.
  await monitor.query("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid=ANY($1) AND state='active'", [[writerPid, otherPid]])
  await Promise.all([db.query('ROLLBACK'), collector.query('ROLLBACK')])
  await db.query('RESET role')
  try {
    await db.query('DELETE FROM auth.users WHERE id=$1', [owner])
    const removed = await storage.storage.from(bucket).remove(paths)
    if (removed.error) throw removed.error
    await db.query('DELETE FROM chat.file_blobs WHERE bucket_id=$1 AND object_name=ANY($2)', [bucket, paths])
  } finally { await monitor.query(`SELECT pg_advisory_unlock(${gcLock})`) }
})
afterAll(async () => { await Promise.all([db?.end(), collector?.end(), monitor?.end()]) })

describe('feedback submission shares the byte collector protocol', () => {
  it('refuses re-reference after collection is claimed while real bytes still match, then collects them', async () => {
    await queue()
    const job = (await claim()).find((row) => row.blob_id === blob)!
    expect(job).toBeDefined()
    const pending = submit()
    const outcome = settled(pending)
    try { expect(await waitingOn(writerPid, pending)).toBe('locked') }
    finally { await collector.query('COMMIT') }
    expect((await outcome).error).toMatchObject({ code: '55000', hint: 'file_blob_deleting' })
    await db.query('ROLLBACK')
    // The worker is paused after its committed claim, before its Storage remove.
    await bytesStillMatch(path)
    expect((await db.query('SELECT id FROM identity.feedback WHERE user_id=$1', [owner])).rowCount).toBe(0)
    await expect(submit()).rejects.toMatchObject({ code: '55000', hint: 'file_blob_deleting' })
    await db.query('ROLLBACK')
    const removed = await storage.storage.from(bucket).remove([path]); expect(removed.error).toBeNull()
    await db.query('SELECT chat.file_blob_gc_finish($1,$2)', [blob, job.claim_token])
    expect((await storage.storage.from(bucket).download(path)).error).toBeTruthy()
    expect((await db.query('SELECT id FROM chat.file_blobs WHERE id=$1', [blob])).rows).toEqual([])
  })

  it('skips a blob held by an uncommitted submission, then retains its real bytes after commit', async () => {
    await queue(); await submit()
    expect((await claim()).map((row) => row.blob_id)).not.toContain(blob)
    await collector.query('COMMIT'); await db.query('COMMIT')
    expect((await claim()).map((row) => row.blob_id)).not.toContain(blob)
    await collector.query('COMMIT')
    const { rows } = await db.query(`SELECT state, chat.file_blob_in_use(id) AS held,
      EXISTS(SELECT 1 FROM chat.file_blob_gc WHERE blob_id=b.id) AS queued FROM chat.file_blobs b WHERE id=$1`, [blob])
    expect(rows).toEqual([{ state: 'live', held: true, queued: false }])
    await bytesStillMatch(path)
  })

  it('lets two submissions first-register the same object despite a concurrent snapshot conflict', async () => {
    await submit()
    const pending = submit([path], collector), outcome = settled(pending)
    try { expect(await waitingOn(otherPid, pending)).toBe('locked') }
    finally { await db.query('COMMIT') }
    const result = await outcome
    await collector.query(result.error ? 'ROLLBACK' : 'COMMIT')
    expect(result.error).toBeUndefined()
    expect((await db.query('SELECT id FROM chat.file_blobs WHERE bucket_id=$1 AND object_name=$2', [bucket, path])).rowCount).toBe(1)
    expect((await db.query('SELECT id FROM identity.feedback WHERE user_id=$1', [owner])).rowCount).toBe(2)
    await bytesStillMatch(path)
  })

  it('first-registers opposite-order arrays with a common lock order and preserves screenshot display order', async () => {
    await monitor.query('BEGIN')
    await monitor.query('SELECT name FROM storage.objects WHERE bucket_id=$1 AND name=$2 FOR UPDATE', [bucket, paths[0]])
    const forward = submit(paths), first = settled(forward)
    let second: ReturnType<typeof settled> | undefined
    try {
      expect(await waitingOn(writerPid, forward)).toBe('locked')
      const reverse = submit([...paths].reverse(), collector); second = settled(reverse)
      expect(await waitingOn(otherPid, reverse)).toBe('locked')
      // Both writers must stop at the first sorted object. An input-order writer
      // would already hold the second object, making this NOWAIT probe fail.
      await monitor.query('SAVEPOINT probe')
      expect((await monitor.query('SELECT name FROM storage.objects WHERE bucket_id=$1 AND name=$2 FOR UPDATE NOWAIT', [bucket, paths[1]])).rowCount).toBe(1)
      await monitor.query('ROLLBACK TO SAVEPOINT probe')
    } finally { await monitor.query('ROLLBACK') }
    // Compatible metadata locks can wake both writers together. Commit whichever
    // finishes first, so the assertion does not depend on the scheduler's winner.
    const winner = await Promise.race([
      first.then(result => ({ side: 'first', result })),
      second!.then(result => ({ side: 'second', result })),
    ])
    await (winner.side === 'first' ? db : collector).query(winner.result.error ? 'ROLLBACK' : 'COMMIT')
    const remaining = await (winner.side === 'first' ? second! : first)
    await (winner.side === 'first' ? collector : db).query(remaining.error ? 'ROLLBACK' : 'COMMIT')
    const a = await first, b = await second!
    expect(a.error).toBeUndefined(); expect(b.error).toBeUndefined()
    expect(a.value!.rows[0].screenshot_paths).toEqual(paths)
    expect(b.value!.rows[0].screenshot_paths).toEqual([...paths].reverse())
    expect((await db.query('SELECT id FROM chat.file_blobs WHERE bucket_id=$1 AND object_name=ANY($2)', [bucket, paths])).rowCount).toBe(2)
    for (const name of paths) await bytesStillMatch(name)
  })
})
