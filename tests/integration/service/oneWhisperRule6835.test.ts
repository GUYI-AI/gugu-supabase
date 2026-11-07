// gugu #6835 悄悄话判据收成一处 —— 对着**真库**跑:每个入口都读一遍,逐格与同一张答案表一致。
// 答案表由测试自己从库里的原始行算(成员与入群时间界 + 悄悄话规则),不借任何一个被测函数。
// 入口:message_visible_to、can_read_message、message_history_as、message_search_as、RLS(messages_view)、
// list_topics_of_chat 的计数、list_unread_locators、mark_unread、get_agent_join_context、topic_source_state、
// message_reply_preview_for。广播那一路由 whisperCountsAndEvents6835 管。
//
// 与 messageViaAppF16 同形:loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,每条用例 BEGIN…ROLLBACK。
// 跑法:`GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:34890/postgres \
//        pnpm exec vitest run oneWhisperRule6835`
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
    throw new Error(`oneWhisperRule6835.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`oneWhisperRule6835.test requires loopback PostgreSQL, got ${parsed.hostname}`)
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
  await database.query('BEGIN')
  try {
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

/** As `userId` (authenticated, their claims) inside the running transaction; a failure comes back as its message. */
async function as<Row>(userId: string, sql: string, values: unknown[]): Promise<{ rows: Row[]; error?: string }> {
  await database.query('SAVEPOINT as_user')
  try {
    await database.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    const { rows } = await database.query<Row>(sql, values)
    await database.query('RELEASE SAVEPOINT as_user')
    return { rows }
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT as_user')
    return { rows: [], error: String((error as Error).message) }
  } finally {
    await database.query(`SELECT set_config('role', 'postgres', true)`)
  }
}

interface Row { id: string; chat_id: string; content: string | null; created_at: Date; is_whisper: boolean; sender_user_id: string | null; to_user_ids: string[] | null; thread_root_id: string | null; seq: string }
interface Member { chat_id: string; user_id: string; hide_history_before: Date | null }

/** The answer sheet: the rule written out once more, here, from the raw rows (no function under test is used). */
function oracle(rows: Row[], members: Member[], topics: Map<string, string>) {
  const floor = (chatId: string, user: string): number | null => {
    const own = members.find((m) => m.chat_id === chatId && m.user_id === user)
    const source = topics.get(chatId)
    const viaSource = source ? members.find((m) => m.chat_id === source && m.user_id === user) : undefined
    const floors = [own, viaSource].filter((m): m is Member => !!m).map((m) => m.hide_history_before?.getTime() ?? -Infinity)
    return floors.length ? Math.min(...floors) : null
  }
  return (row: Row, viewer: string): boolean => {
    const f = floor(row.chat_id, viewer)
    if (f === null || row.created_at.getTime() < f) return false
    return !row.is_whisper || row.sender_user_id === viewer || (row.to_user_ids ?? []).includes(viewer)
  }
}

interface World {
  owner: string; alice: string; peer: string; late: string; a: string; b: string; c: string
  group: string; topic: string; lone: string
  early: string; open: string; whisper: string
  humans: string[]; agents: string[]; viewers: string[]
}

/**
 * A group: owner, Alice (who whispers), a peer, a late joiner (sees nothing before an hour ago), the owner's agents A and B;
 * an early public line (before the late joiner's floor), a public line, and Alice's whisper to A. A topic grown from the
 * early line holds a public line and a whisper to A. Agent C joins the group last (join context). A second group holds
 * only a whisper (mark_unread).
 */
async function seedWorld(tag: string): Promise<World> {
  const w: World = {
    owner: uid(tag, 1), alice: uid(tag, 2), peer: uid(tag, 3), late: uid(tag, 4), a: uid(tag, 5), b: uid(tag, 6), c: uid(tag, 7),
    group: uid(tag, 11), topic: '', lone: uid(tag, 12),
    early: uid(tag, 21), open: uid(tag, 22), whisper: uid(tag, 23),
    humans: [], agents: [], viewers: [],
  }
  w.humans = [w.owner, w.alice, w.peer, w.late]
  w.agents = [w.a, w.b]
  w.viewers = [...w.humans, ...w.agents]
  for (const [id, name] of [[w.owner, '群主'], [w.alice, 'Alice'], [w.peer, 'Peer'], [w.late, 'Late']] as const) {
    await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)`, [id, name])
  }
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1,$2,'6835','6835','darwin')`,
    [`dev-6835-${tag}`, w.owner],
  )
  for (const [id, name] of [[w.a, 'Agent A'], [w.b, 'Agent B'], [w.c, 'Agent C']] as const) {
    await database.query(
      `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent',$2,$3,$4)`,
      [id, name, w.owner, `dev-6835-${tag}`],
    )
  }
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','群',$2),($3,'group','只有悄悄话',$2)`,
    [w.group, w.owner, w.lone])
  for (const user of w.viewers) {
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)`, [w.group, user, user === w.owner ? 'owner' : 'member'])
  }
  for (const user of [w.owner, w.alice, w.peer, w.a]) {
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)`, [w.lone, user, user === w.owner ? 'owner' : 'member'])
  }
  await database.query(`UPDATE chat.chat_members SET hide_history_before = NULL, inbox_published_at = now(), last_read_seq = 0 WHERE chat_id IN ($1,$2)`, [w.group, w.lone])
  await database.query(`UPDATE chat.chat_members SET hide_history_before = now() - interval '1 hour' WHERE chat_id = $1 AND user_id = $2`, [w.group, w.late])

  const post = (id: string, chatId: string, sender: string, content: string, whisperTo: string | null, ago: string) =>
    database.query(
      `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, is_whisper, created_at)
       VALUES ($1,$2,$3,$4,'text',$5,$6, now() - $7::interval)`,
      [id, chatId, sender, content, whisperTo ? [whisperTo] : null, whisperTo !== null, ago],
    )
  await post(w.early, w.group, w.owner, '6835x early', null, '2 hours')
  await post(w.open, w.group, w.alice, '6835x open', null, '30 minutes')
  await post(w.whisper, w.group, w.alice, '6835x whisper', w.a, '30 minutes')
  await post(uid(tag, 24), w.lone, w.alice, '6835x lone whisper', w.a, '30 minutes')
  w.topic = (await as<{ chat_id: string }>(w.owner, 'SELECT chat_id FROM chat.create_topic($1,$2,$3,NULL,NULL)', [w.group, w.early, '话题'])).rows[0]!.chat_id
  await post(uid(tag, 31), w.topic, w.alice, '6835x topic open', null, '20 minutes')
  // gugu #6840:话题里的悄悄话只对话题自己的成员说(库的写入口判),A 先是话题成员。
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`, [w.topic, w.a])
  await post(uid(tag, 32), w.topic, w.alice, '6835x topic whisper', w.a, '20 minutes')
  // C 最后入群:入群前的那几条就是它的「入群前上下文」。
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`, [w.group, w.c])
  await database.query(`UPDATE chat.chat_members SET hide_history_before = NULL, joined_at = now(), last_read_seq = 0, join_context_shown_at = NULL
    WHERE chat_id = $1 AND user_id = $2`, [w.group, w.c])
  return w
}

async function load(w: World) {
  const rows = (await database.query<Row>(
    `SELECT id, chat_id, content, created_at, is_whisper, sender_user_id, to_user_ids, thread_root_id, seq::text AS seq
       FROM chat.messages WHERE chat_id = ANY($1) AND deleted_at IS NULL`, [[w.group, w.topic, w.lone]])).rows
  const members = (await database.query<Member>(
    `SELECT chat_id, user_id, hide_history_before FROM chat.chat_members WHERE chat_id = ANY($1)`, [[w.group, w.topic, w.lone]])).rows
  const topics = new Map([[w.topic, w.group]])
  return { rows, members, visible: oracle(rows, members, topics) }
}

/** Who asks for an actor: a person asks as themselves; an agent is asked for by its owner. */
const callerOf = (w: World, actor: string) => (w.agents.includes(actor) || actor === w.c ? w.owner : actor)
const sorted = (ids: string[]) => [...ids].sort()

describe('#6835 one whisper rule: every entry reads the same answer sheet', () => {
  it('row-level entries — message_visible_to, can_read_message, history, search, RLS — agree cell by cell', async () => {
    await inRollback(async () => {
      const w = await seedWorld('r1')
      const { rows, visible } = await load(w)
      // 阳控:答案表里真有看得见也有看不见的,且两种都跨人、跨线(否则「一致」可能是全真或全假)。
      const cells = rows.flatMap((row) => w.viewers.map((viewer) => visible(row, viewer)))
      expect(cells.filter(Boolean).length).toBeGreaterThan(0)
      expect(cells.filter((cell) => !cell).length).toBeGreaterThan(0)
      expect(visible(rows.find((r) => r.id === w.early)!, w.late)).toBe(false)
      expect(visible(rows.find((r) => r.id === w.whisper)!, w.a)).toBe(true)

      for (const viewer of w.viewers) {
        for (const row of rows) {
          const expected = visible(row, viewer)
          const direct = (await database.query<{ v: boolean }>(
            'SELECT chat.message_visible_to($1,$2,$3,$4,$5,$6) AS v',
            [row.chat_id, row.created_at, row.is_whisper, row.sender_user_id, row.to_user_ids, viewer])).rows[0]!.v
          expect(direct, `message_visible_to ${row.id} for ${viewer}`).toBe(expected)
          const canRead = (await as<{ v: boolean }>(callerOf(w, viewer), 'SELECT chat.can_read_message($1,$2) AS v', [row.id, viewer])).rows[0]!.v
          expect(canRead, `can_read_message ${row.id} for ${viewer}`).toBe(expected)
        }
        for (const chatId of [w.group, w.topic, w.lone]) {
          const expected = sorted(rows.filter((r) => r.chat_id === chatId && !r.thread_root_id && visible(r, viewer)).map((r) => r.id))
          const history = await as<{ id: string }>(callerOf(w, viewer), 'SELECT id FROM chat.message_history_as($1,$2,NULL,NULL,100)', [chatId, viewer])
          expect(sorted(history.rows.map((r) => r.id)), `history ${chatId} for ${viewer}`).toEqual(expected)
          const search = await as<{ id: string }>(callerOf(w, viewer), `SELECT id FROM chat.message_search_as($1,'6835x',$2,NULL,100)`, [chatId, viewer])
          expect(sorted(search.rows.map((r) => r.id)), `search ${chatId} for ${viewer}`).toEqual(
            sorted(rows.filter((r) => r.chat_id === chatId && (r.content ?? '').includes('6835x') && visible(r, viewer)).map((r) => r.id)))
          if (w.humans.includes(viewer)) {
            const rls = await as<{ id: string }>(viewer, 'SELECT id FROM chat.messages_view WHERE chat_id = $1', [chatId])
            expect(sorted(rls.rows.map((r) => r.id)), `RLS ${chatId} for ${viewer}`).toEqual(sorted(rows.filter((r) => r.chat_id === chatId && visible(r, viewer)).map((r) => r.id)))
          }
        }
      }
    })
  })

  it('aggregate entries — topic count, unread, mark_unread, join context — agree with the same sheet', async () => {
    await inRollback(async () => {
      const w = await seedWorld('a1')
      const { rows, visible } = await load(w)
      for (const viewer of w.viewers) {
        const count = await as<{ message_count: string }>(callerOf(w, viewer),
          'SELECT message_count::text FROM chat.list_topics_of_chat($1,$2) WHERE chat_id = $3', [w.group, viewer, w.topic])
        expect(Number(count.rows[0]!.message_count), `topic count for ${viewer}`).toBe(rows.filter((r) => r.chat_id === w.topic && visible(r, viewer)).length)
      }
      for (const viewer of w.humans) {
        const unread = await as<{ unread_count: string }>(viewer,
          `SELECT unread_count::text FROM chat.list_unread_locators($1) WHERE stream_kind = 'main'`, [w.group])
        const expected = rows.filter((r) => r.chat_id === w.group && !r.thread_root_id && r.sender_user_id !== null && r.sender_user_id !== viewer && Number(r.seq) > 0 && visible(r, viewer)).length
        expect(Number(unread.rows[0]?.unread_count ?? 0), `unread for ${viewer}`).toBe(expected)

        const marked = await as(viewer, 'SELECT * FROM chat.mark_unread($1)', [w.lone])
        const seesSomething = rows.some((r) => r.chat_id === w.lone && visible(r, viewer))
        const member = [w.owner, w.alice, w.peer].includes(viewer)
        if (member) expect(marked.error === undefined, `mark_unread for ${viewer}: ${marked.error ?? 'ok'}`).toBe(seesSomething)
      }
      // 阳控:只有悄悄话的那条线,发信人标得了未读,旁人标不了。
      expect((await as(w.alice, 'SELECT * FROM chat.mark_unread($1)', [w.lone])).error).toBeUndefined()
      expect((await as(w.peer, 'SELECT * FROM chat.mark_unread($1)', [w.lone])).error).toMatch(/cannot mark an empty main stream unread/)

      const joined = (await database.query<{ joined_at: Date }>('SELECT joined_at FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2', [w.group, w.c])).rows[0]!.joined_at
      const join = await as<{ skipped_before_join: string }>(w.owner, 'SELECT skipped_before_join::text FROM identity.get_agent_join_context($1,$2)', [w.c, w.group])
      const expectedSkipped = rows.filter((r) => r.chat_id === w.group && r.sender_user_id !== null && r.sender_user_id !== w.c && r.created_at < joined && visible(r, w.c)).length
      expect(expectedSkipped).toBeGreaterThan(0)
      expect(Number(join.rows[0]!.skipped_before_join), 'join context skipped for C').toBe(expectedSkipped)
    })
  })

  // 事件触发器 gg_revoke_public_execute_on_functions 在每次 CREATE [OR REPLACE] FUNCTION 后收回客户端的 EXECUTE:
  // 重建过的函数必须照原样补回,新的两个小件按各自的用途给。
  it('re-created functions keep their client grants; the rule is callable by clients, the floor is not', async () => {
    await inRollback(async () => {
      const clientCalled = [
        'chat.can_read_message(text,text)',
        'chat.list_topics_of_chat(text,text,text)',
        'chat.message_history_as(text,text,text,bigint,integer)',
        'chat.message_reply_preview_for(text,text)',
        'chat.message_search_as(text,text,text,bigint,integer)',
        'chat.topic_source_state(text,text)',
        'chat.list_unread_locators(text)',
        'chat.mark_unread(text,text)',
        'identity.get_agent_join_context(text,text)',
        'chat.whisper_visible_to(boolean,text,text[],text)',
      ]
      const serverOnly = [
        'chat.history_floor(text,text)',
        'chat.message_visible_to(text,timestamptz,boolean,text,text[],text)',
        'chat.message_visible_at(timestamptz,timestamptz,boolean,text,text[],text)',
        'chat.message_reply_preview_row(text,text)',
        'chat.broadcast_to_chat_member_user_events(text,text,jsonb)',
      ]
      const privileges = async (signatures: string[]) => (await database.query<{ fn: string; authenticated: boolean; anon: boolean }>(
        `SELECT s AS fn, has_function_privilege('authenticated', s::regprocedure, 'EXECUTE') AS authenticated,
                has_function_privilege('anon', s::regprocedure, 'EXECUTE') AS anon
           FROM unnest($1::text[]) s ORDER BY s`, [signatures])).rows
      expect(await privileges(clientCalled)).toEqual([...clientCalled].sort().map((fn) => ({ fn, authenticated: true, anon: false })))
      expect(await privileges(serverOnly)).toEqual([...serverOnly].sort().map((fn) => ({ fn, authenticated: false, anon: false })))
      expect((await database.query<{ gone: boolean }>(
        `SELECT to_regprocedure('chat.can_read_message_row(text,timestamptz,boolean,text,text[],text)') IS NULL AS gone`)).rows[0]!.gone).toBe(true)
    })
  })

  it('single-message shells — topic_source_state, message_reply_preview_for — agree with the same sheet', async () => {
    await inRollback(async () => {
      const w = await seedWorld('s1')
      const { rows, visible } = await load(w)
      const early = rows.find((r) => r.id === w.early)!
      for (const viewer of w.viewers) {
        const state = await as<{ state: string }>(callerOf(w, viewer), 'SELECT state FROM chat.topic_source_state($1,$2)', [w.topic, viewer])
        expect(state.rows[0]?.state, `topic source for ${viewer}`).toBe(visible(early, viewer) ? 'readable' : 'unreadable')
        for (const id of [w.early, w.open, w.whisper]) {
          const row = rows.find((r) => r.id === id)!
          const preview = await as<{ reply_to_message_id: string }>(callerOf(w, viewer),
            'SELECT reply_to_message_id FROM chat.message_reply_preview_for($1,$2)', [id, viewer])
          // 悄悄话从不进回复预览(产品规则,不是可见性):那一格恒为空。
          expect(preview.rows.length, `reply preview of ${id} for ${viewer}`).toBe(visible(row, viewer) && !row.is_whisper ? 1 : 0)
        }
      }
      expect(visible(early, w.late)).toBe(false)
      expect(visible(early, w.peer)).toBe(true)
    })
  })
})
