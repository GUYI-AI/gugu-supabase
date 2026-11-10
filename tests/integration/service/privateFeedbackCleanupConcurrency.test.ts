import { createHash, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

const bucket = 'feedback-screenshots'
const options = { auth: { persistSession: false, autoRefreshToken: false } }
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
let db: pg.Client, monitor: pg.Client, admin: SupabaseClient, owner: SupabaseClient
let user: string, path: string, writerPid: number

beforeAll(async () => {
  const api = new URL(process.env.GUGU_INTEGRATION_SUPABASE_URL ?? '')
  const database = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  for (const url of [api, database]) if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback services required')
  admin = createClient(api.href, process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY!, options)
  ;[db, monitor] = Array.from({ length: 2 }, () => new pg.Client({ connectionString: database.href }))
  await Promise.all([db.connect(), monitor.connect()])
  await db.query("SET statement_timeout='15s'")
  const version = Number((await db.query('SHOW server_version_num')).rows[0].server_version_num)
  expect(version).toBeGreaterThanOrEqual(170000); expect(version).toBeLessThan(180000)
  writerPid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
})
beforeEach(async () => {
  await monitor.query("SELECT pg_advisory_lock(hashtextextended('tests:file_blob_gc',0))")
  const email = `${randomUUID()}@feedback-cleanup.invalid`, password = randomUUID() + randomUUID()
  const made = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (made.error) throw made.error
  user = made.data.user.id; path = `${user}/${randomUUID()}.png`
  owner = createClient(process.env.GUGU_INTEGRATION_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!, options)
  const login = await owner.auth.signInWithPassword({ email, password }); if (login.error) throw login.error
  const upload = await owner.storage.from(bucket).upload(path, bytes, { contentType: 'image/png' })
  if (upload.error) throw upload.error
})
afterEach(async () => {
  await db.query('ROLLBACK')
  try {
    await db.query('DELETE FROM auth.users WHERE id=$1', [user])
    const removed = await admin.storage.from(bucket).remove([path]); if (removed.error) throw removed.error
    await db.query('DELETE FROM chat.file_blobs WHERE bucket_id=$1 AND object_name=$2', [bucket, path])
  } finally { await monitor.query("SELECT pg_advisory_unlock(hashtextextended('tests:file_blob_gc',0))") }
})
afterAll(async () => { await Promise.all([db?.end(), monitor?.end()]) })

it.each(['COMMIT', 'ROLLBACK'])('rechecks a real owner Storage cleanup after the pending submission %s', async (completion) => {
  await db.query('BEGIN')
  await db.query('SET LOCAL role TO authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  await db.query(`INSERT INTO identity.feedback(user_id,content,module,app_version,platform,screenshot_paths)
    VALUES($1,'Synthetic cleanup race','other','test','test',$2)`, [user, [path]])
  let finished = false
  const cleanup = owner.storage.from(bucket).remove([path]).then(result => { finished = true; return result })
  let waited = false
  try {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !finished) {
      const { rows } = await monitor.query(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`, [writerPid])
      if (rows.length) { waited = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  } finally { await db.query(completion) }
  const result = await cleanup
  expect(waited).toBe(true)
  const references = (await db.query('SELECT id FROM identity.feedback WHERE user_id=$1', [user])).rowCount
  const objects = (await db.query('SELECT id FROM storage.objects WHERE bucket_id=$1 AND name=$2', [bucket, path])).rowCount
  const downloaded = await owner.storage.from(bucket).download(path)
  if (completion === 'COMMIT') {
    expect(result.error).toBeTruthy()
    expect(references).toBe(1); expect(objects).toBe(1)
    expect(downloaded.error).toBeNull()
    expect(sha(new Uint8Array(await downloaded.data!.arrayBuffer()))).toBe(sha(bytes))
    // A later retry is denied by the ordinary reference policy as well.
    const retry = await owner.storage.from(bucket).remove([path])
    expect(retry.error).toBeNull(); expect(retry.data).toEqual([])
    expect((await owner.storage.from(bucket).download(path)).error).toBeNull()
  } else {
    expect(result.error).toBeNull(); expect(result.data).toHaveLength(1)
    expect(references).toBe(0); expect(objects).toBe(0)
    expect(downloaded.error).toBeTruthy()
  }
})
