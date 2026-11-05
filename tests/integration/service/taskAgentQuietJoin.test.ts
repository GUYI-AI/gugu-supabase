import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 任务 agent 进群(迁移 20261022105000、20261022150000_task_seat_from_chat,gugu-dev#181「项目群并入项目页」)。
 * 对着跑完全部迁移的真库判:
 *   · 项目群可以只有群主一个人(建项目即建群);
 *   · 任务路径(provision_taskpage_agent)进来的座位是主动档(和手动拉的一样)、不出「加入了群聊」,群人数照样 +1;
 *   · 已经在群里的座位不动(档位是群主 / agent 主人定的);
 *   · 别人开了「Agent 加入需审批」的群:任务 agent 排队,群主同意后主动入座、照常提示(宿主此刻不必在线);
 *   · 在对话(普通群)里派的任务,agent 经 add_group_agent(p_as_task = true)入座:同样主动、不提示;
 *   · 正对照:手动拉 agent 进群(add_group_agent,不带 p_as_task)主动、照旧提示 —— 证明「不提示」的判据不是永远绿。
 * 每条用例 BEGIN…ROLLBACK,提交前先 SET CONSTRAINTS ALL IMMEDIATE 核一遍延迟约束。
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
  [id, `${id}@task-agent-join.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'task agent fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}

/** 建项目时建的群:只有群主一个人,和客户端走同一个 RPC。 */
async function ownerOnlyGroup(): Promise<string> {
  const id = randomUUID()
  await asUser(owner)
  await database.query(`SELECT chat.create_gugu_group($1,'Project',$2,'[]'::jsonb)`, [id, owner])
  return id
}
async function provision(groupChatId: string, agentId = randomUUID(), caller = owner) {
  await asUser(caller)
  const row = (await database.query<{ group_chat_id: string; prior_group_state: string; group_created: boolean }>(
    'SELECT * FROM identity.provision_taskpage_agent($1,$2,$3,$4,$5,NULL,$6,$7,$8)',
    [agentId, 'Claude', 'serial', 'claude-code', `dev-${caller}`, groupChatId, randomUUID(), 'Project'],
  )).rows[0]!
  return { agentId, row }
}
async function seat(chatId: string, userId: string) {
  await asService()
  return (await database.query<{ listen_mode: string }>(
    'SELECT listen_mode FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chatId, userId])).rows[0]
}
async function joinNotices(chatId: string): Promise<string[]> {
  await asService()
  return (await database.query<{ client_message_id: string }>(
    `SELECT client_message_id FROM chat.messages WHERE chat_id=$1 AND client_message_id LIKE 'member-joined:%' ORDER BY seq`, [chatId],
  )).rows.map((row) => row.client_message_id)
}
/** 群主开了「Agent 加入需审批」的群,里面有一个普通成员(他不是管理员,他的 agent 进群要排队)。 */
async function approvalGroupWith(member: string): Promise<string> {
  const group = await ownerOnlyGroup()
  await asService()
  await database.query('UPDATE chat.chats SET agent_join_approval = true WHERE id = $1', [group])
  await database.query('SELECT chat.insert_group_member($1,$2)', [group, member])
  return group
}
async function approve(group: string, agentId: string): Promise<void> {
  await asService()
  const request = (await database.query<{ id: string }>(
    `SELECT id FROM chat.group_join_requests WHERE chat_id=$1 AND requester_user_id=$2 AND status='pending'`,
    [group, agentId])).rows[0]!
  await asUser(owner)
  await database.query('SELECT chat.decide_group_join($1,true,$2)', [request.id, owner])
}
async function memberCount(chatId: string): Promise<number> {
  await asService()
  return (await database.query<{ n: number }>('SELECT count(*)::int AS n FROM chat.chat_members WHERE chat_id=$1', [chatId])).rows[0]!.n
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('taskAgentQuietJoin.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner')
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

describe('任务 agent 进群', () => {
  it('项目群可以只有群主一个人', async () => {
    const group = await ownerOnlyGroup()
    expect(await memberCount(group)).toBe(1)
  })

  it('进已有的项目群 ⇒ 主动档、不出「加入了群聊」,群人数 +1', async () => {
    const group = await ownerOnlyGroup()
    const { agentId, row } = await provision(group)
    expect(row).toMatchObject({ group_chat_id: group, prior_group_state: 'active', group_created: false })
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'active' })
    expect(await memberCount(group)).toBe(2)
    expect(await joinNotices(group)).toEqual([])
  })

  it('项目群还不存在 ⇒ 建一个只有群主的群再入座,同样主动、不提示', async () => {
    const group = randomUUID()
    const { agentId, row } = await provision(group)
    expect(row).toMatchObject({ group_chat_id: group, prior_group_state: 'missing', group_created: true })
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'active' })
    expect(await memberCount(group)).toBe(2)
    expect(await joinNotices(group)).toEqual([])
  })

  it('rolls back a newly created group after a seat insert error, keeping the identity usable', async () => {
    const group = randomUUID()
    const agentId = randomUUID()
    await asService()
    await database.query(`CREATE FUNCTION pg_temp.reject_task_seat() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'task seat fixture failure'; END $$;
      CREATE TRIGGER reject_task_seat BEFORE INSERT ON chat.chat_members FOR EACH ROW
      WHEN (NEW.user_id = '${agentId}') EXECUTE FUNCTION pg_temp.reject_task_seat()`)
    const { row } = await provision(group, agentId)
    expect(row).toMatchObject({ group_chat_id: '', group_created: false, prior_group_state: 'join_failed:P0001' })
    expect(await seat(group, agentId)).toBeUndefined()
    expect((await database.query('SELECT id FROM chat.chats WHERE id=$1', [group])).rows).toEqual([])
    await asUser(owner)
    expect((await database.query<{ id: string }>(
      'SELECT id FROM identity.users WHERE id=$1 AND owner_user_id=auth.uid()::text', [agentId],
    )).rows).toEqual([{ id: agentId }])
    // Retry the same identity after the group failure clears; the public address is unchanged.
    await asService()
    await database.query('DROP TRIGGER reject_task_seat ON chat.chat_members')
    const retry = await provision(group, agentId)
    expect(retry.row).toMatchObject({ group_chat_id: group, group_created: true, prior_group_state: 'missing' })
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'active' })
  })

  it('checks deferred membership invariants before leaving enrollment, retaining the identity on failure', async () => {
    const group = await ownerOnlyGroup()
    const agentId = randomUUID()
    await asService()
    await database.query(`CREATE FUNCTION pg_temp.invalidate_task_owner() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE chat.chat_members SET role='member' WHERE chat_id=NEW.chat_id AND role='owner'; RETURN NEW; END $$;
      CREATE TRIGGER invalidate_task_owner AFTER INSERT ON chat.chat_members FOR EACH ROW
      WHEN (NEW.user_id = '${agentId}') EXECUTE FUNCTION pg_temp.invalidate_task_owner()`)
    const { row } = await provision(group, agentId)
    expect(row).toMatchObject({ group_chat_id: '', group_created: false, prior_group_state: 'join_failed:P0001' })
    expect(await seat(group, agentId)).toBeUndefined()
    expect((await database.query('SELECT user_id FROM chat.chat_members WHERE chat_id=$1 AND role=\'owner\'', [group])).rows)
      .toEqual([{ user_id: owner }])
    await asUser(owner)
    expect((await database.query('SELECT * FROM chat.list_my_chats_as($1)', [agentId])).rows).toEqual([])
    await asService()
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  })

  it('leaves successful RPC transactions checked immediately; failed enrollment restores the caller mode', async () => {
    await asService()
    await database.query(`CREATE TEMP TABLE mode_parent(id integer PRIMARY KEY);
      CREATE TEMP TABLE mode_child(id integer REFERENCES mode_parent(id) DEFERRABLE INITIALLY DEFERRED);
      GRANT ALL ON mode_parent, mode_child TO authenticated`)
    const group = await ownerOnlyGroup()
    // A normal PostgREST call ends its transaction after this RPC. A direct SQL
    // caller continuing the same transaction explicitly opts back into deferral.
    await provision(group)
    await database.query('SAVEPOINT immediate_mode')
    await expect(database.query('INSERT INTO mode_child VALUES (1)')).rejects.toMatchObject({ code: '23503' })
    await database.query('ROLLBACK TO SAVEPOINT immediate_mode')
    await database.query('SET CONSTRAINTS ALL DEFERRED')
    await asService()
    await database.query(`CREATE FUNCTION pg_temp.reject_mode_seat() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'mode fixture failure'; END $$;
      CREATE TRIGGER reject_mode_seat BEFORE INSERT ON chat.chat_members FOR EACH ROW
      EXECUTE FUNCTION pg_temp.reject_mode_seat()`)
    const { row } = await provision(group)
    expect(row.prior_group_state).toBe('join_failed:P0001')
    // The failed enrollment subtransaction rolls its constraint-mode changes
    // back too, so an outer transaction which was deferred stays deferred.
    await database.query('INSERT INTO mode_child VALUES (1)')
    await database.query('INSERT INTO mode_parent VALUES (1)')
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  })

  it('已经在群里的座位不动:主人改成被动之后再 provision 一次,仍是被动', async () => {
    const group = await ownerOnlyGroup()
    const { agentId } = await provision(group)
    await asUser(owner)
    await database.query('SELECT chat.set_agent_listen_mode_as($1,$2,$3,$4)', [group, agentId, 'passive', owner])
    await provision(group, agentId)
    expect((await seat(group, agentId))?.listen_mode).toBe('passive')
  })

  it('需审批的群:任务 agent 排队,群主同意后主动入座,并照常提示', async () => {
    const member = await human('Member')
    const group = await approvalGroupWith(member)
    const { agentId, row } = await provision(group, randomUUID(), member)
    expect(row).toMatchObject({ group_chat_id: '', prior_group_state: 'pending_approval' })
    expect((await database.query('SELECT status FROM chat.group_join_requests WHERE chat_id=$1 AND requester_user_id=$2', [group, agentId])).rows)
      .toEqual([{ status: 'pending' }])
    await asUser(owner)
    expect((await database.query('SELECT status FROM chat.group_join_requests WHERE chat_id=$1 AND requester_user_id=$2', [group, agentId])).rows)
      .toEqual([])
    expect(await seat(group, agentId)).toBeUndefined()
    await approve(group, agentId)
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'active' })
    expect(await joinNotices(group)).toEqual([
      expect.stringContaining(member),
      expect.stringContaining(agentId),
    ])
  })

  it('对话里派的任务(add_group_agent 带 p_as_task)⇒ 主动档、不出「加入了群聊」,群人数 +1', async () => {
    const group = await ownerOnlyGroup()
    const { agentId } = await provision(randomUUID())
    await asUser(owner)
    const result = (await database.query<{ result: { status: string } }>(
      'SELECT chat.add_group_agent($1,$2,NULL,auth.uid()::text,true) AS result', [group, agentId])).rows[0]!.result
    expect(result).toMatchObject({ status: 'joined' })
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'active' })
    expect(await memberCount(group)).toBe(2)
    expect(await joinNotices(group)).toEqual([])
  })

  it('对话里派的任务进需审批的群:排队,群主同意后主动入座', async () => {
    const member = await human('Member')
    const group = await approvalGroupWith(member)
    const { agentId } = await provision(randomUUID(), randomUUID(), member)
    await asUser(member)
    await database.query('SELECT chat.add_group_agent($1,$2,NULL,auth.uid()::text,true)', [group, agentId])
    expect(await seat(group, agentId)).toBeUndefined()
    await approve(group, agentId)
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'active' })
  })

  it('对话里派的任务、agent 已经在群里:座位不动', async () => {
    const group = await ownerOnlyGroup()
    const { agentId } = await provision(randomUUID())
    await asUser(owner)
    await database.query('SELECT chat.add_group_agent($1,$2,NULL,auth.uid()::text)', [group, agentId])
    const result = (await database.query<{ result: { status: string } }>(
      'SELECT chat.add_group_agent($1,$2,NULL,auth.uid()::text,true) AS result', [group, agentId])).rows[0]!.result
    expect(result).toMatchObject({ status: 'already_member' })
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'active' })
  })

  it('需审批的群里手动拉 agent ⇒ 同意后主动入座', async () => {
    const member = await human('Member')
    const group = await approvalGroupWith(member)
    const { agentId } = await provision(randomUUID(), randomUUID(), member)
    await asUser(member)
    await database.query('SELECT chat.add_group_agent($1,$2,NULL,auth.uid()::text)', [group, agentId])
    await approve(group, agentId)
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'active' })
  })

  it('正对照:手动拉 agent 进群 ⇒ 主动档,照常出「加入了群聊」', async () => {
    const group = await ownerOnlyGroup()
    const { agentId } = await provision(randomUUID())
    await asUser(owner)
    await database.query('SELECT chat.add_group_agent($1,$2,NULL,auth.uid()::text)', [group, agentId])
    expect(await seat(group, agentId)).toEqual({ listen_mode: 'active' })
    expect(await joinNotices(group)).toEqual([expect.stringContaining(agentId)])
  })
})

describe('任务卡不叫醒任何人', () => {
  async function post(chatId: string, contentType: string): Promise<string> {
    await asService()
    const id = randomUUID()
    await database.query(
      `INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type) VALUES ($1,$2,$3,$4,$5)`,
      [id, chatId, owner, contentType === 'card' ? '{"v":1,"type":"task","text":"x"}' : '大家看一下', contentType],
    )
    return id
  }
  async function woken(messageId: string): Promise<string[]> {
    await asService()
    return (await database.query<{ agent_user_id: string }>(
      'SELECT agent_user_id FROM chat.message_agent_wakes WHERE message_id = $1', [messageId])).rows.map((row) => row.agent_user_id)
  }

  it('群里一个主动档的 agent:我发的任务卡不叫醒它;正对照:我发的一句没点名的话叫醒它', async () => {
    const group = await ownerOnlyGroup()
    const { agentId } = await provision(randomUUID())
    await asUser(owner)
    await database.query('SELECT chat.add_group_agent($1,$2,NULL,auth.uid()::text)', [group, agentId])
    expect(await woken(await post(group, 'card'))).toEqual([])
    expect(await woken(await post(group, 'text'))).toEqual([agentId])
  })
})
