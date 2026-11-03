import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
const { Client: PgClient } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => Client }
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? ''
const clients: Client[] = []
let db: Client
async function connect(): Promise<Client> {
  const c = new PgClient({ connectionString: url })
  await c.connect()
  await c.query("SET statement_timeout='10s'")
  clients.push(c)
  return c
}
beforeAll(async () => {
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('deliveredReadDeadlock6049 requires disposable loopback PostgreSQL')
  }
  db = await connect()
})
afterAll(async () => { await Promise.all(clients.map(c => c.end())) })
interface Fixture { owner: string; other: string; agent: string; outsider: string; chats: string[]; device: string; extraUsers: string[] }
async function fixture(body: (f: Fixture) => Promise<void>): Promise<void> {
  const f: Fixture = { extraUsers: [], owner: randomUUID(), other: randomUUID(), agent: randomUUID(), outsider: randomUUID(), chats: [randomUUID(), randomUUID()], device: `read-6049-${randomUUID()}` }
  try {
    await db.query("INSERT INTO auth.users(id,email) VALUES ($1::uuid,$2)", [f.owner, `read-${f.owner}@example.test`])
    await db.query("INSERT INTO identity.users(id,type,display_name) SELECT id,'human','read race' FROM unnest($1::text[]) id ON CONFLICT (id) DO NOTHING", [[f.owner, f.other, f.outsider]])
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES ($1,$2,'read test','isolated','linux')", [f.device, f.owner])
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES ($1,'agent','read agent',$2,$3)", [f.agent, f.owner, f.device])
    for (const chat of f.chats) {
      await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','receipt lock test',$2)", [chat, f.owner])
      await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role,listen_mode) SELECT $1,u,CASE WHEN u=$2 THEN 'owner' ELSE 'member' END,'passive' FROM unnest($3::text[]) u", [chat, f.owner, [f.owner, f.other, f.agent]])
    }
    await body(f)
  } finally {
    await db.query('ROLLBACK')
    await db.query('DELETE FROM chat.chats WHERE id=ANY($1::text[])', [f.chats])
    await db.query('DELETE FROM auth.users WHERE id=$1::uuid', [f.owner])
    await db.query('DELETE FROM identity.users WHERE id=ANY($1::text[])', [[f.agent, f.owner, f.other, f.outsider, ...f.extraUsers]])
    await db.query('DELETE FROM chat.account_revision_heads WHERE user_id=ANY($1::text[])', [[f.agent, f.owner, f.other, f.outsider, ...f.extraUsers]])
  }
}
async function message(chat: string, sender: string): Promise<{ id: string; seq: string }> {
  return (await db.query<{ id: string; seq: string }>("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES ($1,$2,$3,'receipt regression','text') RETURNING id,seq", [randomUUID(), chat, sender])).rows[0]!
}
async function begin(c: Client, caller: string): Promise<void> {
  await c.query('BEGIN')
  await c.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: caller, role: 'authenticated' })])
}
async function rpc(c: Client, caller: string, sql: string, values: unknown[]): Promise<void> {
  await begin(c, caller)
  try { await c.query('SET LOCAL ROLE authenticated'); await c.query(sql, values); await c.query('COMMIT') }
  catch (error) { await c.query('ROLLBACK'); throw error }
}
async function blocked(pid: number, blocker: number): Promise<void> {
  const deadline = Date.now() + 5000
  do {
    if ((await db.query<{ yes: boolean }>('SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS yes', [pid, blocker])).rows[0]!.yes) return
    await new Promise(resolve => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  throw new Error('RIG-FAIL: receipt did not reach the competing member row')
}
const receiptSql = 'SELECT identity.mark_read_on_deliver($1,$2,$3)'
const watermarkSql = 'SELECT * FROM chat.mark_read($1,$2,$3)'
async function receiptCount(id: string): Promise<number> {
  return Number((await db.query<{ count: string }>("SELECT count(*) FROM chat.message_deliveries WHERE message_id=$1 AND status='read'", [id])).rows[0]!.count)
}

describe('delivered read member/revision lock order #6049', () => {
  it.each(['attach', 'replay', 'retry', 'drift'])('keeps nested prepare %s before revision fanout', async mode => fixture(async f => {
    const c = await connect(), a = await connect(), b = await connect()
    const operation = randomUUID(), provision = randomUUID(), initial = randomUUID()
    const member = { provision_id: provision, member_key: 'assistant', display_name: 'nested receipt', agent_type: 'codex', project_path: '/isolated', inherit_memory: false, history_import_required: false }
    await rpc(c, f.owner, 'SELECT identity.start_agent_provision_operation($1,$2,$3::jsonb)', [operation, f.device, JSON.stringify({ kind: 'single', members: [member] })])
    await rpc(c, f.owner, 'SELECT identity.claim_provision_slots($1)', [operation])
    const prepare = 'SELECT identity.prepare_agent_provision($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)'
    const args = [provision, operation, 'assistant', f.device, member.display_name, member.agent_type, member.project_path, null, null, mode === 'replay' ? initial : null, mode === 'replay' ? 'first prompt' : null]
    await rpc(c, f.owner, prepare, args)
    const row = (await db.query<{ agent_user_id: string; dm_chat_id: string; create_command_id: string }>('SELECT agent_user_id,dm_chat_id,create_command_id FROM identity.agent_provisions WHERE id=$1', [provision])).rows[0]!
    f.chats.push(row.dm_chat_id); f.extraUsers.push(row.agent_user_id)
    const later = await message(row.dm_chat_id, f.owner)
    if (mode === 'retry') {
      await db.query("UPDATE identity.gugu_device_commands SET status='error' WHERE id=$1", [row.create_command_id])
      await rpc(c, f.owner, 'SELECT identity.settle_agent_provision_terminal($1)', [provision])
      await rpc(c, f.owner, 'SELECT identity.set_agent_runtime_state($1,$2)', [row.agent_user_id, 'offline'])
      await rpc(c, f.owner, 'SELECT identity.claim_provision_slots($1,1,$2::uuid[])', [operation, [provision]])
    }
    args[9] = initial; args[10] = 'first prompt'
    await begin(b, f.owner)
    await b.query('SELECT 1 FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2 FOR NO KEY UPDATE', [row.dm_chat_id, row.agent_user_id])
    const pa = (await a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    const pb = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    const prepared = rpc(a, f.owner, prepare, args).then(() => null, (e: Error & { code?: string }) => ({ code: e.code, message: e.message }))
    try {
      await blocked(pa, pb)
      if (mode === 'drift') {
        // The member prelock must not validate a different DM than the one used
        // by the eventual wrapper after a concurrent provision binding change.
        await b.query('UPDATE identity.agent_provisions SET dm_chat_id=$2 WHERE id=$1', [provision, f.chats[0]])
        await b.query('COMMIT')
        expect(await prepared).toEqual({ code: 'P0001', message: expect.stringMatching(/changed while acquiring locks.*DM binding/) })
        expect(await receiptCount(initial)).toBe(0)
        expect((await db.query('SELECT id FROM chat.messages WHERE id=$1', [initial])).rows).toEqual([])
        return
      }
      await b.query('SET LOCAL ROLE authenticated')
      const read = b.query(watermarkSql, [row.dm_chat_id, later.seq, row.agent_user_id]).then(async () => { await b.query('COMMIT'); return null }, async (e: Error & { code?: string }) => { await b.query('ROLLBACK'); return { code: e.code, message: e.message } })
      expect(await Promise.all([prepared, read])).toEqual([null, null])
      expect(await receiptCount(initial)).toBe(1)
      expect((await db.query('SELECT agent_user_id,dm_chat_id FROM identity.agent_provisions WHERE id=$1', [provision])).rows).toEqual([{ agent_user_id: row.agent_user_id, dm_chat_id: row.dm_chat_id }])
    } finally { await b.query('ROLLBACK'); await prepared }
  }))

  it('commits precise receipt and watermark under the formerly inverted member/revision lock order', async () => fixture(async f => {
    const chat = f.chats[0]!, m = await message(chat, f.other), a = await connect(), b = await connect()
    await begin(b, f.owner)
    const pa = (await a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    const pb = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    await b.query('SELECT 1 FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2 FOR NO KEY UPDATE', [chat, f.agent])
    const delivered = rpc(a, f.owner, receiptSql, [chat, m.id, f.agent]).then(() => null, (e: Error & { code?: string }) => ({ code: e.code, message: e.message }))
    try {
      await blocked(pa, pb)
      await b.query('SET LOCAL ROLE authenticated')
      const read = b.query(watermarkSql, [chat, m.seq, f.agent]).then(async () => { await b.query('COMMIT'); return null }, async (e: Error & { code?: string }) => { await b.query('ROLLBACK'); return { code: e.code, message: e.message } })
      expect(await Promise.all([delivered, read])).toEqual([null, null])
      expect(await receiptCount(m.id)).toBe(1)
      expect((await db.query('SELECT last_read_seq FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chat, f.agent])).rows).toEqual([{ last_read_seq: m.seq }])
    } finally { await b.query('ROLLBACK'); await delivered }
  }))

  it('allows concurrent receipts for the same account across chats with repeated delivery idempotence', async () => fixture(async f => {
    const a = await connect(), b = await connect()
    for (let i = 0; i < 12; i++) {
      const messages = await Promise.all(f.chats.map(chat => message(chat, f.other)))
      await Promise.all([a, b].map((c, index) => rpc(c, f.owner, receiptSql, [f.chats[index], messages[index]!.id, f.agent])))
      await Promise.all([a, b].map((c, index) => rpc(c, f.owner, receiptSql, [f.chats[index], messages[index]!.id, f.agent])))
      for (const m of messages) expect(await receiptCount(m.id)).toBe(1)
    }
  }))

  it('preserves exact receipts while an earlier other-sender gap prevents watermark advance', async () => fixture(async f => {
    const chat = f.chats[0]!, first = await message(chat, f.other), later = await message(chat, f.other), c = await connect()
    await rpc(c, f.owner, receiptSql, [chat, later.id, f.agent])
    expect(await receiptCount(later.id)).toBe(1)
    expect((await db.query('SELECT last_read_seq FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chat, f.agent])).rows).toEqual([{ last_read_seq: '0' }])
    await rpc(c, f.owner, receiptSql, [chat, first.id, f.agent])
    await rpc(c, f.owner, receiptSql, [chat, later.id, f.agent])
    expect((await db.query('SELECT last_read_seq FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chat, f.agent])).rows).toEqual([{ last_read_seq: later.seq }])
    expect(await receiptCount(first.id)).toBe(1)
  }))

  it('keeps owner authorization, absent/deleted message no-ops and removed-member denial', async () => fixture(async f => {
    const chat = f.chats[0]!, m = await message(chat, f.other), deleted = await message(chat, f.other), c = await connect()
    await expect(rpc(c, f.outsider, receiptSql, [chat, m.id, f.agent])).rejects.toThrow(/not authorized/)
    await rpc(c, f.owner, receiptSql, [chat, randomUUID(), f.agent])
    await db.query('UPDATE chat.messages SET deleted_at=now() WHERE id=$1', [deleted.id])
    await rpc(c, f.owner, receiptSql, [chat, deleted.id, f.agent])
    expect(await receiptCount(deleted.id)).toBe(0)
    await rpc(c, f.owner, receiptSql, [chat, m.id, f.agent])
    expect(await receiptCount(m.id)).toBe(1)
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chat, f.agent])
    await expect(rpc(c, f.owner, receiptSql, [chat, m.id, f.agent])).rejects.toThrow(/not authorized/)
    await begin(c, f.owner)
    try { await c.query('SET LOCAL ROLE anon'); await expect(c.query(receiptSql, [chat, m.id, f.agent])).rejects.toThrow(/permission denied/) }
    finally { await c.query('ROLLBACK') }
  }))

  it('lets an in-flight member removal complete without reversing the receipt lock order', async () => fixture(async f => {
    const chat = f.chats[0]!, m = await message(chat, f.other), a = await connect(), b = await connect()
    await b.query('BEGIN')
    await b.query('SELECT 1 FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2 FOR NO KEY UPDATE', [chat, f.agent])
    const pa = (await a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    const pb = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    const delivered = rpc(a, f.owner, receiptSql, [chat, m.id, f.agent]).then(() => null, (e: Error & { code?: string }) => ({ code: e.code, message: e.message }))
    try {
      await blocked(pa, pb)
      await b.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chat, f.agent])
      await b.query('COMMIT')
      expect(await delivered).toBeNull()
      expect((await db.query('SELECT user_id FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chat, f.agent])).rows).toEqual([])
      // Authorization preceded removal; the original precise-read path still records
      // the accepted delivery, while the removed member's watermark is never recreated.
      expect(await receiptCount(m.id)).toBe(1)
    } finally { await b.query('ROLLBACK'); await delivered }
  }))
})
