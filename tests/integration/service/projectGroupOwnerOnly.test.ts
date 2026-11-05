import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 项目群里只有项目的主人和主人的 agent(迁移 20261023054500_project_group_owner_only,gugu-dev#181)。
 *
 * 加人的每条路都先问 chat.group_add_denial,这里直接问它,再走一遍真入口 add_group_agent:
 *   · 被设备上报为项目群的群:别人、别人的 agent ⇒ project_group_owner_only;主人自己的 agent ⇒ 照常进;
 *   · 正对照:同样的人、同样的群,只是没有设备上报它是项目群 ⇒ 不拒 —— 证明拒的是「项目群」这条事实;
 *   · 已经在群里的别人不动。
 * 每条用例 BEGIN…ROLLBACK。
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
let owner: string
let colleague: string
let ownAgent: string
let colleagueAgent: string
let group: string

async function inRollback(bound: boolean, body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await seed(bound)
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

async function seed(bound: boolean): Promise<void> {
  owner = randomUUID()
  colleague = randomUUID()
  ownAgent = randomUUID()
  colleagueAgent = randomUUID()
  group = randomUUID()
  for (const [id, name] of [[owner, 'owner'], [colleague, 'colleague']]) {
    await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)`, [id, name])
    await database.query(
      `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1,$2,'pg','pg','darwin')`,
      [`dev-${id}`, id],
    )
  }
  await database.query(
    `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent','mine',$2,$3),($4,'agent','theirs',$5,$6)`,
    [ownAgent, owner, `dev-${owner}`, colleagueAgent, colleague, `dev-${colleague}`],
  )
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','proj',$2)`, [group, owner])
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner')`, [group, owner])
  if (bound) {
    await database.query(
      `INSERT INTO identity.device_projects (device_id, user_id, local_project_id, name, root_path, created_at, chat_id)
       VALUES ($1,$2,'p1','proj','/proj',now(),$3)`,
      [`dev-${owner}`, owner, group],
    )
  }
}

async function denial(userId: string): Promise<string | null> {
  return (await database.query<{ d: string | null }>('SELECT chat.group_add_denial($1,$2,$3) AS d', [group, userId, owner])).rows[0]!.d
}

async function addOwnAgent(): Promise<string> {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
  const status = (await database.query<{ r: { status: string } }>(
    'SELECT chat.add_group_agent($1,$2,NULL,$3) AS r', [group, ownAgent, owner])).rows[0]!.r.status
  await database.query('RESET role')
  return status
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('projectGroupOwnerOnly.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })

describe('项目群里只有主人和主人的 agent', () => {
  it('别人、别人的 agent 进不了项目群', () => inRollback(true, async () => {
    expect(await denial(colleague)).toBe('project_group_owner_only')
    expect(await denial(colleagueAgent)).toBe('project_group_owner_only')
  }))

  it('主人自己的 agent 照常进项目群(经真入口 add_group_agent)', () => inRollback(true, async () => {
    expect(await denial(ownAgent)).toBeNull()
    expect(await addOwnAgent()).toBe('joined')
  }))

  it('正对照:同一个群没有被上报为项目群 ⇒ 别人照常能加', () => inRollback(false, async () => {
    expect(await denial(colleague)).toBeNull()
  }))

  it('已经在项目群里的别人不动', () => inRollback(true, async () => {
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`, [group, colleague])
    expect(await denial(colleague)).toBeNull()
  }))
})
