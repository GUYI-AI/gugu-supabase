import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let owner: string, creator: string, manager: string, reader: string, outsider: string, agent: string
let source: string, topic: string

async function asUser(account: string) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: account, role: 'authenticated' })])
}
async function archive(account: string, actor = account, id = topic, confirmName: string | null = null) {
  await asUser(account)
  const result = await db.query('SELECT chat.archive_topic_as($1,$2,$3) AS receipt', [id, actor, confirmName])
  await db.query('RESET ROLE')
  return result.rows[0].receipt
}
async function denied(work: () => Promise<unknown>) {
  await db.query('SAVEPOINT denied')
  try { await work() } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT denied')
    await db.query('RESET ROLE')
    return (error as Error).message
  }
  throw new Error('Expected topic archival to be denied')
}
async function topicState() {
  return (await db.query('SELECT status FROM chat.chats WHERE id=$1', [topic])).rows[0].status
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Topic archival requires the disposable loopback database')
  }
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, creator, manager, reader, outsider, agent, source, topic] = Array.from({ length: 8 }, randomUUID)
  for (const id of [owner, creator, manager, reader, outsider]) {
    await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@topic-archival.invalid`])
  }
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES ($1,$2,'fixture','fixture','darwin')`, ['topic-' + creator, creator])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES ($1,'agent','Topic creator',$2,$3)`, [agent, creator, 'topic-' + creator])
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','Source',$2)`, [source, owner])
  for (const [id, role] of [[owner, 'owner'], [creator, 'member'], [manager, 'admin'], [reader, 'member'], [agent, 'member']]) {
    await db.query('INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,$3)', [source, id, role])
  }
  const anchor = randomUUID()
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'Source message')`, [anchor, source, creator])
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id) VALUES ($1,'topic','Topic',$2,$3,$4)`, [topic, creator, source, anchor])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin')`, [topic, creator, reader])
})
afterEach(async () => {
  try { await db.query('RESET ROLE'); await db.query('SET CONSTRAINTS ALL IMMEDIATE') }
  finally { await db.query('ROLLBACK') }
})

describe('human topic archival within the source conversation', () => {
  it.each(['owner', 'admin'])('allows the source-group human %s and confirms idempotent archival', async (role) => {
    const account = role === 'owner' ? owner : manager
    expect(await archive(account)).toEqual({ chat_id: topic, status: 'archived' })
    expect(await archive(account)).toEqual({ chat_id: topic, status: 'archived' })
    expect(await topicState()).toBe('archived')
    expect((await db.query('SELECT status FROM chat.chats WHERE id=$1', [source])).rows[0].status).toBe('active')
  })
  it('denies ordinary source members even with a topic admin role', async () => {
    expect(await denied(() => archive(reader))).toContain('Source conversation management required')
    expect(await topicState()).toBe('active')
  })
  it('does not give a group-topic creator management through participation or authorship', async () => {
    expect(await denied(() => archive(creator))).toContain('Source conversation management required')
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [topic, creator])
    expect(await denied(() => archive(creator))).toContain('Source conversation management required')
  })
  it('allows only the creator in a source DM, without treating a peer as a group manager', async () => {
    const dm = randomUUID(), anchor = randomUUID()
    await db.query(`INSERT INTO chat.chats(id,kind) VALUES ($1,'dm')`, [dm])
    await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')`, [dm, reader, creator])
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'DM source')`, [anchor, dm, creator])
    await db.query('UPDATE chat.chats SET source_chat_id=$1, source_message_id=$2 WHERE id=$3', [dm, anchor, topic])
    expect(await denied(() => archive(reader))).toContain('Source conversation management required')
    expect(await archive(creator)).toEqual({ chat_id: topic, status: 'archived' })
  })
  it('requires current source membership for creators and rejects outsiders or spoofed actors', async () => {
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [source, creator])
    expect(await denied(() => archive(creator))).toContain('Source conversation management required')
    expect(await denied(() => archive(outsider))).toContain('Source conversation management required')
    expect(await denied(() => archive(reader, owner))).toContain('group_actor_not_authorized')
    expect(await topicState()).toBe('active')
  })
  it('does not give an Agent creator or its human owner group management', async () => {
    await db.query('UPDATE chat.chats SET creator_user_id=$1 WHERE id=$2', [agent, topic])
    expect(await denied(() => archive(creator, agent, topic, 'Topic'))).toContain('Source conversation management required')
    expect(await denied(() => archive(creator))).toContain('Source conversation management required')
  })
  it('does not accept a group or widen the group-only archival RPC', async () => {
    expect(await denied(() => archive(owner, owner, source))).toContain('Topic not found')
    expect(await denied(async () => {
      await asUser(creator)
      await db.query('SELECT chat.archive_group_as($1,$2)', [topic, creator])
    })).toContain('human_group_owner_required')
  })
  it('removes archived topics from all listings and notifies nonparticipant source members', async () => {
    await db.query('DELETE FROM chat.account_revisions WHERE user_id=ANY($1::text[])', [[owner, creator, manager, reader]])
    await db.query('DELETE FROM realtime.messages WHERE topic=ANY($1::text[])', [[owner, creator, manager, reader].map((id) => `gugu:user:${id}:events`)])
    await archive(manager)
    for (const account of [creator, owner, manager, reader]) {
      await asUser(account)
      expect((await db.query('SELECT * FROM chat.list_topics_of_chat($1)', [source])).rows).toEqual([])
      await db.query('RESET ROLE')
      expect((await db.query(`SELECT user_id FROM chat.account_revisions WHERE user_id=$1 AND event='chat_changed'
        AND resource_key->>'chat_id'=$2`, [account, source])).rows).toHaveLength(1)
      expect((await db.query(`SELECT payload FROM realtime.messages WHERE topic=$1 AND event='chat_changed'
        AND payload->>'topic_of_source_chat'=$2`, [`gugu:user:${account}:events`, source])).rows)
        .toEqual([{ payload: expect.objectContaining({ chat: expect.objectContaining({ id: topic, status: 'archived' }) }) }])
    }
  })
  it('does not grant anonymous execution', async () => {
    expect((await db.query("SELECT has_function_privilege('anon','chat.archive_topic_as(text,text,text)','execute') AS allowed")).rows[0].allowed).toBe(false)
  })
  it('allows a source-group Agent admin with the exact current name, without a topic seat', async () => {
    await db.query("UPDATE chat.chat_members SET role='admin' WHERE chat_id=$1 AND user_id=$2", [source, agent])
    expect(await archive(creator, agent, topic, 'Topic')).toEqual({ chat_id: topic, status: 'archived' })
  })
  it.each([null, '', 'topic', 'Topic ', ' Topic', 'Old name'])('rejects an Agent admin confirmation %j without archiving', async (name) => {
    await db.query("UPDATE chat.chat_members SET role='admin' WHERE chat_id=$1 AND user_id=$2", [source, agent])
    expect(await denied(() => archive(creator, agent, topic, name))).toContain('exactly match the current topic name')
    expect(await topicState()).toBe('active')
  })
  it('rejects a stale confirmation after rename and preserves exact Unicode characters', async () => {
    await db.query("UPDATE chat.chat_members SET role='admin' WHERE chat_id=$1 AND user_id=$2", [source, agent])
    await db.query('UPDATE chat.chats SET name=$1 WHERE id=$2', ['话题 e\u0301', topic])
    for (const name of ['Topic', '话题 é']) {
      expect(await denied(() => archive(creator, agent, topic, name))).toContain('exactly match the current topic name')
    }
    expect(await archive(creator, agent, topic, '话题 e\u0301')).toEqual({ chat_id: topic, status: 'archived' })
  })
  it('denies a non-manager Agent even with the exact name and a human source-owner token', async () => {
    await db.query('UPDATE identity.users SET owner_user_id=$1 WHERE id=$2', [owner, agent])
    expect(await denied(() => archive(owner, agent, topic, 'Topic'))).toContain('Source conversation management required')
    expect(await topicState()).toBe('active')
  })
})
