import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const bucket = 'feedback-screenshots'
const gcLock = "hashtextextended('tests:file_blob_gc',0)"
let db: pg.Client, collector: pg.Client, monitor: pg.Client
let owner: string, path: string, blob: string

async function submit() {
  await db.query('BEGIN')
  await db.query('SET LOCAL role TO authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
  return db.query(`INSERT INTO identity.feedback(user_id,content,module,app_version,platform,screenshot_paths)
    VALUES($1,'Synthetic concurrent submission','other','test','test',$2) RETURNING id`, [owner, [path]])
}
async function claim() {
  await collector.query('BEGIN')
  // Wait for unrelated quota work, rather than treating its advisory lock as an empty queue.
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

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  ;[db, collector, monitor] = Array.from({ length: 3 }, () => new pg.Client({ connectionString: url.href }))
  await Promise.all([db.connect(), collector.connect(), monitor.connect()])
  for (const connection of [db, collector]) await connection.query("SET statement_timeout='15s'")
})
beforeEach(async () => {
  // Committed due jobs exist only while this suite holds the shared GC test mutex.
  await monitor.query(`SELECT pg_advisory_lock(${gcLock})`)
  owner = randomUUID(); path = `${owner}/${randomUUID()}.png`
  await db.query('BEGIN')
  await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`, [owner, `${owner}@feedback-concurrency.invalid`])
  await db.query(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES($1,$2,'{"size":68,"mimetype":"image/png"}')`, [bucket, path])
  blob = (await db.query('SELECT chat.file_blob_for_object($1,$2) AS id', [bucket, path])).rows[0].id
  await db.query('SELECT chat.file_blob_enqueue($1)', [blob])
  await db.query("UPDATE chat.file_blob_gc SET next_attempt_at=now()-interval '1 second' WHERE blob_id=$1", [blob])
  await db.query('COMMIT')
})
afterEach(async () => {
  // Release the collector first so an assertion failure cannot leave submit() waiting on it.
  await collector.query('ROLLBACK')
  await db.query('ROLLBACK')
  await db.query('RESET role')
  await db.query('DELETE FROM auth.users WHERE id=$1', [owner])
  await db.query('DELETE FROM chat.file_blobs WHERE id=$1', [blob])
  await db.query("SELECT set_config('storage.allow_delete_query','true',false)")
  await db.query('DELETE FROM storage.objects WHERE bucket_id=$1 AND name=$2', [bucket, path])
  await monitor.query(`SELECT pg_advisory_unlock(${gcLock})`)
})
afterAll(async () => { await Promise.all([db?.end(), collector?.end(), monitor?.end()]) })

describe('feedback submission shares the byte collector protocol', () => {
  it('waits behind an uncommitted collection claim, then refuses re-reference before byte deletion', async () => {
    expect((await claim()).map((row) => row.blob_id)).toContain(blob)
    const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const pending = submit()
    const outcome = pending.then(() => ({ code: 'ok', hint: '' }), (error: { code: string; hint: string }) => error)
    try {
      expect(await waitingOn(pid, pending)).toBe('locked')
    } finally { await collector.query('COMMIT') }
    expect(await outcome).toMatchObject({ code: '55000', hint: 'file_blob_deleting' })
    await db.query('ROLLBACK')
    expect((await db.query('SELECT name FROM storage.objects WHERE bucket_id=$1 AND name=$2', [bucket, path])).rowCount).toBe(1)
    expect((await db.query('SELECT id FROM identity.feedback WHERE user_id=$1', [owner])).rowCount).toBe(0)
    // Repeating after the committed claim is also denied, including collector retries.
    await expect(submit()).rejects.toMatchObject({ code: '55000', hint: 'file_blob_deleting' })
  })

  it('skips a blob held by an uncommitted submission, then retains it after submission commits', async () => {
    await submit()
    expect((await claim()).map((row) => row.blob_id)).not.toContain(blob)
    await collector.query('COMMIT')
    await db.query('COMMIT')
    expect((await claim()).map((row) => row.blob_id)).not.toContain(blob)
    await collector.query('COMMIT')
    const { rows } = await db.query(`SELECT state, chat.file_blob_in_use(id) AS held,
      EXISTS(SELECT 1 FROM chat.file_blob_gc WHERE blob_id=b.id) AS queued FROM chat.file_blobs b WHERE id=$1`, [blob])
    expect(rows).toEqual([{ state: 'live', held: true, queued: false }])
  })
})
