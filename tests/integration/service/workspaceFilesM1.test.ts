import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 工作区文件服务 M1(迁移 20260929063000,真源 gugu-base notes/2026-09-29-app-platform/workspace-app §2.1–2.2):
 *   · gugu_files 靠 policy 读 workspace_items / chat_members(不是 BYPASSRLS),只能改 ystate/epoch/inline_text/size_bytes;
 *   · ystate / epoch 只归文件服务:客户端 INSERT、UPDATE 都写不进;
 *   · chat.files_authorize:资格走 chat.is_acting_as,可见域同 workspace_item_for;判完 claims 原样恢复;
 *   · 成员移出 / 文件删除各发一条 pg_notify。
 * 每条否定断言配正对照。前三组 BEGIN…ROLLBACK;通知只在提交时投递,那一组用提交过的装置并在 afterAll 清掉。
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>
  on(event: 'notification', listener: (message: { channel: string; payload?: string }) => void): void
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
interface Authorized { chat_id: string; epoch: number; content_type: string; kind: string; actor_id: string; actor_name: string | null }

let database: DatabaseClient
let owner: string
let stranger: string
let agent: string
let strangerAgent: string
/** 建群至少要有一个别的成员:每个群都带上这个旁观者,不影响任何断言。 */
let bystander: string

function databaseUrl(): string {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('workspaceFilesM1.test requires a loopback PostgreSQL database')
  }
  return url.href
}
async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
/** 文件服务的连接:没有 JWT,只有 gugu_files 自己的授权。 */
async function asFiles() {
  await database.query('RESET role')
  await database.query("SELECT set_config('request.jwt.claims', '', true)")
  await database.query('SET LOCAL role TO gugu_files')
}
async function asService() { await database.query('RESET role') }
async function fails(sql: string, values: unknown[] = []): Promise<string> {
  await database.query('SAVEPOINT expected_failure')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT expected_failure')
    return String((error as Error).message)
  }
  await database.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
async function human(name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@workspace-files.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'files fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id)
    VALUES ($1,'agent',$2,$3,true,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}
async function newGroup(creator: string, initial: string[]): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await createFixtureGroup(database, [
    id, 'Files group', creator, JSON.stringify([...initial, bystander].map((user_id) => ({ user_id, role: 'member' }))),
  ])
  await asService()
  return id
}
async function join(chatId: string, userId: string) {
  await asService()
  await database.query("INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')", [chatId, userId])
}
async function document(chatId: string, by: string, text = 'body'): Promise<string> {
  await asService()
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO chat.workspace_items (chat_id, kind, filename, inline_text, size_bytes, created_by)
     VALUES ($1,'document','notes.md',$2,octet_length($2),$3) RETURNING id`,
    [chatId, text, by],
  )
  await asService()
  return rows[0]!.id
}
async function authorize(itemId: string, userId: string, asUserId: string | null = null): Promise<Authorized[]> {
  await asFiles()
  const { rows } = await database.query<Authorized>('SELECT * FROM chat.files_authorize($1,$2,$3)', [itemId, userId, asUserId])
  await asService()
  return rows
}

beforeAll(async () => {
  database = new Client({ connectionString: databaseUrl() })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  // 迁移身份建出的角色,它自己有 ADMIN 但没有 SET:测试连接要切进 gugu_files,在本事务里给自己一次(随 ROLLBACK 撤回)。
  // ⚠️ 必须写出角色名:本地 PG17 栈上 `GRANT … TO CURRENT_USER` 会让整个库进程崩溃重启(09-29 实撞)。
  await database.query("DO $$ BEGIN EXECUTE format('GRANT gugu_files TO %I', current_user); END $$")
  owner = await human('Owner')
  stranger = await human('Stranger')
  agent = await agentOf(owner, 'Owner Agent')
  strangerAgent = await agentOf(stranger, 'Stranger Agent')
  bystander = await human('Bystander')
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

describe('gugu_files:policy 放行的只读 + 四列写', () => {
  it('角色形态:迁移建出来 NOLOGIN、非超级用户、不绕 RLS,和任何 API 角色互不成员', async () => {
    const { rows } = await database.query<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; rolconnlimit: number }>(
      "SELECT rolcanlogin, rolsuper, rolbypassrls, rolconnlimit FROM pg_roles WHERE rolname = 'gugu_files'",
    )
    expect(rows).toEqual([{ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolconnlimit: 16 }])
    const linked = await database.query<{ edge: string }>(`
      SELECT r.rolname || ' -> ' || m.rolname AS edge
        FROM pg_auth_members am
        JOIN pg_roles r ON r.oid = am.member
        JOIN pg_roles m ON m.oid = am.roleid
       WHERE r.rolname = 'gugu_files'
          OR (m.rolname = 'gugu_files' AND r.rolname IN ('anon', 'authenticated', 'service_role', 'authenticator'))`)
    // gugu_files 不是任何角色的成员;API 角色都不是它的成员(文件服务测试的一次性登录角色、测试连接自己给自己的授权不算)。
    expect(linked.rows).toEqual([])
  })

  it('不在群里也读得到任意群的文件与成员行(policy),而同样不在群里的 authenticated 读不到(RLS 在起作用)', async () => {
    const group = await newGroup(owner, [agent])
    const doc = await document(group, owner)
    await asUser(stranger)
    expect((await database.query('SELECT id FROM chat.workspace_items WHERE id = $1', [doc])).rows).toEqual([])
    expect((await database.query('SELECT user_id FROM chat.chat_members WHERE chat_id = $1', [group])).rows).toEqual([])

    await asFiles()
    expect((await database.query('SELECT id, ystate, epoch FROM chat.workspace_items WHERE id = $1', [doc])).rows)
      .toEqual([{ id: doc, ystate: null, epoch: 0 }])
    const members = (await database.query<{ user_id: string }>('SELECT user_id FROM chat.chat_members WHERE chat_id = $1', [group])).rows
    expect(members.map((row) => row.user_id).sort()).toEqual([agent, owner, bystander].sort())
  })

  it('只能改四列:ystate/epoch/inline_text/size_bytes 能写,filename 不行,INSERT/DELETE 不行,别的表读不到', async () => {
    const group = await newGroup(owner, [])
    const doc = await document(group, owner)
    await asFiles()
    const stored = await database.query(
      'UPDATE chat.workspace_items SET ystate = $1, inline_text = $2, size_bytes = $3 WHERE id = $4 AND epoch = 0',
      [Buffer.from([1, 2, 3]), 'body!', 5, doc],
    )
    expect(stored.rowCount).toBe(1)
    expect((await database.query('UPDATE chat.workspace_items SET epoch = epoch + 1 WHERE id = $1 AND epoch = 0', [doc])).rowCount).toBe(1)
    expect(await fails('UPDATE chat.workspace_items SET filename = $1 WHERE id = $2', ['x.md', doc])).toMatch(/permission denied/)
    expect(await fails(`INSERT INTO chat.workspace_items (chat_id, kind, filename, created_by) VALUES ($1,'document','y.md',NULL)`, [group]))
      .toMatch(/permission denied/)
    expect(await fails('DELETE FROM chat.workspace_items WHERE id = $1', [doc])).toMatch(/permission denied/)
    expect(await fails('SELECT 1 FROM chat.messages LIMIT 1')).toMatch(/permission denied/)
    expect(await fails('SELECT 1 FROM identity.users LIMIT 1')).toMatch(/permission denied/)
    await asService()
    expect((await database.query('SELECT inline_text, size_bytes::int AS size, epoch, length(ystate) AS ys FROM chat.workspace_items WHERE id = $1', [doc])).rows)
      .toEqual([{ inline_text: 'body!', size: 5, epoch: 1, ys: 3 }])
  })
})

describe('改名(20260929155000):对象逐个 rename,旧名一个不剩', () => {
  it('角色、判权入口、policy、触发器与通知函数都是新名字;角色设置跟着过来;旧名在库里查不到', async () => {
    const names = async (sql: string) => (await database.query<{ name: string }>(sql)).rows.map((row) => row.name).sort()
    expect(await names("SELECT rolname AS name FROM pg_roles WHERE rolname IN ('gugu_files', 'gugu_rooms')")).toEqual(['gugu_files'])
    expect((await database.query<{ setting: string[] }>(`
      SELECT s.setconfig AS setting FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
       WHERE r.rolname = 'gugu_files' AND s.setdatabase = 0`)).rows[0]?.setting.sort())
      .toEqual(['idle_in_transaction_session_timeout=30s', 'statement_timeout=10s'])
    const both = (...stems: string[]) => stems.flatMap((s) => [s.replace('@', 'rooms'), s.replace('@', 'files')])
    const functions = both('@_authorize', 'notify_@_member_removed', 'notify_@_item_deleted')
    expect(await names(`
      SELECT DISTINCT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'chat' AND p.proname = ANY('{${functions}}'::text[])`))
      .toEqual(['files_authorize', 'notify_files_item_deleted', 'notify_files_member_removed'])
    const policies = both('workspace_items_@_select', 'workspace_items_@_update', 'chat_members_@_select')
    expect(await names(`SELECT policyname AS name FROM pg_policies WHERE policyname = ANY('{${policies}}'::text[])`))
      .toEqual(['chat_members_files_select', 'workspace_items_files_select', 'workspace_items_files_update'])
    expect(await names(`SELECT DISTINCT unnest(roles)::text AS name FROM pg_policies WHERE policyname = ANY('{${policies}}'::text[])`))
      .toEqual(['gugu_files'])
    const triggers = both('chat_members_notify_@_removed', 'workspace_items_notify_@_deleted')
    expect(await names(`SELECT tgname AS name FROM pg_trigger WHERE tgname = ANY('{${triggers}}'::text[])`))
      .toEqual(['chat_members_notify_files_removed', 'workspace_items_notify_files_deleted'])
    // 判权入口只有 gugu_files 能调;anon / authenticated 不能
    const can = async (role: string) =>
      (await database.query<{ ok: boolean }>("SELECT has_function_privilege($1, 'chat.files_authorize(uuid, text, text)', 'EXECUTE') AS ok", [role])).rows[0]!.ok
    expect([await can('gugu_files'), await can('authenticated'), await can('anon')]).toEqual([true, false, false])
  })
})

describe('ystate / epoch 只归文件服务', () => {
  it('成员 INSERT 带 ystate 或 epoch 被拒(20261017194408 起成员直接写表一列都不行,只经 *_as);成员 UPDATE 也改不了这两列;读照旧', async () => {
    const group = await newGroup(owner, [])
    await asUser(owner)
    expect(await fails(
      `INSERT INTO chat.workspace_items (chat_id, kind, filename, inline_text, created_by, ystate) VALUES ($1,'document','a.md','x',$2,'\\x01')`,
      [group, owner],
    )).toMatch(/permission denied/)
    await asUser(owner)
    expect(await fails(
      `INSERT INTO chat.workspace_items (chat_id, kind, filename, inline_text, created_by, epoch) VALUES ($1,'document','a.md','x',$2,7)`,
      [group, owner],
    )).toMatch(/permission denied/)
    const doc = await document(group, owner)
    // 读照旧:成员经 PostgREST(表级 SELECT + RLS)读得到 epoch —— 主进程靠它给页面发打开文件的许可;不是成员读不到。
    await asUser(owner)
    expect((await database.query('SELECT epoch FROM chat.workspace_items WHERE id = $1', [doc])).rows).toEqual([{ epoch: 0 }])
    await asUser(stranger)
    expect((await database.query('SELECT epoch FROM chat.workspace_items WHERE id = $1', [doc])).rows).toEqual([])
    await asUser(owner)
    expect(await fails('UPDATE chat.workspace_items SET filename = $1 WHERE id = $2', ['renamed.md', doc])).toMatch(/permission denied/)
    await asUser(owner)
    expect(await fails('UPDATE chat.workspace_items SET ystate = $1 WHERE id = $2', [Buffer.from([9]), doc])).toMatch(/permission denied/)
    await asUser(owner)
    expect(await fails('UPDATE chat.workspace_items SET epoch = 5 WHERE id = $1', [doc])).toMatch(/permission denied/)
  })
})

describe('chat.workspace_get_as 带 epoch(20260929192000):代 agent 打开时文档名 <id>@<epoch> 的唯一来源', () => {
  it('主人不在群里、agent 在:按 agent 读到的 epoch 和表里一致,冷压缩换代(epoch + 1)后跟着变;按主人自己读不到', async () => {
    const group = await newGroup(stranger, [])
    await join(group, agent)
    const doc = await document(group, stranger)
    const epochAs = async (actor: string) => {
      await asUser(owner)
      const { rows } = await database.query<{ id: string; epoch: number }>('SELECT id, epoch FROM chat.workspace_get_as($1,$2)', [doc, actor])
      await asService()
      return rows
    }
    expect(await epochAs(agent)).toEqual([{ id: doc, epoch: 0 }])
    await database.query('UPDATE chat.workspace_items SET epoch = epoch + 1 WHERE id = $1', [doc])
    expect(await epochAs(agent)).toEqual([{ id: doc, epoch: 1 }])
    // 对照:主人不在这个群,按自己读不到(判据不变,只是多了一列)
    await asUser(owner)
    expect(await fails('SELECT epoch FROM chat.workspace_get_as($1,$2)', [doc, owner])).toMatch(/workspace item not found/)
    await asService()
  })
})

describe('chat.files_authorize:资格走 is_acting_as,可见域同 workspace_item_for', () => {
  it('人:成员放行、带回条目元数据;不在群里与不存在同样返回空', async () => {
    const group = await newGroup(owner, [])
    const doc = await document(group, owner)
    expect(await authorize(doc, owner)).toEqual([
      { chat_id: group, epoch: 0, content_type: 'text/markdown', kind: 'document', actor_id: owner, actor_name: 'Owner' },
    ])
    expect(await authorize(doc, stranger)).toEqual([])
    expect(await authorize(randomUUID(), owner)).toEqual([])
  })

  it('agent:按 agent 自己是不是成员判 —— 主人在、agent 不在 ⇒ 空;agent 入群 ⇒ 放行;主人不在也放行', async () => {
    const group = await newGroup(owner, [])
    const doc = await document(group, owner)
    expect(await authorize(doc, owner, agent)).toEqual([])
    await join(group, agent)
    expect(await authorize(doc, owner, agent)).toMatchObject([{ chat_id: group, actor_id: agent, actor_name: 'Owner Agent' }])

    const theirs = await newGroup(stranger, [])
    await join(theirs, agent)
    const theirDoc = await document(theirs, stranger)
    expect(await authorize(theirDoc, owner)).toEqual([])
    expect(await authorize(theirDoc, owner, agent)).toMatchObject([{ chat_id: theirs, actor_id: agent }])
  })

  it('资格:别人的 agent 拒,陌生人拿主人的 agent 也拒(agent 本身在群里)', async () => {
    const group = await newGroup(owner, [agent, stranger])
    await join(group, strangerAgent)
    const doc = await document(group, owner)
    expect(await authorize(doc, owner, strangerAgent)).toEqual([])
    expect(await authorize(doc, stranger, agent)).toEqual([])
    // 正对照:各自替自己的 agent 问都能过。
    expect(await authorize(doc, owner, agent)).toMatchObject([{ actor_id: agent }])
    expect(await authorize(doc, stranger, strangerAgent)).toMatchObject([{ actor_id: strangerAgent }])
  })

  // 20261005114650(主人 10-05「私聊也是得有面板的」):私聊也有自己的工作区,判据和群一样只看是不是成员。
  it('私聊也是工作区:两个成员都能过;不在这个私聊里的(主人的 agent)返回空', async () => {
    const dm = randomUUID()
    await asService()
    await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'dm',NULL,$2)`, [dm, owner])
    await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member'),($1,$3,'member')`, [dm, owner, stranger])
    const dmDoc = await document(dm, owner)
    expect(await authorize(dmDoc, owner)).toMatchObject([{ chat_id: dm, actor_id: owner }])
    expect(await authorize(dmDoc, stranger)).toMatchObject([{ chat_id: dm, actor_id: stranger }])
    expect(await authorize(dmDoc, owner, agent)).toEqual([])
  })

  it('判完把 claims 原样放回:之前没有就还是没有,之前是谁就还是谁', async () => {
    const group = await newGroup(owner, [agent])
    const doc = await document(group, owner)
    // 按 auth.uid() 的读法看(两处 GUC,空串当没有);gugu_files 没有 auth schema 的 USAGE,直接读 GUC。
    const effective = `SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''),
                                       NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub') AS uid`
    await asFiles()
    expect((await database.query('SELECT * FROM chat.files_authorize($1,$2,$3)', [doc, owner, agent])).rows).toHaveLength(1)
    expect((await database.query(effective)).rows).toEqual([{ uid: null }])
    await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: stranger, role: 'authenticated' })])
    expect((await database.query('SELECT * FROM chat.files_authorize($1,$2,$3)', [doc, owner, agent])).rows).toHaveLength(1)
    expect((await database.query(effective)).rows).toEqual([{ uid: stranger }])
  })

  it('只有一扇门:authenticated 调不了 files_authorize,gugu_files 也直接调不了 is_acting_as', async () => {
    const group = await newGroup(owner, [])
    const doc = await document(group, owner)
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.files_authorize($1,$2,NULL)', [doc, owner])).toMatch(/permission denied/)
    await asFiles()
    // is_acting_as 在 auth.uid() 为空时放行(「服务端自己」):文件服务的连接上正是空的,所以绝不能让它直接调。
    expect(await fails('SELECT chat.is_acting_as($1)', [agent])).toMatch(/permission denied/)
    await database.query('SET LOCAL role TO anon')
    expect(await fails('SELECT * FROM chat.files_authorize($1,$2,NULL)', [doc, owner])).toMatch(/permission denied/)
  })
})

describe('文件服务的两条通知(提交时投递)', () => {
  let actor: DatabaseClient
  let listener: DatabaseClient
  const created: { users: string[]; chats: string[] } = { users: [], chats: [] }
  const heard: { channel: string; payload?: string }[] = []
  /** 通道是全库共用的:同时在跑的别的测试(文件服务的)也在删成员、删文件,只看自己这个群 / 这个文件的。 */
  const about = (prefix: string) => heard.filter((h) => h.payload === prefix || h.payload?.startsWith(`${prefix}:`))

  // 提交过的装置只建 identity.users,❌ auth.users:注册触发器会往全局的计费 / 网关队列里写行,
  // 同时在跑的 gatewayPoolSyncRequests5961 从那条队列里按「最早一条」认领,会认到这里的人。
  async function committedHuman(name: string): Promise<string> {
    const id = randomUUID()
    await actor.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)`, [id, name])
    created.users.push(id)
    return id
  }
  async function committedGroup(creator: string, members: string[]): Promise<string> {
    const id = randomUUID()
    await actor.query('BEGIN')
    await actor.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','Files notify',$2)`, [id, creator])
    await actor.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) SELECT $1, u, CASE WHEN u = $2 THEN 'owner' ELSE 'member' END
      FROM unnest($3::text[]) AS u`, [id, creator, [creator, ...members]])
    await actor.query('COMMIT')
    created.chats.push(id)
    return id
  }
  async function settle() {
    // 通知随提交投递;监听端再绕一个往返,保证已经收进来。
    await listener.query('SELECT 1')
    await new Promise((resolve) => setTimeout(resolve, 50))
    await listener.query('SELECT 1')
  }

  beforeAll(async () => {
    actor = new Client({ connectionString: databaseUrl() })
    listener = new Client({ connectionString: databaseUrl() })
    await actor.connect()
    await listener.connect()
    listener.on('notification', (message) => { heard.push({ channel: message.channel, payload: message.payload }) })
    await listener.query('LISTEN files_member_removed')
    await listener.query('LISTEN files_item_deleted')
  })
  afterAll(async () => {
    try {
      if (created.chats.length) await actor.query('DELETE FROM chat.chats WHERE id = ANY($1)', [created.chats])
      if (created.users.length) await actor.query('DELETE FROM identity.users WHERE id = ANY($1)', [created.users])
    } finally {
      await actor?.end()
      await listener?.end()
    }
  })

  it('移出成员 ⇒ files_member_removed <chat>:<user>;改成员行、回滚的删除都不发', async () => {
    const boss = await committedHuman('Notify Owner')
    const member = await committedHuman('Notify Member')
    // 群至少要留两个人,删掉一个之后还得合法。
    const group = await committedGroup(boss, [member, await committedHuman('Notify Stayer')])
    await settle()
    heard.length = 0

    await actor.query('UPDATE chat.chat_members SET updated_at = now() WHERE chat_id = $1 AND user_id = $2', [group, member])
    await actor.query('BEGIN')
    await actor.query('DELETE FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2', [group, member])
    await actor.query('ROLLBACK')
    await settle()
    expect(about(group)).toEqual([])

    await actor.query('DELETE FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2', [group, member])
    await settle()
    expect(about(group)).toEqual([{ channel: 'files_member_removed', payload: `${group}:${member}` }])
  })

  it('删文件 ⇒ files_item_deleted <id>;改文件不发', async () => {
    const boss = await committedHuman('Notify Item Owner')
    const group = await committedGroup(boss, [await committedHuman('Notify Item Member')])
    const { rows } = await actor.query<{ id: string }>(
      `INSERT INTO chat.workspace_items (chat_id, kind, filename, inline_text, created_by) VALUES ($1,'document','n.md','x',$2) RETURNING id`,
      [group, boss],
    )
    const doc = rows[0]!.id
    await settle()
    heard.length = 0

    await actor.query('UPDATE chat.workspace_items SET inline_text = $1 WHERE id = $2', ['y', doc])
    await settle()
    expect(about(doc)).toEqual([])

    await actor.query('DELETE FROM chat.workspace_items WHERE id = $1', [doc])
    await settle()
    expect(about(doc)).toEqual([{ channel: 'files_item_deleted', payload: doc }])
  })
})
