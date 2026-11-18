// @@@F16 App 以人的名义给 agent 发悄悄话 —— messages.via_app、send_message_idempotent 的 p_via_app 与限速、
// pull_agent_inbox_v2 带上 via_app。对着**真库**跑:列、函数、限速计数和收件箱读取都在库里。
//   · 经 App 发的悄悄话记下是哪个 App;同样的重放收敛,换了 App 的重放是冲突;
//   · 老调用方(10 个参数)不受影响,via_app 为 NULL;
//   · 同一个人同一个 App 一分钟 30 条:第 30 条能过(正对照),第 31 条报 PT429;换一个 App、换一个人都不受它影响;
//   · agent 的收件箱行带 via_app。
//
// 与 agentReactionNotice6562 同形:loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,每条用例 BEGIN…ROLLBACK。
// 跑法:`GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:34890/postgres \
//        pnpm exec vitest run messageViaAppF16`
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
    throw new Error(`messageViaAppF16.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`messageViaAppF16.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

function uid(tag: string, n: number): string {
  const head = tag.padEnd(8, '0').slice(0, 8).replace(/[^0-9a-f]/g, '0')
  return `${head}-f016-4000-8000-${String(n).padStart(12, '0')}`
}

let counter = 0
function messageId(): string {
  counter += 1
  return `7e5c0000-f016-4000-8000-${String(counter).padStart(12, '0')}`
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

interface Room { owner: string; alice: string; agent: string; group: string; device: string }

/** A group: its owner, Alice, and the owner's agent. */
async function seedRoom(tag: string): Promise<Room> {
  const room: Room = { owner: uid(tag, 1), alice: uid(tag, 2), agent: uid(tag, 3), group: uid(tag, 11), device: `dev-viaapp-${tag}` }
  for (const [id, name] of [[room.owner, '群主'], [room.alice, 'Alice']] as const) {
    await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)`, [id, name])
  }
  await database.query(
    `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1, $2, 'viaapp', 'viaapp', 'darwin')`,
    [room.device, room.owner],
  )
  await database.query(
    `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id, desired_status) VALUES ($1,'agent','Claude 9',$2,$3,'online')`,
    [room.agent, room.owner, room.device],
  )
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','群',$2)`, [room.group, room.owner])
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner')`, [room.group, room.owner])
  await database.query(`UPDATE chat.chats SET created_at = now() - interval '1 hour' WHERE id = $1`, [room.group])
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode, notification_level) VALUES ($1,$2,'member','active','all')`,
    [room.group, room.agent],
  )
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`, [room.group, room.alice])
  return room
}

/** As `userId` (the authenticated role with their claims), inside the running transaction; a failure is returned, not thrown. */
async function as<Row>(userId: string, sql: string, values: unknown[]): Promise<{ rows?: Row[]; error?: { code: string; message: string } }> {
  await database.query('SAVEPOINT as_user')
  try {
    await database.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    const { rows } = await database.query<Row>(sql, values)
    await database.query('RELEASE SAVEPOINT as_user')
    await database.query(`SELECT set_config('role', 'postgres', true)`)
    return { rows }
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT as_user')
    await database.query(`SELECT set_config('role', 'postgres', true)`)
    const failure = error as { code?: string; message?: string }
    return { error: { code: String(failure.code), message: String(failure.message) } }
  }
}

function send(room: Room, sender: string, id: string, viaApp: string | null, content = 'card 17 marked doubtful') {
  return as<{ id: string; is_whisper: boolean }>(
    sender,
    'SELECT id, is_whisper FROM chat.send_message_idempotent($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id, room.group, sender, [room.agent], content, 'text', null, null, false, true, viaApp],
  )
}

async function viaAppOf(id: string): Promise<string | null | undefined> {
  const { rows } = await database.query<{ via_app: string | null }>('SELECT via_app FROM chat.messages WHERE id = $1', [id])
  return rows[0]?.via_app
}

describe('messages.via_app: an App speaking to an agent in a person\'s name (F16)', () => {
  it('a whisper sent through an App keeps which App; the same replay converges, one naming another App is a conflict', async () => {
    await inRollback(async () => {
      const room = await seedRoom('va1')
      const id = messageId()
      const sent = await send(room, room.owner, id, 'dinner-vote')
      expect(sent.error).toBeUndefined()
      expect(sent.rows?.[0]).toEqual({ id, is_whisper: true })
      expect(await viaAppOf(id)).toBe('dinner-vote')

      expect((await send(room, room.owner, id, 'dinner-vote')).rows?.[0]?.id).toBe(id)
      expect((await send(room, room.owner, id, 'another-app')).error?.code).toBe('23505')
    })
  })

  it('an old caller (10 arguments) is unchanged: via_app is NULL', async () => {
    await inRollback(async () => {
      const room = await seedRoom('va2')
      const id = messageId()
      const sent = await as<{ id: string }>(
        room.owner,
        'SELECT id FROM chat.send_message_idempotent($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id, room.group, room.owner, ['*'], 'plain', 'text', null, null, false, false],
      )
      expect(sent.error).toBeUndefined()
      expect(await viaAppOf(id)).toBeNull()
    })
  })

  it('30 a minute per person and App: the 30th goes in, the 31st is refused (PT429); another App or person is not counted', async () => {
    await inRollback(async () => {
      const room = await seedRoom('va3')
      for (let n = 1; n <= 30; n += 1) {
        const sent = await send(room, room.owner, messageId(), 'dinner-vote', `n${n}`)
        expect(sent.error, `message ${n}`).toBeUndefined()
      }
      const refused = await send(room, room.owner, messageId(), 'dinner-vote', 'n31')
      expect(refused.error?.code).toBe('PT429')
      expect(refused.error?.message).toMatch(/^rate-limited: at most 30 messages a minute from one App in one person's name/)
      // Controls: another App in the same minute, and another person with the same App.
      expect((await send(room, room.owner, messageId(), 'another-app')).error).toBeUndefined()
      expect((await send(room, room.alice, messageId(), 'dinner-vote')).error).toBeUndefined()
    })
  })

  it('the agent\'s inbox row carries via_app', async () => {
    await inRollback(async () => {
      const room = await seedRoom('va4')
      const id = messageId()
      expect((await send(room, room.owner, id, 'dinner-vote')).error).toBeUndefined()
      const pulled = await as<{ id: string; via_app: string | null; is_whisper: boolean }>(
        room.owner,
        'SELECT id, via_app, is_whisper FROM identity.pull_agent_inbox_v2($1) WHERE id = $2',
        [room.agent, id],
      )
      expect(pulled.error).toBeUndefined()
      expect(pulled.rows).toEqual([{ id, via_app: 'dinner-vote', is_whisper: true }])
    })
  })

  // gugu #6835:发送人的气泡要写出「由『X』App 代你发送」,客户端读的是 messages_view 和 sync_since 的消息载荷。
  it('the sender reads via_app where the client reads messages: messages_view and the message_created payload', async () => {
    await inRollback(async () => {
      const room = await seedRoom('va5')
      const viaApp = messageId()
      const plain = messageId()
      // 发送方拿到的权威行(RETURN QUERY SELECT mv.*)与视图同列:多了 via_app 也不报 structure does not match。
      const sent = await as<{ id: string; via_app: string | null }>(
        room.owner,
        'SELECT id, via_app FROM chat.send_message_idempotent($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [viaApp, room.group, room.owner, [room.agent], 'card 17 marked doubtful', 'text', null, null, false, true, 'dinner-vote'],
      )
      expect(sent.error).toBeUndefined()
      expect(sent.rows).toEqual([{ id: viaApp, via_app: 'dinner-vote' }])
      expect((await send(room, room.owner, plain, null)).error).toBeUndefined()

      const view = await as<{ id: string; via_app: string | null }>(
        room.owner,
        'SELECT id, via_app FROM chat.messages_view WHERE id = ANY($1) ORDER BY via_app NULLS LAST',
        [[viaApp, plain]],
      )
      expect(view.rows).toEqual([{ id: viaApp, via_app: 'dinner-vote' }, { id: plain, via_app: null }])

      const synced = await as<{ result: { operations: Array<{ event: string; payload: { message?: { id: string; via_app: string | null } } }> } }>(
        room.owner,
        'SELECT chat.sync_since(0, 500) AS result',
        [],
      )
      const arrived = synced.rows![0]!.result.operations.filter((op) => op.event === 'message_created').map((op) => op.payload.message)
      expect(arrived.find((message) => message?.id === viaApp)?.via_app).toBe('dinner-vote')
      expect(arrived.find((message) => message?.id === plain)?.via_app).toBeNull()

      // 视图仍按调用者判权(security_invoker):不是收件人的 Alice 读不到这条悄悄话。
      const alice = await as<{ id: string }>(room.alice, 'SELECT id FROM chat.messages_view WHERE id = $1', [viaApp])
      expect(alice.rows).toEqual([])
    })
  })
})
