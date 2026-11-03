import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * In a direct chat (dm, ai) the other member is the addressee of whatever a person sends there without naming
 * anyone: a plain message, a forwarded message, a forwarded attachment, a quote of their own line. The rule lives in the one wake
 * predicate chat.message_wakes_agent, so the wake list (what pull_agent_inbox_v2 reads) and the agent.deliver
 * command agree. An agent's or the server's undirected line in a direct chat still wakes nobody; group rules are
 * unchanged. Every negative has a positive control; every case runs inside BEGIN...ROLLBACK.
 * Run: `GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:<port>/postgres pnpm exec vitest run dmPeerIsAddressee`
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
let owner: string
let agent: string

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asServiceRole() { await database.query('SET LOCAL role TO service_role') }
async function asOwner() { await database.query('RESET role') }

async function human(name: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@dm-peer-is-addressee.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'dm-peer-is-addressee fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
/** An online agent on its owner's device, so the agent.deliver command can reach it. */
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
    VALUES ($1,'agent',$2,$3,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}
/** A chat with its members put in directly, as the server does; the first member is the creator. */
async function chatOf(kind: 'dm' | 'ai' | 'group', members: string[], listenMode: 'active' | 'passive' = 'passive'): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,$2,$3,$4)`,
    [id, kind, kind === 'group' ? 'group' : null, members[0]])
  for (const [i, user] of members.entries()) {
    await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role,listen_mode) VALUES ($1,$2,$3,$4)`,
      [id, user, kind === 'group' && i === 0 ? 'owner' : 'member', listenMode])
  }
  return id
}
async function say(chatId: string, sender: string | null, opts: { to?: string[]; type?: 'text' | 'system'; replyTo?: string; whisper?: boolean } = {}): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, reply_to_message_id, is_whisper)
    VALUES ($1,$2,$3,'hello',$4,$5,$6,$7)`, [id, chatId, sender, opts.type ?? 'text', opts.to ?? null, opts.replyTo ?? null, opts.whisper ?? false])
  return id
}
async function wokenBy(messageId: string): Promise<string[]> {
  await asOwner()
  const { rows } = await database.query<{ agent_user_id: string }>(
    'SELECT agent_user_id FROM chat.message_agent_wakes WHERE message_id = $1 ORDER BY 1', [messageId])
  return rows.map((row) => row.agent_user_id)
}
async function nudgedBy(messageId: string): Promise<string[]> {
  await asOwner()
  const { rows } = await database.query<{ agent: string }>(
    `SELECT payload->>'agent_user_id' AS agent FROM identity.gugu_device_commands
     WHERE type = 'agent.deliver' AND payload->>'message_id' = $1 ORDER BY 1`, [messageId])
  return rows.map((row) => row.agent)
}
async function reaches(messageId: string): Promise<string[]> {
  const woken = await wokenBy(messageId)
  expect(await nudgedBy(messageId)).toEqual(woken)
  return woken
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('dmPeerIsAddressee.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner')
  agent = await agentOf(await human('Agent owner'), 'Friend Agent')
})
afterEach(async () => {
  if (!database) return
  try {
    await asOwner()
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('a person writing in a direct chat addresses the other member', () => {
  it('a plain message without to_user_ids reaches the agent, in dm and in ai; control: naming it still does', async () => {
    for (const kind of ['dm', 'ai'] as const) {
      const chat = await chatOf(kind, [owner, agent])
      expect(await reaches(await say(chat, owner))).toEqual([agent])
      expect(await reaches(await say(chat, owner, { to: [agent] }))).toEqual([agent])
    }
  })

  it('quoting your own line in a direct chat still talks to the peer; explicit recipients are honored', async () => {
    const dm = await chatOf('dm', [owner, agent])
    const mine = await say(dm, owner)
    expect(await reaches(await say(dm, owner, { replyTo: mine }))).toEqual([agent])
    // A direct chat with a third member (a fixture shape, not a product one): naming the other person names only them.
    const other = await human('Other')
    await asOwner()
    await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')`, [dm, other])
    expect(await reaches(await say(dm, owner, { to: [other] }))).toEqual([])
    expect(await reaches(await say(dm, owner, { to: [other], whisper: true }))).toEqual([])
  })

  it('a message forwarded in by the client (a plain insert with forwarded_from_message_id) reaches the agent', async () => {
    const other = await human('Other')
    const group = await chatOf('group', [other, owner])
    const source = await say(group, other)
    const dm = await chatOf('dm', [owner, agent])
    await asUser(owner)
    const id = randomUUID()
    await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, forwarded_from_message_id, client_message_id)
      VALUES ($1,$2,$3,'hello','text',$4,$5)`, [id, dm, owner, source, randomUUID()])
    expect(await reaches(id)).toEqual([agent])
  })

  it('an attachment forwarded in through chat.attachment_forward (empty to_user_ids) reaches the agent', async () => {
    const other = await human('Other')
    const group = await chatOf('group', [other, owner])
    const content = `bytes-${randomUUID()}`
    const key = `staging/${other}/${randomUUID()}`
    await asServiceRole()
    await database.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5,$6,$7)',
      [other, key, createHash('sha256').update(content).digest('hex'), 1234, 'image/png', 640, 480])
    await asUser(other)
    const { rows: [sent] } = await database.query<{ id: string }>(
      'SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,false,NULL,NULL)',
      [key, randomUUID(), group, other, 'a.png', []])
    const dm = await chatOf('dm', [owner, agent])
    await asUser(owner)
    const { rows: [forwarded] } = await database.query<{ id: string }>(
      'SELECT * FROM chat.attachment_forward($1,$2,$3,$4)', [sent!.id, randomUUID(), dm, owner])
    expect(await reaches(forwarded!.id)).toEqual([agent])
  })

  it('an agent\'s undirected line in a direct chat wakes nobody; control: naming the other agent wakes it', async () => {
    const peer = await agentOf(owner, 'Peer Agent')
    const dm = await chatOf('dm', [agent, peer])
    expect(await reaches(await say(dm, agent))).toEqual([])
    expect(await reaches(await say(dm, agent, { to: [peer] }))).toEqual([peer])
  })

  it('a server-written notice (no sender) in a direct chat wakes nobody; control: the person\'s message does', async () => {
    const dm = await chatOf('dm', [owner, agent])
    expect(await reaches(await say(dm, null, { type: 'system' }))).toEqual([])
    expect(await reaches(await say(dm, owner))).toEqual([agent])
  })

  it('groups are unchanged: an undirected message reaches only active agents; naming reaches the named one', async () => {
    const passive = await chatOf('group', [owner, agent], 'passive')
    expect(await reaches(await say(passive, owner))).toEqual([])
    expect(await reaches(await say(passive, owner, { to: [agent] }))).toEqual([agent])
    const active = await chatOf('group', [owner, agent], 'active')
    expect(await reaches(await say(active, owner))).toEqual([agent])
    const peer = await agentOf(owner, 'Peer Agent')
    await asOwner()
    await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role,listen_mode) VALUES ($1,$2,'member','active')`, [active, peer])
    expect(await reaches(await say(active, peer))).toEqual([])
  })
})
