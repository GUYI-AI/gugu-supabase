import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

// 20261110050000: a topic root is the message marked is_thread_root, and a reply marks its root. Before, a root nobody
// marked (the client's best-effort mark_thread_root) was listed by thread_summaries because it had replies, while the
// unread locators never counted those replies.
let db: Client
let owner: string, reader: string, group: string
const release = readFileSync(new URL('../../../supabase/migrations/20261110050000_reply_marks_thread_root.sql', import.meta.url), 'utf8')

async function asUser<Row = Record<string, unknown>>(user: string, sql: string, values: unknown[] = []): Promise<Row[]> {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  await db.query('SET LOCAL ROLE authenticated')
  try { return (await db.query(sql, values)).rows as Row[] } finally { await db.query('RESET ROLE') }
}
const send = async (id: string, sender: string, extra: { thread_root_id?: string; is_whisper?: boolean; to?: string[] } = {}) =>
  db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,thread_root_id,is_whisper,to_user_ids)
    VALUES($1,$2,$3,'fixture',$4,$5,$6)`, [id, group, sender, extra.thread_root_id ?? null, extra.is_whisper ?? false, extra.to ?? null])
const marked = async (id: string) => (await db.query('SELECT is_thread_root FROM chat.messages WHERE id=$1', [id])).rows[0].is_thread_root
const threadStreams = async () => (await asUser<{ thread_root_id: string; unread_count: string }>(reader,
  "SELECT thread_root_id, unread_count FROM chat.list_unread_locators_for_chats($1) WHERE stream_kind='thread'", [[group]]))
  .map(r => [r.thread_root_id, Number(r.unread_count)])
const summaries = async () => (await asUser<{ thread_root_id: string; reply_count: string }>(reader,
  'SELECT thread_root_id, reply_count FROM chat.thread_summaries($1) ORDER BY 1', [group])).map(r => [r.thread_root_id, Number(r.reply_count)])

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Requires the disposable loopback database')
  }
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, reader, group] = [randomUUID(), randomUUID(), randomUUID()]
  await db.query("INSERT INTO identity.users(id,type,display_name) SELECT id,'human','Thread root fixture' FROM unnest($1::text[]) id", [[owner, reader]])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Thread root fixture',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [group, owner, reader])
  await db.query('UPDATE chat.chat_members SET inbox_published_at=clock_timestamp() WHERE chat_id=$1', [group])
})
afterEach(async () => { await db.query('ROLLBACK') })

it('a reply marks its unmarked root, so the topic is listed and its replies are unread', async () => {
  const root = randomUUID()
  await send(root, reader)
  expect(await marked(root)).toBe(false)
  await send(randomUUID(), owner, { thread_root_id: root })
  expect(await marked(root)).toBe(true)
  expect(await summaries()).toEqual([[root, 1]])
  expect(await threadStreams()).toEqual([[root, 1]])
})

it('a whisper root and a reply naming another chat\'s message are left unmarked', async () => {
  const whisper = randomUUID(), elsewhere = randomUUID(), other = randomUUID()
  await send(whisper, owner, { is_whisper: true, to: [reader] })
  await send(randomUUID(), reader, { thread_root_id: whisper })
  expect(await marked(whisper)).toBe(false)
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Other',$2)", [other, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [other, owner])
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'other chat')", [elsewhere, other, owner])
  await send(randomUUID(), owner, { thread_root_id: elsewhere })
  expect(await marked(elsewhere)).toBe(false)
})

it('the release marks every existing root with a live reply, and thread_summaries reads the mark only', async () => {
  const replied = randomUUID(), onlyDeleted = randomUUID(), opened = randomUUID(), reply = randomUUID()
  await send(replied, owner); await send(onlyDeleted, owner); await send(opened, owner)
  await send(randomUUID(), reader, { thread_root_id: replied })
  await send(reply, reader, { thread_root_id: onlyDeleted })
  await db.query('UPDATE chat.messages SET deleted_at=now() WHERE id=$1', [reply])
  // As before this release: replies did not mark; a topic opened before its first reply was marked by mark_thread_root.
  await db.query('UPDATE chat.messages SET is_thread_root=(id=$3) WHERE id=ANY($1) OR id=$2', [[replied, onlyDeleted], opened, opened])
  await db.query(release)
  expect([await marked(replied), await marked(onlyDeleted), await marked(opened)]).toEqual([true, false, true])
  expect(await summaries()).toEqual([[opened, 0], [replied, 1]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  expect(await threadStreams()).toEqual([])
})
