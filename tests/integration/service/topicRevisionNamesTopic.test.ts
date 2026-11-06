import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let owner: string, reader: string, source: string

async function as(id: string, sql: string, values: unknown[] = []) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',json_build_object('sub',$1::text,'role','authenticated')::text,true)`, [id])
  const result = await db.query(sql, values)
  await db.query('RESET ROLE')
  return result.rows
}
async function message(chat: string, content = 'hello') {
  const id = randomUUID()
  await db.query('INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,$4)', [id, chat, owner, content])
  return id
}
async function topicIn(chat: string) {
  const anchor = await message(chat, 'source message'), id = randomUUID()
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id) VALUES ($1,'topic','topic',$2,$3,$4)`, [id, owner, chat, anchor])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner')`, [id, owner])
  return id
}
/** The reader's chat_changed revisions on the source line since a mark, as their resource keys. */
async function sourceChanges(since: string) {
  const { rows } = await db.query(`SELECT resource_key FROM chat.account_revisions
    WHERE user_id=$1 AND event='chat_changed' AND resource_key->>'chat_id'=$2 AND revision>$3 ORDER BY revision`, [reader, source, since])
  return rows.map(row => row.resource_key as { chat_id: string; entity_id?: string })
}
async function mark() {
  const { rows } = await db.query('SELECT COALESCE(max(revision),0)::text AS r FROM chat.account_revisions WHERE user_id=$1', [reader])
  return rows[0].r as string
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('topic revisions require disposable loopback PostgreSQL')
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, reader] = [randomUUID(), randomUUID()]
  for (const id of [owner, reader]) await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`, [id, `${id}@topic-revision.example.test`])
  source = randomUUID()
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','topic revision fixture',$2)`, [source, owner])
  for (const member of [owner, reader]) await db.query('INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,$3)', [source, member, member === owner ? 'owner' : 'member'])
})
afterEach(async () => { await db?.query('ROLLBACK') })

describe('a topic change on its source line names the topic', () => {
  it('a source-line message is the line itself; topic creation, activity, message deletion, rename, membership and archival name the topic', async () => {
    let since = await mark()
    await message(source)
    expect(await sourceChanges(since)).toEqual([{ chat_id: source }])

    since = await mark()
    const topic = await topicIn(source)
    // The topic row and its first member each publish; the anchor message is the line's own.
    expect((await sourceChanges(since)).filter(key => key.entity_id)).toEqual([{ chat_id: source, entity_id: topic }, { chat_id: source, entity_id: topic }])

    since = await mark()
    const sent = await message(topic)
    expect(await sourceChanges(since)).toEqual([{ chat_id: source, entity_id: topic }])

    since = await mark()
    await db.query('UPDATE chat.messages SET deleted_at=now() WHERE id=$1', [sent])
    expect(await sourceChanges(since)).toEqual([{ chat_id: source, entity_id: topic }])

    since = await mark()
    await db.query("UPDATE chat.chats SET name='renamed' WHERE id=$1", [topic])
    expect(await sourceChanges(since)).toEqual([{ chat_id: source, entity_id: topic }])

    since = await mark()
    await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'member')`, [topic, reader])
    expect(await sourceChanges(since)).toEqual([{ chat_id: source, entity_id: topic }])

    since = await mark()
    await db.query("UPDATE chat.chats SET status='archived' WHERE id=$1", [topic])
    expect(await sourceChanges(since)).toEqual([{ chat_id: source, entity_id: topic }])
  })

  it('list_topics_of_chat reads one topic of the line, or all of them', async () => {
    const first = await topicIn(source), second = await topicIn(source)
    const all = await as(reader, 'SELECT chat_id FROM chat.list_topics_of_chat($1)', [source])
    expect(all.map(row => row.chat_id).sort()).toEqual([first, second].sort())
    expect(await as(reader, 'SELECT chat_id,name FROM chat.list_topics_of_chat(p_source_chat_id => $1, p_topic_chat_id => $2)', [source, second]))
      .toEqual([{ chat_id: second, name: 'topic' }])
    const elsewhere = randomUUID()
    await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','other',$2)`, [elsewhere, owner])
    await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner')`, [elsewhere, owner])
    expect(await as(reader, 'SELECT chat_id FROM chat.list_topics_of_chat(p_source_chat_id => $1, p_topic_chat_id => $2)', [source, await topicIn(elsewhere)])).toEqual([])
  })
})
