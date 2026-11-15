import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 群文件夹一扇门(迁移 20261017194408):
 *   · authenticated 对 chat.workspace_items 没有 INSERT / UPDATE / DELETE,哪一列都没有;三条写 RLS 没了;读照旧;
 *   · 人以自己的身份走 *_as:建、原地改名(move_as)、删,和 agent 同一套判据;
 *   · workspace_update_document_as 没了;workspace_replace_file_as 回 parent_id / system_role / path;
 *   · 删权：建的人自己(或自己的 agent 建的),再加上群主、管理员删得了任何条目;workspace_deletable_as 说的与删的判据一致。
 * 每条否定配正对照;每条用例 BEGIN…ROLLBACK。
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
let owner: string
let member: string

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asService() {
  await database.query('RESET role')
}
async function fails(sql: string, values: unknown[] = []): Promise<string> {
  await database.query('SAVEPOINT expected_failure')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT expected_failure')
    return (error as Error).message
  }
  await database.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
async function human(name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@workspace-one-door.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  return id
}
async function newGroup(creator: string, initial: string[]): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await createFixtureGroup(database, [
    id, 'One door', creator, JSON.stringify(initial.map((user_id) => ({ user_id, role: 'member' }))),
  ])
  await asService()
  return id
}
async function rpc<Row = Record<string, unknown>>(caller: string, sql: string, values: unknown[]): Promise<Row[]> {
  await asUser(caller)
  const { rows } = await database.query<Row>(sql, values)
  await asService()
  return rows
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('workspaceOneDoor.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner')
  member = await human('Member')
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

describe('只有门能写', () => {
  it('authenticated 没有写权限(表级、哪一列都没有),三条写 RLS 没了;SELECT 照旧', async () => {
    const { rows } = await database.query<Record<string, boolean>>(`SELECT
      has_table_privilege('authenticated', 'chat.workspace_items', 'SELECT') AS select,
      has_table_privilege('authenticated', 'chat.workspace_items', 'DELETE') AS delete,
      has_any_column_privilege('authenticated', 'chat.workspace_items', 'INSERT') AS insert,
      has_any_column_privilege('authenticated', 'chat.workspace_items', 'UPDATE') AS update`)
    expect(rows[0]).toEqual({ select: true, delete: false, insert: false, update: false })
    const writes = await database.query<{ policyname: string }>(`SELECT policyname FROM pg_policies
      WHERE schemaname = 'chat' AND tablename = 'workspace_items' AND 'authenticated' = ANY(roles) AND cmd <> 'SELECT' AND permissive = 'PERMISSIVE'`)
    expect(writes.rows).toEqual([])
    // 对照:读的那条还在。
    const reads = await database.query<{ policyname: string }>(`SELECT policyname FROM pg_policies
      WHERE schemaname = 'chat' AND tablename = 'workspace_items' AND 'authenticated' = ANY(roles) AND cmd = 'SELECT' AND permissive = 'PERMISSIVE'`)
    expect(reads.rows).toEqual([{ policyname: 'workspace_items_select_member' }])
  })

  it('成员直接 INSERT / UPDATE / DELETE 被拒;同一个人经 *_as 建、原地改名、删照常(版本 +1)', async () => {
    const group = await newGroup(owner, [member])
    await asUser(member)
    expect(await fails(`INSERT INTO chat.workspace_items (chat_id, kind, filename, inline_text, created_by) VALUES ($1,'document','a.md','x',$2)`, [group, member]))
      .toMatch(/permission denied/)
    const [made] = await rpc<{ id: string; created_by: string; path: string }>(member,
      'SELECT id, created_by, path FROM chat.workspace_create_document_as($1,$2,$3,$4)', [group, member, 'a.md', 'x'])
    expect(made).toMatchObject({ created_by: member, path: 'a.md' })
    await asUser(member)
    expect(await fails('UPDATE chat.workspace_items SET filename = $1 WHERE id = $2', ['b.md', made!.id])).toMatch(/permission denied/)
    expect(await fails('DELETE FROM chat.workspace_items WHERE id = $1', [made!.id])).toMatch(/permission denied/)
    const [renamed] = await rpc<{ filename: string; version: number; path: string }>(member,
      'SELECT filename, version, path FROM chat.workspace_move_as($1,$2,NULL,$3)', [made!.id, member, 'b.md'])
    expect(renamed).toEqual({ filename: 'b.md', version: 2, path: 'b.md' })
    // 删权只在门里:别的(不是群主、管理员的)成员删不掉,建的人删得掉。
    const other = await human('Other member')
    await database.query("INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')", [group, other])
    await asUser(other)
    expect(await fails('SELECT * FROM chat.workspace_delete_as($1,$2)', [made!.id, other])).toMatch(/不是你\(或你的 agent\)建的/)
    expect((await rpc<{ id: string }>(member, 'SELECT id FROM chat.workspace_delete_as($1,$2)', [made!.id, member]))).toEqual([{ id: made!.id }])
  })
})

describe('门的形状', () => {
  it('workspace_update_document_as 没了', async () => {
    const { rowCount } = await database.query(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'chat' AND p.proname = 'workspace_update_document_as'`)
    expect(rowCount).toBe(0)
  })

  it('workspace_replace_file_as 回位置:子文件夹里的文件换内容,回的 path 是它在文件夹里的路径', async () => {
    const group = await newGroup(owner, [member])
    const [folder] = await rpc<{ id: string }>(owner, 'SELECT id FROM chat.workspace_mkdir_as($1,$2,$3)', [group, owner, '合同/2026'])
    const first = `${group}/${owner}/${randomUUID()}-a.pdf`
    const second = `${group}/${owner}/${randomUUID()}-b.pdf`
    await database.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('workspace',$1),('workspace',$2)`, [first, second])
    const [file] = await rpc<{ id: string }>(owner,
      'SELECT id FROM chat.workspace_create_file_as($1,$2,$3,$4,$5,$6,NULL,$7)', [group, owner, 'a.pdf', 'application/pdf', 1, first, '合同/2026'])
    const [replaced] = await rpc<{ version: number; parent_id: string; system_role: string | null; path: string }>(owner,
      'SELECT version, parent_id, system_role, path FROM chat.workspace_replace_file_as($1,$2,$3,$4,NULL,$5)', [file!.id, owner, second, 2, 1])
    expect(replaced).toEqual({ version: 2, parent_id: folder!.id, system_role: null, path: '合同/2026/a.pdf' })
  })
})

describe('群主、管理员删得了任何条目(owner 10-18)', () => {
  it('群主删成员建的文件、删装着别人东西的文件夹 ⇒ 成功;普通成员删别人建的 ⇒ 拒;deletable_as 说的一样', async () => {
    const other = await human('Other member')
    const group = await newGroup(owner, [member, other])
    const [theirs] = await rpc<{ id: string }>(member, 'SELECT id FROM chat.workspace_create_document_as($1,$2,$3,$4)', [group, member, 'theirs.md', 'x'])
    const [mine] = await rpc<{ id: string }>(other, 'SELECT id FROM chat.workspace_create_document_as($1,$2,$3,$4)', [group, other, 'mine.md', 'x'])
    const [box] = await rpc<{ id: string }>(other, 'SELECT id FROM chat.workspace_mkdir_as($1,$2,$3)', [group, other, 'Box'])
    await rpc(member, 'SELECT id FROM chat.workspace_create_document_as($1,$2,$3,$4,p_folder => $5)', [group, member, 'in-box.md', 'x', 'Box'])
    const deletable = async (who: string) =>
      (await rpc<{ id: string }>(who, 'SELECT id FROM chat.workspace_deletable_as($1::uuid[],$2) AS id', [[theirs!.id, mine!.id, box!.id], who]))
        .map((row) => row.id).sort()
    // 普通成员:只有自己建的;自己建的文件夹里有别人的东西 ⇒ 整个删不了,不出现。
    expect(await deletable(other)).toEqual([mine!.id])
    await asUser(other)
    expect(await fails('SELECT * FROM chat.workspace_delete_as($1,$2)', [theirs!.id, other])).toMatch(/不是你\(或你的 agent\)建的/)
    expect(await fails('SELECT * FROM chat.workspace_delete_as($1,$2)', [box!.id, other])).toMatch(/里有 1 项不是你/)
    // 群主:都删得掉。
    expect(await deletable(owner)).toEqual([theirs!.id, mine!.id, box!.id].sort())
    expect((await rpc<{ id: string }>(owner, 'SELECT id FROM chat.workspace_delete_as($1,$2)', [theirs!.id, owner])).map((r) => r.id)).toEqual([theirs!.id])
    expect((await rpc<{ id: string }>(owner, 'SELECT id FROM chat.workspace_delete_as($1,$2)', [box!.id, owner]))).toHaveLength(2)
  })

  it('管理员同样;「附件」系统文件夹谁也删不了', async () => {
    const group = await newGroup(owner, [member])
    await database.query("UPDATE chat.chat_members SET role = 'admin' WHERE chat_id = $1 AND user_id = $2", [group, member])
    const [doc] = await rpc<{ id: string }>(owner, 'SELECT id FROM chat.workspace_create_document_as($1,$2,$3,$4)', [group, owner, 'owners.md', 'x'])
    const folder = (await database.query<{ id: string }>("SELECT chat.workspace_system_folder($1,'attachments') AS id", [group])).rows[0]!.id
    expect((await rpc<{ id: string }>(member, 'SELECT id FROM chat.workspace_deletable_as($1::uuid[],$2) AS id', [[doc!.id, folder], member])).map((r) => r.id))
      .toEqual([doc!.id])
    await asUser(member)
    expect(await fails('SELECT * FROM chat.workspace_delete_as($1,$2)', [folder, member])).toMatch(/系统文件夹/)
    expect((await rpc<{ id: string }>(member, 'SELECT id FROM chat.workspace_delete_as($1,$2)', [doc!.id, member])).map((r) => r.id)).toEqual([doc!.id])
  })

  it('私聊没有管理员:发起人(那一行的 role 是 owner)删不掉对方建的;对方删得掉自己的', async () => {
    const dm = randomUUID()
    await asService()
    await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'dm',NULL,$2)`, [dm, owner])
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'member')`, [dm, owner, member])
    const [theirs] = await rpc<{ id: string }>(member, 'SELECT id FROM chat.workspace_create_document_as($1,$2,$3,$4)', [dm, member, 'theirs.md', 'x'])
    expect(await rpc(owner, 'SELECT id FROM chat.workspace_deletable_as($1::uuid[],$2) AS id', [[theirs!.id], owner])).toEqual([])
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_delete_as($1,$2)', [theirs!.id, owner])).toMatch(/不是你\(或你的 agent\)建的/)
    expect((await rpc<{ id: string }>(member, 'SELECT id FROM chat.workspace_delete_as($1,$2)', [theirs!.id, member])).map((r) => r.id)).toEqual([theirs!.id])
  })

  it('话题按源群判:源群的管理员删得了话题里别人建的;开话题的人(话题里 role 是 owner、源群里是普通成员)删不了', async () => {
    const opener = await human('Topic opener')
    const author = await human('Author')
    const group = await newGroup(owner, [member, opener, author])
    await database.query("UPDATE chat.chat_members SET role = 'admin' WHERE chat_id = $1 AND user_id = $2", [group, member])
    const topic = randomUUID()
    const source = randomUUID()
    await database.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type) VALUES ($1,$2,$3,'源消息','text')`, [source, group, opener])
    await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id, source_chat_id, source_message_id) VALUES ($1,'topic','话题',$2,$3,$4)`,
      [topic, opener, group, source])
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')`, [topic, opener, member, author])
    const [doc] = await rpc<{ id: string }>(author, 'SELECT id FROM chat.workspace_create_document_as($1,$2,$3,$4)', [topic, author, 'notes.md', 'x'])
    expect(await rpc(opener, 'SELECT id FROM chat.workspace_deletable_as($1::uuid[],$2) AS id', [[doc!.id], opener])).toEqual([])
    await asUser(opener)
    expect(await fails('SELECT * FROM chat.workspace_delete_as($1,$2)', [doc!.id, opener])).toMatch(/不是你\(或你的 agent\)建的/)
    expect((await rpc<{ id: string }>(member, 'SELECT id FROM chat.workspace_deletable_as($1::uuid[],$2) AS id', [[doc!.id], member])).map((r) => r.id)).toEqual([doc!.id])
    expect((await rpc<{ id: string }>(member, 'SELECT id FROM chat.workspace_delete_as($1,$2)', [doc!.id, member])).map((r) => r.id)).toEqual([doc!.id])
  })
})
