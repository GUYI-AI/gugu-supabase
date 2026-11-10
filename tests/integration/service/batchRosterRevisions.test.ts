import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// docs/batch-roster-revisions.md: one membership statement sends each recipient one roster revision per chat. It names the
// recipient's own seat when the statement changed it, otherwise the first changed seat by id.

interface Database {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => Database
}
type Revision = { user_id: string; resource_key: { chat_id: string; user_id?: string; kind?: string }; tombstone: boolean }
let db: Database

async function asUser(userId: string) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: 'authenticated' })])
}
async function humans(count: number) {
  const ids = Array.from({ length: count }, () => randomUUID()).sort()
  await db.query(`INSERT INTO auth.users(id,email) SELECT id::uuid, id||'@batch-roster.invalid' FROM unnest($1::text[]) id`, [ids])
  await db.query(`INSERT INTO identity.users(id,type,display_name) SELECT id,'human','Batch roster' FROM unnest($1::text[]) id
    ON CONFLICT(id) DO NOTHING`, [ids])
  return ids
}
async function agentsOf(owner: string, count: number) {
  const device = `device-${owner}`
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Batch roster','fixture','linux')`, [device, owner])
  const ids = Array.from({ length: count }, () => randomUUID()).sort()
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id)
    SELECT id,'agent','Batch agent',$2,$3 FROM unnest($1::text[]) id`, [ids, owner, device])
  return ids
}
async function group(owner: string, members: string[]) {
  const chat = randomUUID()
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Batch roster',$2)", [chat, owner])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role)
    SELECT $1,id,CASE WHEN id=$2 THEN 'owner' ELSE 'member' END FROM unnest($3::text[]) id`, [chat, owner, [owner, ...members]])
  return chat
}
async function clear() {
  await db.query('RESET ROLE')
  await db.query('DELETE FROM chat.account_revisions')
}
async function revisions(event: string, chat: string) {
  await db.query('RESET ROLE')
  const { rows } = await db.query<Revision>(
    `SELECT user_id,resource_key,tombstone FROM chat.account_revisions
      WHERE event=$1 AND resource_key->>'chat_id'=$2 ORDER BY user_id,revision`, [event, chat])
  return rows
}
// recipient -> the seat its one revision names
function named(rows: Revision[]) {
  expect(rows.every(row => row.resource_key.kind === 'roster' && !row.tombstone)).toBe(true)
  expect(new Set(rows.map(row => row.user_id)).size).toBe(rows.length)
  return Object.fromEntries(rows.map(row => [row.user_id, row.resource_key.user_id]))
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('batchRosterRevisions requires a disposable loopback database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => { await db.query('BEGIN') })
afterEach(async () => { await db.query('ROLLBACK') })

describe('one roster revision per recipient per statement', () => {
  it('seats several people with one revision each: a newcomer names itself, a member the first new seat', async () => {
    const [owner, member, ...newcomers] = await humans(5)
    const chat = await group(owner!, [member!])
    await clear()
    await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) SELECT $1,id,'member' FROM unnest($2::text[]) id`, [chat, newcomers])
    const first = [...newcomers].sort()[0]
    expect(named(await revisions('chat_members_changed', chat))).toEqual({
      [owner!]: first, [member!]: first,
      ...Object.fromEntries(newcomers.map(id => [id, id])),
    })
  })

  it('keeps the single-seat revision: everyone hears the seat that joined', async () => {
    const [owner, member, newcomer] = await humans(3)
    const chat = await group(owner!, [member!])
    await clear()
    await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')`, [chat, newcomer])
    expect(named(await revisions('chat_members_changed', chat))).toEqual({ [owner!]: newcomer, [member!]: newcomer, [newcomer!]: newcomer })
  })

  it('publishes a multi-seat role change once per recipient and leaves private state row level', async () => {
    const [owner, a, b, c] = await humans(4)
    const chat = await group(owner!, [a!, b!, c!])
    await clear()
    await db.query(`UPDATE chat.chat_members SET role='admin' WHERE chat_id=$1 AND user_id = ANY($2::text[])`, [chat, [a, b]])
    const first = [a!, b!].sort()[0]
    expect(named(await revisions('chat_members_changed', chat))).toEqual({ [owner!]: first, [a!]: a, [b!]: b, [c!]: first })
    await clear()
    await db.query(`UPDATE chat.chat_members SET is_pinned=true WHERE chat_id=$1`, [chat])
    const own = await revisions('chat_members_changed', chat)
    expect(own.map(row => [row.user_id, row.resource_key.user_id, row.resource_key.kind]))
      .toEqual([owner!, a!, b!, c!].sort().map(id => [id, id, 'own']))
  })

  it('opens a topic with one roster revision per participant and one source-line notice per source member', async () => {
    const [owner, ...others] = await humans(6)
    const chat = await group(owner!, others)
    const message = randomUUID()
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,'Topic source','text')`, [message, chat, owner])
    await clear()
    await asUser(owner!)
    const { rows: [topic] } = await db.query<{ chat_id: string }>('SELECT chat_id FROM chat.create_topic($1,$2,$3,$4)', [chat, message, 'Batch', others])
    const roster = named(await revisions('chat_members_changed', topic!.chat_id))
    expect(Object.keys(roster).sort()).toEqual([owner!, ...others].sort())
    expect(Object.entries(roster).every(([recipient, seat]) => recipient === seat)).toBe(true)
    const notices = (await revisions('chat_changed', chat)).filter(row => (row.resource_key as { entity_id?: string }).entity_id === topic!.chat_id)
    // the topic's creation and its seats: two notices per source member, whatever the number of seats
    expect(notices.map(row => row.user_id).sort()).toEqual([owner!, ...others, owner!, ...others].sort())
  })

  it('pulls several mentioned people into a topic with one revision each', async () => {
    const [owner, ...others] = await humans(5)
    const chat = await group(owner!, others)
    const message = randomUUID()
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,'Topic source','text')`, [message, chat, owner])
    await asUser(owner!)
    const { rows: [topic] } = await db.query<{ chat_id: string }>('SELECT chat_id FROM chat.create_topic($1,$2,$3,$4)', [chat, message, 'Batch', []])
    await clear()
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,to_user_ids) VALUES($1,$2,$3,'Pull in','text',$4)`,
      [randomUUID(), topic!.chat_id, owner, others])
    const first = [...others].sort()[0]
    expect(named(await revisions('chat_members_changed', topic!.chat_id))).toEqual({
      [owner!]: first, ...Object.fromEntries(others.map(id => [id, id])),
    })
  })

  it('creates a group with its initial agents in one statement, flood rule included', async () => {
    const [owner] = await humans(1)
    const agents = await agentsOf(owner!, 7)
    const chat = randomUUID()
    await clear()
    await asUser(owner!)
    await db.query('SELECT chat.create_gugu_group($1,$2,$3,$4)', [chat, 'Batch', owner, JSON.stringify(agents.map(user_id => ({ user_id })))])
    await db.query('RESET ROLE')
    const { rows: seats } = await db.query<{ user_id: string; listen_mode: string }>(
      'SELECT user_id, listen_mode FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id', [chat])
    expect(seats.map(seat => seat.user_id)).toEqual([owner!, ...agents].sort())
    expect(seats.filter(seat => agents.includes(seat.user_id)).every(seat => seat.listen_mode === 'passive')).toBe(true)
    // the owner's seat, the initial agents, the flood rule's passive switch
    const rows = await revisions('chat_members_changed', chat)
    expect(rows.map(row => [row.user_id, row.resource_key.user_id])).toEqual([[owner, owner], [owner, agents[0]], [owner, agents[0]]])
  })

  it('seats a repeated initial member once, with its first role', async () => {
    const [owner] = await humans(1)
    const [agent] = await agentsOf(owner!, 1)
    const chat = randomUUID()
    await asUser(owner!)
    await db.query('SELECT chat.create_gugu_group($1,$2,$3,$4)', [chat, 'Batch', owner,
      JSON.stringify([{ user_id: agent, role: 'admin' }, { user_id: agent, role: 'member' }, { user_id: owner }])])
    await db.query('RESET ROLE')
    const { rows } = await db.query<{ user_id: string; role: string }>('SELECT user_id, role FROM chat.chat_members WHERE chat_id=$1 ORDER BY role', [chat])
    expect(rows).toEqual([{ user_id: agent, role: 'admin' }, { user_id: owner, role: 'owner' }])
  })
})
