// gugu #6835 message_deliveries 的读取策略改为逐行判断 —— 对着**真库**跑。
//   · 每个人读到的回执行,逐行等于答案表:消息所在会话的成员,且那条消息他看得见(入群时间界、悄悄话规则);
//   · 结构(不用墙钟):策略就是一次 can_see_delivery_of 调用;读一页回执时它只按索引挑出来的行数被调;计划里没有 hashed SubPlan;
//   · can_see_delivery_of 只判 auth.uid() 自己,没有 actor 参数:以 A 的身份问一条只有 B 看得见的消息,答 false。
// 调用次数取自 pg_stat_get_xact_function_calls(本事务、track_functions = all)。
//
// 与 replyPreviewCost6835 同形:loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,每条用例 BEGIN…ROLLBACK。
// 跑法:`GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:34890/postgres \
//        pnpm exec vitest run deliveryPolicyCost6835`
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
    throw new Error(`deliveryPolicyCost6835.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`deliveryPolicyCost6835.test requires loopback PostgreSQL, got ${parsed.hostname}`)
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
    await database.query(`SET LOCAL track_functions = 'all'`)
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

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

const CAN_SEE = 'chat.can_see_delivery_of(text)'
async function callsOfCanSee(): Promise<number> {
  return Number((await database.query<{ n: string }>(
    `SELECT COALESCE(pg_stat_get_xact_function_calls($1::regprocedure), 0)::text AS n`, [CAN_SEE])).rows[0]!.n)
}

interface Msg { id: string; chat_id: string; sender_user_id: string; to_user_ids: string[] | null; is_whisper: boolean; created_at: Date }
interface World {
  owner: string; alice: string; peer: string; late: string; a: string
  group: string; other: string; topic: string
  messages: Msg[]; members: Array<{ chat_id: string; user_id: string; hide_history_before: Date | null }>
  humans: string[]
}

/**
 * A group (owner, Alice, a peer, a late joiner with a floor an hour ago, the owner's agent A) with an early line, public
 * lines and Alice's whisper to A; a second chat only the owner and the peer are in; a topic of the group that only
 * Alice and A joined. Every message has a delivery row from A's device and one from the owner's device.
 */
async function seedWorld(tag: string): Promise<World> {
  const w = {
    owner: uid(tag, 1), alice: uid(tag, 2), peer: uid(tag, 3), late: uid(tag, 4), a: uid(tag, 5),
    group: uid(tag, 11), other: uid(tag, 12), topic: '',
  } as World
  w.humans = [w.owner, w.alice, w.peer, w.late]
  for (const [id, name] of [[w.owner, '群主'], [w.alice, 'Alice'], [w.peer, 'Peer'], [w.late, 'Late']] as const) {
    await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)`, [id, name])
  }
  await database.query(`INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1,$2,'6835','6835','darwin')`,
    [`dev-6835-${tag}`, w.owner])
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent','Agent A',$2,$3)`,
    [w.a, w.owner, `dev-6835-${tag}`])
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','群',$2),($3,'group','另一个群',$2)`,
    [w.group, w.owner, w.other])
  for (const user of [w.owner, w.alice, w.peer, w.late, w.a]) {
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)`, [w.group, user, user === w.owner ? 'owner' : 'member'])
  }
  for (const user of [w.owner, w.peer]) {
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)`, [w.other, user, user === w.owner ? 'owner' : 'member'])
  }
  await database.query(`UPDATE chat.chat_members SET hide_history_before = NULL WHERE chat_id IN ($1,$2)`, [w.group, w.other])
  await database.query(`UPDATE chat.chat_members SET hide_history_before = now() - interval '1 hour' WHERE chat_id = $1 AND user_id = $2`, [w.group, w.late])
  let n = 20
  const post = async (chatId: string, sender: string, content: string, ago: string, whisperTo: string | null = null, toUsers: string[] | null = null) => {
    n += 1
    const id = uid(tag, n)
    await database.query(
      `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, is_whisper, created_at)
       VALUES ($1,$2,$3,$4,'text',$5,$6, now() - $7::interval)`,
      [id, chatId, sender, content, whisperTo ? [whisperTo] : toUsers, whisperTo !== null, ago])
    return id
  }
  const early = await post(w.group, w.owner, '早先的一句', '2 hours')
  await post(w.group, w.alice, '公开的一句', '30 minutes')
  await post(w.group, w.alice, '只给 A', '30 minutes', w.a)
  await post(w.other, w.peer, '另一个群里的', '30 minutes')
  w.topic = (await as<{ chat_id: string }>(w.owner, 'SELECT chat_id FROM chat.create_topic($1,$2,$3,NULL,NULL)', [w.group, early, '话题']))[0]!.chat_id
  // 话题只有 Alice(说话即参与)与 A(被点名即拉进来)是成员;群主是建话题的人,也是成员。
  await post(w.topic, w.alice, '话题里 @A', '20 minutes', null, [w.a])
  w.messages = (await database.query<Msg>(
    `SELECT id, chat_id, sender_user_id, to_user_ids, is_whisper, created_at FROM chat.messages
      WHERE chat_id = ANY($1) AND deleted_at IS NULL`, [[w.group, w.other, w.topic]])).rows
  for (const m of w.messages) {
    await database.query(`INSERT INTO chat.message_deliveries (message_id, device_id, status) VALUES ($1,$2,'delivered'),($1,$3,'read')`,
      [m.id, `gugu-agent:${w.a}`, `dev-6835-${tag}`])
  }
  w.members = (await database.query<World['members'][number]>(
    `SELECT chat_id, user_id, hide_history_before FROM chat.chat_members WHERE chat_id = ANY($1)`, [[w.group, w.other, w.topic]])).rows
  return w
}

/** The answer sheet, written out here from the raw rows: a direct member of the message's chat who can see the message. */
function sees(w: World, viewer: string, m: Msg): boolean {
  const direct = w.members.find((x) => x.chat_id === m.chat_id && x.user_id === viewer)
  if (!direct) return false
  const source = m.chat_id === w.topic ? w.members.find((x) => x.chat_id === w.group && x.user_id === viewer) : undefined
  const floors = [direct, source].filter(Boolean).map((x) => x!.hide_history_before?.getTime() ?? -Infinity)
  if (m.created_at.getTime() < Math.min(...floors)) return false
  return !m.is_whisper || m.sender_user_id === viewer || (m.to_user_ids ?? []).includes(viewer)
}

const sorted = (xs: string[]) => [...xs].sort()

describe('#6835 message_deliveries policy: one check per row read, the same answer as before', () => {
  it('every person reads exactly the delivery rows of the messages the sheet says they can see', async () => {
    await inRollback(async () => {
      const w = await seedWorld('d1')
      const all = w.messages.map((m) => m.id)
      // 阳控:答案表里每个人都有看得见和看不见的消息。
      for (const viewer of w.humans) {
        expect(w.messages.some((m) => sees(w, viewer, m)), `${viewer} sees something`).toBe(true)
        expect(w.messages.some((m) => !sees(w, viewer, m)), `${viewer} misses something`).toBe(true)
      }
      for (const viewer of w.humans) {
        const rows = await as<{ message_id: string; device_id: string }>(viewer,
          'SELECT message_id, device_id FROM chat.message_deliveries WHERE message_id = ANY($1)', [all])
        const expected = w.messages.filter((m) => sees(w, viewer, m)).flatMap((m) => [`${m.id}|gugu-agent:${w.a}`, `${m.id}|dev-6835-d1`])
        expect(sorted(rows.map((r) => `${r.message_id}|${r.device_id}`)), `deliveries for ${viewer}`).toEqual(sorted(expected))
      }
    })
  })

  it('structure: the policy is the check; it runs once per row the index picks; no hashed subplan over all of my messages', async () => {
    await inRollback(async () => {
      const w = await seedWorld('s1')
      const { rows: policy } = await database.query<{ qual: string }>(
        `SELECT pg_get_expr(polqual, polrelid) AS qual FROM pg_policy WHERE polname = 'message_deliveries_select_member'`)
      expect(policy.map((p) => p.qual)).toEqual(['chat.can_see_delivery_of(message_id)'])

      // 测试库里这张表只有几十行,规划器可能宁可顺序扫;真实大小的表按 id 列表自己就走主键(devdb 的计划贴在 PR 里)。
      // 这里钉的是「走索引时,每行判一次、只判挑出来的行」,所以把顺序扫关掉。
      await database.query('SET LOCAL enable_seqscan = off')
      const page = w.messages.filter((m) => m.chat_id === w.group).map((m) => m.id)
      const candidates = Number((await database.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM chat.message_deliveries WHERE message_id = ANY($1)', [page])).rows[0]!.n)
      expect(candidates).toBe(page.length * 2)
      const before = await callsOfCanSee()
      await as(w.peer, 'SELECT message_id FROM chat.message_deliveries WHERE message_id = ANY($1)', [page])
      expect(await callsOfCanSee() - before, 'one check per candidate row').toBe(candidates)

      const plan = (await as<{ 'QUERY PLAN': string }>(w.peer,
        'EXPLAIN (COSTS OFF) SELECT message_id FROM chat.message_deliveries WHERE message_id = ANY($1)', [page]))
        .map((r) => r['QUERY PLAN']).join('\n')
      expect(plan).not.toMatch(/hashed SubPlan/i)
      expect(plan).toMatch(/Index Cond: \(message_id = ANY/)
      expect(plan).toMatch(/Filter: .*chat\.can_see_delivery_of\(message_id\)/)
    })
  })

  it('can_see_delivery_of judges only the caller: asked by A about a message only B can see, it answers false', async () => {
    await inRollback(async () => {
      const w = await seedWorld('p1')
      // 只收一个参数(消息 id),没有「以谁的身份」那一格。
      const { rows: args } = await database.query<{ args: string }>(
        `SELECT pg_get_function_identity_arguments($1::regprocedure) AS args`, [CAN_SEE])
      expect(args[0]!.args).toBe('p_message_id text')
      const onlyPeerAndOwner = w.messages.find((m) => m.chat_id === w.other)!
      const whisperToA = w.messages.find((m) => m.is_whisper)!
      const ask = async (caller: string, messageId: string) =>
        (await as<{ v: boolean }>(caller, 'SELECT chat.can_see_delivery_of($1) AS v', [messageId]))[0]!.v
      expect(await ask(w.alice, onlyPeerAndOwner.id)).toBe(false) // Alice is not in that chat
      expect(await ask(w.peer, onlyPeerAndOwner.id)).toBe(true)   // 正对照:在里面的人问,答 true
      expect(await ask(w.peer, whisperToA.id)).toBe(false)        // 同一个群,但那是给 A 的悄悄话
      expect(await ask(w.alice, whisperToA.id)).toBe(true)        // 正对照:发信人问,答 true
    })
  })

  it('grants: authenticated and service_role may call the check, anon may not', async () => {
    await inRollback(async () => {
      const { rows } = await database.query<{ authenticated: boolean; service: boolean; anon: boolean }>(
        `SELECT has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS service,
                has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon`, [CAN_SEE])
      expect(rows[0]).toEqual({ authenticated: true, service: true, anon: false })
    })
  })
})
