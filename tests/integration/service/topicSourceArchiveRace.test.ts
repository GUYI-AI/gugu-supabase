import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// A source's archive and a new topic on it, from two connections: the fixtures are committed so the other connection sees
// them, and removed at the end.
let a: Client, b: Client
let owner: string, source: string, anchor: string
const created: { users: string[]; agents: string[]; chats: string[] } = { users: [], agents: [], chats: [] }

async function as(client: Client, id: string) {
  await client.query('SET LOCAL ROLE authenticated')
  await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function createTopic(client: Client, name: string) {
  await client.query('BEGIN')
  await as(client, owner)
  return client.query('SELECT chat_id FROM chat.create_topic($1,$2,$3)', [source, anchor, name])
}
async function archiveSource(client: Client) {
  await client.query('BEGIN')
  await as(client, owner)
  return client.query('SELECT chat.archive_group_as($1,$2)', [source, owner])
}
/** The second must wait on the source row until the first commits: the lock orders them, not luck. */
async function expectBlocked(pending: Promise<unknown>) {
  const state = await Promise.race([
    pending.then(() => 'settled', () => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 400)),
  ])
  expect(state).toBe('blocked')
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Topic source archive races require the disposable loopback database')
  }
  a = new Client({ connectionString: url.href }); b = new Client({ connectionString: url.href })
  await a.connect(); await b.connect()
})
afterAll(async () => {
  try {
    if (created.chats.length) await a.query('DELETE FROM chat.chats WHERE id=ANY($1) OR source_chat_id=ANY($1)', [created.chats])
    if (created.agents.length) await a.query('DELETE FROM identity.users WHERE id=ANY($1::text[])', [created.agents])
    await a.query("DELETE FROM identity.gugu_devices WHERE device_id LIKE 'topic-race-%'")
    if (created.users.length) await a.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [created.users])
  } finally { await a?.end(); await b?.end() }
})
beforeEach(async () => {
  ;[owner, source, anchor] = [randomUUID(), randomUUID(), randomUUID()]
  await a.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [owner, `${owner}@topic-source-race.invalid`])
  created.users.push(owner)
  await a.query('BEGIN')
  await a.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','Race source',$2)`, [source, owner])
  await a.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner')`, [source, owner])
  await a.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'Anchor')`, [anchor, source, owner])
  await a.query('COMMIT')
  created.chats.push(source)
})

describe('a topic opened while its source is being archived', () => {
  it('is refused when the archive commits first', async () => {
    await archiveSource(a)
    const opening = createTopic(b, 'Late')
    await expectBlocked(opening)
    await a.query('COMMIT')
    await expect(opening).rejects.toThrow('is archived')
    await b.query('ROLLBACK')
    expect((await a.query('SELECT count(*)::int AS n FROM chat.chats WHERE source_chat_id=$1', [source])).rows[0].n).toBe(0)
  })
  it('is archived with the source when it commits first', async () => {
    const { rows: [{ chat_id: topic }] } = await createTopic(b, 'Early')
    const archiving = archiveSource(a)
    await expectBlocked(archiving)
    await b.query('COMMIT')
    await archiving
    await a.query('COMMIT')
    expect((await a.query('SELECT status FROM chat.chats WHERE id=$1', [topic])).rows[0].status).toBe('archived')
  })
})

describe('two Agents opening topics on one source at once', () => {
  // An Agent's create_topic also posts a notice into the source, which takes the source row FOR NO KEY UPDATE. B holds the
  // source FOR SHARE, as a FOR SHARE guard would leave an opener; A then opens. With such a guard A would get through to its
  // notice, and B's notice would wait on A while A waits on B: 40P01. The guard's FOR NO KEY UPDATE queues A instead.
  let agents: string[]
  beforeEach(async () => {
    const device = 'topic-race-' + owner
    agents = [randomUUID(), randomUUID()]
    await a.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES ($1,$2,'fixture','fixture','darwin')`, [device, owner])
    for (const agent of agents) {
      await a.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES ($1,'agent','Race agent',$2,$3)`, [agent, owner, device])
      await a.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'member')`, [source, agent])
    }
    created.agents.push(...agents)
  })
  async function openAs(client: Client, agent: string, name: string) {
    await as(client, owner)
    return client.query('SELECT chat_id FROM chat.create_topic($1,$2,$3,NULL,$4)', [source, anchor, name, agent])
  }
  it('both open, one after the other', async () => {
    await b.query('BEGIN')
    await b.query('SELECT 1 FROM chat.chats WHERE id=$1 FOR SHARE', [source])
    await a.query('BEGIN')
    const first = openAs(a, agents[0]!, 'First').then(() => a.query('COMMIT'), async (error) => { await a.query('ROLLBACK'); throw error })
    await expectBlocked(first)
    await openAs(b, agents[1]!, 'Second')
    await b.query('COMMIT')
    await first
    expect((await a.query("SELECT count(*)::int AS n FROM chat.chats WHERE source_chat_id=$1 AND status='active'", [source])).rows[0].n).toBe(2)
  })
  it('both open when started together', async () => {
    const open = async (client: Client, agent: string, name: string) => {
      await client.query('BEGIN')
      try { await openAs(client, agent, name); await client.query('COMMIT') } catch (error) { await client.query('ROLLBACK'); throw error }
    }
    await Promise.all([open(a, agents[0]!, 'One'), open(b, agents[1]!, 'Two')])
    expect((await a.query("SELECT count(*)::int AS n FROM chat.chats WHERE source_chat_id=$1 AND status='active'", [source])).rows[0].n).toBe(2)
  })
})
