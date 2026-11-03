import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = (process.env.GUGU_INTEGRATION_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim()
const service = (process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
const anon = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim()
const run = randomUUID(), device = `archive-${run}`, agent = randomUUID(), dm = randomUUID()
const rooms = Array.from({ length: 3 }, randomUUID)
const password = 'Archive-fixture-pw1' // gitleaks:allow -- disposable loopback Auth fixture
let admin: SupabaseClient, owner: SupabaseClient, stranger: SupabaseClient
let ownerId = '', strangerId = ''
async function must<T>(request: PromiseLike<unknown>): Promise<T> {
  const result = await request as { data: T; error: { message: string } | null }
  if (result.error) throw new Error(result.error.message)
  return result.data
}
beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Archive REST test requires loopback Supabase')
  if (!service || !anon) throw new Error('Loopback service and anon credentials are required')
  admin = createClient(url, service, { auth: { persistSession: false } })
  const accounts: SupabaseClient[] = []
  for (const label of ['owner', 'stranger']) {
    const email = `${run}-${label}@archive.invalid`
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (created.error) throw new Error(created.error.message)
    if (label === 'owner') ownerId = created.data.user.id; else strangerId = created.data.user.id
    const client = createClient(url, anon, { auth: { persistSession: false } })
    const signed = await client.auth.signInWithPassword({ email, password })
    if (signed.error) throw new Error(signed.error.message)
    accounts.push(client)
  }
  ;[owner, stranger] = accounts
  await must(admin.schema('identity').from('gugu_devices').insert({ device_id: device, user_id: ownerId, label: 'archive', hostname: 'fixture', platform: 'linux' }))
  await must(admin.schema('identity').from('users').insert({ id: agent, type: 'agent', display_name: 'Archive REST fixture', owner_user_id: ownerId, device_id: device, agent_public: true }))
  for (const id of rooms) {
    await must(owner.schema('chat').rpc('create_gugu_group', { p_chat_id: id, p_name: 'Archive REST fixture', p_owner_user_id: ownerId, p_initial_members: [] }))
    await must(owner.schema('chat').rpc('add_group_agent', { p_chat_id: id, p_agent_user_id: agent, p_message: null, p_as_user_id: ownerId }))
  }
  await must(admin.schema('chat').from('chats').insert({ id: dm, kind: 'dm', creator_user_id: ownerId }))
  await must(admin.schema('chat').from('chat_members').insert([{ chat_id: dm, user_id: ownerId, role: 'owner' }, { chat_id: dm, user_id: agent, role: 'member' }]))
  await must(owner.schema('chat').from('messages').insert({ id: randomUUID(), chat_id: dm, sender_user_id: agent, content: 'Historical sender survives' }))
}, 60_000)
afterAll(async () => {
  if (!admin) return
  // Only this disposable fixture's exact IDs. No shared account data is used.
  const errors: string[] = []
  for (const id of [...rooms, dm]) {
    const result = await admin.schema('chat').from('chats').delete().eq('id', id)
    if (result.error) errors.push(result.error.message)
  }
  const removed = await admin.schema('identity').from('users').delete().eq('id', agent)
  if (removed.error) errors.push(removed.error.message)
  const dropped = await admin.schema('identity').from('gugu_devices').delete().eq('device_id', device)
  if (dropped.error) errors.push(dropped.error.message)
  for (const id of [ownerId, strangerId].filter(Boolean)) {
    const result = await admin.auth.admin.deleteUser(id)
    if (result.error) errors.push(result.error.message)
  }
  await owner?.removeAllChannels(); await stranger?.removeAllChannels()
  if (errors.length) throw new Error(`Archive fixture teardown: ${errors.join('; ')}`)
}, 60_000)

describe('archive through authenticated PostgREST and private realtime', () => {
  it('defaults true; one hint invalidates three groups, historical identity remains and old identity cannot send', async () => {
    const before = await must<unknown[]>(admin.schema('chat').from('chat_members').select('*').eq('user_id', agent).order('chat_id'))
    expect(before).toHaveLength(4)
    const noRemoval = await must<{ removed_at: null }>(owner.schema('identity').rpc('archive_user', { p_user_id: agent, p_remove_social_identity: false }))
    expect(noRemoval.removed_at).toBeNull()
    const unauthorized = await stranger.schema('identity').rpc('archive_user', { p_user_id: agent })
    expect(unauthorized.error?.code).toBe('42501')

    let eventResolve!: (value: unknown) => void
    let probeResolve!: () => void
    const probe = new Promise<void>(resolve => { probeResolve = resolve })
    const event = new Promise<unknown>(resolve => { eventResolve = resolve })
    const channel = owner.channel('gugu:identity:lifecycle', { config: { private: true } })
      .on('broadcast', { event: 'identity_removed' }, message => { if (message.payload.id === agent) eventResolve(message.payload) })
      .on('broadcast', { event: 'stream_probe' }, () => probeResolve())
    await new Promise<void>((resolve, reject) => {
      channel.subscribe(status => {
        if (status === 'SUBSCRIBED') resolve()
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(`Private identity channel: ${status}`))
      })
    })
    // A cold Realtime opens (and on a fresh database reopens) its database-broadcast
    // stream after the first join; rows written before it streams are never delivered.
    // Probe through the same database path until one arrives.
    const database = new Client({ connectionString: process.env.GUGU_INTEGRATION_DATABASE_URL })
    await database.connect()
    try {
      for (;;) {
        await database.query("SELECT realtime.send('{}'::jsonb,'stream_probe','gugu:identity:lifecycle',true)")
        if (await Promise.race([probe.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 500))])) break
      }
    } finally { await database.end() }
    try {
      const receipt = await must<{ removed_at: string }>(owner.schema('identity').rpc('archive_user', { p_user_id: agent }))
      expect(receipt.removed_at).toBeTruthy()
      expect(await event).toEqual({ id: agent, removed_at: receipt.removed_at })
      expect(await must(owner.schema('identity').rpc('archive_user', { p_user_id: agent }))).toEqual(receipt)
      expect(await must(admin.schema('chat').from('chat_members').select('*').eq('user_id', agent).order('chat_id'))).toEqual(before)
      for (const room of rooms) {
        const roster = await must<{ user_id: string }[]>(owner.schema('chat').rpc('list_member_ids', { p_chat_id: room }))
        expect(roster.map(r => r.user_id)).not.toContain(agent)
        expect(await must(owner.schema('chat').from('active_members').select('user_id').eq('chat_id', room))).toHaveLength(1)
        expect(await must(owner.schema('chat').rpc('is_addressable_in', { p_chat_id: room, p_user_id: agent }))).toBe(false)
        const sent = await owner.schema('chat').from('messages').insert({ id: randomUUID(), chat_id: room, sender_user_id: agent, content: 'Forbidden after archive' })
        expect(sent.error?.code).toBe('42501')
      }
      expect(await must(owner.schema('identity').from('active_users').select('id').eq('id', agent))).toEqual([])
      expect(await must(owner.schema('identity').from('users').select('id,removed_at').eq('id', agent))).toEqual([{ id: agent, removed_at: receipt.removed_at }])
      expect(await must(owner.schema('chat').rpc('historical_dm_peer', { p_chat_id: dm }))).toEqual([{ user_id: agent, removed_at: receipt.removed_at }])
      expect(await must(owner.schema('chat').from('messages').select('sender_user_id').eq('chat_id', dm))).toContainEqual({ sender_user_id: agent })
    } finally { await owner.removeChannel(channel) }
  })
})
