import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Joining a topic by speaking in it or being mentioned (join_topic_participants, BEFORE INSERT on messages) inserts the
// topic membership first; that row's AFTER trigger (auto_passive_on_agent_flood -> apply_agent_flood_rule) only then
// locks the topic's chats row. A message whose join already took the chats row, and that then inserts the same
// membership (a mention), waits on the first one's uncommitted membership while the first waits on the chats row:
// 40P01 (seen under concurrent topic sends). The interleaving is driven deterministically: B holds the topic row from a
// first join, A joins and parks on that row, then B mentions A's sender.
interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client: PgClient } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => Client }
const url = (process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '').trim()
const clients: Client[] = []
let admin: Client
let users: string[], group: string, topic: string
const insert = `INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,client_message_id,to_user_ids)
  VALUES ($1,$2,$3,'topic join','text',$1,$4)`

async function connect(): Promise<Client> {
  const client = new PgClient({ connectionString: url })
  await client.connect()
  clients.push(client)
  await client.query("SET statement_timeout = '10s'")
  return client
}
const pidOf = async (client: Client) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
async function blockedBy(pid: number, blocker: number, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const { rows } = await admin.query<{ blocked: boolean }>('SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked', [pid, blocker])
    if (rows[0]!.blocked) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`RIG-FAIL: ${what}`)
}
const outcome = (run: Promise<unknown>) => run.then(() => null, (error: { code?: string; message?: string }) => error.code ?? error.message ?? 'error')

beforeAll(async () => {
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
    throw new Error('topicJoinLockOrder requires a disposable loopback PostgreSQL database')
  }
  admin = await connect()
  users = Array.from({ length: 3 }, () => randomUUID())
  group = randomUUID()
  const anchor = randomUUID()
  await admin.query(`INSERT INTO identity.users(id,type,display_name) SELECT id,'human','topic join' FROM unnest($1::text[]) id`, [users])
  await admin.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','topic join',$2)`, [group, users[0]])
  await admin.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) SELECT $1,id,CASE WHEN id=$2 THEN 'owner' ELSE 'member' END FROM unnest($3::text[]) id`, [group, users[0], users])
  await admin.query(insert, [anchor, group, users[0], null])
  await admin.query('BEGIN')
  await admin.query(`SELECT set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: users[0], role: 'authenticated' })])
  topic = (await admin.query<{ chat_id: string }>(`SELECT chat_id FROM chat.create_topic($1,$2,'topic join',NULL,NULL)`, [group, anchor])).rows[0]!.chat_id
  await admin.query('COMMIT')
})
afterAll(async () => {
  await admin.query('DELETE FROM chat.chats WHERE id=ANY($1::text[])', [[topic, group]])
  await admin.query('DELETE FROM identity.users WHERE id=ANY($1::text[])', [users])
  await admin.query('DELETE FROM chat.account_revision_heads WHERE user_id=ANY($1::text[])', [users])
  await Promise.all(clients.map((client) => client.end()))
})

describe('topic join lock order', () => {
  it('a new speaker and a mention of that speaker in one topic both commit', async () => {
    const [, joiner, mentioner] = users as [string, string, string]
    const a = await connect(), b = await connect()
    const [aPid, bPid] = await Promise.all([pidOf(a), pidOf(b)])
    expect((await admin.query('SELECT user_id FROM chat.chat_members WHERE chat_id=$1 AND user_id=ANY($2::text[])', [topic, [joiner, mentioner]])).rows).toEqual([])
    await b.query('BEGIN')
    await b.query(insert, [randomUUID(), topic, mentioner, null]) // B joins the topic by speaking: holds the topic row
    await a.query('BEGIN')
    const aSend = outcome(a.query(insert, [randomUUID(), topic, joiner, null]).then(() => a.query('COMMIT')))
    await blockedBy(aPid, bPid, 'the new speaker never waited on the topic row')
    const bSend = outcome(b.query(insert, [randomUUID(), topic, mentioner, [joiner]]).then(() => b.query('COMMIT')))
    const outcomes = { mention: await bSend, speaker: await aSend }
    console.info(JSON.stringify(outcomes))
    if (outcomes.mention) await b.query('ROLLBACK')
    if (outcomes.speaker) await a.query('ROLLBACK')
    expect(outcomes).toEqual({ mention: null, speaker: null })
    const { rows } = await admin.query<{ user_id: string }>('SELECT user_id FROM chat.chat_members WHERE chat_id=$1 AND user_id=ANY($2::text[]) ORDER BY user_id', [topic, [joiner, mentioner]])
    expect(rows.map((row) => row.user_id)).toEqual([joiner, mentioner].sort())
    const { rows: seqs } = await admin.query<{ seq: string }>('SELECT seq FROM chat.messages WHERE chat_id=$1 ORDER BY seq', [topic])
    expect(seqs.map((row) => Number(row.seq)).every((seq, i, all) => i === 0 || seq === all[i - 1]! + 1)).toBe(true)
  })
})
