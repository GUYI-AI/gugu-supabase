// gugu #6840 悄悄话合不合法,在库的写入口判一次(chat.enforce_whisper_rule,chat.messages BEFORE INSERT)。
// 规则:收件人正好一个、不是发信人、是这条 chat 自己的成员(话题只认话题成员)。不按 chat 种类拦(私聊里的悄悄话漏不出去)。
// 两条写入路都要过它:直插 messages(agent 的 MCP 以主人令牌走这条)与 send_message_idempotent(人、App)。
//
// 与 oneWhisperRule6835 同形:loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,每条用例 BEGIN…ROLLBACK。
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface QueryResult<Row> { rows: Row[] }
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>
}

const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
const DATABASE_URL = (process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '').trim()
let database: DatabaseClient

beforeAll(async () => {
  const parsed = new URL(DATABASE_URL)
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`whisperWriteRule6840.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})
afterAll(async () => { await database?.end() })

function uid(n: number): string {
  return `68400000-6840-4000-8000-${String(n).padStart(12, '0')}`
}

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

/** Run `sql`; a failure comes back as its message instead of aborting the transaction. */
async function attempt(sql: string, values: unknown[], asUser?: string): Promise<string | null> {
  await database.query('SAVEPOINT attempt')
  try {
    if (asUser) {
      await database.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [
        JSON.stringify({ sub: asUser, role: 'authenticated' }),
      ])
    }
    await database.query(sql, values)
    await database.query('RELEASE SAVEPOINT attempt')
    return null
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT attempt')
    return String((error as Error).message)
  } finally {
    await database.query(`SELECT set_config('role', 'postgres', true)`)
  }
}

const owner = uid(1), bob = uid(2), carol = uid(3), outsider = uid(4), agent = uid(5)
const group = uid(11), dm = uid(12), agentDm = uid(13), source = uid(21), agentLine = uid(22)
let topic = ''

async function seed(): Promise<void> {
  for (const [id, name] of [[owner, '群主'], [bob, 'Bob'], [carol, 'Carol'], [outsider, '外人']] as const) {
    await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)`, [id, name])
  }
  await database.query(`INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ('dev-6840',$1,'6840','6840','darwin')`, [owner])
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent','Agent',$2,'dev-6840')`, [agent, owner])
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','群',$3),($2,'dm',NULL,$3)`, [group, dm, owner])
  for (const user of [owner, bob, carol, agent]) {
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)`, [group, user, user === owner ? 'owner' : 'member'])
  }
  for (const user of [owner, bob]) {
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`, [dm, user])
  }
  await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type) VALUES ($1,$2,$3,'源','text')`, [source, group, owner])
  // 话题:群主开、只拉了 Bob。Carol 在来源群里,不在话题里。
  await database.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [
    JSON.stringify({ sub: owner, role: 'authenticated' }),
  ])
  topic = (await database.query<{ chat_id: string }>(`SELECT chat_id FROM chat.create_topic($1,$2,'话题',$3::text[],NULL)`, [group, source, [bob]])).rows[0]!.chat_id
  await database.query(`SELECT set_config('role', 'postgres', true)`)
}

/** The agent path: a row inserted straight into chat.messages (what the MCP server does with the owner's token). */
const insert = (chatId: string, sender: string, to: string[] | null, n: number) => attempt(
  `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, is_whisper) VALUES ($1,$2,$3,'psst','text',$4,true)`,
  [uid(100 + n), chatId, sender, to],
)
/** The people / App path: send_message_idempotent as the sender. */
const send = (chatId: string, sender: string, to: string[], n: number) => attempt(
  `SELECT * FROM chat.send_message_idempotent(
     p_message_id => $1, p_chat_id => $2, p_sender_user_id => $3, p_to_user_ids => $4, p_content => 'psst',
     p_content_type => 'text', p_reply_to_message_id => NULL, p_thread_root_id => NULL, p_is_thread_root => false,
     p_is_whisper => true)`,
  [uid(200 + n), chatId, sender, to], sender,
)

describe('whisper write rule (#6840)', () => {
  it('lets a legal whisper through on both write paths, in a group and in a topic', async () => {
    await inRollback(async () => {
      await seed()
      expect(await insert(group, agent, [bob], 1)).toBeNull()
      expect(await send(group, bob, [carol], 2)).toBeNull()
      expect(await insert(topic, owner, [bob], 3)).toBeNull()
      const rows = (await database.query<{ n: string }>(`SELECT count(*)::text AS n FROM chat.messages WHERE id = ANY($1) AND is_whisper`,
        [[uid(101), uid(202), uid(103)]])).rows[0]!.n
      expect(rows).toBe('3')
    })
  })

  it.each([
    ['to yourself', () => insert(group, agent, [agent], 11), /A whisper cannot be sent to yourself/],
    ['to someone outside the chat', () => insert(group, agent, [outsider], 12), /is not a member of/],
    ['to two people', () => insert(group, agent, [bob, carol], 14), /exactly one person: to_user_ids holds 2 recipients/],
    ['in a topic to a source-group member who is not in the topic', () => insert(topic, owner, [carol], 15), /is not a member of/],
    ['through send_message_idempotent to yourself', () => send(group, bob, [bob], 16), /A whisper cannot be sent to yourself/],
    ['through send_message_idempotent to someone outside the chat', () => send(group, bob, [outsider], 17), /is not a member of/],
  ])('refuses a whisper %s, and writes nothing', async (_, write, message) => {
    await inRollback(async () => {
      await seed()
      expect(await write()).toMatch(message)
      const written = (await database.query<{ n: string }>(`SELECT count(*)::text AS n FROM chat.messages WHERE content = 'psst'`)).rows[0]!.n
      expect(written).toBe('0')
    })
  })

  // L2 在 #84 上挡下的一格:私聊里人给 agent 的消息点表情,chat.notify_agent_of_reaction() 在私聊里写一条
  // is_whisper 的系统提醒(sender 为 NULL)。按 chat 种类拦会让这次点表情整个失败。
  it('lets the reaction notice in a personal assistant DM through: the person reacts, the assistant gets told', async () => {
    await inRollback(async () => {
      await seed()
      await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'dm',NULL,$2)`, [agentDm, owner])
      for (const user of [owner, agent]) {
        await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`, [agentDm, user])
      }
      // Only the personal assistant retains a writable own-agent DM.
      const operation = uid(31)
      await database.query("INSERT INTO identity.agent_provision_operations(id,owner_user_id,device_id,kind,payload_hash,blueprint,phase) VALUES($1,$2,$3,'single','fixture','{}','completed')", [operation, owner, 'dev-6840'])
      await database.query(`INSERT INTO identity.agent_provisions(id,owner_user_id,operation_id,member_key,device_id,display_name,agent_type,inherit_memory,history_import_required,payload_hash,agent_user_id,provisioned_agent_user_id,dm_chat_id,phase)
        VALUES($1,$2,$3,'assistant',$4,'Assistant fixture','claude-code',false,false,'fixture',$5::text,$5::uuid,$6,'completed')`, [uid(32), owner, operation, 'dev-6840', agent, agentDm])
      await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type) VALUES ($1,$2,$3,'干完了','text')`,
        [agentLine, agentDm, agent])
      expect(await attempt(`INSERT INTO chat.message_reactions (message_id, user_id, emoji) VALUES ($1,$2,'👍')`, [agentLine, owner])).toBeNull()
      const notices = (await database.query<{ to_user_ids: string[]; sender_user_id: string | null }>(
        `SELECT to_user_ids, sender_user_id FROM chat.messages WHERE chat_id = $1 AND is_whisper AND content_type = 'system'`, [agentDm])).rows
      expect(notices).toEqual([{ to_user_ids: [agent], sender_user_id: null }])
    })
  })

  it('leaves ordinary messages alone', async () => {
    await inRollback(async () => {
      await seed()
      expect(await attempt(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids) VALUES ($1,$2,$3,'hi','text',$4)`,
        [uid(301), group, agent, [bob, carol]],
      )).toBeNull()
    })
  })
})
