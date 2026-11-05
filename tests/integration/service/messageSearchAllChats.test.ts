import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * chat.message_search_as with p_chat_id NULL searches every chat the actor is a member of, under the same visibility
 * rule as one chat (message_visible_at with each chat's history floor), and says which chat each row is in.
 * Every case runs inside BEGIN...ROLLBACK.
 * Run: `GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:<port>/postgres pnpm exec vitest run messageSearchAllChats`
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => DatabaseClient }
let database: DatabaseClient

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asService() { await database.query('RESET role') }
async function human(name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`, [id, `${id}@search-all.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  return id
}
async function groupWith(owner: string, members: string[]): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','search',$2)`, [id, owner])
  for (const user of [owner, ...members]) {
    await database.query('INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,$3)', [id, user, user === owner ? 'owner' : 'member'])
  }
  await database.query('UPDATE chat.chat_members SET hide_history_before = NULL WHERE chat_id = $1', [id])
  return id
}
async function say(chatId: string, sender: string, content: string, opts: { at?: string; whisperTo?: string[] } = {}): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, created_at, is_whisper)
    VALUES ($1,$2,$3,$4,'text',$5,$6,$7)`, [id, chatId, sender, content, opts.whisperTo ?? null, opts.at ?? new Date().toISOString(), !!opts.whisperTo])
  return id
}
const search = async (actor: string, chat: string | null, query: string) => {
  await asUser(actor)
  const rows = (await database.query<{ id: string; chat_id: string }>('SELECT id, chat_id FROM chat.message_search_as($1,$2)', [chat, query])).rows
  await asService()
  return rows
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('messageSearchAllChats.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => { await database.query('BEGIN') })
afterEach(async () => { if (database) { try { await asService() } finally { await database.query('ROLLBACK') } } })

describe('message_search_as across the actor\'s chats', () => {
  it('finds a needle in every chat the actor is in, newest first, and says which chat', async () => {
    const ada = await human('Ada'), bob = await human('Bob'), eve = await human('Eve')
    const one = await groupWith(ada, [bob]), two = await groupWith(bob, [ada]), elsewhere = await groupWith(eve, [bob])
    const older = await say(one, bob, 'kiwi needle older', { at: '2026-10-30T00:00:00Z' })
    const newer = await say(two, bob, 'kiwi needle newer', { at: '2026-10-31T00:00:00Z' })
    await say(elsewhere, eve, 'kiwi needle not hers')
    await say(one, bob, 'nothing here')
    expect(await search(ada, null, 'kiwi needle')).toEqual([{ id: newer, chat_id: two }, { id: older, chat_id: one }])
    expect((await search(ada, one, 'kiwi needle')).map(r => r.id)).toEqual([older])
  })

  it('keeps the one visibility rule in every chat: a whisper to someone else stays hidden', async () => {
    const ada = await human('Ada'), bob = await human('Bob'), cy = await human('Cy')
    const room = await groupWith(bob, [ada, cy])
    const open = await say(room, bob, 'mango plan')
    await say(room, bob, 'mango secret', { whisperTo: [cy] })
    expect((await search(ada, null, 'mango')).map(r => r.id)).toEqual([open])
    expect((await search(cy, null, 'mango')).map(r => r.id)).toHaveLength(2)
  })

  it('refuses a sequence cursor across chats', async () => {
    const ada = await human('Ada')
    await asUser(ada)
    await database.query('SAVEPOINT cursor_refused')
    await expect(database.query("SELECT * FROM chat.message_search_as(NULL,'x',NULL,10)")).rejects.toThrow(/pages one chat/)
    await database.query('ROLLBACK TO SAVEPOINT cursor_refused')
  })
})
