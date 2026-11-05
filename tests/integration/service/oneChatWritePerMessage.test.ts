import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// One published chats change per message: a message in an n-member group writes message_created + chat_changed for
// each member (2n journal rows), not message_created + 2 x chat_changed (3n). Seq allocation keeps its row lock, so
// concurrent inserts still get contiguous, unique seq.
interface Database {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => Database
}
const MEMBERS = 168
let url: URL
let db: Database
let owner: string, group: string, members: string[]

beforeAll(async () => {
  url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('oneChatWritePerMessage requires a disposable loopback database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })

async function seedGroup(client: Database, size: number) {
  const ids = Array.from({ length: size }, () => randomUUID())
  await client.query(`INSERT INTO auth.users(id,email) SELECT id::uuid, id || '@one-chat-write.invalid' FROM unnest($1::text[]) id`, [ids])
  await client.query(`INSERT INTO identity.users(id,type,display_name) SELECT id,'human','One write fixture' FROM unnest($1::text[]) id ON CONFLICT(id) DO NOTHING`, [ids])
  const chat = randomUUID()
  await client.query("INSERT INTO chat.chats(id,kind,name,creator_user_id,max_members) VALUES($1,'group','One write',$2,$3)", [chat, ids[0], size])
  await client.query(`INSERT INTO chat.chat_members(chat_id,user_id,role)
    SELECT $1,id,CASE WHEN id=$2 THEN 'owner' ELSE 'member' END FROM unnest($3::text[]) id`, [chat, ids[0], ids])
  return { chat, ids }
}
async function dropGroup(chat: string, ids: string[]) {
  await db.query('DELETE FROM chat.chats WHERE id=$1', [chat])
  await db.query('DELETE FROM auth.users WHERE id = ANY($1::uuid[])', [ids])
}
async function journal() {
  const { rows } = await db.query<{ event: string; n: number }>(
    `SELECT event, count(*)::int AS n FROM chat.account_revisions WHERE resource_key->>'chat_id'=$1 GROUP BY event ORDER BY event`, [group])
  console.info(JSON.stringify({ journal: rows }))
  return Object.fromEntries(rows.map((row) => [row.event, row.n]))
}

describe('one published chats change per message', () => {
  // Joining 168 members fans out per join; seed once, roll back only each test's messages.
  beforeAll(async () => {
    ;({ chat: group, ids: members } = await seedGroup(db, MEMBERS))
    owner = members[0]!
  }, 120_000)
  afterAll(() => dropGroup(group, members))
  beforeEach(async () => {
    await db.query('BEGIN')
    await db.query("DELETE FROM chat.account_revisions WHERE resource_key->>'chat_id'=$1", [group])
  })
  afterEach(async () => { await db.query('ROLLBACK') })

  it(`a message in a ${MEMBERS}-member group writes exactly 2 x members journal rows`, async () => {
    const { rows: [sent] } = await db.query<{ seq: string }>(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type)
      VALUES($1,$2,$3,'hello everyone','text') RETURNING seq`, [randomUUID(), group, owner])
    expect(await journal()).toEqual({ chat_changed: MEMBERS, message_created: MEMBERS })
    const { rows: [chat] } = await db.query<{ next_message_seq: string; last_message_preview: string }>(
      'SELECT next_message_seq, last_message_preview FROM chat.chats WHERE id=$1', [group])
    // The one chat_changed carries both facts the client reads from the chats row.
    expect(Number(chat!.next_message_seq)).toBe(Number(sent!.seq) + 1)
    expect(chat!.last_message_preview).toBe('hello everyone')
  })

  it('a whisper still tells every member the new seq once, and leaves the shared preview alone', async () => {
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,'public','text')`, [randomUUID(), group, owner])
    await db.query("DELETE FROM chat.account_revisions WHERE resource_key->>'chat_id'=$1", [group])
    const recipient = members[1]!
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,is_whisper,to_user_ids)
      VALUES($1,$2,$3,'just you','text',true,$4)`, [randomUUID(), group, owner, [recipient]])
    expect(await journal()).toEqual({ chat_changed: MEMBERS, message_created: 2 })
    const { rows: [chat] } = await db.query<{ last_message_preview: string }>('SELECT last_message_preview FROM chat.chats WHERE id=$1', [group])
    expect(chat!.last_message_preview).toBe('public')
  })

  it('the seq allocation alone changes nothing but next_message_seq and is not published', async () => {
    // A deduplicated insert runs the BEFORE INSERT seq allocation (assign_message_seq) and no AFTER trigger: the only
    // place to see that write by itself. If it also moved updated_at (or anything else), the "seq only" check could
    // never match and every message would publish two chat_changed again.
    const clientId = randomUUID()
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,client_message_id) VALUES($1,$2,$3,'first','text',$4)`, [randomUUID(), group, owner, clientId])
    await db.query("DELETE FROM chat.account_revisions WHERE resource_key->>'chat_id'=$1", [group])
    const row = async () => (await db.query<{ row: Record<string, unknown> }>('SELECT to_jsonb(c) AS row FROM chat.chats c WHERE id=$1', [group])).rows[0]!.row
    const before = await row()
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,client_message_id) VALUES($1,$2,$3,'retry','text',$4)
      ON CONFLICT (chat_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING`, [randomUUID(), group, owner, clientId])
    const after = await row()
    expect(Number(after.next_message_seq)).toBe(Number(before.next_message_seq) + 1)
    expect({ ...after, next_message_seq: null }).toEqual({ ...before, next_message_seq: null })
    expect(await journal()).toEqual({})
  })

  it('two equal messages in one transaction both publish their seq', async () => {
    for (let i = 0; i < 2; i++) {
      await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,'same','text')`, [randomUUID(), group, owner])
    }
    expect(await journal()).toEqual({ chat_changed: 2 * MEMBERS, message_created: 2 * MEMBERS })
  })
})

describe('seq allocation under concurrent inserts', () => {
  let chat: string, ids: string[]
  beforeAll(async () => { ({ chat, ids } = await seedGroup(db, 4)) })
  afterAll(() => dropGroup(chat, ids))

  it('8 writers x 25 messages get 200 contiguous, unique seq', async () => {
    const writers = await Promise.all(Array.from({ length: 8 }, async () => {
      const client = new Client({ connectionString: url.href }); await client.connect(); return client
    }))
    try {
      await Promise.all(writers.map(async (client, w) => {
        for (let i = 0; i < 25; i++) {
          await client.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,$4,'text')`,
            [randomUUID(), chat, ids[w % ids.length], `writer ${w} message ${i}`])
        }
      }))
    } finally { await Promise.all(writers.map((client) => client.end())) }
    const { rows } = await db.query<{ seq: string }>('SELECT seq FROM chat.messages WHERE chat_id=$1 ORDER BY seq', [chat])
    const seqs = rows.map((row) => Number(row.seq))
    expect(seqs).toHaveLength(200)
    expect(new Set(seqs).size).toBe(200)
    expect(seqs.at(-1)! - seqs[0]!).toBe(199)
    const { rows: [head] } = await db.query<{ next_message_seq: string }>('SELECT next_message_seq FROM chat.chats WHERE id=$1', [chat])
    expect(Number(head!.next_message_seq)).toBe(seqs.at(-1)! + 1)
  })
})
