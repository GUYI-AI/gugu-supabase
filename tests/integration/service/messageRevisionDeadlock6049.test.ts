import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface Result<Row> { rows: Row[] }
interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<Result<Row>>
}
const { Client: PgClient } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => Client
}
const url = (process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '').trim()
let admin: Client
const clients: Client[] = []
const insert = `INSERT INTO chat.messages
  (id, chat_id, sender_user_id, content, content_type, client_message_id, to_user_ids, is_whisper)
  VALUES ($1,$2,$3,'revision lock regression','text',$1,$4,$5) RETURNING id, seq`

async function connect(): Promise<Client> {
  const client = new PgClient({ connectionString: url })
  await client.connect()
  clients.push(client)
  await client.query("SET statement_timeout = '10s'")
  return client
}
beforeAll(async () => {
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
    throw new Error('messageRevisionDeadlock6049 requires a disposable loopback PostgreSQL database')
  }
  admin = await connect()
})
afterAll(async () => { await Promise.all(clients.map((client) => client.end())) })

interface Fixture { users: string[]; group: string; topic: string; high: string; low: string; middle: string }
async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const suffix = randomUUID().slice(8)
  const users = ['10006049', '50006049', '90006049'].map((prefix) => prefix + suffix)
  const [low, middle, high] = users as [string, string, string]
  const group = randomUUID(), anchor = randomUUID()
  let topic = ''
  try {
    await admin.query(`INSERT INTO identity.users(id,type,display_name)
      SELECT id,'human','6049 fixture' FROM unnest($1::text[]) AS id`, [users])
    await admin.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id)
      VALUES ($1,'group','6049 source',$2)`, [group, high])
    await admin.query(`INSERT INTO chat.chat_members(chat_id,user_id,role)
      SELECT $1,id,CASE WHEN id=$2 THEN 'owner' ELSE 'member' END FROM unnest($3::text[]) AS id`, [group, high, users])
    await admin.query(insert, [anchor, group, high, null, false])
    await admin.query('BEGIN')
    await admin.query(`SELECT set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: high, role: 'authenticated' })])
    topic = (await admin.query<{ chat_id: string }>(
      `SELECT chat_id FROM chat.create_topic($1,$2,'6049 topic',NULL,NULL)`, [group, anchor],
    )).rows[0]!.chat_id
    await admin.query('COMMIT')
    expect((await admin.query(`SELECT user_id FROM chat.chat_members WHERE chat_id=$1`, [topic])).rows)
      .toEqual([{ user_id: high }])
    await body({ users, group, topic, high, low, middle })
  } finally {
    await admin.query('ROLLBACK')
    // Committed fixtures are necessary for separate connections. Teardown also
    // removes the journal heads (they deliberately have no identity FK).
    await admin.query('DELETE FROM chat.chats WHERE id=ANY($1::text[])', [[topic, group]])
    await admin.query('DELETE FROM identity.users WHERE id=ANY($1::text[])', [users])
    await admin.query('DELETE FROM chat.account_revision_heads WHERE user_id=ANY($1::text[])', [users])
  }
}

async function waitUntilBlocked(pid: number, blocker: number): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const { rows } = await admin.query<{ blocked: boolean }>(
      'SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked', [pid, blocker],
    )
    if (rows[0]!.blocked) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('RIG-FAIL: topic never reached the competing source transaction')
}

interface SendResult { id: string; chat: string; sender: string; targets: string[] | null; error?: { code?: string; message: string } }
async function send(client: Client, chat: string, sender: string, targets: string[] | null = null, transaction = false): Promise<SendResult> {
  const id = randomUUID()
  try {
    await client.query(insert, [id, chat, sender, targets, false])
    if (transaction) await client.query('COMMIT')
    return { id, chat, sender, targets }
  } catch (error) {
    if (transaction) await client.query('ROLLBACK')
    return { id, chat, sender, targets, error: error as SendResult['error'] }
  }
}

async function verifySends(results: SendResult[]): Promise<void> {
  for (const result of results) {
    const count = async () => Number((await admin.query<{ count: string }>(
      'SELECT count(*) FROM chat.messages WHERE id=$1 OR client_message_id=$1', [result.id],
    )).rows[0]!.count)
    if (result.error) {
      // On the pre-fix control this exercises the actual deadlock victim's
      // rollback and exact-ID retry; no new UUID can conceal a duplicate.
      expect(await count()).toBe(0)
      await admin.query(insert, [result.id, result.chat, result.sender, result.targets, false])
      expect(await count()).toBe(1)
    } else {
      expect(await count()).toBe(1)
    }
  }
  expect(results.filter((result) => result.error).map(({ id, error }) => ({ id, code: error?.code, message: error?.message }))).toEqual([])
}

describe('message revision lock order #6049', () => {
  for (const firstJoin of ['none', 'mention', 'sender'] as const) {
    it(`source/topic contention, including topic membership before sequence assignment: join=${firstJoin}`, async () => {
      await withFixture(async (f) => {
        const source = await connect(), topic = await connect()
        const sourcePid = (await source.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
        const topicPid = (await topic.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
        await source.query('BEGIN')
        await topic.query('BEGIN')
        // Stop the source fan-out immediately after its first recipient. The
        // messages themselves use the ordinary, unmodified INSERT path.
        await source.query('SELECT 1 FROM chat.account_revision_heads WHERE user_id=$1 FOR NO KEY UPDATE', [f.low])
        const topicSend = send(topic, f.topic, firstJoin === 'sender' ? f.middle : f.high, firstJoin === 'mention' ? [f.middle] : null, true)
        try {
          await waitUntilBlocked(topicPid, sourcePid)
          const results = await Promise.all([topicSend, send(source, f.group, f.high, null, true)])
          await verifySends(results)
          if (firstJoin !== 'none') {
            expect((await admin.query('SELECT user_id FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [f.topic, f.middle])).rows)
              .toEqual([{ user_id: f.middle }])
          }
        } finally {
          await source.query('ROLLBACK')
          await topicSend
          await topic.query('ROLLBACK')
        }
      })
    }, 30_000)
  }

  it('ordinary concurrent sends keep unique IDs, contiguous sequences and per-account revisions', async () => {
    await withFixture(async (f) => {
      const source = await connect(), topic = await connect()
      const results: SendResult[] = []
      for (let round = 0; round < 30; round++) {
        results.push(...await Promise.all([send(source, f.group, f.high), send(topic, f.topic, f.high)]))
      }
      await verifySends(results)
      const { rows } = await admin.query<{ valid: boolean }>(`SELECT
        count(*)=count(DISTINCT seq) AND max(seq)-min(seq)+1=count(*) AS valid
        FROM chat.messages WHERE chat_id=ANY($1::text[]) GROUP BY chat_id`, [[f.group, f.topic]])
      expect(rows).toEqual([{ valid: true }, { valid: true }])
      const revisions = await admin.query<{ valid: boolean }>(`SELECT
        count(*)=max(revision) AND count(*)=count(DISTINCT revision) AS valid
        FROM chat.account_revisions WHERE user_id=ANY($1::text[]) GROUP BY user_id`, [f.users])
      expect(revisions.rows).toEqual(f.users.map(() => ({ valid: true })))
      // The broader lock set must not broaden message notification recipients.
      const recipients = await admin.query<{ user_id: string }>(`SELECT DISTINCT user_id
        FROM chat.account_revisions WHERE event='message_created' AND resource_key->>'chat_id'=$1 ORDER BY user_id`, [f.topic])
      expect(recipients.rows).toEqual([{ user_id: f.high }])
    })
  }, 30_000)

  it('whisper fan-out and explicit helper ACL remain unchanged', async () => {
    await withFixture(async (f) => {
      const id = randomUUID()
      await admin.query(insert, [id, f.group, f.high, [f.middle], true])
      const { rows } = await admin.query<{ user_id: string }>(`SELECT user_id
        FROM chat.account_revisions WHERE event='message_created' AND resource_key->>'entity_id'=$1 ORDER BY user_id`, [id])
      expect(rows).toEqual([{ user_id: f.middle }, { user_id: f.high }])
      const acl = await admin.query<{ allowed: boolean }>(`SELECT has_function_privilege(role,
        'chat.lock_chat_revision_recipients(text,text[])', 'EXECUTE') AS allowed
        FROM unnest(ARRAY['anon','authenticated','service_role']) AS role`)
      expect(acl.rows).toEqual([{ allowed: false }, { allowed: false }, { allowed: true }])
    })
  })
})
