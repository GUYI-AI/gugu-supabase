import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
const { Client: PgClient } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => Client }
let db: Client
const OWNER = '60360000-0000-4000-8000-000000000001'
const OTHER = '60360000-0000-4000-8000-000000000002'
const AGENT = '60360000-0000-4000-8000-000000000003'
const FIRST = '60360000-0000-4000-8000-000000000004'
const LAST = '60360000-0000-4000-8000-000000000005'
interface Row { id: string; chat_id: string; seq: number; scan_max_ingest_seq: string; content: string }
// The RPC's default page, and the smallest seed that proves each claim: one page plus one of rows that do not wake the agent
// (they would fill a page if they counted), and a backlog that a small page has to walk over more than ten pages.
const DEFAULT_PAGE = 80
const SKIP = DEFAULT_PAGE + 1
const BACKLOG = DEFAULT_PAGE
const PAGE = 8

beforeAll(async () => {
  const connectionString = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('agentInboxPagination6036 requires loopback PostgreSQL')
  }
  db = new PgClient({ connectionString })
  await db.connect()
  await db.query("SET statement_timeout = '10s'")
})
afterAll(async () => { await db?.end() })

async function rollback(body: () => Promise<void>): Promise<void> {
  await db.query('BEGIN')
  try { await body() } finally { await db.query('ROLLBACK') }
}
async function asOwner(): Promise<void> {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: OWNER, role: 'authenticated' })])
}
// SKIP 条 'skip' 是 passive 成员的群内无点名消息:#6077 起它们不唤醒这个 agent,RPC 根本不返回。
// backlog 条 'backlog' 是点名给它的积压,用 PAGE 大小的页把分页真的撑过十页。
async function seed(backlog = BACKLOG): Promise<void> {
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','owner'),($2,'human','other')", [OWNER, OTHER])
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES ('inbox-6036',$1,'test','mac1','darwin')", [OWNER])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES ($1,'agent','reader',$2,'inbox-6036')", [AGENT, OWNER])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','skip-prefix',$3),($2,'dm','later-dm',$3)", [FIRST, LAST, OWNER])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role,listen_mode) SELECT c,u,'member','passive' FROM unnest($1::text[]) c CROSS JOIN unnest($2::text[]) u", [[FIRST, LAST], [OWNER, OTHER, AGENT]])
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) SELECT '6036-skip-'||n,$1,$2,'skip','text' FROM generate_series(1,$3::int) n", [FIRST, OTHER, SKIP])
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,to_user_ids) SELECT '6036-row-'||n,$1,$2,'backlog','text',ARRAY[$3] FROM generate_series(1,$4::int) n", [FIRST, OTHER, AGENT, backlog])
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,to_user_ids) VALUES ('6036-at',$1,$3,'mention','text',ARRAY[$4]),('6036-dm',$2,$3,'dm','text',ARRAY[$4])", [FIRST, LAST, OWNER, AGENT])
  await db.query('ANALYZE chat.messages; ANALYZE chat.chat_members; ANALYZE identity.users')
}
async function page(cursor?: Row, fence?: string, limit = DEFAULT_PAGE): Promise<Row[]> {
  return (await db.query<Row>('SELECT * FROM identity.pull_agent_inbox_v2($1,NULL,NULL,$2,$3,$4)', [AGENT, limit, cursor ? { chat_id: cursor.chat_id, seq: cursor.seq } : null, fence ?? null])).rows
}

describe('#6036 agent inbox pagination (pull_agent_inbox_v2)', () => {
  it('rows that do not wake the agent never occupy a page: the @ and the DM are the whole first page', async () => rollback(async () => {
    await seed(0)
    await asOwner()
    expect((await page()).map((row) => row.id)).toEqual(['6036-at', '6036-dm'])
  }))

  it('scans over ten pages without writes under one ingest fence, and preserves precise reads', async () => rollback(async () => {
    await seed()
    await asOwner()
    const first = await db.query<Row>('SELECT * FROM identity.pull_agent_inbox_v2($1)', [AGENT])
    expect(first.rows).toHaveLength(DEFAULT_PAGE)
    expect(first.rows.every((row) => row.content === 'backlog')).toBe(true)
    const seen: Row[] = []
    let cursor: Row | undefined
    let fence: string | undefined
    for (;;) {
      const rows = await page(cursor, fence, PAGE)
      seen.push(...rows)
      if (rows.length < PAGE) break
      cursor = rows.at(-1)!
      fence ??= cursor.scan_max_ingest_seq
      expect(rows.every((row) => row.scan_max_ingest_seq === fence)).toBe(true)
    }
    expect(seen.length).toBeGreaterThan(10 * PAGE)
    expect(seen).toHaveLength(BACKLOG + 2)
    expect(seen.some((row) => row.content === 'skip')).toBe(false)
    expect(seen.slice(-2).map((row) => row.id)).toEqual(['6036-at', '6036-dm'])
    expect(Number(seen.at(-1)!.seq)).toBe(1)
    expect((await page()).map((row) => row.id)).toEqual(first.rows.map((row) => row.id))
    await db.query('SELECT identity.mark_read_on_deliver($1,$2,$3)', [FIRST, '6036-at', AGENT])
    const after = await db.query<Row>('SELECT * FROM identity.pull_agent_inbox_v2($1,$2,NULL,1000)', [AGENT, FIRST])
    expect(after.rows).toHaveLength(BACKLOG)
    expect(after.rows.some((row) => row.id === '6036-at')).toBe(false)
    expect((await db.query<{ last_read_seq: string }>('SELECT last_read_seq FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [FIRST, AGENT])).rows[0]!.last_read_seq).toBe('0')
  }))

  it('keeps membership, join-time, whisper and ownership gates on every page', async () => rollback(async () => {
    await seed()
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,to_user_ids,is_whisper,created_at) VALUES ('6036-hidden',$1,$2,'private','text',ARRAY[$3],true,now()),('6036-old',$1,$2,'history','text',ARRAY[$3],false,now()-interval '1 day')", [LAST, OWNER, OTHER])
    await asOwner()
    const rows = await db.query<Row>('SELECT * FROM identity.pull_agent_inbox_v2($1,$2,NULL,80,$3,NULL)', [AGENT, LAST, { chat_id: FIRST, seq: SKIP }])
    expect(rows.rows.map((row) => row.id)).toEqual(['6036-dm'])
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: OTHER, role: 'authenticated' })])
    await expect(page()).rejects.toThrow('not authorized')
  }))
})
