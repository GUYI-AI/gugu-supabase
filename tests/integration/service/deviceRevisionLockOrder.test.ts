import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Device writes and message inserts share one lock order: device rows, then account revision heads.
 * Each case pins the formerly inverted interleaving with a lock held by a control session, so the
 * pre-fix order deadlocks deterministically (40P01) instead of racing.
 */
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
  await c.query("SET statement_timeout='15s'")
  clients.push(c)
  return c
}
beforeAll(async () => {
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('deviceRevisionLockOrder requires disposable loopback PostgreSQL')
  }
  db = await connect()
})
afterAll(async () => { await Promise.all(clients.map(c => c.end())) })

type Outcome = null | { code?: string; message: string }
const settle = (p: Promise<unknown>): Promise<Outcome> => p.then(() => null, (e: Error & { code?: string }) => ({ code: e.code, message: e.message }))
const pid = async (c: Client) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
async function blocked(waiter: number, blocker?: number): Promise<void> {
  const deadline = Date.now() + 5000
  do {
    const { rows } = await db.query<{ by: number[] }>('SELECT pg_blocking_pids($1::integer) AS by', [waiter])
    if (blocker === undefined ? rows[0]!.by.length > 0 : rows[0]!.by.includes(blocker)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  throw new Error(`RIG-FAIL: backend ${waiter} never waited${blocker === undefined ? '' : ` on ${blocker}`}`)
}
async function as<T>(c: Client, user: string, body: () => Promise<T>): Promise<T> {
  await c.query('BEGIN')
  try {
    await c.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
    await c.query('SET LOCAL ROLE authenticated')
    const result = await body()
    await c.query('COMMIT')
    return result
  } catch (error) { await c.query('ROLLBACK'); throw error }
}

interface Fixture { humans: string[]; agents: string[]; devices: string[]; chats: string[] }
async function fixture(body: (f: Fixture) => Promise<void>): Promise<void> {
  const f: Fixture = { humans: [], agents: [], devices: [], chats: [] }
  try { await body(f) } finally {
    await db.query('DELETE FROM chat.chats WHERE id=ANY($1::text[])', [f.chats])
    await db.query('DELETE FROM identity.gugu_device_commands WHERE device_id=ANY($1::text[])', [f.devices])
    await db.query('DELETE FROM identity.agent_runtime_states WHERE agent_user_id=ANY($1::text[])', [f.agents])
    await db.query('DELETE FROM identity.users WHERE id=ANY($1::text[])', [f.agents])
    await db.query('DELETE FROM identity.gugu_devices WHERE device_id=ANY($1::text[])', [f.devices])
    await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [f.humans])
    await db.query('DELETE FROM identity.users WHERE id=ANY($1::text[])', [f.humans])
    await db.query('DELETE FROM chat.account_revision_heads WHERE user_id=ANY($1::text[])', [[...f.humans, ...f.agents]])
  }
}
async function human(f: Fixture, id = randomUUID()): Promise<string> {
  f.humans.push(id)
  await db.query('INSERT INTO auth.users(id,email) VALUES ($1::uuid,$2)', [id, `lock-order-${id}@example.test`])
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','lock order') ON CONFLICT (id) DO NOTHING", [id])
  return id
}
async function device(f: Fixture, owner: string): Promise<string> {
  const id = `lock-order-${randomUUID()}`
  f.devices.push(id)
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,status,capabilities)
    VALUES ($1,$2,'lock order','isolated','linux','online','{"runtimes":["codex"],"host_runtime_capability":1}')`, [id, owner])
  return id
}
async function agent(f: Fixture, owner: string, host: string): Promise<string> {
  const id = randomUUID()
  f.agents.push(id)
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES ($1,'agent','lock order agent',$2,$3)", [id, owner, host])
  return id
}
/** The first member is the group's human owner. */
async function group(f: Fixture, members: string[]): Promise<string> {
  const id = randomUUID()
  f.chats.push(id)
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','lock order',$2)", [id, members[0]])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) SELECT $1,u,CASE WHEN u=$2 THEN 'owner' ELSE 'member' END FROM unnest($3::text[]) u", [id, members[0], members])
  return id
}
/** Existing heads: initializing one would add a foreign-key lock on the user row and move the pause. */
async function heads(users: string[]): Promise<void> {
  await db.query('INSERT INTO chat.account_revision_heads(user_id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [users])
}
const revision = async (user: string) =>
  Number((await db.query<{ revision: string }>('SELECT revision FROM chat.account_revision_heads WHERE user_id=$1', [user])).rows[0]?.revision ?? 0)

/** The client's registration write, verbatim in shape: PostgREST on_conflict=device_id sets every column, device_id included. */
const REGISTER = `INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,status,capabilities,machine_id,last_seen_at,updated_at)
  VALUES ($1,$2,'lock order','isolated','linux','online',$3::jsonb,'machine-'||$1,now(),now())
  ON CONFLICT (device_id) DO UPDATE SET device_id=EXCLUDED.device_id,user_id=EXCLUDED.user_id,label=EXCLUDED.label,
    hostname=EXCLUDED.hostname,platform=EXCLUDED.platform,status=EXCLUDED.status,capabilities=EXCLUDED.capabilities,
    machine_id=EXCLUDED.machine_id,last_seen_at=EXCLUDED.last_seen_at,updated_at=EXCLUDED.updated_at`

describe('device and account-revision lock order', () => {
  it('commits a registration upsert and a message that wakes an agent on that device', async () => fixture(async f => {
    const owner = await human(f), other = await human(f), host = await device(f, owner)
    const hosted = await agent(f, owner, host), chat = await group(f, [owner, other, hosted])
    await heads([owner, other, hosted])
    const control = await connect(), sender = await connect(), register = await connect()
    const [pc, ps, pr] = await Promise.all([pid(control), pid(sender), pid(register)])
    const before = await revision(owner), message = randomUUID()
    // Pause the message after its member heads are locked and before its agent.deliver command: recording
    // the wake takes FOR KEY SHARE on the agent's user row, which the control session holds exclusively.
    await control.query('BEGIN')
    await control.query('SELECT 1 FROM identity.users WHERE id=$1 FOR UPDATE', [hosted])
    const sent = settle(sender.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,to_user_ids,content,content_type)
      VALUES ($1,$2,$3,$4,'please look','text')`, [message, chat, other, [hosted]]))
    try {
      await blocked(ps, pc)
      const registered = settle(as(register, owner, () => register.query(REGISTER, [host, owner, '{"runtimes":["codex","claude"],"host_runtime_capability":1}'])))
      await blocked(pr, ps)
      await control.query('ROLLBACK')
      expect(await Promise.all([sent, registered])).toEqual([null, null])
    } finally { await control.query('ROLLBACK') }
    const { rows: commands } = await db.query<{ type: string; agent: string }>(
      "SELECT type, payload->>'agent_user_id' AS agent FROM identity.gugu_device_commands WHERE device_id=$1 AND payload->>'message_id'=$2", [host, message])
    expect(commands).toEqual([{ type: 'agent.deliver', agent: hosted }])
    expect((await db.query('SELECT capabilities->$2 AS runtimes FROM identity.gugu_devices WHERE device_id=$1', [host, 'runtimes'])).rows)
      .toEqual([{ runtimes: ['codex', 'claude'] }])
    // The message and the device change each advanced the owner's head once.
    expect(await revision(owner)).toBeGreaterThanOrEqual(before + 2)
  }))

  it('commits a device status change and a runtime write whose viewers cross the device agents', async () => fixture(async f => {
    const owner = await human(f), [low, high] = [randomUUID(), randomUUID()].sort()
    await human(f, low); await human(f, high)
    const elsewhere = await human(f), host = await device(f, owner)
    const first = await agent(f, owner, host), second = await agent(f, owner, host)
    // The device trigger visits its agents in this order; give the first one the higher-sorting viewer.
    const order = (await db.query<{ id: string }>("SELECT id FROM identity.users WHERE device_id=$1 AND type='agent'", [host])).rows.map(r => r.id)
    expect(new Set(order)).toEqual(new Set([first, second]))
    await group(f, [high, order[0]!])
    await group(f, [low, order[1]!])
    const watched = await agent(f, elsewhere, await device(f, elsewhere))
    await group(f, [low, high, watched])
    await heads([owner, low, high, elsewhere])
    const control = await connect(), writer = await connect(), runtime = await connect()
    const [pc, pd, pr] = await Promise.all([pid(control), pid(writer), pid(runtime)])
    const before = await Promise.all([owner, low, high].map(revision))
    await control.query('BEGIN')
    await control.query('SELECT 1 FROM chat.account_revision_heads WHERE user_id=$1 FOR NO KEY UPDATE', [high])
    const offline = settle(as(writer, owner, () => writer.query("UPDATE identity.gugu_devices SET status='offline' WHERE device_id=$1", [host])))
    try {
      await blocked(pd, pc)
      const reported = settle(as(runtime, elsewhere, () => runtime.query('SELECT identity.set_agent_runtime_state($1,NULL,$2)', [watched, 'running'])))
      await blocked(pr)
      await control.query('ROLLBACK')
      expect(await Promise.all([offline, reported])).toEqual([null, null])
    } finally { await control.query('ROLLBACK') }
    expect((await db.query('SELECT status FROM identity.gugu_devices WHERE device_id=$1', [host])).rows).toEqual([{ status: 'offline' }])
    const after = await Promise.all([owner, low, high].map(revision))
    expect(after[0]).toBeGreaterThan(before[0]!)
    expect(after[1]).toBeGreaterThan(before[1]!)
    expect(after[2]).toBeGreaterThan(before[2]!)
  }))

  it('pre-locks exactly the accounts a presence fan-out advances', async () => fixture(async f => {
    const owner = await human(f), friend = await human(f), member = await human(f), stranger = await human(f)
    const host = await device(f, owner), watched = await agent(f, owner, host), peer = await agent(f, owner, host)
    await group(f, [member, watched, peer])
    const [a, b] = [watched, friend].sort()
    await db.query('INSERT INTO identity.friendships(user_a_id,user_b_id) VALUES ($1,$2)', [a, b])
    // Any chat a friendship opens is cleaned up with the fixture.
    f.chats.push(...(await db.query<{ id: string }>('SELECT chat_id AS id FROM chat.chat_members WHERE user_id=ANY($1::text[]) AND chat_id<>ALL($2::text[])', [[watched, friend], f.chats])).rows.map(r => r.id))
    const candidates = [owner, friend, member, stranger]
    await heads(candidates)
    const before = await Promise.all(candidates.map(revision))
    await db.query('SELECT identity.fan_agent_presence_to_viewers($1, identity.build_agent_presence_payload($1))', [watched])
    const after = await Promise.all(candidates.map(revision))
    const advanced = candidates.filter((_, i) => after[i]! > before[i]!).sort()
    const locked = (await db.query<{ id: string }>('SELECT identity.agent_presence_viewer_ids($1) AS id', [watched])).rows.map(r => r.id).sort()
    expect(advanced).toEqual([owner, friend, member].sort())
    expect(locked).toEqual(advanced)
  }))

  it('locks agent devices before any other BEFORE INSERT trigger on messages runs', async () => {
    // tgtype bit 2 = BEFORE, bit 4 = INSERT; such triggers fire in name order.
    const { rows } = await db.query<{ tgname: string }>(`SELECT tgname FROM pg_trigger
      WHERE tgrelid='chat.messages'::regclass AND NOT tgisinternal AND tgtype & 2 = 2 AND tgtype & 4 = 4 ORDER BY tgname COLLATE "C"`)
    expect(rows[0]?.tgname).toBe('messages_a_lock_agent_devices')
  })
})
