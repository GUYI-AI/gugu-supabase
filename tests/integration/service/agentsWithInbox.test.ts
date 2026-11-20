import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
const { Client: PgClient } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => Client }
let db: Client
const OWNER = '33360000-0000-4000-8000-000000000001'
const OTHER = '33360000-0000-4000-8000-000000000002'
const NAMED = '33360000-0000-4000-8000-000000000003'
const QUIET = '33360000-0000-4000-8000-000000000004'
const DONE = '33360000-0000-4000-8000-000000000005'
const FOREIGN = '33360000-0000-4000-8000-000000000006'
const GROUP = '33360000-0000-4000-8000-000000000007'
const AGENTS = [NAMED, QUIET, DONE, FOREIGN]

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('agentsWithInbox requires loopback PostgreSQL')
  }
  db = new PgClient({ connectionString: url.href })
  await db.connect()
  await db.query("SET statement_timeout = '10s'")
})
afterAll(async () => { await db?.end() })

async function rollback(body: () => Promise<void>): Promise<void> {
  await db.query('BEGIN')
  try { await body() } finally { await db.query('ROLLBACK') }
}
async function as(user: string): Promise<void> {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
}
async function seed(): Promise<void> {
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','owner'),($2,'human','other')", [OWNER, OTHER])
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES ('inbox-3336',$1,'test','host','linux'),('inbox-3336-other',$2,'test','other','linux')`, [OWNER, OTHER])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id)
    VALUES ($1,'agent','named',$4,'inbox-3336'),($2,'agent','quiet',$4,'inbox-3336'),($3,'agent','done',$4,'inbox-3336'),($5,'agent','foreign',$6,'inbox-3336-other')`,
  [NAMED, QUIET, DONE, OWNER, FOREIGN, OTHER])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','3336',$2)", [GROUP, OTHER])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role,listen_mode) SELECT $1,u,'member','passive' FROM unnest($2::text[]) u",
    [GROUP, [OWNER, OTHER, ...AGENTS]])
  // One message names NAMED, DONE and FOREIGN; QUIET is passive and unnamed, so nothing wakes it.
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,to_user_ids) VALUES ('3336-at',$1,$2,'hi','text',$3)",
    [GROUP, OTHER, [NAMED, DONE, FOREIGN]])
  // DONE already read it (the reader's precise read row).
  await db.query("INSERT INTO chat.message_deliveries(message_id,device_id,status) VALUES ('3336-at','gugu-agent:'||$1,'read')", [DONE])
}
async function roster(): Promise<string[]> {
  return (await db.query<{ agent_user_id: string }>('SELECT agent_user_id FROM identity.agents_with_inbox($1::text[])', [AGENTS])).rows
    .map((row) => row.agent_user_id).sort()
}
async function pulled(agent: string): Promise<boolean> {
  return (await db.query('SELECT 1 FROM identity.pull_agent_inbox_v2($1)', [agent])).rows.length > 0
}

describe('identity.agents_with_inbox: one roster read for a waking host', () => {
  it('names exactly the owned agents pull_agent_inbox_v2 has rows for', async () => rollback(async () => {
    await seed()
    await as(OWNER)
    expect(await roster()).toEqual([NAMED])
    for (const agent of [NAMED, QUIET, DONE]) expect(await pulled(agent)).toBe(agent === NAMED)
  }))

  it('drops an archived agent, as pull_agent_inbox_v2 does', async () => rollback(async () => {
    await seed()
    await db.query('UPDATE identity.users SET session_archived_at=now() WHERE id=$1', [NAMED])
    await as(OWNER)
    expect(await roster()).toEqual([])
  }))

  it('is closed to anonymous callers', async () => rollback(async () => {
    await db.query('SET LOCAL ROLE anon')
    await expect(db.query('SELECT * FROM identity.agents_with_inbox($1::text[])', [AGENTS])).rejects.toThrow(/permission denied/)
  }))
})
