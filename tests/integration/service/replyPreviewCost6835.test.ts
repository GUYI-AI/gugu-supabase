// gugu #6835 回复预览与逐条可见性判断的开销 —— 对着**真库**跑,用结构断言(函数的语言 / STRICT / 易变性、本事务里的
// 函数调用次数、计划里的表达式),不用墙钟:
//   · 没有回复的一页 30 行,预览函数一次也不被调(STRICT);有回复的那一页,每条回复按读到的回复列各调一次(只算返回的行);
//   · 批量读(history / search / 话题计数 / RLS)里悄悄话规则被内联成表达式:whisper_visible_to 的调用次数为 0,
//     可见下界每条查询(话题计数是每个话题)只算一次;
//   · 预览逐字符合规则:看得见被回复的那条才有预览,悄悄话从不进预览,发信人已注销写「已注销用户」。
// 调用次数取自 pg_stat_get_xact_function_calls(本事务内、尚未落盘的计数),会话里开 track_functions = all。
//
// 与 oneWhisperRule6835 同形:loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,每条用例 BEGIN…ROLLBACK。
// 跑法:`GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:34890/postgres \
//        pnpm exec vitest run replyPreviewCost6835`
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
    throw new Error(`replyPreviewCost6835.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`replyPreviewCost6835.test requires loopback PostgreSQL, got ${parsed.hostname}`)
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

const FN = {
  previewFor: 'chat.message_reply_preview_for(text,text)',
  previewRow: 'chat.message_reply_preview_row(text,text)',
  visible: 'chat.message_visible_to(text,timestamptz,boolean,text,text[],text)',
  whisper: 'chat.whisper_visible_to(boolean,text,text[],text)',
  floor: 'chat.history_floor(text,text)',
} as const
type Counted = keyof typeof FN

/** This transaction's call counts for the functions above (functions that were inlined are never called, so never counted). */
async function calls(): Promise<Record<Counted, number>> {
  const { rows } = await database.query<{ key: Counted; n: string }>(
    `SELECT key, COALESCE(pg_stat_get_xact_function_calls(sig::regprocedure), 0)::text AS n
       FROM jsonb_each_text($1::jsonb) AS f(key, sig)`, [JSON.stringify(FN)])
  return Object.fromEntries(rows.map((r) => [r.key, Number(r.n)])) as Record<Counted, number>
}
async function delta(body: () => Promise<unknown>): Promise<Record<Counted, number>> {
  const before = await calls()
  await body()
  const after = await calls()
  return Object.fromEntries((Object.keys(FN) as Counted[]).map((k) => [k, after[k] - before[k]])) as Record<Counted, number>
}

interface World {
  owner: string; alice: string; peer: string; late: string; a: string
  group: string; topic: string
  early: string; open: string; whisper: string; orphan: string
  replies: Record<'early' | 'open' | 'whisper' | 'orphan', string>
  plain: string[]
}

/**
 * A group: owner, Alice, a peer, a late joiner (floor an hour ago), the owner's agent A. Four targets — an early line
 * (before the late joiner's floor), a public line, Alice's whisper to A, a line whose sender account is gone — then
 * the owner's reply to each, then 40 plain lines on top: the newest page of 30 has no reply in it, the next one has all four.
 */
async function seedWorld(tag: string): Promise<World> {
  const w: World = {
    owner: uid(tag, 1), alice: uid(tag, 2), peer: uid(tag, 3), late: uid(tag, 4), a: uid(tag, 5),
    group: uid(tag, 11), topic: '',
    early: uid(tag, 21), open: uid(tag, 22), whisper: uid(tag, 23), orphan: uid(tag, 24),
    replies: { early: uid(tag, 31), open: uid(tag, 32), whisper: uid(tag, 33), orphan: uid(tag, 34) },
    plain: Array.from({ length: 40 }, (_, i) => uid(tag, 100 + i)),
  }
  for (const [id, name] of [[w.owner, '群主'], [w.alice, 'Alice'], [w.peer, 'Peer'], [w.late, 'Late']] as const) {
    await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)`, [id, name])
  }
  await database.query(`INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1,$2,'6835','6835','darwin')`,
    [`dev-6835-${tag}`, w.owner])
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent','Agent A',$2,$3)`,
    [w.a, w.owner, `dev-6835-${tag}`])
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','群',$2)`, [w.group, w.owner])
  for (const user of [w.owner, w.alice, w.peer, w.late, w.a]) {
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)`, [w.group, user, user === w.owner ? 'owner' : 'member'])
  }
  await database.query(`UPDATE chat.chat_members SET hide_history_before = NULL WHERE chat_id = $1`, [w.group])
  await database.query(`UPDATE chat.chat_members SET hide_history_before = now() - interval '1 hour' WHERE chat_id = $1 AND user_id = $2`, [w.group, w.late])
  let minute = 180
  const post = (id: string, sender: string, content: string, extra: { whisperTo?: string; replyTo?: string } = {}) => {
    minute -= 1
    return database.query(
      `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, is_whisper, reply_to_message_id, created_at)
       VALUES ($1,$2,$3,$4,'text',$5,$6,$7, now() - make_interval(mins => $8))`,
      [id, w.group, sender, content, extra.whisperTo ? [extra.whisperTo] : null, !!extra.whisperTo, extra.replyTo ?? null, minute],
    )
  }
  await post(w.early, w.owner, '早先的一句')
  minute = 50 // everything after this is inside the late joiner's floor
  await post(w.open, w.alice, '公开的一句')
  await post(w.whisper, w.alice, '只给 A', { whisperTo: w.a })
  await post(w.orphan, w.alice, '注销了的人说的')
  // 账号注销后 sender 经 ON DELETE SET NULL 变空:直接把这一格造成那个样子。
  await database.query('UPDATE chat.messages SET sender_user_id = NULL WHERE id = $1', [w.orphan])
  for (const [key, target] of [['early', w.early], ['open', w.open], ['whisper', w.whisper], ['orphan', w.orphan]] as const) {
    await post(w.replies[key], w.owner, `回复 ${key}`, { replyTo: target })
  }
  for (const [i, id] of w.plain.entries()) await post(id, i % 2 ? w.alice : w.owner, `第 ${i} 句`)
  w.topic = (await as<{ chat_id: string }>(w.owner, 'SELECT chat_id FROM chat.create_topic($1,$2,$3,NULL,NULL)', [w.group, w.open, '话题']))[0]!.chat_id
  await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type) VALUES ($1,$2,$3,'话题里一句','text')`,
    [uid(tag, 41), w.topic, w.alice])
  return w
}

const PAGE = `SELECT id, reply_to_message_id, reply_to_sender_user_id, reply_to_sender_name, reply_to_content
                FROM chat.messages_view
               WHERE chat_id = $1 AND deleted_at IS NULL AND thread_root_id IS NULL AND is_imported_history_root = false
                 AND ($2::bigint IS NULL OR seq < $2) ORDER BY seq DESC LIMIT 30`

describe('#6835 reply preview and visibility cost — structural, not wall-clock', () => {
  it('the three functions are plpgsql, STABLE, SECURITY DEFINER; the previews are STRICT; the rule helper stays inlinable sql', async () => {
    await inRollback(async () => {
      const { rows } = await database.query<{ fn: string; lang: string; strict: boolean; volatile: string; definer: boolean; config: string[] | null }>(
        `SELECT p.oid::regprocedure::text AS fn, l.lanname AS lang, p.proisstrict AS strict, p.provolatile::text AS volatile,
                p.prosecdef AS definer, p.proconfig AS config
           FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
          WHERE p.oid = ANY (ARRAY[$1,$2,$3,$4]::regprocedure[]) ORDER BY 1`,
        [FN.previewFor, FN.previewRow, FN.visible, FN.whisper])
      const shape = Object.fromEntries(rows.map((r) => [r.fn, { lang: r.lang, strict: r.strict, volatile: r.volatile, definer: r.definer, config: r.config }]))
      expect(shape['chat.message_reply_preview_for(text,text)']).toMatchObject({ lang: 'plpgsql', strict: true, volatile: 's', definer: true })
      expect(shape['chat.message_reply_preview_row(text,text)']).toMatchObject({ lang: 'plpgsql', strict: true, volatile: 's', definer: true })
      expect(shape['chat.message_visible_to(text,timestamp with time zone,boolean,text,text[],text)']).toMatchObject({ lang: 'plpgsql', strict: false, volatile: 's', definer: true })
      // 规划器只内联普通、不带 DEFINER / SET 的 sql 函数。
      expect(shape['chat.whisper_visible_to(boolean,text,text[],text)']).toEqual({ lang: 'sql', strict: false, volatile: 'i', definer: false, config: null })
    })
  })

  it('a page of 30 rows without replies calls no preview; the next page calls it once per reply column read, per reply row', async () => {
    await inRollback(async () => {
      const w = await seedWorld('p1')
      for (const viewer of [w.owner, w.alice, w.peer, w.late]) {
        let newest: Array<{ id: string; reply_to_message_id: string | null }> = []
        const first = await delta(async () => { newest = await as(viewer, PAGE, [w.group, null]) })
        expect(newest).toHaveLength(30)
        expect(newest.filter((r) => r.reply_to_message_id).length).toBe(0)
        expect(first.previewFor, `page 1 preview calls for ${viewer}`).toBe(0)
        expect(first.previewRow).toBe(0)
        expect(first.visible).toBe(0)

        // 正对照:下一页有回复 —— 计数器是活的,STRICT 不是把预览关掉了。回复列是标量子查询(只在被读、且只对返回的行求值),
        // PAGE 读了三列,所以每条回复三次外壳、三次内核;没读回复列的查询一次也不调(见 inboxAndPreviewReadCost)。
        const oldestSeq = (await database.query<{ seq: string }>('SELECT seq::text FROM chat.messages WHERE id = $1', [newest.at(-1)!.id])).rows[0]!.seq
        let older: Array<{ reply_to_message_id: string | null }> = []
        const second = await delta(async () => { older = await as(viewer, PAGE, [w.group, oldestSeq]) })
        const replyRows = older.filter((r) => r.reply_to_message_id).length
        expect(replyRows).toBe(4)
        expect(second.previewFor, `page 2 preview calls for ${viewer}`).toBe(3 * replyRows)
        expect(second.previewRow).toBe(3 * replyRows)
      }
    })
  })

  it('bulk readers inline the whisper rule and take the floor once: history, search, topic count, RLS', async () => {
    await inRollback(async () => {
      const w = await seedWorld('b1')
      // 正对照:直接调一次,计数器就记一次 —— 下面的 0 是「被内联」,不是「没在数」。
      expect((await delta(() => database.query(`SELECT chat.whisper_visible_to(true, 'x', NULL, 'y')`))).whisper).toBe(1)

      const history = await delta(() => as(w.owner, 'SELECT id FROM chat.message_history_as($1,$2,NULL,NULL,100)', [w.group, w.a]))
      expect(history).toMatchObject({ whisper: 0, visible: 0, floor: 1 })
      const search = await delta(() => as(w.owner, `SELECT id FROM chat.message_search_as($1,'句',$2,NULL,100)`, [w.group, w.a]))
      expect(search).toMatchObject({ whisper: 0, visible: 0, floor: 1 })
      const topics = await delta(() => as(w.owner, 'SELECT message_count FROM chat.list_topics_of_chat($1,$2)', [w.group, w.a]))
      expect(topics).toMatchObject({ whisper: 0, visible: 0, floor: 1 })
      const rls = await delta(() => as(w.peer, 'SELECT count(*) FROM chat.messages WHERE chat_id = $1', [w.group]))
      expect(rls.whisper).toBe(0)
      // RLS 的计划里,悄悄话规则是展开后的表达式,不是一次函数调用。
      const plan = (await as<{ 'QUERY PLAN': string }>(w.peer, `EXPLAIN (VERBOSE, COSTS OFF) SELECT id FROM chat.messages WHERE chat_id = $1`, [w.group]))
        .map((r) => r['QUERY PLAN']).join('\n')
      expect(plan).not.toContain('whisper_visible_to')
      expect(plan).toMatch(/= ANY \(\(ARRAY\[/)
    })
  })

  it('previews follow the rule: seen target → its preview; whisper never; gone sender → 已注销用户; late joiner not before its floor', async () => {
    await inRollback(async () => {
      const w = await seedWorld('v1')
      const target = (await database.query<{ id: string; sender_user_id: string | null; content: string; created_at: Date }>(
        'SELECT id, sender_user_id, content, created_at FROM chat.messages WHERE id = ANY($1)', [[w.early, w.open, w.whisper, w.orphan]])).rows
      const names = new Map([[w.owner, '群主'], [w.alice, 'Alice']])
      const floorOf = (viewer: string) => (viewer === w.late ? Date.now() - 3600_000 : -Infinity)
      const expected = (viewer: string, targetId: string) => {
        const t = target.find((r) => r.id === targetId)!
        if (targetId === w.whisper || t.created_at.getTime() < floorOf(viewer)) return null
        return { sender: t.sender_user_id, name: t.sender_user_id ? names.get(t.sender_user_id)! : '已注销用户', content: t.content }
      }
      for (const viewer of [w.owner, w.alice, w.peer, w.late]) {
        const rows = await as<{ id: string; reply_to_sender_user_id: string | null; reply_to_sender_name: string | null; reply_to_content: string | null }>(viewer,
          `SELECT id, reply_to_sender_user_id, reply_to_sender_name, reply_to_content FROM chat.messages_view WHERE id = ANY($1)`,
          [Object.values(w.replies)])
        for (const [key, targetId] of [['early', w.early], ['open', w.open], ['whisper', w.whisper], ['orphan', w.orphan]] as const) {
          const row = rows.find((r) => r.id === w.replies[key])
          if (!row) continue // the late joiner does not see replies written before its floor
          const want = expected(viewer, targetId)
          expect(row.reply_to_content === null ? null : { sender: row.reply_to_sender_user_id, name: row.reply_to_sender_name, content: row.reply_to_content },
            `preview of ${key} for ${viewer}`).toEqual(want)
        }
      }
      // agent 经外壳读(主人代问);NULL 的 viewer 或消息 id:STRICT,一行都不给。
      expect((await as(w.owner, 'SELECT * FROM chat.message_reply_preview_for($1,$2)', [w.open, w.a])).length).toBe(1)
      expect((await as(w.owner, 'SELECT * FROM chat.message_reply_preview_for($1,$2)', [w.whisper, w.a])).length).toBe(0)
      expect((await as(w.owner, 'SELECT * FROM chat.message_reply_preview_for(NULL,$1)', [w.a])).length).toBe(0)
      expect((await as(w.owner, 'SELECT * FROM chat.message_reply_preview_for($1,NULL)', [w.open])).length).toBe(0)
    })
  })

  it('re-created functions keep their grants', async () => {
    await inRollback(async () => {
      const { rows } = await database.query<{ fn: string; authenticated: boolean; service: boolean; anon: boolean }>(
        `SELECT s AS fn, has_function_privilege('authenticated', s::regprocedure, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', s::regprocedure, 'EXECUTE') AS service,
                has_function_privilege('anon', s::regprocedure, 'EXECUTE') AS anon
           FROM unnest($1::text[]) s ORDER BY s`, [[FN.previewFor, FN.previewRow, FN.visible]])
      expect(rows).toEqual([
        { fn: FN.previewFor, authenticated: true, service: true, anon: false },
        { fn: FN.previewRow, authenticated: false, service: true, anon: false },
        { fn: FN.visible, authenticated: false, service: true, anon: false },
      ])
    })
  })
})
