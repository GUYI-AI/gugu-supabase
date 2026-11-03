import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** Archive keeps every historical row, including exclusive DMs and sender identity.
 * The legacy owned-agent entry delegates to archive; no per-message cleanup remains.
 * Transactional loopback fixture; authenticated RPC with privileged read-back only.
 */

interface QueryResult<Row> { rows: Row[] }
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>
}

const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}

const DATABASE_URL = (
  process.env.GUGU_INTEGRATION_DATABASE_URL
  ?? process.env.GUGU_DATABASE_URL
  ?? ''
).trim()

const OWNER = '59190000-0000-4000-8000-000000000001'
const BYSTANDER = '59190000-0000-4000-8000-000000000002'
const AGENT = 'agent-it-5919'
const DEVICE = 'dev-it-5919'
const GROUP = '59190000-0000-4000-8000-000000000003'
const DM = '59190000-0000-4000-8000-000000000004'

let database: DatabaseClient

function requireLoopbackDatabase(): void {
  let parsed: URL
  try {
    parsed = new URL(DATABASE_URL)
  } catch {
    throw new Error('GUGU_INTEGRATION_DATABASE_URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`agentRemovalKeepsMessages5919.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`agentRemovalKeepsMessages5919.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

beforeAll(async () => {
  requireLoopbackDatabase()
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})

afterAll(async () => {
  await database?.end()
})

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

async function seed(): Promise<void> {
  await database.query(
    `INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','owner'),($2,'human','bystander')`,
    [OWNER, BYSTANDER],
  )
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
     VALUES ($1, $2, 'it-5919', 'it-5919', 'darwin')`,
    [DEVICE, OWNER],
  )
  await database.query(
    `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent','agent',$2,$3)`,
    [AGENT, OWNER, DEVICE],
  )
  await database.query(
    `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','shared',$3),($2,'dm',NULL,$3)`,
    [GROUP, DM, OWNER],
  )
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role)
     VALUES ($1,$3,'owner'),($1,$4,'member'),($1,$5,'member'),($2,$3,'owner'),($2,$5,'member')`,
    [GROUP, DM, OWNER, BYSTANDER, AGENT],
  )
  const messages: Array<[string, string, string, string[] | null, string | null, string[]]> = [
    ['m1', GROUP, OWNER, [AGENT], null, []],
    ['m2', GROUP, AGENT, [OWNER], null, [BYSTANDER]],
    ['m3', GROUP, BYSTANDER, null, null, [AGENT]],
    ['m4', GROUP, BYSTANDER, null, 'm2', []],
    ['m5', DM, OWNER, [AGENT], null, []],
  ]
  for (const [id, chatId, sender, to, replyTo, deletedFor] of messages) {
    await database.query(
      `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids,
                                  reply_to_message_id, deleted_for_user_ids)
       VALUES ($1,$2,$3,$1,'text',$4,$5,$6::jsonb)`,
      [`${id}-it-5919`, chatId, sender, to, replyTo && `${replyTo}-it-5919`, JSON.stringify(deletedFor)],
    )
  }
  await database.query(
    `INSERT INTO chat.message_reactions (message_id, user_id, emoji)
     VALUES ('m3-it-5919',$1,'+1'),('m3-it-5919',$2,'tada'),('m2-it-5919',$3,'heart')`,
    [AGENT, BYSTANDER, OWNER],
  )
  await database.query(
    `INSERT INTO chat.message_deliveries (message_id, device_id, status)
     VALUES ('m3-it-5919',$1,'delivered'),('m2-it-5919',$2,'delivered')
     ON CONFLICT (message_id, device_id) DO NOTHING`,
    [`gugu-agent:${AGENT}`, DEVICE],
  )
}

async function removeAgentAsOwner(): Promise<void> {
  await database.query(
    "SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)",
    [OWNER],
  )
  await database.query('SET LOCAL role authenticated')
  await database.query('SELECT identity.remove_owned_agent($1)', [AGENT])
  await database.query('RESET role')
}

describe('#5919 archive preserves the complete conversation', () => {
  it('retains shared and DM messages, sender IDs, recipients, receipts and reactions byte for byte', async () => {
    await inRollback(async () => {
      await seed()
      const statements = [
        'SELECT * FROM chat.messages WHERE chat_id=ANY($1) ORDER BY id',
        'SELECT * FROM chat.chat_members WHERE chat_id=ANY($1) ORDER BY chat_id,user_id',
        "SELECT * FROM chat.message_reactions WHERE message_id IN ('m2-it-5919','m3-it-5919') ORDER BY message_id,user_id",
        "SELECT * FROM chat.message_deliveries WHERE message_id IN ('m2-it-5919','m3-it-5919') ORDER BY message_id,device_id",
      ]
      const before = []
      for (let i=0;i<statements.length;i++) before.push((await database.query(statements[i], i<2 ? [[GROUP, DM]] : [])).rows)
      expect(before[0]).toHaveLength(5)
      await removeAgentAsOwner()
      for (let i=0;i<statements.length;i++) expect((await database.query(statements[i], i<2 ? [[GROUP, DM]] : [])).rows).toEqual(before[i])
      const identity = await database.query<{ removed_at: Date }>('SELECT removed_at FROM identity.users WHERE id=$1', [AGENT])
      expect(identity.rows).toHaveLength(1)
      expect(identity.rows[0].removed_at).not.toBeNull()
    })
  })
})
