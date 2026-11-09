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
    // What publish_device_projects records for a bound project (20261109210000_project_groups).
    await database.query('INSERT INTO chat.project_groups (chat_id) VALUES ($1)', [group])
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

async function groupInfo(chat = group, account = owner, actor = account): Promise<Record<string, unknown>> {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: account, role: 'authenticated' })])
  const { rows } = await database.query<{ info: Record<string, unknown> }>(
    'SELECT chat.group_info_as($1,$2) AS info', [chat, actor])
  await database.query('RESET role')
  return rows[0]!.info
}

async function rejectedInfo(chat: string, account: string, actor = account): Promise<string> {
  await database.query('SAVEPOINT denied_info')
  try {
    await groupInfo(chat, account, actor)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT denied_info')
    return String((error as Error).message)
  }
  throw new Error('Expected group-info authorization rejection')
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

describe('member-visible project classification uses the existing group-info door', () => {
  it('returns false for an ordinary group and preserves existing settings and authority', () => inRollback(false, async () => {
    const info = await groupInfo()
    expect(info).toMatchObject({ id: group, is_project_group: false, my_role: 'owner', can_manage: true, can_dissolve: true, can_archive_topic: false })
    expect(info.name).toBe('proj')
  }))

  it('returns true to a member who cannot read the project owner’s device records', () => inRollback(true, async () => {
    await database.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [group, colleague])
    const info = await groupInfo(group, colleague)
    expect(info).toMatchObject({ id: group, is_project_group: true, my_role: 'member', can_manage: false })
    expect(info).not.toHaveProperty('device_id')
    expect(info).not.toHaveProperty('root_path')
    await database.query('SET LOCAL role TO authenticated')
    expect((await database.query('SELECT 1 FROM identity.device_projects WHERE chat_id=$1', [group])).rows).toHaveLength(0)
  }))

  it('classifies the actual group rather than inheriting project status into its topic', () => inRollback(true, async () => {
    await database.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [group, colleague])
    await addOwnAgent()
    const anchor = randomUUID()
    await database.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Project topic')", [anchor, group, owner])
    await groupInfo()
    await database.query('SET LOCAL role TO authenticated')
    const topic = (await database.query<{ chat_id: string }>('SELECT * FROM chat.create_topic($1,$2,$3,$4)', [group, anchor, 'Topic', [ownAgent]])).rows[0]!.chat_id
    await database.query('RESET role')
    expect((await database.query('SELECT 1 FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [topic, colleague])).rows).toHaveLength(0)
    expect(await groupInfo(topic, colleague)).toMatchObject({ id: topic, is_project_group: false, my_role: 'member', can_manage: false })
    expect(await groupInfo(topic)).toMatchObject({ is_project_group: false, my_role: 'owner', can_manage: true, can_archive_topic: true, can_dissolve: false })
  }))

  it('keeps the authenticated caller visibility when acting as an owned Agent without a seat', () => inRollback(true, async () => {
    expect(await groupInfo(group, owner, ownAgent)).toMatchObject({ id: group, is_project_group: true, my_role: null, can_manage: false })
  }))

  it('returns the same project metadata after an authorized settings update', () => inRollback(true, async () => {
    const before = await groupInfo()
    await database.query('SET LOCAL role TO authenticated')
    const updated = (await database.query<{ info: Record<string, unknown> }>(
      'SELECT chat.update_group_as($1,$2::jsonb,$3) AS info', [group, JSON.stringify({ name: 'Renamed' }), owner])).rows[0]!.info
    expect(updated).toEqual({ ...before, name: 'Renamed' })
  }))

  it('does not expose group existence or classification to an unrelated caller', () => inRollback(true, async () => {
    expect(await rejectedInfo(group, colleague)).toContain('group_not_visible')
    expect(await rejectedInfo(randomUUID(), colleague)).toContain('group_not_visible')
    expect(await rejectedInfo(group, colleague, ownAgent)).toContain('group_actor_not_authorized')
    expect((await database.query<{ allowed: boolean }>("SELECT has_function_privilege('anon','chat.group_info_as(text,text)','EXECUTE') AS allowed")).rows[0]!.allowed).toBe(false)
  }))

  // 20261109210000_project_groups: the account records the project group; a project with no folder on any machine is still one.
  it('stays a project group, still owner-only, after the last folder binding is removed', () => inRollback(true, async () => {
    expect((await groupInfo()).is_project_group).toBe(true)
    expect(await denial(colleague)).toBe('project_group_owner_only')
    await database.query('DELETE FROM identity.device_projects WHERE chat_id=$1', [group])
    expect((await groupInfo()).is_project_group).toBe(true)
    expect(await denial(colleague)).toBe('project_group_owner_only')
    expect(await denial(ownAgent)).toBeNull()
  }))
})
