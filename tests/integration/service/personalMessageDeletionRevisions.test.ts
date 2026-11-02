import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
interface Operation {
  event: string
  payload: { chat_id?: string; entity_id?: string; through_seq?: number; tombstone?: boolean }
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient

async function asUser<Row = Record<string, unknown>>(user: string, sql: string, values: unknown[] = []): Promise<Row[]> {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  try { return (await database.query<Row>(sql, values)).rows }
  finally { await database.query('RESET role') }
}
async function human(): Promise<string> {
  const id = randomUUID()
  await database.query("INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human','Deletion fixture')", [id])
  return id
}
async function room(owner: string, members: string[]): Promise<string> {
  const id = randomUUID()
  await database.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','Deletion fixture',$2)", [id, owner])
  for (const member of [owner, ...members]) {
    await database.query('INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,$3)', [id, member, member === owner ? 'owner' : 'member'])
  }
  return id
}
async function say(chat: string, sender: string): Promise<{ id: string; seq: string }> {
  return (await database.query<{ id: string; seq: string }>(
    "INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES ($1,$2,$3,'Deletion fixture','text') RETURNING id,seq",
    [randomUUID(), chat, sender])).rows[0]!
}
async function cursor(user: string): Promise<string> {
  return (await database.query<{ revision: string }>('SELECT revision FROM chat.account_revision_heads WHERE user_id=$1', [user])).rows[0]?.revision ?? '0'
}
async function changes(user: string, after: string): Promise<Operation[]> {
  return (await asUser<{ page: { operations: Operation[] } }>(user, 'SELECT chat.sync_since($1,500) AS page', [after]))[0]!.page.operations
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('personalMessageDeletionRevisions requires a disposable loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => { await database.query('BEGIN') })
afterEach(async () => { await database.query('RESET role'); await database.query('ROLLBACK') })

describe('personal message deletions in account sync', () => {
  it('r1: publishes a non-sender deletion only to the caller, preserving the row for everyone else', async () => {
    const sender = await human(), caller = await human(), peer = await human()
    const chat = await room(sender, [caller, peer]), message = await say(chat, sender)
    const users = [sender, caller, peer], before = await Promise.all(users.map(cursor))
    expect(await asUser(caller, 'SELECT * FROM chat.delete_message($1)', [message.id])).toEqual([{ chat_id: chat, globally_deleted: false }])
    const revisions = []
    for (let index = 0; index < users.length; index += 1) revisions.push(await changes(users[index]!, before[index]!))
    expect(revisions).toEqual([[], [{ event: 'message_deleted', revision: expect.any(String), payload: { chat_id: chat, entity_id: message.id, tombstone: true } }], []])
    expect((await database.query('SELECT deleted_at,deleted_for_user_ids FROM chat.messages WHERE id=$1', [message.id])).rows).toEqual([{ deleted_at: null, deleted_for_user_ids: [caller] }])
  })

  it('r2: publishes one private clear boundary at the maximum seq and keeps subsequent messages', async () => {
    const sender = await human(), caller = await human(), peer = await human()
    const chat = await room(sender, [caller, peer])
    await say(chat, sender)
    const last = await say(chat, caller)
    const users = [sender, caller, peer], before = await Promise.all(users.map(cursor))
    await asUser(caller, 'SELECT chat.clear_messages_for_me($1)', [chat])
    expect(await changes(caller, before[1]!)).toEqual([{ event: 'messages_cleared', revision: expect.any(String), payload: { chat_id: chat, through_seq: Number(last.seq), tombstone: true } }])
    expect(await changes(sender, before[0]!)).toEqual([])
    expect(await changes(peer, before[2]!)).toEqual([])
    const next = await say(chat, sender)
    expect(Number(next.seq)).toBeGreaterThan(Number(last.seq))
    expect((await database.query('SELECT id FROM chat.messages WHERE chat_id=$1 AND deleted_for_user_ids @> jsonb_build_array($2::text) ORDER BY seq', [chat, caller])).rows).toHaveLength(2)
    expect((await database.query('SELECT deleted_for_user_ids FROM chat.messages WHERE id=$1', [next.id])).rows).toEqual([{ deleted_for_user_ids: [] }])
  })

  it('r3: keeps sender soft deletion at one existing message_deleted revision per member', async () => {
    const sender = await human(), caller = await human(), peer = await human()
    const chat = await room(sender, [caller, peer]), message = await say(chat, sender)
    const users = [sender, caller, peer], before = await Promise.all(users.map(cursor))
    expect(await asUser(sender, 'SELECT * FROM chat.delete_message($1)', [message.id])).toEqual([{ chat_id: chat, globally_deleted: true }])
    for (let index = 0; index < users.length; index += 1) {
      const deleted = (await changes(users[index]!, before[index]!)).filter((operation) => operation.event === 'message_deleted')
      expect(deleted).toEqual([{ event: 'message_deleted', revision: expect.any(String), payload: { chat_id: chat, entity_id: message.id, tombstone: true } }])
    }
  })

  it('clears only the named chat, leaving its separate topic untouched', async () => {
    const sender = await human(), caller = await human(), chat = await room(sender, [caller])
    const root = await say(chat, sender), topic = randomUUID()
    await database.query("INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id) VALUES ($1,'topic','Topic fixture',$2,$3,$4)", [topic, sender, chat, root.id])
    const reply = await say(topic, sender), before = await cursor(caller)
    await asUser(caller, 'SELECT chat.clear_messages_for_me($1)', [chat])
    expect((await changes(caller, before)).filter((operation) => operation.event === 'messages_cleared')).toEqual([{ event: 'messages_cleared', revision: expect.any(String), payload: { chat_id: chat, through_seq: Number(root.seq), tombstone: true } }])
    expect((await database.query('SELECT deleted_for_user_ids FROM chat.messages WHERE id=$1', [reply.id])).rows).toEqual([{ deleted_for_user_ids: [] }])
  })

  it('emits boundary zero for an empty chat and includes already soft-deleted rows in the maximum', async () => {
    const sender = await human(), caller = await human(), chat = await room(sender, [caller])
    let before = await cursor(caller)
    await asUser(caller, 'SELECT chat.clear_messages_for_me($1)', [chat])
    expect(await changes(caller, before)).toEqual([{ event: 'messages_cleared', revision: expect.any(String), payload: { chat_id: chat, through_seq: 0, tombstone: true } }])
    const last = await say(chat, sender)
    await asUser(sender, 'SELECT * FROM chat.delete_message($1)', [last.id])
    before = await cursor(caller)
    await asUser(caller, 'SELECT chat.clear_messages_for_me($1)', [chat])
    expect(await changes(caller, before)).toEqual([{ event: 'messages_cleared', revision: expect.any(String), payload: { chat_id: chat, through_seq: Number(last.seq), tombstone: true } }])
  })

  it('still refuses nonmembers without publishing a personal deletion', async () => {
    const sender = await human(), outsider = await human(), chat = await room(sender, [])
    const message = await say(chat, sender), before = await cursor(outsider)
    for (const [sql, value] of [
      ['SELECT * FROM chat.delete_message($1)', message.id],
      ['SELECT chat.clear_messages_for_me($1)', chat],
    ]) {
      await database.query('SAVEPOINT denied')
      await database.query('SET LOCAL role TO authenticated')
      await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: outsider, role: 'authenticated' })])
      await expect(database.query(sql!, [value])).rejects.toThrow(/not a member of chat/)
      await database.query('ROLLBACK TO SAVEPOINT denied')
    }
    expect(await changes(outsider, before)).toEqual([])
  })
})
