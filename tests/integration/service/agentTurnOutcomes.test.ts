import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

interface Database {
  connect(): Promise<void>
  end(): Promise<void>
  query<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => Database }
let db: Database
let owner: string, otherOwner: string, chat: string, thread: string

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('agentTurnOutcomes requires the disposable loopback database')
  }
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); otherOwner = randomUUID(); chat = randomUUID(); thread = randomUUID()
  for (const id of [owner, otherOwner]) {
    await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
      confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
      VALUES ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,
      '{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`, [id, `${id}@turn-outcomes.invalid`])
    await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
      VALUES ($1,$2,'Outcome fixture','fixture','darwin')`, [`outcome-${id}`, id])
  }
})
afterEach(async () => {
  if (!db) return
  try { await db.query('RESET role'); await db.query('SET CONSTRAINTS ALL IMMEDIATE') } finally { await db.query('ROLLBACK') }
})

async function insert(agent: string, input: { id?: string; account?: string; room?: string; root?: string | null; status?: string; at?: string; reason?: string } = {}) {
  const id = input.id ?? randomUUID(), account = input.account ?? owner
  await db.query(`INSERT INTO identity.gugu_device_commands(id,user_id,device_id,type,status,payload,result,error,created_at,completed_at)
    VALUES ($1,$2,$3,'agent.deliver',$4,$5::jsonb,$6::jsonb,'weekly limit reached',$7,$7)`, [
    id, account, `outcome-${account}`, input.status ?? 'error',
    JSON.stringify({ agent_user_id: agent, chat_id: input.room ?? chat, thread_root_id: input.root ?? null, content: 'Private prompt', extra: 'Not an outcome field' }),
    JSON.stringify({ reply_notice: 'context', ...(input.reason !== undefined ? { reason: input.reason } : {}), private_trace: 'Not an outcome field' }), input.at ?? '2026-11-01T00:00:00Z',
  ])
  return id
}
async function asUser(account: string | null = owner) {
  await db.query('SET LOCAL role TO authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: account, role: 'authenticated' })])
}
type Outcome = { id: string; status: string; payload: Record<string, unknown>; result: Record<string, unknown> }
const read = async (room: string | null = chat, root: string | null = null) => (await db.query<{ value: Outcome[] }>(
  'SELECT identity.read_agent_turn_outcomes($1,$2) AS value', [room, root],
)).rows[0]!.value

describe('conversation-scoped latest agent delivery outcomes', () => {
  it('returns every agent through authenticated HTTP without an implicit API row cap', async () => {
    const endpoint = new URL(process.env.GUGU_INTEGRATION_SUPABASE_URL ?? '')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('HTTP outcome tests require the fixture API')
    await db.query(`INSERT INTO identity.gugu_device_commands(user_id,device_id,type,status,payload)
      SELECT $1,$2,'agent.deliver','error',jsonb_build_object('chat_id',$3::text,'agent_user_id','agent-'||i)
      FROM generate_series(1,1005) i`, [owner, `outcome-${owner}`, chat])
    await db.query('COMMIT')
    const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, db: { schema: 'identity' } }
    const admin = createClient(endpoint.href, process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY!, options)
    const client = createClient(endpoint.href, process.env.VITE_SUPABASE_ANON_KEY!, options)
    try {
      const password = randomUUID()
      expect((await admin.auth.admin.updateUserById(owner, { password, email_confirm: true })).error).toBeNull()
      expect((await client.auth.signInWithPassword({ email: `${owner}@turn-outcomes.invalid`, password })).error).toBeNull()
      const result = await client.rpc('read_agent_turn_outcomes', { p_chat_id: chat, p_thread_root_id: null })
      expect(result.error).toBeNull()
      expect(result.data).toHaveLength(1005)
      const anonymous = createClient(endpoint.href, process.env.VITE_SUPABASE_ANON_KEY!, options)
      expect((await anonymous.rpc('read_agent_turn_outcomes', { p_chat_id: chat })).error?.code).toBe('42501')
    } finally {
      await client.auth.signOut()
      await db.query('DELETE FROM identity.gugu_device_commands WHERE user_id=ANY($1::uuid[])', [[owner, otherOwner]])
      await db.query('DELETE FROM identity.gugu_devices WHERE user_id=ANY($1::uuid[])', [[owner, otherOwner]])
      await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[owner, otherOwner]])
      await db.query('BEGIN')
    }
  })
  it('does not lose an older agent outcome behind more than 50 newer deliveries', async () => {
    const older = await insert('older-agent')
    for (let i = 0; i < 60; i++) await insert(`recent-${i}`, { at: '2026-11-01T01:00:00Z', status: 'done' })
    await asUser()
    const rows = await read()
    expect(rows).toHaveLength(61)
    expect(rows.at(-1)?.id).toBe(older)
  })
  it('returns the latest status for each agent, including success and pending recovery', async () => {
    await insert('succeeded'); await insert('retrying')
    const success = await insert('succeeded', { status: 'done', at: '2026-11-01T01:00:00Z' })
    const pending = await insert('retrying', { status: 'pending', at: '2026-11-01T02:00:00Z' })
    await asUser()
    expect((await read()).map(row => [row.id, row.status])).toEqual([[pending, 'pending'], [success, 'done']])
  })
  it('preserves the stored reason without classifying the error again', async () => {
    await insert('agent', { reason: 'undelivered' })
    await asUser()
    expect((await read())[0]!.result.reason).toBe('undelivered')
  })
  it('projects a null reason for a legacy command without a stored reason', async () => {
    await insert('agent')
    await asUser()
    expect((await read())[0]!.result.reason).toBeNull()
  })
  it('reads the owner latest outcome across chats and threads only when chat is null', async () => {
    const main = await insert('agent')
    const otherChat = randomUUID()
    const latest = await insert('agent', { room: otherChat, root: thread, at: '2026-11-01T01:00:00Z' })
    const another = await insert('another-agent', { room: otherChat, at: '2026-11-01T02:00:00Z' })
    const foreign = await insert('agent', { account: otherOwner, at: '2026-11-01T03:00:00Z' })
    await asUser()
    expect((await read(null)).map(row => row.id)).toEqual([another, latest])
    const defaults = await db.query<{ value: Outcome[] }>('SELECT identity.read_agent_turn_outcomes() AS value')
    expect(defaults.rows[0]!.value.map(row => row.id)).toEqual([another, latest])
    expect((await read()).map(row => row.id)).toEqual([main])
    expect((await read(otherChat, thread)).map(row => row.id)).toEqual([latest])
    expect((await read(otherChat)).map(row => row.id)).toEqual([another])
    await db.query('RESET role'); await asUser(otherOwner)
    expect((await read(null)).map(row => row.id)).toEqual([foreign])
  })
  it('isolates owner, conversation and exact thread without a caller-supplied owner or roster', async () => {
    const main = await insert('agent')
    const scoped = await insert('agent', { root: thread })
    const otherChat = randomUUID()
    await insert('agent', { room: otherChat }); await insert('foreign-agent', { account: otherOwner })
    await asUser()
    expect((await read()).map(row => row.id)).toEqual([main])
    expect((await read(chat, thread)).map(row => row.id)).toEqual([scoped])
    expect(await read(chat, randomUUID())).toEqual([])
    await db.query('RESET role'); await asUser(otherOwner)
    expect((await read()).map(row => row.payload.agent_user_id)).toEqual(['foreign-agent'])
    expect(await read(otherChat)).toEqual([])
  })
  it('uses the command id as a deterministic tie break and returns only projection fields', async () => {
    await insert('agent', { id: '00000000-0000-0000-0000-000000000001' })
    const latest = await insert('agent', { id: '00000000-0000-0000-0000-000000000002', status: 'done' })
    await asUser()
    const rows = await read()
    expect(rows).toHaveLength(1); expect(rows[0]!.id).toBe(latest)
    expect(rows[0]!.payload).toEqual({ agent_user_id: 'agent' })
    expect(rows[0]!.result).toEqual({ reply_notice: 'context', reason: null })
  })
  it('keeps the older client table read available under its existing owner RLS', async () => {
    const own = await insert('agent'); await insert('agent', { account: otherOwner })
    await asUser()
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM identity.gugu_device_commands
      WHERE type='agent.deliver' AND payload->>'chat_id'=$1 AND payload->>'agent_user_id' IN ('agent')
      ORDER BY created_at DESC LIMIT 50`, [chat])
    expect(rows).toEqual([{ id: own }])
  })
  it('grants only authenticated callers and refuses a missing identity', async () => {
    const { rows } = await db.query<{ authenticated: boolean; anon: boolean; service: boolean }>(`SELECT
      has_function_privilege('authenticated','identity.read_agent_turn_outcomes(text,text)','EXECUTE') AS authenticated,
      has_function_privilege('anon','identity.read_agent_turn_outcomes(text,text)','EXECUTE') AS anon,
      has_function_privilege('service_role','identity.read_agent_turn_outcomes(text,text)','EXECUTE') AS service`)
    expect(rows).toEqual([{ authenticated: true, anon: false, service: false }])
    expect((await db.query<{ definer: boolean }>("SELECT prosecdef AS definer FROM pg_proc WHERE oid='identity.read_agent_turn_outcomes(text,text)'::regprocedure")).rows).toEqual([{ definer: false }])
    await asUser(null)
    await db.query('SAVEPOINT no_identity')
    await expect(read()).rejects.toMatchObject({ code: '42501', message: 'not authenticated' })
    await db.query('ROLLBACK TO SAVEPOINT no_identity')
  })
})
