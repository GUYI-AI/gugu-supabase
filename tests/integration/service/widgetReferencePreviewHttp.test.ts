import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const api = process.env.GUGU_INTEGRATION_SUPABASE_URL ?? ''
const anon = process.env.VITE_SUPABASE_ANON_KEY ?? ''
const service = process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY ?? ''
const accounts: string[] = []
let db: pg.Client, group: string, owner: string, peer: string, ownerToken: string, peerToken: string
let admin: ReturnType<typeof createClient>
beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(api).hostname)) throw new Error('Owned loopback Data API required')
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Owned loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
  admin = createClient(api, service, { auth: { autoRefreshToken: false, persistSession: false } })
  const login = async () => {
    const email = randomUUID() + '@preview-fixture.invalid', password = randomUUID()
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (created.error) throw created.error
    const id = created.data.user!.id; accounts.push(id)
    const client = createClient(api, anon, { auth: { autoRefreshToken: false, persistSession: false } })
    const signed = await client.auth.signInWithPassword({ email, password })
    if (signed.error) throw signed.error
    return { id, token: signed.data.session!.access_token }
  }
  const a = await login(), b = await login()
  owner = a.id; ownerToken = a.token; peer = b.id; peerToken = b.token
  group = randomUUID()
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Reference preview HTTP fixture',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [group, owner])
})
afterAll(async () => {
  try { if (group) await db.query('DELETE FROM chat.chats WHERE id=$1', [group]) }
  finally {
    try { for (const id of accounts) { const deleted = await admin.auth.admin.deleteUser(id); if (deleted.error) throw deleted.error } }
    finally { await db?.end() }
  }
})
async function post(content: string) {
  const id = randomUUID()
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,$4,'text')", [id, group, owner, content])
  return id
}
async function read(token = ownerToken) {
  const response = await fetch(api + '/rest/v1/rpc/list_chat_previews', {
    method: 'POST',
    headers: { apikey: anon, authorization: 'Bearer ' + token, 'content-profile': 'chat', 'content-type': 'application/json' },
    body: JSON.stringify({ p_chat_ids: [group] }),
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  expect(response.status).toBe(200)
  return { data: JSON.parse(text) as Array<{ id: string; preview: string | null; preview_source: string | null }>, bytes: Buffer.byteLength(text) }
}

describe('the chat list preview RPC through the real Data API', () => {
  it('does not transfer an ordinary long reply but preserves marker-bearing source before truncation', async () => {
    const ordinary = await post('z'.repeat(120_000))
    const small = await read()
    expect(small.data[0]?.id).toBe(ordinary)
    expect(small.data[0]).toHaveProperty('preview_source')
    expect(small.data[0]?.preview?.length).toBe(100)
    expect(small.data[0]?.preview_source === null).toBe(true)
    expect(small.bytes).toBeLessThan(512)
    const source = 'x'.repeat(70000) + '\n\ngugu-widget://fixture'
    const reference = await post(source)
    const full = await read()
    expect(full.data[0]?.id).toBe(reference)
    expect(full.data[0]?.preview?.length).toBe(100)
    expect(full.data[0]?.preview_source === source).toBe(true)
  })

  it('returns no row to a signed-in non-member, skips a message deleted for the viewer and says nothing of a recalled one', async () => {
    const id = await post('gugu-widget://viewer-private')
    expect((await read(peerToken)).data).toEqual([])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [group, peer])
    expect((await read(peerToken)).data[0]?.preview_source).toBe('gugu-widget://viewer-private')
    await db.query('UPDATE chat.messages SET deleted_for_user_ids=$1::jsonb WHERE id=$2', [JSON.stringify([owner]), id])
    // Deleted for the owner: not the owner's latest message any more (20261110054000).
    expect((await read()).data.find(row => row.id === id)).toBeUndefined()
    expect((await read(peerToken)).data[0]?.preview_source).toBe('gugu-widget://viewer-private')
    await db.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1', [id])
    expect((await read(peerToken)).data[0]).toMatchObject({ id, preview: null, preview_source: null })
  })
})
