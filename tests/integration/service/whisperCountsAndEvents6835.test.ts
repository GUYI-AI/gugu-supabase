// gugu #6835 悄悄话的条数与动静只给看得见它的人 —— 对着**真库**跑。
//   · 话题列表的 message_count 按调用者读得到的数,且与他 message_history_as 读到的行数相同;
//   · 关于一条悄悄话的人类账号事件只发给看得见它的人;agent 仍经 *_as 读取消息，不消费自己的 journal。
// 每条否定断言都配公开消息的正对照:「没收到」也可能是没发出去,只有正对照能分开。
//
// 与 messageViaAppF16 同形:loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,每条用例 BEGIN…ROLLBACK。
// 跑法:`GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:34890/postgres \
//        pnpm exec vitest run whisperCountsAndEvents6835`
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BEGIN_READING_REVISIONS } from '../../support/revisionTransaction'

interface QueryResult<Row> { rows: Row[] }
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>
}

const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
const DATABASE_URL = (
  process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? ''
).trim()

let database: DatabaseClient

function requireLoopbackDatabase(): void {
  let parsed: URL
  try {
    parsed = new URL(DATABASE_URL)
  } catch {
    throw new Error('GUGU_INTEGRATION_DATABASE_URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`whisperCountsAndEvents6835.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`whisperCountsAndEvents6835.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

function uid(tag: string, n: number): string {
  const head = tag.padEnd(8, '0').slice(0, 8).replace(/[^0-9a-f]/g, '0')
  return `${head}-6835-4000-8000-${String(n).padStart(12, '0')}`
}

beforeAll(async () => {
  requireLoopbackDatabase()
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})
afterAll(async () => { await database?.end() })

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query(BEGIN_READING_REVISIONS)
  try {
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

/** As `userId` inside the running transaction; the role goes back to postgres afterwards. */
async function as<Row>(userId: string, sql: string, values: unknown[]): Promise<Row[]> {
  await database.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ])
  try {
    return (await database.query<Row>(sql, values)).rows
  } finally {
    await database.query(`SELECT set_config('role', 'postgres', true)`)
  }
}

interface Room { owner: string; alice: string; peer: string; a: string; b: string; group: string; topic: string; ids: () => string }

/** A group: its owner, Alice (who whispers), a peer (never addressed), the owner's agents A and B; and a topic of it. */
async function seedRoom(tag: string): Promise<Room> {
  let n = 100
  const room: Room = {
    owner: uid(tag, 1), alice: uid(tag, 2), peer: uid(tag, 3), a: uid(tag, 4), b: uid(tag, 5),
    group: uid(tag, 11), topic: '', ids: () => uid(tag, (n += 1)),
  }
  for (const [id, name] of [[room.owner, '群主'], [room.alice, 'Alice'], [room.peer, 'Peer']] as const) {
    await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)`, [id, name])
  }
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1,$2,'6835','6835','darwin')`,
    [`dev-6835-${tag}`, room.owner],
  )
  for (const [id, name] of [[room.a, 'Agent A'], [room.b, 'Agent B']] as const) {
    await database.query(
      `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent',$2,$3,$4)`,
      [id, name, room.owner, `dev-6835-${tag}`],
    )
  }
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','群',$2)`, [room.group, room.owner])
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'member'),($1,$4,'member'),($1,$5,'member'),($1,$6,'member')`,
    [room.group, room.owner, room.alice, room.peer, room.a, room.b],
  )
  await database.query(`UPDATE chat.chat_members SET hide_history_before = NULL WHERE chat_id = $1`, [room.group])
  const source = room.ids()
  await post(room, room.group, room.owner, source, '来源消息', null)
  room.topic = (await as<{ chat_id: string }>(room.owner, 'SELECT chat_id FROM chat.create_topic($1,$2,$3,NULL,NULL)', [room.group, source, '话题']))[0]!.chat_id
  return room
}

async function post(room: Room, chatId: string, sender: string, id: string, content: string, whisperTo: string | null): Promise<void> {
  await database.query(
    `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, is_whisper) VALUES ($1,$2,$3,$4,'text',$5,$6)`,
    [id, chatId, sender, content, whisperTo ? [whisperTo] : null, whisperTo !== null],
  )
}

/** The account revisions each user got after `mark`, for one event (and chat), as the sorted list of users. */
async function mark(): Promise<Map<string, number>> {
  const { rows } = await database.query<{ user_id: string; head: string }>('SELECT user_id, max(revision)::text AS head FROM chat.account_revisions GROUP BY user_id')
  return new Map(rows.map((row) => [row.user_id, Number(row.head)]))
}
async function notified(since: Map<string, number>, event: string, where: { entityId?: string; chatId?: string }): Promise<string[]> {
  const { rows } = await database.query<{ user_id: string; revision: string }>(
    `SELECT user_id, revision::text AS revision FROM chat.account_revisions
      WHERE event = $1 AND ($2::text IS NULL OR resource_key->>'entity_id' = $2) AND ($3::text IS NULL OR resource_key->>'chat_id' = $3)`,
    [event, where.entityId ?? null, where.chatId ?? null],
  )
  return [...new Set(rows.filter((row) => Number(row.revision) > (since.get(row.user_id) ?? 0)).map((row) => row.user_id))].sort()
}

describe('#6835 whispers count and ring only for the people who can see them', () => {
  it('topic message_count is what the caller can read — the same number message_history_as gives them', async () => {
    await inRollback(async () => {
      const room = await seedRoom('c1')
      await post(room, room.topic, room.alice, room.ids(), '公开一句', null)
      // gugu #6840:话题里的悄悄话只对话题自己的成员说(库的写入口判),A 先是话题成员。
      await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`, [room.topic, room.a])
      for (let k = 0; k < 3; k += 1) await post(room, room.topic, room.alice, room.ids(), `悄悄话 ${k}`, room.a)

      const countFor = async (caller: string, actor: string | null) =>
        Number((await as<{ message_count: string }>(caller, 'SELECT message_count::text FROM chat.list_topics_of_chat($1,$2) WHERE chat_id = $3', [room.group, actor, room.topic]))[0]!.message_count)
      const readFor = async (caller: string, actor: string | null) =>
        (await as<{ id: string }>(caller, 'SELECT id FROM chat.message_history_as($1,$2,NULL,NULL,100)', [room.topic, actor])).length

      // 阳控:四行都在库里。
      expect(Number((await database.query<{ n: string }>('SELECT count(*)::text AS n FROM chat.messages WHERE chat_id = $1', [room.topic])).rows[0]!.n)).toBe(4)
      const cells: Array<[string, string, string | null, number]> = [
        ['A (the whisper\'s recipient)', room.owner, room.a, 4],
        ['B (same owner, not addressed)', room.owner, room.b, 1],
        ['the owner', room.owner, null, 1],
        ['Alice (the sender)', room.alice, null, 4],
        ['the peer', room.peer, null, 1],
      ]
      for (const [who, caller, actor, expected] of cells) {
        expect(await countFor(caller, actor), who).toBe(expected)
        expect(await readFor(caller, actor), `${who} reads`).toBe(expected)
      }
    })
  })

  it('whisper account events reach only visible human viewers; public events reach all human members', async () => {
    await inRollback(async () => {
      const room = await seedRoom('e1')
      const everyone = [room.owner, room.alice, room.peer].sort()
      const whisperHumans = [room.alice] // The other participant is an agent, not an account-event consumer.
      const whisper = room.ids()
      const open = room.ids()

      let since = await mark()
      await post(room, room.group, room.alice, whisper, '只给 A', room.a)
      await post(room, room.group, room.alice, open, '大家好', null)
      expect(await notified(since, 'message_created', { entityId: whisper })).toEqual(whisperHumans)
      expect(await notified(since, 'message_created', { entityId: open })).toEqual(everyone)
      // The agent still reads its whisper through the owner-authenticated RPC.
      const read = await as<{ id: string }>(room.owner, 'SELECT id FROM chat.message_history_as($1,$2,NULL,NULL,100)', [room.group, room.a])
      expect(read.map(({ id }) => id)).toContain(whisper)

      since = await mark()
      await database.query(`INSERT INTO chat.message_reactions (id, message_id, user_id, emoji) VALUES ($1,$2,$3,'👍'),($4,$5,$3,'👍')`,
        [room.ids(), whisper, room.a, room.ids(), open])
      expect(await notified(since, 'reaction_changed', { entityId: whisper })).toEqual(whisperHumans)
      expect(await notified(since, 'reaction_changed', { entityId: open })).toEqual(everyone)

      since = await mark()
      await database.query(`INSERT INTO chat.message_deliveries (message_id, device_id, status) VALUES ($1,$3,'delivered'),($2,$3,'delivered')`,
        [whisper, open, `gugu-agent:${room.a}`])
      expect(await notified(since, 'delivery_changed', { entityId: whisper })).toEqual(whisperHumans)
      expect(await notified(since, 'delivery_changed', { entityId: open })).toEqual(everyone)

      since = await mark()
      await database.query('UPDATE chat.messages SET deleted_at = now() WHERE id = ANY($1)', [[whisper, open]])
      expect(await notified(since, 'message_deleted', { entityId: whisper })).toEqual(whisperHumans)
      expect(await notified(since, 'message_deleted', { entityId: open })).toEqual(everyone)
    })
  })

  it('topic source-line wakes retain visible human viewers and exclude agent accounts', async () => {
    await inRollback(async () => {
      const room = await seedRoom('t1')
      const everyone = [room.owner, room.alice, room.peer].sort()
      // Alice 与 A 先经一句公开点名进话题:进话题本身是另一条(成员变化)事件,不混进下面的读数。
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids) VALUES ($1,$2,$3,'@A 进来','text',$4)`,
        [room.ids(), room.topic, room.alice, [room.a]],
      )

      let since = await mark()
      await post(room, room.topic, room.alice, room.ids(), '话题里只给 A', room.a)
      expect(await notified(since, 'chat_changed', { chatId: room.group })).toEqual([room.alice])

      since = await mark()
      await post(room, room.topic, room.alice, room.ids(), '话题里公开一句', null)
      expect(await notified(since, 'chat_changed', { chatId: room.group })).toEqual(everyone)
    })
  })

  it('a human whisper recipient retains creation and deletion events without notifying other human members', async () => {
    await inRollback(async () => {
      const room = await seedRoom('f1')
      const whisper = room.ids()
      const viewers = [room.alice, room.peer].sort()
      let since = await mark()
      await post(room, room.group, room.alice, whisper, '只给 Peer', room.peer)
      expect(await notified(since, 'message_created', { entityId: whisper })).toEqual(viewers)
      since = await mark()
      await database.query('UPDATE chat.messages SET deleted_at = now() WHERE id=$1', [whisper])
      expect(await notified(since, 'message_deleted', { entityId: whisper })).toEqual(viewers)
    })
  })
})
