import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * nmhjklnm/gugu#6400 根治:一条消息叫醒哪些 agent,在它写入那一刻定下;之后改寻址、改档位都不让它重新挑收件人。
 *
 * 群:群主(真人)、路人(真人)、两个 agent —— WATCHER 是被观察的收件人,SPEAKER 是会被删的那个。
 * 每条用例都带阳控:同一次拉取里,一条按「此刻」规则确实该投的消息必须在结果里,
 * 「拉取什么都不返回」不能让判据变绿。
 *
 *   · 切档(owner 定:不补投):passive 时发的「没点名」消息,切到 active 后不补投;切到 active 之后发的照常投。
 *     反向同理:active 时发的,之后切到 passive 仍投给它。
 *   · 回复目标被删:路人回复 SPEAKER(不带 @)→ 只该叫醒 SPEAKER;SPEAKER 被删、回复失去路由目标后,
 *     active 的 WATCHER 拿不到它。
 *   · 寻址被擦空:只 @ SPEAKER 的消息被擦成 '{}'(identity.erase_human_account 的同类写法)后,WATCHER 拿不到它。
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

const OWNER = '64010000-0000-4000-8000-000000000001'
const BYSTANDER = '64010000-0000-4000-8000-000000000002'
const WATCHER = 'agent-watcher-it-6401'
const SPEAKER = 'agent-speaker-it-6401'
const DEVICE = 'dev-it-6401'
const GROUP = '64010000-0000-4000-8000-000000000003'

let database: DatabaseClient

function requireLoopbackDatabase(): void {
  let parsed: URL
  try {
    parsed = new URL(DATABASE_URL)
  } catch {
    throw new Error('GUGU_INTEGRATION_DATABASE_URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`agentWakesFrozenAtSend6400.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`agentWakesFrozenAtSend6400.test requires loopback PostgreSQL, got ${parsed.hostname}`)
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

async function seed(watcherMode: 'active' | 'passive'): Promise<void> {
  await database.query(
    `INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','owner'),($2,'human','bystander')`,
    [OWNER, BYSTANDER],
  )
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
     VALUES ($1, $2, 'it-6401', 'it-6401', 'darwin')`,
    [DEVICE, OWNER],
  )
  await database.query(
    `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
     VALUES ($1,'agent','watcher',$3,$4),($2,'agent','speaker',$3,$4)`,
    [WATCHER, SPEAKER, OWNER, DEVICE],
  )
  await database.query(
    `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','shared',$2)`,
    [GROUP, OWNER],
  )
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode)
     VALUES ($1,$2,'owner','passive'),($1,$3,'member','passive'),($1,$4,'member',$6),($1,$5,'member','passive')`,
    [GROUP, OWNER, BYSTANDER, WATCHER, SPEAKER, watcherMode],
  )
}

async function send(
  id: string,
  sender: string,
  opts: { to?: string[] | null; replyTo?: string | null } = {},
): Promise<void> {
  await database.query(
    `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, reply_to_message_id)
     VALUES ($1,$2,$3,$1,'text',$4,$5)`,
    [`${id}-it-6401`, GROUP, sender, opts.to ?? null, opts.replyTo ? `${opts.replyTo}-it-6401` : null],
  )
}

async function setWatcherMode(mode: 'active' | 'passive'): Promise<void> {
  await database.query(
    'UPDATE chat.chat_members SET listen_mode = $3 WHERE chat_id = $1 AND user_id = $2',
    [GROUP, WATCHER, mode],
  )
}

async function actAsOwner(): Promise<void> {
  await database.query(
    "SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)",
    [OWNER],
  )
  await database.query('SET LOCAL role authenticated')
}

/** WATCHER 的一次拉取,新旧两个入口都拉,必须给出同一份结果。 */
async function pullWatcher(): Promise<string[]> {
  await actAsOwner()
  const v2 = await database.query<{ id: string }>(
    'SELECT id FROM identity.pull_agent_inbox_v2($1) ORDER BY seq', [WATCHER])
  const legacy = await database.query<{ id: string }>(
    'SELECT id FROM identity.pull_agent_inbox_v2($1) ORDER BY seq', [WATCHER])
  await database.query('RESET role')
  const ids = v2.rows.map((row) => row.id.replace('-it-6401', ''))
  expect(legacy.rows.map((row) => row.id.replace('-it-6401', ''))).toEqual(ids)
  return ids
}

describe('#6400 who a message wakes is decided when it is written', () => {
  it('passive -> active does not replay untagged messages sent before the switch', async () => {
    await inRollback(async () => {
      await seed('passive')
      await send('before-switch', OWNER)
      await setWatcherMode('active')
      await send('after-switch', OWNER)

      expect(await pullWatcher()).toEqual(['after-switch'])
    })
  })

  it('active -> passive still delivers untagged messages sent while it was active', async () => {
    await inRollback(async () => {
      await seed('active')
      await send('while-active', OWNER)
      await setWatcherMode('passive')
      await send('while-passive', OWNER)
      await send('mentioned', OWNER, { to: [WATCHER] })

      expect(await pullWatcher()).toEqual(['while-active', 'mentioned'])
    })
  })

  it('a reply to an agent that is later removed is not handed to an active agent', async () => {
    await inRollback(async () => {
      await seed('active')
      await send('speaker-says', SPEAKER)
      await send('reply-to-speaker', BYSTANDER, { replyTo: 'speaker-says' })
      await send('open', OWNER)

      await actAsOwner()
      await database.query('SELECT identity.remove_owned_agent($1)', [SPEAKER])
      await database.query('RESET role')

      // The old sender is retained; removal must not reroute its replies.
      const target = await database.query<{ target: string | null }>(
        "SELECT chat.message_reply_routing_target('speaker-says-it-6401') AS target")
      expect(target.rows[0].target).toBe(SPEAKER)

      expect(await pullWatcher()).toEqual(['open'])
    })
  })

  it('a mention whose addressing is later scrubbed to empty is not handed to an active agent', async () => {
    await inRollback(async () => {
      await seed('active')
      await send('only-speaker', OWNER, { to: [SPEAKER] })
      await send('open', OWNER)
      await database.query(
        "UPDATE chat.messages SET to_user_ids = '{}' WHERE id = 'only-speaker-it-6401'")

      expect(await pullWatcher()).toEqual(['open'])
    })
  })
})
