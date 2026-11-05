import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * nmhjklnm/gugu#6400:删掉一个 agent 后,只 @ 它一个人的旧消息 ❌ 变成「没点名」投给群里的 active agent。
 *
 * 场景:一个群(群主 + 路人 + 将被删的 agent + 另一个 active 档 agent)。群主发了
 *   · 只 @ 将被删 agent 的一条(预发事故里那两条的形状);
 *   · 同时 @ 它和路人的一条(擦掉它之后名单仍非空,照旧擦);
 *   · 一条没点名的普通发言 —— 阳控:active agent 的拉取确实会拿到没点名的消息,
 *     「拉取什么都不返回」不能让判据变绿。
 * active agent 在删除之前一条都没读(对应事故里它回合结束才拉取)。删除之后它拉一次收件箱。
 *
 * 另一条用例:共享群里只发给它的 whisper —— 以前被擦成 '{}',成了没有收件人的 whisper
 * (messages_whisper_directed_chk 拦不住:array_length('{}',1) 是 NULL)。
 *
 * 判据取自 behavior/group-routing.md:点名的消息「其他 agent 不被这条消息触发」。
 *
 * 跑法:loopback `GUGU_INTEGRATION_DATABASE_URL`(跑过全部迁移的库);每条用例 BEGIN…ROLLBACK。
 */

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
  process.env.GUGU_INTEGRATION_DATABASE_URL
  ?? process.env.GUGU_DATABASE_URL
  ?? ''
).trim()

const OWNER = '64000000-0000-4000-8000-000000000001'
const BYSTANDER = '64000000-0000-4000-8000-000000000002'
const REMOVED = 'agent-removed-it-6400'
const ACTIVE = 'agent-active-it-6400'
const DEVICE = 'dev-it-6400'
const GROUP = '64000000-0000-4000-8000-000000000003'

let database: DatabaseClient

function requireLoopbackDatabase(): void {
  let parsed: URL
  try {
    parsed = new URL(DATABASE_URL)
  } catch {
    throw new Error('GUGU_INTEGRATION_DATABASE_URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`removedAgentSoleMention6400.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`removedAgentSoleMention6400.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

beforeAll(async () => {
  requireLoopbackDatabase()
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})

afterAll(async () => {
  await database?.end()
})

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

async function seed(extra: Array<[string, string[] | null, boolean]> = []): Promise<void> {
  await database.query(
    `INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','owner'),($2,'human','bystander')`,
    [OWNER, BYSTANDER],
  )
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
     VALUES ($1, $2, 'it-6400', 'it-6400', 'darwin')`,
    [DEVICE, OWNER],
  )
  await database.query(
    `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
     VALUES ($1,'agent','removed',$3,$4),($2,'agent','active',$3,$4)`,
    [REMOVED, ACTIVE, OWNER, DEVICE],
  )
  await database.query(
    `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','shared',$2)`,
    [GROUP, OWNER],
  )
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode)
     VALUES ($1,$2,'owner','passive'),($1,$3,'member','passive'),($1,$4,'member','passive'),($1,$5,'member','active')`,
    [GROUP, OWNER, BYSTANDER, REMOVED, ACTIVE],
  )
  const messages: Array<[string, string[] | null, boolean]> = [
    ['sole', [REMOVED], false],
    ['shared', [REMOVED, BYSTANDER], false],
    ['open', null, false],
    ...extra,
  ]
  for (const [id, to, whisper] of messages) {
    await database.query(
      `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, is_whisper)
       VALUES ($1,$2,$3,$1,'text',$4,$5)`,
      [`${id}-it-6400`, GROUP, OWNER, to, whisper],
    )
  }
}

async function actAsOwner(): Promise<void> {
  await database.query(
    "SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)",
    [OWNER],
  )
  await database.query('SET LOCAL role authenticated')
}

describe('#6400 a message that named only a removed agent stays directed', () => {
  it('keeps all original recipients, including the removed identity', async () => {
    await inRollback(async () => {
      await seed()
      await actAsOwner()
      await database.query('SELECT identity.remove_owned_agent($1)', [REMOVED])
      await database.query('RESET role')

      const identity = await database.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM identity.users WHERE id = $1', [REMOVED])
      expect(identity.rows[0].n).toBe('1')

      const rows = await database.query<{ id: string; to_user_ids: string[] | null; is_whisper: boolean }>(
        `SELECT id, to_user_ids, is_whisper FROM chat.messages WHERE chat_id = $1 ORDER BY id`, [GROUP])
      expect(rows.rows).toEqual([
        { id: 'open-it-6400', to_user_ids: null, is_whisper: false },
        { id: 'shared-it-6400', to_user_ids: [REMOVED, BYSTANDER], is_whisper: false },
        { id: 'sole-it-6400', to_user_ids: [REMOVED], is_whisper: false },
      ])
    })
  })

  it('keeps the recipient of a whisper addressed only to the removed agent', async () => {
    await inRollback(async () => {
      await seed([['whisper', [REMOVED], true]])
      await actAsOwner()
      // whisper 必须有收件人;擦成 '{}' 时 CHECK 取 NULL 放行,不会报错,只能看落库值。
      await database.query('SELECT identity.remove_owned_agent($1)', [REMOVED])
      await database.query('RESET role')

      const rows = await database.query<{ to_user_ids: string[]; is_whisper: boolean; identities: string }>(
        `SELECT m.to_user_ids, m.is_whisper,
                (SELECT count(*)::text FROM identity.users WHERE id = $2) AS identities
         FROM chat.messages m WHERE m.id = 'whisper-it-6400' AND m.chat_id = $1`, [GROUP, REMOVED])
      expect(rows.rows).toEqual([{ to_user_ids: [REMOVED], is_whisper: true, identities: '1' }])
    })
  })

  it('does not hand the removed agent\'s sole mention to the active agent on its next pull', async () => {
    await inRollback(async () => {
      await seed()
      await actAsOwner()
      await database.query('SELECT identity.remove_owned_agent($1)', [REMOVED])

      const pulled = await database.query<{ id: string }>(
        'SELECT id FROM identity.pull_agent_inbox_v2($1) ORDER BY seq', [ACTIVE])
      const legacy = await database.query<{ id: string }>(
        'SELECT id FROM identity.pull_agent_inbox_v2($1) ORDER BY seq', [ACTIVE])
      await database.query('RESET role')

      // 阳控:没点名的那条确实被 active agent 拿到。
      expect(pulled.rows.map((row) => row.id)).toEqual(['open-it-6400'])
      expect(legacy.rows.map((row) => row.id)).toEqual(['open-it-6400'])
    })
  })
})
