import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BEGIN_READING_REVISIONS, FLUSH_REVISIONS } from '../../support/revisionTransaction'

/**
 * 入群申请推到审批人(迁移 20261002091500):chat.group_join_requests 每变一次,给这个群的群主、管理员和发起人
 * 各发一条 friend_requests_changed(他们「新的请求」那个收件箱的事件)。
 *   · 有人替 agent 申请 ⇒ 群主、管理员、发起人各收一条,带这条申请的 id;agent 自己、普通成员不收;
 *   · 批准 / 拒绝 ⇒ 同一批人再各收一条;
 *   · 正对照:不用审批的群,agent 直接入群,不落申请 ⇒ 群主不收这条。
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
let admin: string
let member: string
let bystander: string
let memberAgent: string
let ownerAgent: string

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asService() { await database.query('RESET role') }
async function human(name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@join-request-revision.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'revision fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id)
    VALUES ($1,'agent',$2,$3,true,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}
async function newGroup(approval: boolean): Promise<string> {
  const id = randomUUID()
  await asUser(owner)
  await createFixtureGroup(database, [
    id, 'Join request revisions', owner, JSON.stringify([{ user_id: ownerAgent, role: 'member' }]),
  ])
  await asService()
  await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'admin'),($1,$3,'member'),($1,$4,'member')`,
    [id, admin, member, bystander])
  await database.query('UPDATE chat.chats SET agent_join_approval = $2 WHERE id = $1', [id, approval])
  return id
}
async function addAgent(actor: string, chatId: string, agentId: string) {
  await asUser(actor)
  return (await database.query<{ result: { status: string; request_id?: string } }>(
    'SELECT chat.add_group_agent($1,$2,$3,auth.uid()::text) AS result', [chatId, agentId, '请让它帮忙评审'])).rows[0]!.result
}
/** The friend_requests_changed revisions a user has received so far: the join request each one names. */
async function inbox(userId: string): Promise<(string | null)[]> {
  await asService()
  await database.query(FLUSH_REVISIONS)
  const { rows } = await database.query<{ join_request_id: string | null }>(
    `SELECT resource_key->>'join_request_id' AS join_request_id FROM chat.account_revisions
      WHERE user_id = $1 AND event = 'friend_requests_changed' ORDER BY revision`, [userId])
  return rows.map((row) => row.join_request_id)
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('groupJoinRequestRevision.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query(BEGIN_READING_REVISIONS)
  owner = await human('Owner'); admin = await human('Admin'); member = await human('Member'); bystander = await human('Bystander')
  memberAgent = await agentOf(member, 'Member Agent')
  ownerAgent = await agentOf(owner, 'Owner Agent')
})
afterEach(async () => {
  if (!database) return
  try {
    await asService()
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('入群申请推到审批人', () => {
  it('替 agent 申请:群主、管理员、发起人各收一条,agent 自己和普通成员不收', async () => {
    const group = await newGroup(true)
    const result = await addAgent(member, group, memberAgent)
    expect(result).toMatchObject({ status: 'pending_approval' })
    await asService()
    const [{ id: requestId }] = (await database.query<{ id: string }>(
      'SELECT id FROM chat.group_join_requests WHERE chat_id = $1 AND requester_user_id = $2', [group, memberAgent])).rows
    for (const recipient of [owner, admin, member]) expect(await inbox(recipient)).toEqual([requestId])
    expect(await inbox(memberAgent)).toEqual([])
    expect(await inbox(bystander)).toEqual([])
  })

  it('批准、拒绝:同一批人再各收一条', async () => {
    const group = await newGroup(true)
    await addAgent(member, group, memberAgent)
    const second = await agentOf(member, 'Second Agent')
    await addAgent(member, group, second)
    await asService()
    const idOf = new Map((await database.query<{ id: string; requester_user_id: string }>(
      'SELECT id, requester_user_id FROM chat.group_join_requests WHERE chat_id = $1', [group])).rows
      .map((row) => [row.requester_user_id, row.id]))
    await asUser(admin)
    await database.query('SELECT chat.decide_group_join($1,true,auth.uid()::text)', [idOf.get(memberAgent)])
    await database.query('SELECT chat.decide_group_join($1,false,auth.uid()::text)', [idOf.get(second)])
    const expected = [idOf.get(memberAgent), idOf.get(second), idOf.get(memberAgent), idOf.get(second)]
    for (const recipient of [owner, admin, member]) expect(await inbox(recipient)).toEqual(expected)
    expect(await inbox(bystander)).toEqual([])
  })

  it('正对照:不用审批的群直接入群,不落申请,群主不收这条', async () => {
    const group = await newGroup(false)
    expect(await addAgent(member, group, memberAgent)).toMatchObject({ status: 'joined' })
    expect(await inbox(owner)).toEqual([])
    expect(await inbox(member)).toEqual([])
  })
})
