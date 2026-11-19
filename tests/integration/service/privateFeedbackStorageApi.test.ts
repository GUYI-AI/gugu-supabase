import { createHash, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'

const bucket = 'feedback-screenshots'
const options = { auth: { persistSession: false, autoRefreshToken: false } }
let db: pg.Client, admin: SupabaseClient, owner: SupabaseClient, other: SupabaseClient
const users: string[] = [], paths: string[] = []
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

beforeAll(async () => {
  const api = new URL(process.env.GUGU_INTEGRATION_SUPABASE_URL ?? '')
  const database = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  for (const url of [api, database]) if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback services required')
  db = new pg.Client({ connectionString: database.href }); await db.connect()
  admin = createClient(api.href, process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY!, options)
  const accounts: SupabaseClient[] = []
  for (let i = 0; i < 2; i++) {
    const email = `${randomUUID()}@feedback-api.invalid`, password = randomUUID() + randomUUID()
    const made = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (made.error) throw made.error
    users.push(made.data.user.id)
    const client = createClient(api.href, process.env.VITE_SUPABASE_ANON_KEY!, options)
    const login = await client.auth.signInWithPassword({ email, password }); if (login.error) throw login.error
    accounts.push(client)
    const path = `${made.data.user.id}/${randomUUID()}.png`; paths.push(path)
    const uploaded = await client.storage.from(bucket).upload(path, bytes, { contentType: 'image/png' }); if (uploaded.error) throw uploaded.error
  }
  ;[owner, other] = accounts
})
afterAll(async () => {
  // Only this fixture's bytes, users and collector registrations are removed.
  if (admin && paths.length) await admin.storage.from(bucket).remove(paths)
  if (db) {
    for (const user of users) await db.query('DELETE FROM auth.users WHERE id=$1', [user])
    await db.query('DELETE FROM chat.file_blobs WHERE bucket_id=$1 AND object_name=ANY($2)', [bucket, paths])
    await db.end()
  }
})

it('an erased account cannot list, download or sign using its unexpired token while bytes await collection', async () => {
  const path = paths[0], identity = users[0]
  const session = (await owner.auth.getSession()).data.session!
  expect(session.expires_at! * 1000).toBeGreaterThan(Date.now() + 60_000)
  const original = await owner.storage.from(bucket).download(path)
  expect(original.error).toBeNull()
  expect(sha(new Uint8Array(await original.data!.arrayBuffer()))).toBe(sha(bytes))
  expect((await owner.storage.from(bucket).list(identity)).data?.map((row) => row.name)).toContain(path.split('/')[1])
  expect((await owner.storage.from(bucket).createSignedUrl(path, 60)).error).toBeNull()
  // Account deletion runs the same erasure trigger as the product. No byte collector has run yet.
  await db.query('DELETE FROM auth.users WHERE id=$1', [identity])
  expect((await db.query('SELECT name FROM storage.objects WHERE bucket_id=$1 AND name=$2', [bucket, path])).rowCount).toBe(1)
  expect((await admin.storage.from(bucket).download(path)).error).toBeNull()
  expect((await owner.auth.getSession()).data.session!.access_token).toBe(session.access_token)
  const listing = await owner.storage.from(bucket).list(identity)
  expect(listing.error).toBeNull(); expect(listing.data).toEqual([])
  expect((await owner.storage.from(bucket).download(path)).error).toBeTruthy()
  const signed = await owner.storage.from(bucket).createSignedUrl(path, 60)
  expect(signed.error).toBeTruthy(); expect(signed.data).toBeNull()
  // A still-live account remains able to use the same API routes for its own evidence.
  expect((await other.storage.from(bucket).download(paths[1])).error).toBeNull()
  expect((await other.storage.from(bucket).list(users[1])).data).toHaveLength(1)
  expect((await other.storage.from(bucket).createSignedUrl(paths[1], 60)).error).toBeNull()
})
