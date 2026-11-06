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
type ReadState = { stream_id: string; last_read_seq: string; is_marked_unread: boolean; version: number }
type Operation = { revision: string; event: string; payload: Record<string, unknown> }
type Page = { operations: Operation[]; has_more: boolean }
let db: Database
let owner: string, reader: string, group: string, root: string, stream: string, seq: string

async function asUser<Row = Record<string, unknown>>(user: string, sql: string, values: unknown[] = []): Promise<Row[]> {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  try { return (await db.query<Row>(sql, values)).rows }
  finally { await db.query('RESET ROLE') }
}
async function cursor(user: string) {
  return (await db.query<{ revision: string }>('SELECT revision FROM chat.account_revision_heads WHERE user_id=$1', [user])).rows[0]?.revision ?? '0'
}
async function changes(user: string, after: string) {
  return (await asUser<{ page: Page }>(user, 'SELECT chat.sync_since($1,100) AS page', [after]))[0]!.page
}
async function markRead() {
  return (await asUser<ReadState>(reader, 'SELECT * FROM chat.mark_stream_read($1,$2,$3,$4)', [group, stream, seq, root]))[0]!
}
function readPayload(state: ReadState) {
  return {
    chat_id: group, entity_id: reader, stream_id: stream, stream_kind: 'thread', thread_root_id: root,
    last_read_seq: Number(state.last_read_seq), is_marked_unread: state.is_marked_unread, version: state.version,
    tombstone: false,
  }
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('thread read revision tests require a disposable loopback database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); reader = randomUUID(); group = randomUUID(); root = randomUUID()
  stream = `thread:${group}:${root}`
  await db.query("INSERT INTO identity.users(id,type,display_name) SELECT id,'human','Thread read fixture' FROM unnest($1::text[]) id", [[owner, reader]])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Thread read fixture',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [group, owner, reader])
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,is_thread_root) VALUES($1,$2,$3,'Thread root','text',true)", [root, group, owner])
  seq = (await db.query<{ seq: string }>(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,thread_root_id)
    VALUES($1,$2,$3,'Unread reply','text',$4) RETURNING seq`, [randomUUID(), group, owner, root])).rows[0]!.seq
})
afterEach(async () => { await db.query('ROLLBACK') })

describe('thread read account revisions', () => {
  it('returns the first thread read through sync_since without changing a peer or the main cursor', async () => {
    expect((await asUser(reader, 'SELECT stream_id FROM chat.list_unread_locators($1)', [group])).map(row => row.stream_id)).toContain(stream)
    expect((await db.query('SELECT 1 FROM chat.chat_member_stream_read_state WHERE chat_id=$1 AND user_id=$2', [group, reader])).rows).toEqual([])
    const before = await cursor(reader), peerBefore = await cursor(owner)
    await db.query('DELETE FROM realtime.messages WHERE topic=ANY($1::text[])', [[owner, reader].map(user => `gugu:user:${user}:events`)])
    const mainBefore = (await db.query('SELECT last_read_seq FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [group, reader])).rows
    const state = await markRead()
    expect(String(state.last_read_seq)).toBe(seq)
    expect(state.is_marked_unread).toBe(false)
    const page = await changes(reader, before)
    expect(page.operations).toEqual([
      { revision: String(BigInt(before) + 1n), event: 'member_stream_read_changed', payload: readPayload(state) },
    ])
    expect(await cursor(reader)).toBe(page.operations.at(-1)!.revision)
    expect(page.has_more).toBe(false)
    expect((await changes(reader, await cursor(reader))).operations).toEqual([])
    expect((await changes(owner, peerBefore)).operations).toEqual([])
    expect(await cursor(owner)).toBe(peerBefore)
    const wakes = (await db.query<{ topic: string; private: boolean; payload: { revision: number } }>(
      "SELECT topic,private,payload FROM realtime.messages WHERE topic=ANY($1::text[]) AND event='im_revision_advanced'",
      [[owner, reader].map(user => `gugu:user:${user}:events`)])).rows
    expect(wakes.map(wake => String(wake.payload.revision)).sort()).toEqual(page.operations.map(op => op.revision).sort())
    expect(wakes.every(wake => wake.topic === `gugu:user:${reader}:events` && wake.private)).toBe(true)
    const legacy = (await db.query<{ payload: { member: Record<string, unknown> } }>(
      "SELECT payload FROM realtime.messages WHERE topic=$1 AND event='member_stream_read_changed'", [`gugu:user:${reader}:events`])).rows
    expect(legacy).toEqual([])
    expect((await db.query('SELECT last_read_seq FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [group, reader])).rows).toEqual(mainBefore)
    expect((await asUser(reader, 'SELECT stream_id FROM chat.list_unread_locators($1)', [group])).map(row => row.stream_id)).not.toContain(stream)
  })

  it('publishes an update when an existing thread cursor advances', async () => {
    const first = await markRead()
    seq = (await db.query<{ seq: string }>(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,thread_root_id)
      VALUES($1,$2,$3,'Later unread reply','text',$4) RETURNING seq`, [randomUUID(), group, owner, root])).rows[0]!.seq
    const before = await cursor(reader)
    const state = await markRead()
    expect(String(state.last_read_seq)).toBe(seq)
    expect(state.version).toBe(first.version + 1)
    expect((await changes(reader, before)).operations).toEqual([
      { revision: String(BigInt(before) + 1n), event: 'member_stream_read_changed', payload: readPayload(state) },
    ])
  })

  it.each([
    { lastRead: 'reply', unread: false, version: 0 },
    { lastRead: '0', unread: true, version: 0 },
    { lastRead: '0', unread: false, version: 1 },
  ])('publishes a nondefault cursor insertion: %j', async ({ lastRead, unread, version }) => {
    const before = await cursor(reader)
    const state = (await asUser<ReadState>(reader, `INSERT INTO chat.chat_member_stream_read_state
      (chat_id,user_id,stream_id,stream_kind,thread_root_id,last_read_seq,is_marked_unread,version)
      VALUES($1,$2,$3,'thread',$4,$5,$6,$7) RETURNING stream_id,last_read_seq,is_marked_unread,version`,
      [group, reader, stream, root, lastRead === 'reply' ? seq : lastRead, unread, version]))[0]!
    expect((await changes(reader, before)).operations).toEqual([
      { revision: String(BigInt(before) + 1n), event: 'member_stream_read_changed', payload: readPayload(state) },
    ])
  })

  it('publishes a private tombstone when the reader deletes a cursor and exposes unread replies again', async () => {
    const state = await markRead()
    const before = await cursor(reader), peerBefore = await cursor(owner)
    expect(await asUser(owner, `DELETE FROM chat.chat_member_stream_read_state
      WHERE chat_id=$1 AND user_id=$2 AND stream_id=$3 RETURNING stream_id`, [group, reader, stream])).toEqual([])
    expect((await asUser(reader, 'SELECT stream_id FROM chat.list_unread_locators($1)', [group])).map(row => row.stream_id)).not.toContain(stream)
    await db.query('DELETE FROM realtime.messages WHERE topic=ANY($1::text[])', [[owner, reader].map(user => `gugu:user:${user}:events`)])
    expect(await asUser(reader, `DELETE FROM chat.chat_member_stream_read_state
      WHERE chat_id=$1 AND user_id=$2 AND stream_id=$3 RETURNING stream_id`, [group, reader, stream])).toEqual([{ stream_id: stream }])
    const expectedRevision = String(BigInt(before) + 1n)
    expect((await changes(reader, before)).operations).toEqual([
      { revision: expectedRevision, event: 'member_stream_read_changed', payload: { ...readPayload(state), tombstone: true } },
    ])
    expect(await cursor(reader)).toBe(expectedRevision)
    expect((await changes(owner, peerBefore)).operations).toEqual([])
    expect(await cursor(owner)).toBe(peerBefore)
    const wakes = (await db.query('SELECT topic,private,payload FROM realtime.messages WHERE topic=ANY($1::text[]) AND event=$2',
      [[owner, reader].map(user => `gugu:user:${user}:events`), 'im_revision_advanced'])).rows
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toMatchObject({ topic: `gugu:user:${reader}:events`, private: true, payload: { revision: Number(expectedRevision) } })
    const unread = await asUser<{ cursor_seq: string; unread_count: string }>(reader,
      'SELECT cursor_seq,unread_count FROM chat.list_unread_locators($1) WHERE stream_id=$2', [group, stream])
    expect(unread).toEqual([{ cursor_seq: '0', unread_count: '1' }])
    // Recreating the cursor through the same RPC is another single effective read.
    const restored = await markRead()
    expect((await changes(reader, expectedRevision)).operations).toEqual([
      { revision: String(BigInt(expectedRevision) + 1n), event: 'member_stream_read_changed', payload: readPayload(restored) },
    ])
  })

  it('skips unchanged writes but publishes unread-intent and version-only changes', async () => {
    const state = await markRead()
    const before = await cursor(reader)
    await asUser(reader, `UPDATE chat.chat_member_stream_read_state
      SET last_read_seq=last_read_seq,is_marked_unread=is_marked_unread,version=version,updated_at=now()
      WHERE chat_id=$1 AND user_id=$2 AND stream_id=$3`, [group, reader, stream])
    expect((await changes(reader, before)).operations).toEqual([])
    for (const update of ['is_marked_unread=true', 'version=version+1']) {
      const after = await cursor(reader)
      await asUser(reader, `UPDATE chat.chat_member_stream_read_state SET ${update}
        WHERE chat_id=$1 AND user_id=$2 AND stream_id=$3`, [group, reader, stream])
      const page = await changes(reader, after)
      if (update.startsWith('version')) state.version += 1
      state.is_marked_unread = true
      expect(page.operations).toEqual([
        { revision: String(BigInt(after) + 1n), event: 'member_stream_read_changed', payload: readPayload(state) },
      ])
    }
  })

  it('keeps the revision trigger closed to API callers', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1,'chat.publish_member_stream_read_revision()','EXECUTE') AS allowed", [role])).rows[0]!.allowed).toBe(false)
    }
  })
})
