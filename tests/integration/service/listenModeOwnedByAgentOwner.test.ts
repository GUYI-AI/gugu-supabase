import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Agent owners retain their settings; current source-group managers may also change listen mode.
 * Role/removal protections are independent of this setting permission.
 *
 * 场景:群主 G 建的群里,普通成员 M 带着自己的 agent;G 也带一个 agent(阳控:G 改自己的照样改得动)。
 * 以 authenticated 身份 + 真 JWT claims 跑 RLS 与守卫;每条用例 BEGIN…ROLLBACK。
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
let groupOwner: string
let member: string
let admin: string
let outsider: string
let memberAgent: string
let ownerAgent: string
let group: string
let topic: string

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asService() { await database.query('RESET role') }
async function listenMode(userId: string) {
  await asService()
  const { rows } = await database.query<{ listen_mode: string }>(
    'SELECT listen_mode FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2', [group, userId])
  return rows[0]?.listen_mode ?? null
}
async function setListenMode(actor: string, userId: string, mode: string) {
  await asUser(actor)
  const { rows } = await database.query<{ user_id: string }>(
    'SELECT chat.set_agent_listen_mode_as($1,$2,$3,auth.uid()::text)', [group, userId, mode])
  return rows.length
}
async function rejected(body: () => Promise<unknown>) {
  await database.query('SAVEPOINT rejected_update')
  try {
    await body()
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT rejected_update')
    return String((error as Error).message)
  }
  throw new Error('Expected the update to be rejected, but it succeeded')
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('listenModeOwnedByAgentOwner.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  groupOwner = randomUUID(); member = randomUUID(); admin = randomUUID(); outsider = randomUUID(); memberAgent = randomUUID(); ownerAgent = randomUUID(); group = randomUUID(); topic = randomUUID()
  for (const id of [groupOwner, member, admin, outsider]) {
    await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
    [id, `${id}@listen-mode-fixture.invalid`])
  }
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','Group Owner'),($2,'human','Member')
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [groupOwner, member])
  await database.query("INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human','Admin'),($2,'human','Outsider') ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name", [admin, outsider])
  const ownerDevice = `listen-${groupOwner}`
  const memberDevice = `listen-${member}`
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'owner fixture','fixture','darwin'),($3,$4,'member fixture','fixture','darwin')`,
  [ownerDevice, groupOwner, memberDevice, member])
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES
    ($1,'agent','Owner Agent',$2,$3),($4,'agent','Member Agent',$5,$6)`,
  [ownerAgent, groupOwner, ownerDevice, memberAgent, member, memberDevice])
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','群',$2)`, [group, groupOwner])
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode) VALUES
    ($1,$2,'owner','passive'),($1,$3,'member','passive'),($1,$4,'member','passive'),($1,$5,'member','passive')`,
  [group, groupOwner, member, ownerAgent, memberAgent])
  await database.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'admin')", [group, admin])
  // 话题:群主开的,群主和成员 M 是参与者;两个 agent 都还没进来(话题「能拉不能加」,插入不核 agent 归属)。
  const sourceMessage = randomUUID()
  await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type) VALUES ($1,$2,$3,1,'源消息','text')`,
    [sourceMessage, group, groupOwner])
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id, source_chat_id, source_message_id) VALUES ($1,'topic','话题',$2,$3,$4)`,
    [topic, groupOwner, group, sourceMessage])
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'member')`, [topic, groupOwner, member])
})
afterEach(async () => {
  if (!database) return
  try {
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('listen_mode is controlled by agent owners and current source-group managers', () => {
  it('lets an ordinary member switch their own agent', async () => {
    expect(await setListenMode(member, memberAgent, 'active')).toBe(1)
    expect(await listenMode(memberAgent)).toBe('active')
  })

  it('allows the group owner on another member’s agent and their own', async () => {
    expect(await setListenMode(groupOwner, memberAgent, 'active')).toBe(1)
    expect(await listenMode(memberAgent)).toBe('active')
    // The same RPC retains the human owner’s existing permission.
    expect(await setListenMode(groupOwner, ownerAgent, 'active')).toBe(1)
    expect(await listenMode(ownerAgent)).toBe('active')
  })


  it('allows an administrator to change the group owner’s agent and observes revocation', async () => {
    expect(await setListenMode(admin, ownerAgent, 'active')).toBe(1)
    expect(await listenMode(ownerAgent)).toBe('active')
    await database.query("UPDATE chat.chat_members SET role='member' WHERE chat_id=$1 AND user_id=$2", [group, admin])
    expect(await rejected(() => setListenMode(admin, ownerAgent, 'passive'))).toMatch(/agent_owner_or_group_manager_required/)
    expect(await listenMode(ownerAgent)).toBe('active')
  })

  it('does not give ordinary members or outsiders authority over another agent', async () => {
    for (const actor of [member, outsider]) {
      expect(await rejected(() => setListenMode(actor, ownerAgent, 'active'))).toMatch(/agent_owner_or_group_manager_required/)
      expect(await listenMode(ownerAgent)).toBe('passive')
    }
  })

  it('retains the human group owner role and removal protection while allowing their agent setting', async () => {
    expect(await setListenMode(admin, ownerAgent, 'active')).toBe(1)
    await asUser(admin)
    expect(await rejected(() => database.query("SELECT chat.set_group_member_role_as($1,$2,'member',auth.uid()::text)", [group, groupOwner]))).toMatch(/group_owner_role_protected/)
    expect(await rejected(() => database.query('SELECT chat.remove_group_member_as($1,$2,auth.uid()::text)', [group, groupOwner]))).toMatch(/group_owner_cannot_leave/)
    expect(await listenMode(ownerAgent)).toBe('active')
  })

  it('inherits source-group management for topic listen mode without changing the source', async () => {
    await database.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [topic, ownerAgent])
    await asUser(admin)
    await database.query("SELECT chat.set_agent_listen_mode_as($1,$2,'active',auth.uid()::text)", [topic, ownerAgent])
    expect(await listenMode(ownerAgent)).toBe('passive')
    const { rows } = await database.query<{ listen_mode: string }>('SELECT listen_mode FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [topic, ownerAgent])
    expect(rows).toEqual([{ listen_mode: 'active' }])
    await database.query("UPDATE chat.chat_members SET role='member' WHERE chat_id=$1 AND user_id=$2", [group, admin])
    await database.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [topic, admin])
    await asUser(admin)
    expect(await rejected(() => database.query("SELECT chat.set_agent_listen_mode_as($1,$2,'passive',auth.uid()::text)", [topic, ownerAgent]))).toMatch(/agent_owner_or_group_manager_required/)
  })

  it('rejects human targets, invalid modes, absent members and archived manager scope', async () => {
    expect(await rejected(() => setListenMode(admin, groupOwner, 'active'))).toMatch(/agent_owner_or_group_manager_required/)
    expect(await rejected(() => setListenMode(admin, ownerAgent, 'invalid'))).toMatch(/invalid_listen_mode/)
    await asService()
    await database.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [group, ownerAgent])
    expect(await rejected(() => setListenMode(admin, ownerAgent, 'active'))).toMatch(/group_member_not_found/)
    await asService()
    await database.query("UPDATE chat.chats SET status='archived' WHERE id=$1", [group])
    expect(await rejected(() => setListenMode(admin, memberAgent, 'active'))).toMatch(/agent_owner_or_group_manager_required/)
  })

  it('keeps the group owner\'s other powers over that agent: role and removal', async () => {
    await asUser(groupOwner)
    const promoted = await database.query('SELECT chat.set_group_member_role_as($1,$2,$3,auth.uid()::text)', [group, memberAgent, 'admin'])
    expect(promoted.rows).toHaveLength(1)
    const removed = await database.query('SELECT chat.remove_group_member_as($1,$2,auth.uid()::text)', [group, memberAgent])
    expect(removed.rows).toHaveLength(1)
  })

  it('lets the owner take their agent out of the group', async () => {
    await asUser(member)
    const left = await database.query('SELECT chat.remove_group_member_as($1,$2,auth.uid()::text)', [group, memberAgent])
    expect(left.rows).toHaveLength(1)
    expect(await listenMode(memberAgent)).toBeNull()
  })

  it('leaves server-side rules that run as the definer alone', async () => {
    // 与刷屏自动转被动同形:SECURITY DEFINER 函数里改别人 agent 的档位,由调用它的群主触发。
    // 函数随用例的事务一起回滚。
    await database.query(`CREATE FUNCTION chat.it_definer_sets_listen_mode(p_chat_id TEXT, p_user_id TEXT) RETURNS VOID
      LANGUAGE sql SECURITY DEFINER AS $$ UPDATE chat.chat_members SET listen_mode = 'active' WHERE chat_id = p_chat_id AND user_id = p_user_id $$`)
    await database.query('GRANT EXECUTE ON FUNCTION chat.it_definer_sets_listen_mode(TEXT, TEXT) TO authenticated')
    await asUser(groupOwner)
    await database.query('SELECT chat.it_definer_sets_listen_mode($1, $2)', [group, memberAgent])
    expect(await listenMode(memberAgent)).toBe('active')
  })

  it('revokes chosen/default listen-mode inserts, including the owner; topic admission still uses its RPC', async () => {
    for (const mode of ['passive', 'active']) {
      await asUser(groupOwner)
      expect(await rejected(() => database.query(
        "INSERT INTO chat.chat_members(chat_id,user_id,role,listen_mode) VALUES ($1,$2,'member',$3)",
        [topic, memberAgent, mode]))).toMatch(/permission denied/)
    }
    await asService()
    await database.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'member')", [topic, memberAgent])
    await asUser(member)
    await database.query("SELECT chat.set_agent_listen_mode_as($1,$2,'passive',auth.uid()::text)", [topic, memberAgent])
    await asService()
    expect((await database.query<{ listen_mode: string }>('SELECT listen_mode FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [topic, memberAgent])).rows)
      .toEqual([{ listen_mode: 'passive' }])
  })

  it('pins the column default the insert guard compares against', async () => {
    await asService()
    const { rows } = await database.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns WHERE table_schema = 'chat' AND table_name = 'chat_members' AND column_name = 'listen_mode'`)
    expect(rows).toEqual([{ column_default: "'active'::text" }])
  })

  it('leaves service_role writes alone (the guard must not even evaluate the owner check for it)', async () => {
    // service_role 没有 is_owned_agent_user 的执行权:守卫只要碰到那个函数就会报 permission denied。
    await database.query('SET LOCAL role TO service_role')
    const updated = await database.query('UPDATE chat.chat_members SET listen_mode = $3 WHERE chat_id = $1 AND user_id = $2 RETURNING user_id', [group, memberAgent, 'active'])
    expect(updated.rows).toHaveLength(1)
    const inserted = await database.query<{ listen_mode: string }>('INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode) VALUES ($1,$2,\'member\',\'passive\') RETURNING listen_mode', [topic, memberAgent])
    expect(inserted.rows).toEqual([{ listen_mode: 'passive' }])
    expect(await listenMode(memberAgent)).toBe('active')
  })
})
