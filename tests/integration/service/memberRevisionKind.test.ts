import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

interface Database {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => Database
}
type Revision = { user_id: string; resource_key: { kind?: string }; tombstone: boolean }
let db: Database
let owner: string, peer: string, viewer: string, agent: string, group: string, message: string, seq: string

async function asUser(userId: string) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: 'authenticated' })])
}
async function clearRevisions() {
  await db.query('RESET ROLE')
  await db.query("DELETE FROM chat.account_revisions WHERE resource_key->>'chat_id'=$1", [group])
}
async function revisions(event = 'chat_members_changed') {
  await db.query('RESET ROLE')
  const { rows } = await db.query<Revision>(
    `SELECT user_id,resource_key,tombstone FROM chat.account_revisions
     WHERE event=$1 AND resource_key->>'chat_id'=$2 ORDER BY user_id,revision`, [event, group])
  console.info(JSON.stringify({ event, rows }))
  return rows
}
function fanout(rows: Revision[], recipients: string[], tombstone = false) {
  expect(rows.map(row => row.user_id)).toEqual([...recipients].sort())
  expect(rows.map(row => row.tombstone)).toEqual(recipients.map(() => tombstone))
}
async function markPeerRead() {
  await asUser(peer)
  await db.query('SELECT * FROM chat.mark_stream_read($1,$2,$3)', [group, `main:${group}`, seq])
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('memberRevisionKind requires a disposable loopback database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); peer = randomUUID(); viewer = randomUUID()
  agent = randomUUID(); group = randomUUID(); message = randomUUID()
  for (const id of [owner, peer, viewer]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, `${id}@membership-revision.invalid`])
    await db.query(`INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Revision fixture') ON CONFLICT(id) DO NOTHING`, [id])
  }
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'Revision fixture','fixture','linux')`, [`device-${peer}`, peer])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id)
    VALUES($1,'agent','Revision agent',$2,$3)`, [agent, peer, `device-${peer}`])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Revision kinds',$2)", [group, owner])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role)
    SELECT $1,id,CASE WHEN id=$2 THEN 'owner' ELSE 'member' END FROM unnest($3::text[]) id`, [group, owner, [owner, peer, viewer, agent]])
  seq = (await db.query<{ seq: string }>(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type)
    VALUES($1,$2,$3,'Read revision fixture','text') RETURNING seq`, [message, group, owner])).rows[0]!.seq
  await clearRevisions()
})
afterEach(async () => {
  try { await db.query('RESET ROLE'); await db.query('SET CONSTRAINTS ALL IMMEDIATE') }
  finally { await db.query('ROLLBACK') }
})

describe('private member state revision budget', () => {
  it('marks a human stream read without broadcasting a roster revision to peers', async () => {
    await markPeerRead()
    const rows = await revisions()
    fanout(rows, [peer])
    expect(rows[0]!.resource_key.kind).toBe('own')
  })

  it('uses the owner token for an agent receipt and notifies only that agent of own state', async () => {
    await asUser(peer)
    await db.query('SELECT identity.mark_read_on_deliver($1,$2,$3)', [group, message, agent])
    const rows = await revisions()
    fanout(rows, [agent])
    expect(rows[0]!.resource_key.kind).toBe('own')
  })

  it('keeps a private pin change with its row owner', async () => {
    await asUser(peer)
    await db.query('UPDATE chat.chat_members SET is_pinned=true WHERE chat_id=$1 AND user_id=$2', [group, peer])
    const rows = await revisions()
    fanout(rows, [peer])
    expect(rows[0]!.resource_key.kind).toBe('own')
  })
})

describe('roster and read receipt fanout controls', () => {
  it('preserves role change recipients', async () => {
    await asUser(owner)
    await db.query("UPDATE chat.chat_members SET role='admin' WHERE chat_id=$1 AND user_id=$2", [group, peer])
    fanout(await revisions(), [owner, peer, viewer, agent])
  })

  it('preserves listen mode change recipients', async () => {
    await asUser(peer)
    await db.query("UPDATE chat.chat_members SET listen_mode='passive' WHERE chat_id=$1 AND user_id=$2", [group, agent])
    fanout(await revisions(), [owner, peer, viewer, agent])
  })

  it('preserves join recipients and the leaving row owner tombstone', async () => {
    const newcomer = randomUUID()
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','New member')", [newcomer])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [group, newcomer])
    fanout(await revisions(), [owner, peer, viewer, agent, newcomer])
    await clearRevisions()
    await asUser(peer)
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [group, peer])
    fanout(await revisions(), [owner, peer, viewer, agent, newcomer], true)
  })

  it('still broadcasts the independent read-watermark revision to every member', async () => {
    await markPeerRead()
    fanout(await revisions('member_read_changed'), [owner, peer, viewer, agent])
  })

  it('labels roster updates explicitly without changing their recipients', async () => {
    await asUser(owner)
    await db.query("UPDATE chat.chat_members SET role='admin' WHERE chat_id=$1 AND user_id=$2", [group, peer])
    const rows = await revisions()
    fanout(rows, [owner, peer, viewer, agent])
    expect(rows.every(row => row.resource_key.kind === 'roster')).toBe(true)
  })
})
