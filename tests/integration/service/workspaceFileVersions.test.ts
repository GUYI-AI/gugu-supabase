import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 二进制文件换成新版本,旧内容留成历史(迁移 20261011011000,咕咕 G1):
 *   · chat.workspace_replace_file_as:人(p_as_user_id = 本人)和 agent 同一条路;条目 id 不变、version + 1、
 *     pointer / 大小 / 类型换新;被替换的那一版和新的一版都在 workspace_item_versions;只留最近 50 版,裁掉的 pointer 回给调用方;
 *   · 文本文件、别的对话的对象、版本冲突、不是成员:拒,一个字都不写;
 *   · chat.workspace_versions_as 列历史;成员按条目的 RLS 直接读历史表,不是成员读不到;
 *   · 桶:没人指向的对象任何成员都能删,仍被指向的照旧只有上传者能删。
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
let outsider: string
let agent: string

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
  [id, `${id}@workspace-file-versions.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'file-versions fixture','fixture','darwin')`, [`dev-${id}`, id])
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
    id, 'File versions', creator, JSON.stringify(initial.map((user_id) => ({ user_id, role: 'member' }))),
  ])
  await asService()
  return id
}
/** 一个对象进 workspace 桶(上传者 = 路径第二段),返回它的 pointer。 */
async function object(chatId: string, by: string, name = 'deck.pptx'): Promise<string> {
  const pointer = `${chatId}/${by}/${randomUUID()}-${name}`
  await asService()
  await database.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('workspace',$1)`, [pointer])
  return pointer
}
/** 一个二进制文件:对象进桶以后 INSERT 一条 pointer(服务端直接插,created_by = by)。 */
async function binary(chatId: string, by: string): Promise<{ id: string; pointer: string }> {
  const pointer = await object(chatId, by)
  await asService()
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, blob_id, size_bytes, source_message_ids, created_by, version)
     VALUES ($1,'file','deck.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation',chat.file_blob_for_pointer($2,100,'application/vnd.openxmlformats-officedocument.presentationml.presentation',$3),100,'{}',$3,1) RETURNING id`,
    [chatId, pointer, by],
  )
  await asService()
  return { id: rows[0]!.id, pointer }
}
async function document(chatId: string, by: string): Promise<string> {
  await asService()
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, inline_text, size_bytes, source_message_ids, created_by, version)
     VALUES ($1,'document','notes.md','text/markdown','body',4,'{}',$2,1) RETURNING id`,
    [chatId, by],
  )
  await asService()
  return rows[0]!.id
}
type Replaced = { id: string; version: number; pointer: string; size_bytes: string; content_type: string; pruned_pointers: string[]; updated_by: string | null }
async function replace(itemId: string, caller: string, actor: string, pointer: string, size: number, expected: number | null = null): Promise<Replaced> {
  await asUser(caller)
  const { rows } = await database.query<Replaced>('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,$4,NULL,$5)', [itemId, actor, pointer, size, expected])
  await asService()
  return rows[0]!
}
async function history(itemId: string): Promise<{ n: number; pointer: string; made_by: string; size_bytes: string }[]> {
  await asService()
  return (await database.query<{ n: number; pointer: string; made_by: string; size_bytes: string }>(
    'SELECT n, chat.file_blob_pointer(blob_id) AS pointer, made_by, size_bytes FROM chat.workspace_item_versions WHERE item_id = $1 ORDER BY n', [itemId])).rows
}
async function item(itemId: string): Promise<{ pointer: string; version: number; size_bytes: string }> {
  await asService()
  return (await database.query<{ pointer: string; version: number; size_bytes: string }>(
    'SELECT chat.file_blob_pointer(blob_id) AS pointer, version, size_bytes FROM chat.workspace_items WHERE id = $1', [itemId])).rows[0]!
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('workspaceFileVersions.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner')
  member = await human('Member')
  outsider = await human('Outsider')
  agent = await agentOf(owner, 'Owner Agent')
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

describe('workspace_replace_file_as', () => {
  it('人换版本:条目 id 不变、version + 1、pointer 和大小换新;第 1 版和第 2 版都在历史里,各记各的作者', async () => {
    const group = await newGroup(owner, [member])
    const file = await binary(group, owner)
    const next = await object(group, member)
    const done = await replace(file.id, member, member, next, 250)
    expect(done).toMatchObject({ id: file.id, version: 2, pointer: next, pruned_pointers: [], updated_by: member })
    expect(String(done.size_bytes)).toBe('250')
    expect(await item(file.id)).toMatchObject({ pointer: next, version: 2 })
    expect(await history(file.id)).toMatchObject([
      { n: 1, pointer: file.pointer, made_by: owner },
      { n: 2, pointer: next, made_by: member },
    ])
  })

  it('agent 走同一条路,写入记在 agent 名下;它的主人不能冒充别人的 agent', async () => {
    const group = await newGroup(owner, [agent, member])
    const file = await binary(group, member)
    const next = await object(group, owner)
    expect(await replace(file.id, owner, agent, next, 9)).toMatchObject({ version: 2, updated_by: agent })
    expect((await history(file.id)).at(-1)).toMatchObject({ n: 2, made_by: agent })

    const other = await object(group, member)
    await asUser(member)
    expect(await fails('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,1)', [file.id, agent, other])).toMatch(/Not allowed to act as/)
    expect(await item(file.id)).toMatchObject({ pointer: next, version: 2 })
  })

  it('拒:文本文件、别的对话的对象、版本冲突、不是成员 —— 条目与历史都没动', async () => {
    const group = await newGroup(owner, [member])
    const elsewhere = await newGroup(outsider, [member])
    const file = await binary(group, owner)
    const doc = await document(group, owner)
    const next = await object(group, owner)

    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,1)', [doc, owner, next]))
      .toMatch(/is a live text file; change it through the file service/)
    const foreign = await object(elsewhere, outsider)
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,1)', [file.id, owner, foreign]))
      .toMatch(/not a chat you are a member of/)
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,1,NULL,7)', [file.id, owner, next]))
      .toMatch(/version conflict: expected 7, got 1/)
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,1)', [file.id, owner, file.pointer]))
      .toMatch(/already has/)
    await asUser(outsider)
    expect(await fails('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,1)', [file.id, outsider, next]))
      .toMatch(/workspace item not found/)

    expect(await item(file.id)).toMatchObject({ pointer: file.pointer, version: 1 })
    // Only the current version's own record.
    expect(await history(file.id)).toMatchObject([{ n: 1, pointer: file.pointer }])
    // 正对照:同样的对象、对的版本号,换得进去
    expect(await replace(file.id, owner, owner, next, 3, 1)).toMatchObject({ version: 2 })
  })

  it('只留最近 50 版:第 51 版写进去时裁掉第 1 版,第 52 版裁掉第 2 版,裁掉的 pointer 回给调用方', async () => {
    const group = await newGroup(owner, [member])
    const file = await binary(group, owner)
    const pointers = [file.pointer]
    let last: Replaced | null = null
    for (let v = 2; v <= 52; v++) {
      const next = await object(group, owner)
      pointers.push(next)
      last = await replace(file.id, owner, owner, next, v)
      if (v < 51) expect(last.pruned_pointers).toEqual([])
      if (v === 51) expect(last.pruned_pointers).toEqual([pointers[0]])
    }
    expect(last!.version).toBe(52)
    expect(last!.pruned_pointers).toEqual([pointers[1]])
    const kept = await history(file.id)
    expect(kept).toHaveLength(50)
    expect(kept[0]!.n).toBe(3)
    expect(kept.at(-1)!.n).toBe(52)
  })
})

describe('读历史', () => {
  it('workspace_versions_as 新的在前;成员能直接读历史表,不是成员一行都看不到', async () => {
    const group = await newGroup(owner, [member, agent])
    const file = await binary(group, owner)
    await replace(file.id, owner, owner, await object(group, owner), 2)
    await asUser(owner)
    expect((await database.query<{ n: number }>('SELECT n FROM chat.workspace_versions_as($1,$2)', [file.id, agent])).rows.map((r) => r.n))
      .toEqual([2, 1])
    await asUser(member)
    expect((await database.query('SELECT n FROM chat.workspace_item_versions WHERE item_id = $1', [file.id])).rowCount).toBe(2)
    await asUser(outsider)
    expect((await database.query('SELECT n FROM chat.workspace_item_versions WHERE item_id = $1', [file.id])).rowCount).toBe(0)
    await asUser(outsider)
    expect(await fails('SELECT * FROM chat.workspace_versions_as($1,$2)', [file.id, outsider])).toMatch(/workspace item not found/)
  })

  it('workspace_version_as 读一版的内容:成员读到 pointer;不是成员被拒;没有的那一版说没有', async () => {
    const group = await newGroup(owner, [member, agent])
    const file = await binary(group, owner)
    const next = await object(group, owner)
    await replace(file.id, owner, owner, next, 2)
    await asUser(owner)
    expect((await database.query('SELECT n, pointer, inline_text FROM chat.workspace_version_as($1,$2,1)', [file.id, agent])).rows)
      .toEqual([{ n: 1, pointer: file.pointer, inline_text: null }])
    await asUser(member)
    expect((await database.query('SELECT n, pointer FROM chat.workspace_version_as($1,$2,2)', [file.id, member])).rows)
      .toEqual([{ n: 2, pointer: next }])
    await asUser(outsider)
    expect(await fails('SELECT * FROM chat.workspace_version_as($1,$2,1)', [file.id, outsider])).toMatch(/workspace item not found/)
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_version_as($1,$2,9)', [file.id, owner])).toMatch(/has no version 9/)
  })

  it('历史表谁也不能直接写', async () => {
    const group = await newGroup(owner, [member])
    const file = await binary(group, owner)
    await asUser(owner)
    expect(await fails(`INSERT INTO chat.workspace_item_versions (item_id, n, inline_text, content_type) VALUES ($1, 9, $2, 'x')`, [file.id, 'x']))
      .toMatch(/permission denied/)
  })
})

describe('files_record_version:文本文件按轮记一版(迁移 20261011011100,咕咕 G2)', () => {
  async function text(chatId: string, by: string, name: string, type: string, body: string): Promise<string> {
    await asService()
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, inline_text, size_bytes, source_message_ids, created_by, version)
       VALUES ($1,'document',$2,$3,$4,octet_length($4),'{}',$5,1) RETURNING id`,
      [chatId, name, type, body, by],
    )
    await asService()
    return rows[0]!.id
  }
  async function record(itemId: string, body: string, by: string | null): Promise<boolean> {
    await asService()
    return (await database.query<{ recorded: boolean }>('SELECT chat.files_record_version($1, $2, $3) AS recorded', [itemId, body, by])).rows[0]!.recorded
  }
  const texts = async (itemId: string) => (await database.query<{ inline_text: string }>(
    'SELECT inline_text FROM chat.workspace_item_versions WHERE item_id = $1 ORDER BY n', [itemId])).rows.map((r) => r.inline_text)

  it('JSON 按值比:键的顺序不同、值相同,不再记一版(重新加载后 Yjs 可能换了顺序);值不同照记;解析不了的照文本比', async () => {
    const group = await newGroup(owner, [agent])
    const data = await text(group, owner, 'board.json', 'application/json', '{}')
    expect(await record(data, '{"a":1,"b":2}', agent)).toBe(true)
    expect(await record(data, '{"b":2,"a":1}', null)).toBe(false)
    expect(await texts(data)).toEqual(['{"a":1,"b":2}'])
    // 对照:值不同的 JSON 照记
    expect(await record(data, '{"b":3,"a":1}', owner)).toBe(true)
    // 解析不了的照文本比:不同就记、相同不记
    expect(await record(data, '{"b":3,', owner)).toBe(true)
    expect(await record(data, '{"b":3,', owner)).toBe(false)
    expect(await texts(data)).toEqual(['{"a":1,"b":2}', '{"b":3,"a":1}', '{"b":3,'])
  })

  it('对照:markdown 只看文本 —— 文本不同就记,哪怕只差一个空格', async () => {
    const group = await newGroup(owner, [agent])
    const notes = await text(group, owner, 'notes.md', 'text/markdown', 'body')
    expect(await record(notes, '# a', agent)).toBe(true)
    expect(await record(notes, '# a ', owner)).toBe(true)
    expect(await record(notes, '# a ', owner)).toBe(false)
    expect(await texts(notes)).toEqual(['# a', '# a '])
  })
})

describe('注销账号的清理链认得历史', () => {
  it('一个对象只被历史指着:上传者注销以后它不进回收队列,只清 owner;对照:真没人指着的进队列', async () => {
    const group = await newGroup(owner, [member])
    const file = await binary(group, member) // 第 1 版是 member 传的
    await replace(file.id, owner, owner, await object(group, owner), 2) // owner 换成第 2 版:member 那份只剩历史指着
    const stray = await object(group, member) // 对照:member 传过、谁都不指着
    await asService()
    const referenced = async (name: string) =>
      (await database.query<{ r: boolean }>(`SELECT identity.storage_object_is_referenced('workspace', $1) AS r`, [name])).rows[0]!.r
    expect(await referenced(file.pointer)).toBe(true)
    expect(await referenced(stray)).toBe(false)

    const queued = async () => (await database.query<{ name: string }>(
      `SELECT b.object_name AS name FROM chat.file_blob_gc g JOIN chat.file_blobs b ON b.id = g.blob_id
        WHERE b.bucket_id = 'workspace' AND b.object_name = ANY($1) ORDER BY 1`, [[file.pointer, stray]])).rows.map((r) => r.name)
    const before = await queued()
    expect(before).not.toContain(stray)

    // 注销 = 删 auth 账号,触发器跑 identity.erase_human_account
    await database.query('DELETE FROM auth.users WHERE id = $1::uuid', [member])
    expect(await queued()).toEqual([...before, stray].sort())
    expect((await database.query('SELECT 1 FROM storage.objects WHERE name = $1', [file.pointer])).rowCount).toBe(1)
    const kept = await history(file.id)
    expect(kept.map((v) => v.pointer)).toContain(file.pointer)
    // 作者随人注销清成 NULL(与 workspace_items.created_by 同一规矩),那一版留着
    expect(kept.find((v) => v.pointer === file.pointer)!.made_by).toBeNull()
  })
})

describe('桶:没人指向的对象', () => {
  it('workspace_pointer_in_use 认条目和历史两处;换版本后被裁掉、删文件后历史随条目走,都成了没人指向', async () => {
    const group = await newGroup(owner, [member])
    const file = await binary(group, owner)
    const next = await object(group, member)
    const stray = await object(group, member)
    await replace(file.id, owner, owner, next, 2)
    await asUser(owner)
    const inUse = async (p: string) => (await database.query<{ used: boolean }>('SELECT chat.workspace_pointer_in_use($1) AS used', [p])).rows[0]!.used
    expect(await inUse(file.pointer)).toBe(true)
    expect(await inUse(next)).toBe(true)
    expect(await inUse(stray)).toBe(false)
    await asUser(owner)
    await database.query('SELECT id FROM chat.workspace_delete_as($1,$2)', [file.id, owner])
    await asUser(owner)
    expect(await inUse(file.pointer)).toBe(false)
    expect(await inUse(next)).toBe(false)
  })

  it('preserves reference/membership predicates while physical Storage reads and deletes require the managed service', async () => {
    await database.query("SELECT set_config('storage.allow_delete_query','true',true)")
    const group = await newGroup(owner, [member])
    const file = await binary(group, owner)
    const stray = await object(group, owner, 'stray.png')
    const policy = async (who: string, name: string) => {
      await asUser(who)
      // Evaluate the historical predicate with this actor's claims independently of the new restrictive gate.
      // Actual authenticated Storage access is asserted separately below; this is not an allowed DELETE.
      await asService()
      const { rows } = await database.query<{ allowed: boolean }>(
        `SELECT (bucket_id = 'workspace'
                 AND chat.is_member((storage.foldername(name))[1])
                 AND ((storage.foldername(name))[2] = auth.uid()::TEXT OR NOT chat.workspace_pointer_in_use(name))) AS allowed
           FROM storage.objects WHERE name = $1 AND chat.is_member((storage.foldername(name))[1])`, [name])
      return rows[0]?.allowed ?? null
    }
    expect(await policy(member, stray)).toBe(true)
    expect(await policy(member, file.pointer)).toBe(false)
    expect(await policy(owner, file.pointer)).toBe(true)
    expect(await policy(outsider, stray)).toBe(null)
    for (const who of [owner,member,outsider]) {
      await asUser(who)
      expect((await database.query('SELECT name FROM storage.objects WHERE name=ANY($1)',[[stray,file.pointer]])).rows).toEqual([])
      expect((await database.query('DELETE FROM storage.objects WHERE name=ANY($1) RETURNING name',[[stray,file.pointer]])).rows).toEqual([])
    }
    await asUser(member)
    expect((await database.query('SELECT id FROM chat.workspace_get_as($1,$2)',[file.id,member])).rows).toEqual([{id:file.id}])
    await asUser(outsider)
    expect(await fails('SELECT id FROM chat.workspace_get_as($1,$2)',[file.id,outsider])).toMatch(/workspace item not found/)
    // 策略本身就是这一句:库里的定义与上面判的式子相同
    await asService()
    const { rows } = await database.query<{ qual: string }>(
      `SELECT pg_get_expr(polqual, polrelid) AS qual FROM pg_policy WHERE polname = 'workspace_delete_owner'`)
    expect(rows[0]!.qual).toMatch(/workspace_pointer_in_use\(name\)/)
  })
})
