import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 群文件夹的子文件夹(迁移 20261016012659;gugu-base notes/2026-10-15-attachments-into-folder/设计.md §2、§2.1):
 *   · 文件夹是 kind = 'folder' 的一行,parent_id 指向它;路径在读的时候拼;深度最多 16 层;不能放进自己里面;
 *   · 同一个文件夹里不许重名(不分大小写、名字先规范化);INSERT 撞名自动加「 (n)」(n = 同系列最大 + 1,不填空缺),
 *     改名 / 移动撞名报 workspace_name_taken;两条并发的同名插入不会撞;
 *   · 「附件」系统文件夹:只由服务端建,不能改名、移动、删除,里面照常管;整个对话被删时照样删得干净;
 *   · 非空文件夹直接 DELETE 被外键拦下(外键级联不走 RLS),整棵删只走 workspace_delete_as,有一项删不了就一项都不删;
 *   · agent 那一侧的 RPC:list / get 带路径,create 能放进文件夹(缺的自动建),mkdir、move;已发出的旧调用照旧。
 * 每条否定配正对照;除并发那一组以外,每条用例 BEGIN…ROLLBACK。
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let databaseUrl: string
let database: DatabaseClient
let owner: string
let member: string
let outsider: string
let agent: string

async function asUser(id: string, db: DatabaseClient = database) {
  await db.query('SET LOCAL role TO authenticated')
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asService(db: DatabaseClient = database) {
  await db.query('RESET role')
}
/** The refusal as one line: what a person reads (message — already-shipped clients show it as it is), the code a client
 *  branches on (HINT), and the SQLSTATE. */
async function fails(sql: string, values: unknown[] = []): Promise<string> {
  await database.query('SAVEPOINT expected_failure')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT expected_failure')
    const e = error as Error & { hint?: string; code?: string }
    return `${e.message} | hint: ${e.hint ?? ''} | code: ${e.code ?? ''}`
  }
  await database.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
async function human(name: string, db: DatabaseClient = database): Promise<string> {
  await asService(db)
  const id = randomUUID()
  await db.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@workspace-subfolders.invalid`])
  await db.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await db.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'subfolders fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id)
    VALUES ($1,'agent',$2,$3,true,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}
async function newGroup(creator: string, initial: string[], db: DatabaseClient = database): Promise<string> {
  const id = randomUUID()
  await asUser(creator, db)
  await createFixtureGroup(db, [
    id, 'Subfolders', creator, JSON.stringify(initial.map((user_id) => ({ user_id, role: 'member' }))),
  ])
  await asService(db)
  return id
}
/** 同一个事务里建的行 created_at 都一样,所以按名字排,不按建的先后。 */
const sorted = (list: string[]) => [...list].sort()
/**
 * 直接往表里插一行(服务端;人只经 *_as 写,20261017194408),created_by = by;放入那一侧的触发器照管名字与父。
 * 回插进去以后的 id 与最终的名字。
 */
async function put(
  chatId: string, by: string, filename: string,
  opts: { kind?: 'document' | 'folder'; parent?: string | null } = {},
): Promise<{ id: string; filename: string }> {
  await asService()
  const kind = opts.kind ?? 'document'
  const { rows } = await database.query<{ id: string; filename: string }>(
    `INSERT INTO chat.workspace_items (chat_id, parent_id, kind, filename, content_type, inline_text, size_bytes, source_message_ids, created_by, version)
     VALUES ($1,$2,$3,$4,$5,$6,0,'{}',$7,1) RETURNING id, filename`,
    [chatId, opts.parent ?? null, kind, filename, kind === 'folder' ? 'inode/directory' : 'text/plain', kind === 'folder' ? null : '', by],
  )
  await asService()
  return rows[0]!
}
async function names(chatId: string, parent: string | null = null): Promise<string[]> {
  await asService()
  const { rows } = await database.query<{ filename: string }>(
    `SELECT filename FROM chat.workspace_items WHERE chat_id = $1 AND parent_id IS NOT DISTINCT FROM $2`,
    [chatId, parent],
  )
  return sorted(rows.map((row) => row.filename))
}
async function rpc<Row = Record<string, unknown>>(caller: string, sql: string, values: unknown[]): Promise<Row[]> {
  await asUser(caller)
  const { rows } = await database.query<Row>(sql, values)
  await asService()
  return rows
}
async function exists(id: string): Promise<boolean> {
  await asService()
  return (await database.query('SELECT 1 FROM chat.workspace_items WHERE id = $1', [id])).rowCount === 1
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('workspaceSubfolders.test requires a loopback PostgreSQL database')
  }
  databaseUrl = url.href
  database = new Client({ connectionString: databaseUrl })
  await database.connect()
})
afterAll(async () => { await database?.end() })

describe('within one transaction', () => {
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

  describe('文件夹与路径', () => {
    it('人直接往表里建文件夹、往文件夹里放东西;list_as 按路径列,路径从根拼起', async () => {
      const group = await newGroup(owner, [member])
      const docs = await put(group, owner, 'Docs', { kind: 'folder' })
      const year = await put(group, member, '2026', { kind: 'folder', parent: docs.id })
      const plan = await put(group, member, 'plan.md', { parent: year.id })
      await put(group, owner, 'root.md')

      const all = await rpc<{ filename: string; path: string; parent_id: string | null; kind: string }>(owner,
        'SELECT filename, path, parent_id, kind FROM chat.workspace_list_as($1,$2)', [group, owner])
      expect(all.map((row) => row.path).sort()).toEqual(['Docs', 'Docs/2026', 'Docs/2026/plan.md', 'root.md'])
      const inYear = await rpc<{ id: string; path: string }>(owner,
        'SELECT id, path FROM chat.workspace_list_as($1,$2,p_folder => $3)', [group, owner, 'docs/2026'])
      expect(inYear).toEqual([{ id: plan.id, path: 'Docs/2026/plan.md' }])
      const byId = await rpc<{ id: string }>(owner, 'SELECT id FROM chat.workspace_list_as($1,$2,p_folder => $3)', [group, owner, docs.id])
      expect(byId.map((row) => row.id)).toEqual([year.id])
      const root = await rpc<{ filename: string }>(owner, 'SELECT filename FROM chat.workspace_list_as($1,$2,p_folder => $3)', [group, owner, ''])
      expect(root.map((row) => row.filename).sort()).toEqual(['Docs', 'root.md'])
      const folders = await rpc<{ filename: string }>(owner, 'SELECT filename FROM chat.workspace_list_as($1,$2,p_kind => $3)', [group, owner, 'folder'])
      expect(folders.map((row) => row.filename).sort()).toEqual(['2026', 'Docs'])
      const got = await rpc<{ path: string; parent_id: string; epoch: number }>(owner,
        'SELECT path, parent_id, epoch FROM chat.workspace_get_as($1,$2)', [plan.id, owner])
      expect(got).toEqual([{ path: 'Docs/2026/plan.md', parent_id: year.id, epoch: 0 }])

      await asUser(owner)
      expect(await fails('SELECT * FROM chat.workspace_list_as($1,$2,p_folder => $3)', [group, owner, 'Docs/nope'])).toMatch(/workspace_folder_not_found/)
    })

    it('读一个文件夹只读它这一层(20261107220000):每行与整棵读里的那一行一样,含路径;分页的 total 是这一层的;最深那一层的也是', async () => {
      const group = await newGroup(owner, [member])
      let parent: string | null = null
      const chain: string[] = []
      for (let depth = 1; depth <= 15; depth += 1) {
        parent = (await put(group, owner, `d${depth}`, { kind: 'folder', parent })).id
        chain.push(parent)
      }
      for (const name of ['a.md', 'b.md', 'c.md']) await put(group, member, name, { parent: chain[2] })
      await put(group, owner, 'deep.md', { parent: chain[14] })
      await put(group, owner, 'root.md')

      const list = (folder: string | null, offset = 0, limit: number | null = null) => rpc<Record<string, unknown>>(owner,
        'SELECT * FROM chat.workspace_list_as($1,$2,$3,$4,p_folder => $5)', [group, owner, offset, limit, folder])
      const whole = await list(null)
      const childrenOf = (id: string | null) => whole.filter((row) => row.parent_id === id).map((row) => ({ ...row, total: expect.anything() }))
      expect(await list(chain[2]!)).toEqual(childrenOf(chain[2]!))
      expect(await list('d1/d2/d3')).toEqual(childrenOf(chain[2]!))
      expect(await list('')).toEqual(childrenOf(null))
      const deep = await list(chain[14]!)
      expect(deep.map((row) => row.path)).toEqual([`${chain.map((_, i) => `d${i + 1}`).join('/')}/deep.md`])
      expect(deep).toEqual(childrenOf(chain[14]!))
      const page = await list(chain[2]!, 1, 2)
      expect(page.map((row) => [row.filename, row.total])).toEqual(childrenOf(chain[2]!).slice(1, 3).map((row) => [row.filename, '4']))
    })

    it('读一个文件夹的深度上限(20261107220000):第 63 层能列,第 64 层不能,与整棵读走到的边界一样', async () => {
      const group = await newGroup(owner, [member])
      let parent: string | null = null
      const chain: string[] = []
      // 写的那一侧只放 16 层(触发器);这里造的是读的那一侧兜着的、更深的旧数据。
      await database.query("SET LOCAL session_replication_role = replica")
      for (let depth = 1; depth <= 64; depth += 1) {
        parent = (await put(group, owner, `d${depth}`, { kind: 'folder', parent })).id
        chain.push(parent)
      }
      await put(group, owner, 'in63.md', { parent: chain[62] })
      await put(group, owner, 'in64.md', { parent: chain[63] })
      await database.query("SET LOCAL session_replication_role = origin")
      const list = (folder: string | null) => rpc<{ filename: string; path: string; total: string }>(owner,
        'SELECT * FROM chat.workspace_list_as($1,$2,p_folder => $3)', [group, owner, folder])
      const in63 = await list(chain[62]!)
      expect(sorted(in63.map((row) => row.filename))).toEqual(['d64', 'in63.md'])
      const base = chain.slice(0, 63).map((_, i) => `d${i + 1}`).join('/')
      expect(sorted(in63.map((row) => row.path))).toEqual([`${base}/d64`, `${base}/in63.md`])
      expect(await list(chain[63]!)).toEqual([])
      const whole = await rpc<{ filename: string }>(owner, 'SELECT * FROM chat.workspace_list_as($1,$2)', [group, owner])
      expect(whole.map((row) => row.filename)).toContain('in63.md')
      expect(whole.map((row) => row.filename)).not.toContain('in64.md')
    })

    it('切页之后才查的副本与设备版本(20261107220000):每行都对;与名字、种类过滤、分页一起用也对;同一份内容有多个副本也只占一行,活着的那份说了算', async () => {
      const group = await newGroup(owner, [member])
      const folder = (await put(group, owner, 'Docs', { kind: 'folder' })).id
      const transferGroup = (await database.query<{ g: string }>('SELECT chat.file_transfer_group($1) AS g', [group])).rows[0]!.g
      const account = async (user: string) => (await database.query<{ a: string }>('SELECT chat.file_transfer_account($1) AS a', [user])).rows[0]!.a
      // 放进文件夹时触发器已经记下这一份的副本(file_transfer_track);这里改它的状态,或再多放一份、或拿掉。
      const copyIs = async (blob: string, by: string, state: { expiresAt?: string; expiredAt?: string } = {}) => {
        await database.query(`UPDATE chat.file_transfer_storage_refs r SET account_id=$3,expires_at=$4,expired_at=$5
          FROM chat.file_transfer_storage o WHERE o.id=r.storage_id AND o.blob_id=$1 AND r.chat_id=$2`,
        [blob, transferGroup, await account(by), state.expiresAt ?? null, state.expiredAt ?? null])
      }
      const file = async (name: string, minute: number, contentType = 'application/pdf') => {
        const blob = (await database.query<{ id: string }>(`INSERT INTO chat.file_blobs(bucket_id,object_name,size_bytes,content_type,created_by)
          VALUES('workspace',$1,9,$2,$3) RETURNING id`, [randomUUID(), contentType, member])).rows[0]!.id
        // 同一个事务里 now() 都一样:分页的次序要靠明确的时间才看得出。
        const item = (await database.query<{ id: string }>(`INSERT INTO chat.workspace_items(chat_id,parent_id,kind,filename,content_type,size_bytes,blob_id,source_message_ids,created_by,version,created_at)
          VALUES($1,$2,'file',$3,$4,9,$5,'{}',$6,1,TIMESTAMPTZ '2026-11-07 00:00:00+00'+make_interval(mins=>$7)) RETURNING id`,
        [group, folder, name, contentType, blob, member, minute])).rows[0]!.id
        return { item, blob }
      }
      await file('a-kept.pdf', 6)
      const expiresAt = '2030-01-01T00:00:00.000Z'
      await copyIs((await file('b-temporary.pdf', 5)).blob, owner, { expiresAt })
      await file('c-image.png', 4, 'image/png')
      const expiredAt = '2026-11-01T00:00:00.000Z'
      await copyIs((await file('d-reclaimed.pdf', 3)).blob, member, { expiredAt })
      const onDevice = await file('e-device.pdf', 2)
      await database.query('DELETE FROM chat.file_transfer_storage_refs r USING chat.file_transfer_storage o WHERE o.id=r.storage_id AND o.blob_id=$1', [onDevice.blob])
      const device = `dev-${owner}`
      await database.query(`INSERT INTO chat.file_device_revisions(item_id,version,host_device_id,host_project_id,relative_path,sha256,size_bytes,file_name,content_type)
        VALUES($1,1,$2,'project','e-device.pdf',$3,9,'e-device.pdf','application/pdf')`, [onDevice.item, device, 'ab'.repeat(32)])
      const twoCopies = await file('f-two-copies.pdf', 1)
      for (const reclaimedAt of [null, expiredAt]) {
        const extra = (await database.query<{ id: string }>(`INSERT INTO chat.file_transfer_storage(blob_id,bucket_id,object_name,size_bytes)
          VALUES($1,'workspace',$2,9) RETURNING id`, [twoCopies.blob, randomUUID()])).rows[0]!.id
        await database.query('INSERT INTO chat.file_transfer_storage_refs(storage_id,chat_id,account_id,expired_at) VALUES($1,$2,$3,$4)',
          [extra, transferGroup, await account(member), reclaimedAt])
      }
      // 新建的这一行 created_at = now(),比上面那些都新:排最前。
      await put(group, member, 'a-note.md', { parent: folder })

      const columns = 'filename,path,total::int AS total,storage_class,copy_account_id,host_device_id,is_mine,expires_at,copy_expired_at'
      const list = (offset: number, limit: number | null, name: string | null = null, kind: string | null = null, exact = false) =>
        rpc<Record<string, unknown>>(owner, `SELECT ${columns} FROM chat.workspace_list_as($1,$2,$3,$4,$5,$6,'Docs',$7)`, [group, owner, offset, limit, name, kind, exact])
      const memberAccount = await account(member)
      const ownerAccount = await account(owner)
      const row = (filename: string, total: number, fields: Record<string, unknown>) => ({
        filename, path: `Docs/${filename}`, total, storage_class: null, copy_account_id: null, host_device_id: null,
        is_mine: null, expires_at: null, copy_expired_at: null, ...fields,
      })
      const kept = { storage_class: 'kept', copy_account_id: memberAccount, is_mine: false }

      expect(await list(0, null)).toEqual([
        row('a-note.md', 7, {}),
        row('a-kept.pdf', 7, kept),
        row('b-temporary.pdf', 7, { storage_class: 'temporary', copy_account_id: ownerAccount, is_mine: true, expires_at: new Date(expiresAt) }),
        row('c-image.png', 7, { ...kept, storage_class: 'image' }),
        row('d-reclaimed.pdf', 7, { copy_account_id: memberAccount, copy_expired_at: new Date(expiredAt) }),
        row('e-device.pdf', 7, { host_device_id: device }),
        row('f-two-copies.pdf', 7, kept),
      ])
      // 分页只切这一层,total 还是这一层的总数。
      const page = await list(5, 2)
      expect(page.map((got) => [got.filename, got.total])).toEqual([['e-device.pdf', 7], ['f-two-copies.pdf', 7]])
      // 客户端按名字找文件夹里的一项(p_folder + p_name + p_exact),也有模糊搜与种类过滤。
      expect(await list(0, null, 'E-DEVICE.pdf', null, true)).toEqual([row('e-device.pdf', 1, { host_device_id: device })])
      expect((await list(0, 1, 'copies')).map((got) => [got.filename, got.total])).toEqual([['f-two-copies.pdf', 1]])
      expect((await list(0, null, null, 'document')).map((got) => got.filename)).toEqual(['a-note.md'])
      expect(await list(0, null, 'nothing')).toEqual([])
    })

    it('父必须是同一个对话里的文件夹:别的对话的、不存在的、是文件的都拒;文件夹不能放进自己里面', async () => {
      const group = await newGroup(owner, [member])
      const elsewhere = await newGroup(owner, [member])
      const there = await put(elsewhere, owner, 'There', { kind: 'folder' })
      const file = await put(group, owner, 'a.md')
      const a = await put(group, owner, 'A', { kind: 'folder' })
      const b = await put(group, owner, 'B', { kind: 'folder', parent: a.id })

      await asService()
      const insert = `INSERT INTO chat.workspace_items (chat_id, parent_id, kind, filename, content_type, inline_text, created_by)
                      VALUES ($1,$2,'document','x.md','text/plain','',$3)`
      expect(await fails(insert, [group, there.id, owner])).toMatch(/workspace_bad_parent/)
      expect(await fails(insert, [group, file.id, owner])).toMatch(/workspace_bad_parent/)
      expect(await fails(insert, [group, randomUUID(), owner])).toMatch(/workspace_bad_parent/)
      expect(await fails('UPDATE chat.workspace_items SET parent_id = $1 WHERE id = $2', [b.id, a.id])).toMatch(/^不能把文件夹放进它自己里面 \| hint: workspace_bad_parent/)
      expect(await fails('UPDATE chat.workspace_items SET parent_id = $1 WHERE id = $2', [a.id, a.id])).toMatch(/^不能把文件夹放进它自己里面 \| hint: workspace_bad_parent/)
      // 对照:同一个对话里的文件夹,放得进去。
      await database.query(insert, [group, a.id, owner])
      expect(await names(group, a.id)).toEqual(['B', 'x.md'])
    })

    it('最多 16 层:mkdir 16 层可以,第 17 层拒;带着两层的文件夹挪到第 15 层下面也拒', async () => {
      const group = await newGroup(owner, [member])
      const sixteen = Array.from({ length: 16 }, (_, i) => `d${i + 1}`).join('/')
      const deep = await rpc<{ path: string }>(owner, 'SELECT path FROM chat.workspace_mkdir_as($1,$2,$3)', [group, owner, sixteen])
      expect(deep[0]!.path).toBe(sixteen)
      await asUser(owner)
      expect(await fails('SELECT * FROM chat.workspace_mkdir_as($1,$2,$3)', [group, owner, `${sixteen}/d17`])).toMatch(/^文件夹最多套 16 层 \| hint: workspace_too_deep/)

      // p/q:mkdir 回的是最里面那一层 q;下面挪的是 p(带着 q 一起动)。
      await rpc(owner, 'SELECT id FROM chat.workspace_mkdir_as($1,$2,$3)', [group, owner, 'p/q'])
      const pair = (await rpc<{ id: string; filename: string }>(owner, 'SELECT id, filename FROM chat.workspace_list_as($1,$2,p_folder => $3)', [group, owner, '']))
        .filter((row) => row.filename === 'p')
      expect(pair).toHaveLength(1)
      const fifteen = Array.from({ length: 15 }, (_, i) => `d${i + 1}`).join('/')
      await asUser(owner)
      expect(await fails('SELECT * FROM chat.workspace_move_as($1,$2,$3)', [pair[0]!.id, owner, fifteen])).toMatch(/^文件夹最多套 16 层 \| hint: workspace_too_deep/)
      // 对照:挪到第 14 层下面,连同下面一层正好 16 层。
      const fourteen = Array.from({ length: 14 }, (_, i) => `d${i + 1}`).join('/')
      const moved = await rpc<{ path: string }>(owner, 'SELECT path FROM chat.workspace_move_as($1,$2,$3)', [pair[0]!.id, owner, fourteen])
      expect(moved[0]!.path).toBe(`${fourteen}/p`)
    })
  })

  describe('名字', () => {
    it('INSERT 撞名自动加「 (n)」:不分大小写;n = 同系列最大 + 1,不填空缺;带「 (n)」的原名算同一系列;别的文件夹不算撞', async () => {
      const group = await newGroup(owner, [member])
      expect((await put(group, owner, 'shot.png')).filename).toBe('shot.png')
      expect((await put(group, member, 'shot.png')).filename).toBe('shot (2).png')
      expect((await put(group, owner, 'SHOT.PNG')).filename).toBe('SHOT (3).PNG')
      const third = await put(group, owner, 'shot.png')
      expect(third.filename).toBe('shot (4).png')
      await asService()
      await database.query('DELETE FROM chat.workspace_items WHERE filename = $1 AND chat_id = $2', ['shot (2).png', group])
      expect((await put(group, owner, 'shot.png')).filename).toBe('shot (5).png')
      expect((await put(group, owner, 'shot (4).png')).filename).toBe('shot (6).png')
      // 对照:别的文件夹里同名不算撞;原名没人用就用原名。
      const box = await put(group, owner, 'box', { kind: 'folder' })
      expect((await put(group, owner, 'shot.png', { parent: box.id })).filename).toBe('shot.png')
      expect((await put(group, owner, 'other.png')).filename).toBe('other.png')
    })

    it('扩展名:最后一个点后 1–16 个字符、不含空白、点不在首位;否则整串都是主名', async () => {
      const group = await newGroup(owner, [member])
      // 空白按明列的那张表认(全角空格、不换行空格、em 空格),不看库的 ctype(复核 L11 追记 2)。
      const all = ['.env', 'README', 'archive.tar.gz', 'a. b', 'x.verylongextension12', 'a.b\u3000c', 'a.b\u00A0c', 'a.b\u2003c']
      for (const name of all) await put(group, owner, name)
      const again = []
      for (const name of all) again.push((await put(group, owner, name)).filename)
      expect(again).toEqual(['.env (2)', 'README (2)', 'archive.tar (2).gz', 'a. b (2)', 'x.verylongextension12 (2)', 'a.b\u3000c (2)', 'a.b\u00A0c (2)', 'a.b\u2003c (2)'])
    })

    it('名字先规范化:NFC;去首尾空白;/ \\ 控制字符换成 _;空名与「.」「..」叫「未命名」;超过 255 个字符截主名、保住扩展名', async () => {
      const group = await newGroup(owner, [member])
      const nfd = 'é.md'
      expect((await put(group, owner, nfd)).filename).toBe('é.md')
      expect((await put(group, owner, 'é.md')).filename).toBe('é (2).md')
      expect((await put(group, owner, '  a/b\\c\td.md  ')).filename).toBe('a_b_c_d.md')
      // 首尾空白按明列的那张表去(复核 L11 追记 2):全角空格、不换行空格、tab、em 空格、窄不换行空格、换行;C1 控制字符换成 _。
      expect((await put(group, owner, '\u3000\u00A0\t报告.md\u2003\u202F\n')).filename).toBe('报告.md')
      expect((await put(group, owner, 'c\u0085d\u009F.md')).filename).toBe('c_d_.md')
      expect((await put(group, owner, '')).filename).toBe('未命名')
      expect((await put(group, owner, '..')).filename).toBe('未命名 (2)')
      const long = `${'长'.repeat(300)}.pdf`
      const first = (await put(group, owner, long)).filename
      expect([...first]).toHaveLength(255)
      expect(first.endsWith('.pdf')).toBe(true)
      const second = (await put(group, owner, long)).filename
      expect([...second]).toHaveLength(255)
      expect(second.endsWith(' (2).pdf')).toBe(true)
    })

    it('看不见的格式字符(Unicode Cf)去掉,在哪儿都去:零宽空格 / 连接符 / 不连字、BOM、方向控制、软连字符、词连接符;两个 emoji 之间的零宽连接符留下(复核 L11 追记 1)', async () => {
      const group = await newGroup(owner, [member])
      expect((await put(group, owner, 'plan.md')).filename).toBe('plan.md')
      // 看起来一样的名字就是同一个名字:撞名,加「 (n)」。
      expect((await put(group, owner, '\u200Bplan.md\u200D')).filename).toBe('plan (2).md')
      expect((await put(group, owner, 'pl\uFEFFan\u2060.md')).filename).toBe('plan (3).md')
      expect((await put(group, owner, 'p\u00ADl\u200Ca\u200Dn.md')).filename).toBe('plan (4).md')
      // 方向控制:名字里夹一个 U+202E,「photo」后面的「gpj.exe」就倒着显示成「exe.jpg」。
      expect((await put(group, owner, 'photo\u202Egpj.exe')).filename).toBe('photogpj.exe')
      // 去掉以后才组合得起来的,照样 NFC。
      expect((await put(group, owner, 'e\u200B\u0301.md')).filename).toBe('\u00E9.md')
      // 对照(去多了也要红):组合 emoji 里的零宽连接符留下,变体选择符(不是 Cf)留下。
      expect((await put(group, owner, '\u{1F469}\u200D\u{1F4BB} 笔记.md')).filename).toBe('\u{1F469}\u200D\u{1F4BB} 笔记.md')
      expect((await put(group, owner, '\u2764\uFE0F\u200D\u{1F525}.md')).filename).toBe('\u2764\uFE0F\u200D\u{1F525}.md')
      // 只剩格式字符的名字是空名。
      expect((await put(group, owner, '\u200B\u200D')).filename).toBe('未命名')
      // 根上「附件」:前后、中间夹看不见的字符也是「附件」—— 留给系统文件夹,拿到的是「附件 (2)」「附件 (3)」。
      expect((await put(group, owner, '\u200B附件\u200B', { kind: 'folder' })).filename).toBe('附件 (2)')
      expect((await put(group, owner, '附\u200D件', { kind: 'folder' })).filename).toBe('附件 (3)')
      const box = await put(group, owner, 'Box', { kind: 'folder' })
      expect(await fails('UPDATE chat.workspace_items SET filename = $1 WHERE id = $2', ['\uFEFF附件', box.id])).toMatch(/hint: workspace_name_taken \| code: 23505$/)
    })

    it('看不见的字符按 Default_Ignorable_Code_Point 去(20261016035700):变体选择符、U+034F、韩文填充符、蒙古文变体选择符、高棉文元音都去;emoji 里的零宽连接符与 VS16、键帽前的 VS16 留下', async () => {
      const group = await newGroup(owner, [member])
      // 不在 Cf 里、照样看不见的:每一个都拼得出「附件」,根上留给系统文件夹,拿到的是「附件 (n)」。
      expect((await put(group, owner, '附\uFE0F件', { kind: 'folder' })).filename, 'VS16 不在 emoji 后面').toBe('附件 (2)')
      expect((await put(group, owner, '\u034F附件', { kind: 'folder' })).filename, '组合字形连接符').toBe('附件 (3)')
      expect((await put(group, owner, '附件\u3164', { kind: 'folder' })).filename, '韩文填充符').toBe('附件 (4)')
      expect((await put(group, owner, '\u115F附件', { kind: 'folder' })).filename, '韩文初声填充符').toBe('附件 (5)')
      expect((await put(group, owner, '附件\uFFA0', { kind: 'folder' })).filename, '半角韩文填充符').toBe('附件 (6)')
      expect((await put(group, owner, '附\u180B件', { kind: 'folder' })).filename, '蒙古文自由变体选择符').toBe('附件 (7)')
      expect((await put(group, owner, '\u17B4附件', { kind: 'folder' })).filename, '高棉文元音').toBe('附件 (8)')
      expect((await put(group, owner, '附件\uFE00', { kind: 'folder' })).filename, '变体选择符 1').toBe('附件 (9)')
      expect((await put(group, owner, '附件\u{E0100}', { kind: 'folder' })).filename, '变体选择符 17').toBe('附件 (10)')
      expect((await put(group, owner, '附件\u{E0FFF}', { kind: 'folder' })).filename, 'U+E0000–E0FFF 里未分配的').toBe('附件 (11)')
      // 对照(去多了也要红):emoji 后面的 VS16、键帽、组合 emoji 留下。
      expect((await put(group, owner, '\u2764\uFE0F.md')).filename).toBe('\u2764\uFE0F.md')
      expect((await put(group, owner, '1\uFE0F\u20E3.md')).filename).toBe('1\uFE0F\u20E3.md')
      expect((await put(group, owner, '\u{1F3F3}\uFE0F\u200D\u{1F308}.md')).filename).toBe('\u{1F3F3}\uFE0F\u200D\u{1F308}.md')
      expect((await put(group, owner, '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}.md')).filename).toBe('\u{1F469}\u{1F3FD}\u200D\u{1F4BB}.md')
      // 不在 emoji 里的 VS16、跟着它的零宽连接符、数字后面没有键帽符的 VS16、文字形式选择符:都去。
      expect((await put(group, owner, 'a\uFE0F\u200D\u{1F525}.md')).filename).toBe('a\u{1F525}.md')
      expect((await put(group, owner, '7\uFE0F.md')).filename).toBe('7.md')
      expect((await put(group, owner, '\u2764\uFE0Ex.md')).filename).toBe('\u2764x.md')
      expect((await put(group, owner, '\u3164')).filename).toBe('未命名')
    })

    it('上传撞了谁由库说(workspace_clash_as,复核追记 1 要改 A):带肤色的 ZWJ 名字、★ + VS16、NFD 的 café、首尾的 U+0085、超过 255 个字符、只差大小写,都回原来那一行;它自己就叫这个回 NULL;别的文件夹不算;「☆.md」旁边放「☆ + VS16.md」不撞', async () => {
      const group = await newGroup(owner, [member, agent])
      const clash = async (item: string, picked: string, as = owner) =>
        (await rpc<{ c: string | null }>(owner, 'SELECT chat.workspace_clash_as($1,$2,$3) AS c', [item, as, picked]))[0]!.c
      for (const picked of ['\u{1F469}\u{1F3FD}\u200D\u{1F4BB}.md', '\u2605\uFE0F.md', 'cafe\u0301.md', '\u0085note.md\u0085', 'a'.repeat(300) + '.md', 'Report.md']) {
        const first = await put(group, owner, picked)
        const second = await put(group, member, picked === 'Report.md' ? 'report.md' : picked)
        expect(second.filename, picked).not.toBe(first.filename)
        expect(await clash(second.id, picked === 'Report.md' ? 'report.md' : picked), picked).toBe(first.id)
        expect(await clash(first.id, picked), `${picked}:它自己就叫这个`).toBeNull()
      }
      // agent 问,同样的回答(它在这个群里)。
      const mine = await put(group, owner, 'mine.md')
      const again = await put(group, owner, 'mine.md')
      expect(await clash(again.id, 'mine.md', agent)).toBe(mine.id)
      // 只认同一层:根上先有「x.md」,Box 里又有一个,Box 里第二个撞的是 Box 里那一个。
      const box = await put(group, owner, 'Box', { kind: 'folder' })
      const top = await put(group, owner, 'x.md')
      // The one at the top made a day earlier: an answer that forgot the folder would be it (the oldest of that name).
      await database.query(`UPDATE chat.workspace_items SET created_at = created_at - interval '1 day' WHERE id = $1`, [top.id])
      const inBox = await put(group, owner, 'x.md', { parent: box.id })
      const inBox2 = await put(group, owner, 'x.md', { parent: box.id })
      expect(inBox2.filename).toBe('x (2).md')
      expect(await clash(inBox2.id, 'x.md')).toBe(inBox.id)
      // emoji 后面的 VS16 留着:「☆ + VS16.md」是另一个名字,不撞(JS 那套会问错,复核追记 1)。
      await put(group, owner, '\u2606.md')
      const white = await put(group, owner, '\u2606\uFE0F.md')
      expect(white.filename).toBe('\u2606\uFE0F.md')
      expect(await clash(white.id, '\u2606\uFE0F.md')).toBeNull()
    })

    it('workspace_clash_as 的门槛:本人或自己的 agent,并且是条目所在会话的成员;不限群 / 话题(私聊里也能问);别人的 agent、不在会话里、没有这一条都拒', async () => {
      const group = await newGroup(owner, [member])
      const first = await put(group, owner, 'a.md')
      const second = await put(group, member, 'a.md')
      const theirAgent = await agentOf(member, 'Member Agent')
      await asUser(outsider)
      expect(await fails('SELECT chat.workspace_clash_as($1,$2,$3)', [second.id, outsider, 'a.md'])).toMatch(/not found in a chat you are a member of/)
      await asUser(owner)
      expect(await fails('SELECT chat.workspace_clash_as($1,$2,$3)', [second.id, theirAgent, 'a.md'])).toMatch(/Not allowed to act as/)
      expect(await fails('SELECT chat.workspace_clash_as($1,$2,$3)', [second.id, agent, 'a.md']), '自己的 agent,可它不在这个群').toMatch(/not found in a chat you are a member of/)
      expect(await fails('SELECT chat.workspace_clash_as($1,$2,$3)', [randomUUID(), owner, 'a.md'])).toMatch(/not found in a chat you are a member of/)
      expect(await fails('SELECT chat.workspace_clash_as($1,$2,$3)', ['not-an-id', owner, 'a.md'])).toMatch(/not found in a chat you are a member of/)
      await asService()
      // 对照:同一个人在这个群里照样问得到。
      expect((await rpc<{ c: string }>(owner, 'SELECT chat.workspace_clash_as($1,$2,$3) AS c', [second.id, owner, 'a.md']))[0]!.c).toBe(first.id)
      // 私聊:人的上传直接插表,私聊里的 App 也走这条。
      const dm = randomUUID()
      await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'dm',NULL,$2)`, [dm, owner])
      await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member'),($1,$3,'member')`, [dm, owner, member])
      const d1 = await put(dm, owner, 'b.md')
      const d2 = await put(dm, member, 'b.md')
      expect((await rpc<{ c: string }>(member, 'SELECT chat.workspace_clash_as($1,$2,$3) AS c', [d2.id, member, 'b.md']))[0]!.c).toBe(d1.id)
    })

    it('按名字找:list_as 的精确模式(p_exact,复核追记 1 要改 A)按库存名字的规则比 —— 原样挑的名字(带肤色的 ZWJ、★ + VS16、NFD)找得到它那一行;不分大小写;不认子串;不给 p_exact 照旧是子串', async () => {
      const group = await newGroup(owner, [member])
      const box = await put(group, owner, 'Box', { kind: 'folder' })
      const person = await put(group, owner, '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}.md', { parent: box.id })
      const star = await put(group, owner, '\u2605\uFE0F.md', { parent: box.id })
      const cafe = await put(group, owner, 'caf\u00E9.md', { parent: box.id })
      const report = await put(group, owner, 'report.md', { parent: box.id })
      await put(group, owner, 'report-2.md', { parent: box.id })
      await put(group, owner, 'report.md')
      const exact = async (name: string) => (await rpc<{ id: string }>(owner,
        'SELECT id FROM chat.workspace_list_as($1,$2,p_name => $3,p_folder => $4,p_exact => true)', [group, owner, name, 'Box'])).map((row) => row.id)
      expect(await exact('\u{1F469}\u{1F3FD}\u200D\u{1F4BB}.md')).toEqual([person.id])
      expect(await exact('\u2605\uFE0F.md')).toEqual([star.id])
      expect(await exact('\u2605.md'), '★ 不带 VS16 是另一个名字').toEqual([])
      expect(await exact('cafe\u0301.md'), 'NFD').toEqual([cafe.id])
      expect(await exact(' REPORT.MD '), '不分大小写、首尾空白不算').toEqual([report.id])
      expect(await exact('report'), '不认子串').toEqual([])
      const fuzzy = await rpc<{ filename: string }>(owner,
        'SELECT filename FROM chat.workspace_list_as($1,$2,p_name => $3,p_folder => $4)', [group, owner, 'report', 'Box'])
      expect(sorted(fuzzy.map((row) => row.filename))).toEqual(['report-2.md', 'report.md'])
    })

    it('改名撞名报 workspace_name_taken(触发器;人与 agent 都经原地 move_as);只改大小写自己不算撞', async () => {
      const group = await newGroup(owner, [agent])
      const a = await put(group, owner, 'a.md')
      const b = await put(group, owner, 'b.md')
      expect(await fails('UPDATE chat.workspace_items SET filename = $1 WHERE id = $2', ['A.MD', b.id])).toMatch(/^这个文件夹里已经有「A\.MD」了 \| hint: workspace_name_taken \| code: 23505$/)
      await asUser(owner)
      expect(await fails('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)', [b.id, agent, 'a.md'])).toMatch(/workspace_name_taken/)
      expect(await fails('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)', [b.id, owner, 'a.md'])).toMatch(/workspace_name_taken/)
      // 对照:只改大小写;改成没人用的名字。
      await rpc(owner, 'SELECT id FROM chat.workspace_move_as($1,$2,NULL,$3)', [a.id, owner, 'A.md'])
      const renamed = await rpc<{ filename: string }>(owner, 'SELECT filename FROM chat.workspace_move_as($1,$2,NULL,$3)', [b.id, agent, 'c.md'])
      expect(renamed[0]!.filename).toBe('c.md')
      expect(await names(group)).toEqual(['A.md', 'c.md'])
    })

    it('留痕表只有服务端读得到', async () => {
      await asUser(owner)
      expect(await fails('SELECT * FROM chat.workspace_name_migrations')).toMatch(/permission denied/)
      await asService()
      await database.query('SELECT count(*) FROM chat.workspace_name_migrations')
    })
  })

  describe('「附件」系统文件夹', () => {
    it('只由服务端建;再要一次回同一个;不能改名、移动、删除(RPC、服务端直接改都拒);里面照常管', async () => {
      const group = await newGroup(owner, [agent])
      await asService()
      const { rows } = await database.query<{ id: string }>("SELECT chat.workspace_system_folder($1,'attachments') AS id", [group])
      const folder = rows[0]!.id
      expect((await database.query<{ id: string }>("SELECT chat.workspace_system_folder($1,'attachments') AS id", [group])).rows[0]!.id).toBe(folder)
      const listed = await rpc<{ filename: string; system_role: string; kind: string }>(owner,
        'SELECT filename, system_role, kind FROM chat.workspace_list_as($1,$2)', [group, owner])
      expect(listed).toEqual([{ filename: '附件', system_role: 'attachments', kind: 'folder' }])

      const other = await put(group, owner, 'Elsewhere', { kind: 'folder' })
      await asUser(owner)
      expect(await fails('SELECT chat.workspace_system_folder($1,$2)', [group, 'attachments'])).toMatch(/permission denied/)
      expect(await fails('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)', [folder, owner, 'Mine']))
        .toMatch(/^「附件」是系统文件夹,不能改名、移动或删除;里面的文件照常管 \| hint: workspace_system_folder/)
      expect(await fails('SELECT * FROM chat.workspace_delete_as($1,$2)', [folder, owner])).toMatch(/workspace_system_folder/)
      expect(await fails('SELECT * FROM chat.workspace_move_as($1,$2,$3)', [folder, agent, 'Elsewhere'])).toMatch(/workspace_system_folder/)
      await asService()
      expect(await fails('UPDATE chat.workspace_items SET filename = $1 WHERE id = $2', ['Mine', folder])).toMatch(/workspace_system_folder/)
      expect(await fails('UPDATE chat.workspace_items SET parent_id = $1 WHERE id = $2', [other.id, folder])).toMatch(/workspace_system_folder/)
      expect(await fails('DELETE FROM chat.workspace_items WHERE id = $1', [folder])).toMatch(/workspace_system_folder/)
      expect(await fails("UPDATE chat.workspace_items SET system_role = NULL WHERE id = $1", [folder])).toMatch(/workspace_system_folder/)
      expect(await exists(folder)).toBe(true)

      // 对照:里面照常放、照常删。
      const inside = await put(group, owner, 'shot.png', { parent: folder })
      expect(await rpc(owner, 'SELECT id FROM chat.workspace_delete_as($1,$2)', [inside.id, owner])).toEqual([{ id: inside.id }])
    })

    it('根上「附件」这个名字留给系统文件夹:成员的得「附件 (2)」,改名、挪成根上的「附件」报撞名;按路径「附件/…」写进系统那一个(复核 L11 要改 2)', async () => {
      const group = await newGroup(owner, [agent])
      // 系统文件夹建出来之前,成员先建一个叫「附件」(大小写、规范化都算)的文件夹:拿到的是「附件 (2)」。
      expect((await put(group, owner, ' 附件 ', { kind: 'folder' })).filename).toBe('附件 (2)')
      const box = await put(group, owner, 'Box', { kind: 'folder' })
      await asUser(owner)
      expect(await fails('SELECT * FROM chat.workspace_move_as($1,$2,NULL,$3)', [box.id, owner, '附件'])).toMatch(/hint: workspace_name_taken \| code: 23505$/)
      // 对照:子文件夹里叫「附件」可以;挪到根上就撞。
      const inner = await put(group, owner, '附件', { kind: 'folder', parent: box.id })
      expect(inner.filename).toBe('附件')
      await asUser(owner)
      expect(await fails('SELECT * FROM chat.workspace_move_as($1,$2,$3)', [inner.id, owner, ''])).toMatch(/hint: workspace_name_taken/)
      // agent 按路径写「附件/x.md」:系统文件夹由服务端建出来(名字就是「附件」),文件落在它里面,不是成员那个。
      const made = await rpc<{ path: string; parent_id: string }>(owner,
        'SELECT path, parent_id FROM chat.workspace_create_document_as($1,$2,$3,$4,p_folder => $5)', [group, agent, 'x.md', 'v', '附件'])
      await asService()
      const system = (await database.query<{ id: string; filename: string }>(
        "SELECT id, filename FROM chat.workspace_items WHERE chat_id = $1 AND system_role = 'attachments'", [group])).rows[0]!
      expect(system.filename).toBe('附件')
      expect(made).toEqual([{ path: '附件/x.md', parent_id: system.id }])
      const listed = await rpc<{ filename: string }>(owner, 'SELECT filename FROM chat.workspace_list_as($1,$2,p_folder => $3)', [group, agent, '附件'])
      expect(listed.map((row) => row.filename)).toEqual(['x.md'])
    })

    it('整个对话被删时,连同「附件」与文件夹里的一切删得干净', async () => {
      const group = await newGroup(owner, [member])
      await asService()
      const folder = (await database.query<{ id: string }>("SELECT chat.workspace_system_folder($1,'attachments') AS id", [group])).rows[0]!.id
      const inner = await put(group, owner, 'Inner', { kind: 'folder', parent: folder })
      await put(group, owner, 'x.md', { parent: inner.id })
      await asService()
      await database.query('DELETE FROM chat.chats WHERE id = $1', [group])
      expect((await database.query('SELECT 1 FROM chat.workspace_items WHERE chat_id = $1', [group])).rowCount).toBe(0)
    })

    it('约束:system_role 只认 attachments、只能在根上、只能是文件夹;一个对话只有一个', async () => {
      const group = await newGroup(owner, [member])
      await asService()
      const folder = (await database.query<{ id: string }>("SELECT chat.workspace_system_folder($1,'attachments') AS id", [group])).rows[0]!.id
      const insert = `INSERT INTO chat.workspace_items (chat_id, parent_id, kind, filename, content_type, created_by, system_role)
                      VALUES ($1,$2,$3,$4,'inode/directory',NULL,$5)`
      expect(await fails(insert, [group, null, 'folder', 'x', 'trash'])).toMatch(/workspace_items_system_role_chk/)
      expect(await fails(insert, [group, folder, 'folder', 'y', 'attachments'])).toMatch(/workspace_items_system_role_chk/)
      expect(await fails(insert, [group, null, 'document', 'z', 'attachments'])).toMatch(/workspace_items_folder_shape_chk/)
      expect(await fails(insert, [group, null, 'folder', 'w', 'attachments'])).toMatch(/workspace_items_system_role_key/)
      expect(await fails(`INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, inline_text, created_by)
                          VALUES ($1,'folder','v','inode/directory','body',$2)`, [group, owner])).toMatch(/workspace_items_folder_shape_chk/)
    })
  })

  describe('删除', () => {
    it('非空文件夹直接 DELETE(服务端)被拦下;空文件夹删得掉', async () => {
      const group = await newGroup(owner, [member])
      const full = await put(group, owner, 'Full', { kind: 'folder' })
      await put(group, owner, 'x.md', { parent: full.id })
      const empty = await put(group, owner, 'Empty', { kind: 'folder' })
      expect(await fails('DELETE FROM chat.workspace_items WHERE id = $1', [full.id])).toMatch(/^文件夹「Full」里还有东西[^|]*\| hint: workspace_folder_not_empty \| code: 23503$/)
      expect((await database.query('DELETE FROM chat.workspace_items WHERE id = $1', [empty.id])).rowCount).toBe(1)
      expect(await exists(full.id)).toBe(true)
    })

    it('不能借文件夹删别人的文件:别人的文件挪进我的文件夹,我(普通成员)整棵删 → 一项都不删', async () => {
      const group = await newGroup(owner, [member])
      const mine = await put(group, member, 'Mine', { kind: 'folder' })
      const theirs = await put(group, owner, 'their.md')
      await rpc(member, 'SELECT id FROM chat.workspace_move_as($1,$2,$3)', [theirs.id, member, mine.id])
      await asUser(member)
      expect(await fails('SELECT * FROM chat.workspace_delete_as($1,$2)', [mine.id, member])).toMatch(/^文件夹「Mine」里有 1 项不是你[^|]*什么都没删 \| hint: workspace_folder_not_yours/)
      expect(await exists(mine.id)).toBe(true)
      expect(await exists(theirs.id)).toBe(true)
      // 对照:文件的主人把它挪走以后,整棵删得掉。
      await rpc(owner, 'SELECT id FROM chat.workspace_move_as($1,$2,$3)', [theirs.id, owner, ''])
      expect((await rpc(member, 'SELECT id FROM chat.workspace_delete_as($1,$2)', [mine.id, member])).map((row) => row.id)).toEqual([mine.id])
    })

    it('整棵删:回被删的每一行;agent 删主人建的(6492 原样),人删自己 agent 建的;不是建的人删不了', async () => {
      const group = await newGroup(owner, [agent, member])
      const tree = await rpc<{ id: string }>(owner, 'SELECT id FROM chat.workspace_mkdir_as($1,$2,$3)', [group, owner, 'T/U'])
      const byAgent = await rpc<{ id: string }>(owner, 'SELECT id FROM chat.workspace_create_document_as($1,$2,$3,p_folder => $4)', [group, agent, 'n.md', 'T/U'])
      await asUser(member)
      expect(await fails('SELECT * FROM chat.workspace_delete_as($1,$2)', [byAgent[0]!.id, member])).toBe('「n.md」不是你(或你的 agent)建的,删不了 | hint: workspace_item_not_yours | code: 42501')
      const top = (await rpc<{ id: string; filename: string }>(owner, 'SELECT id, filename FROM chat.workspace_list_as($1,$2,p_folder => $3)', [group, owner, '']))
      const t = top.find((row) => row.filename === 'T')!
      await asUser(member)
      expect(await fails('SELECT * FROM chat.workspace_delete_as($1,$2)', [t.id, member])).toBe('「T」不是你(或你的 agent)建的,删不了 | hint: workspace_item_not_yours | code: 42501')
      const gone = await rpc<{ id: string }>(owner, 'SELECT id FROM chat.workspace_delete_as($1,$2)', [t.id, owner])
      expect(gone.map((row) => row.id).sort()).toEqual([t.id, tree[0]!.id, byAgent[0]!.id].sort())
      expect(await names(group)).toEqual([])

      const ownerMade = await put(group, owner, 'O', { kind: 'folder' })
      expect((await rpc(owner, 'SELECT id FROM chat.workspace_delete_as($1,$2)', [ownerMade.id, agent])).map((row) => row.id)).toEqual([ownerMade.id])
    })
  })

  describe('agent 那一侧的 RPC', () => {
    it('create 放进文件夹(缺的上级自动建,记在 agent 名下),回最终的名字与路径;mkdir 已有就回已有的;路径里有文件拒', async () => {
      const group = await newGroup(owner, [agent])
      const made = await rpc<{ filename: string; path: string; created_by: string }>(owner,
        'SELECT filename, path, created_by FROM chat.workspace_create_document_as($1,$2,$3,$4,p_folder => $5)', [group, agent, 'Plan.md', 'v1', '合同/2026'])
      expect(made).toEqual([{ filename: 'Plan.md', path: '合同/2026/Plan.md', created_by: agent }])
      const again = await rpc<{ filename: string; path: string }>(owner,
        'SELECT filename, path FROM chat.workspace_create_document_as($1,$2,$3,$4,p_folder => $5)', [group, agent, 'plan.md', 'v2', '合同/2026'])
      expect(again).toEqual([{ filename: 'plan (2).md', path: '合同/2026/plan (2).md' }])
      const folders = await rpc<{ path: string; created_by: string }>(owner,
        'SELECT path, created_by FROM chat.workspace_list_as($1,$2,p_kind => $3)', [group, agent, 'folder'])
      expect(folders.sort((a, b) => a.path.localeCompare(b.path))).toEqual([{ path: '合同', created_by: agent }, { path: '合同/2026', created_by: agent }])
      const twice = await rpc<{ path: string }>(owner, 'SELECT path FROM chat.workspace_mkdir_as($1,$2,$3)', [group, agent, '合同/2026'])
      expect(twice).toEqual([{ path: '合同/2026' }])
      await asUser(owner)
      expect(await fails('SELECT * FROM chat.workspace_mkdir_as($1,$2,$3)', [group, agent, '合同/2026/Plan.md/x'])).toMatch(/workspace_not_a_folder/)
      await asUser(outsider)
      expect(await fails('SELECT * FROM chat.workspace_mkdir_as($1,$2,$3)', [group, outsider, 'x'])).toMatch(/is not a chat you are a member of/)
    })

    it('move:换文件夹、可同时改名、到根;p_folder NULL = 只改名;撞名报 workspace_name_taken;版本冲突拒', async () => {
      const group = await newGroup(owner, [agent])
      const doc = await put(group, owner, 'a.md')
      const moved = await rpc<{ path: string; version: number }>(owner, 'SELECT path, version FROM chat.workspace_move_as($1,$2,$3)', [doc.id, agent, 'Box'])
      expect(moved).toEqual([{ path: 'Box/a.md', version: 2 }])
      const renamed = await rpc<{ path: string }>(owner, 'SELECT path FROM chat.workspace_move_as($1,$2,NULL,$3)', [doc.id, agent, 'b.md'])
      expect(renamed).toEqual([{ path: 'Box/b.md' }])
      const back = await rpc<{ path: string; parent_id: string | null }>(owner, 'SELECT path, parent_id FROM chat.workspace_move_as($1,$2,$3)', [doc.id, agent, ''])
      expect(back).toEqual([{ path: 'b.md', parent_id: null }])
      await put(group, owner, 'B.MD', { parent: (await rpc<{ id: string }>(owner, 'SELECT id FROM chat.workspace_mkdir_as($1,$2,$3)', [group, owner, 'Box']))[0]!.id })
      await asUser(owner)
      expect(await fails('SELECT * FROM chat.workspace_move_as($1,$2,$3)', [doc.id, agent, 'Box'])).toMatch(/workspace_name_taken/)
      await asUser(owner)
      expect(await fails('SELECT * FROM chat.workspace_move_as($1,$2,$3,NULL,$4)', [doc.id, agent, 'Other', 1])).toMatch(/version conflict: expected 1, got 4/)
    })

    it('已发出的旧调用照旧:list 只传两个参数拿到全部行(含文件夹),create 不带 p_folder 落在根上', async () => {
      const group = await newGroup(owner, [agent])
      await rpc(owner, 'SELECT * FROM chat.workspace_mkdir_as($1,$2,$3)', [group, agent, 'Box'])
      const created = await rpc<{ path: string; parent_id: string | null }>(owner,
        'SELECT path, parent_id FROM chat.workspace_create_document_as(p_chat_id => $1, p_as_user_id => $2, p_title => $3, p_content => $4)', [group, agent, 'old.md', 'x'])
      expect(created).toEqual([{ path: 'old.md', parent_id: null }])
      const old = await rpc<{ filename: string; total: string }>(owner,
        'SELECT filename, total FROM chat.workspace_list_as(p_chat_id => $1, p_as_user_id => $2)', [group, agent])
      expect(old.map((row) => row.filename).sort()).toEqual(['Box', 'old.md'])
      expect(Number(old[0]!.total)).toBe(2)
    })

    it('执行权:对外的 RPC 只给 authenticated;内部件谁都不给;系统文件夹只给 service_role', async () => {
      await asService()
      const { rows } = await database.query<{ fn: string; anon: boolean; auth: boolean; service: boolean }>(`
        SELECT p.oid::regprocedure::text AS fn,
               has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
               has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'chat' AND p.proname IN (
           'workspace_list_as','workspace_get_as','workspace_create_document_as','workspace_create_file_as','workspace_mkdir_as',
           'workspace_move_as','workspace_delete_as','workspace_place_item','workspace_name_taken','workspace_folder_for',
           'workspace_path_of','workspace_may_delete','workspace_lock_chat','workspace_clean_name','workspace_split_name',
           'workspace_fit_name','workspace_stored_name','workspace_items_place','workspace_items_guard_delete','workspace_system_folder',
           'workspace_clash_as')
         ORDER BY 1`)
      const by = Object.fromEntries(rows.map((row) => [row.fn.replace(/\(.*$/, ''), row]))
      for (const fn of ['workspace_list_as', 'workspace_get_as', 'workspace_create_document_as', 'workspace_create_file_as', 'workspace_mkdir_as', 'workspace_move_as', 'workspace_delete_as', 'workspace_clash_as']) {
        expect(by[`chat.${fn}`], fn).toMatchObject({ anon: false, auth: true })
      }
      for (const fn of ['workspace_place_item', 'workspace_name_taken', 'workspace_folder_for', 'workspace_path_of', 'workspace_may_delete', 'workspace_lock_chat',
        'workspace_clean_name', 'workspace_split_name', 'workspace_fit_name', 'workspace_stored_name', 'workspace_items_place', 'workspace_items_guard_delete']) {
        expect(by[`chat.${fn}`], fn).toMatchObject({ anon: false, auth: false })
      }
      expect(by['chat.workspace_system_folder']).toMatchObject({ anon: false, auth: false, service: true })
      // 每个函数只有一个签名(没有留下旧的重载)。
      expect(rows.filter((row) => row.fn.startsWith('chat.workspace_list_as('))).toHaveLength(1)
      expect(rows.filter((row) => row.fn.startsWith('chat.workspace_create_document_as('))).toHaveLength(1)
    })
  })
})

describe('并发(各自提交)', () => {
  let other: DatabaseClient
  let monitor: DatabaseClient
  let creator: string
  const groups: string[] = []

  beforeAll(async () => {
    other = new Client({ connectionString: databaseUrl })
    await other.connect()
    // Never switches role: a connection as authenticated cannot see other backends' waits.
    monitor = new Client({ connectionString: databaseUrl })
    await monitor.connect()
  })
  afterAll(async () => {
    // 只删这些对话(连同它们的条目);测试号留在用完即弃的库里。
    for (const group of groups) await database.query('DELETE FROM chat.chats WHERE id = $1', [group])
    await other.end()
    await monitor.end()
  })

  async function committedGroup(): Promise<string> {
    await database.query('BEGIN')
    creator = await human('Concurrent')
    const second = await human('Concurrent member')
    const group = await newGroup(creator, [second])
    await database.query('COMMIT')
    groups.push(group)
    return group
  }
  async function committedPut(group: string, filename: string, opts: { kind?: 'document' | 'folder'; parent?: string | null } = {}) {
    await database.query('BEGIN')
    const row = await put(group, creator, filename, opts)
    await database.query('COMMIT')
    return row
  }
  /**
   * Until the statement on backend `pid` settles, or the database says it waits on a lock: a fact, read on `monitor`
   * (never a wall clock — the second writer of a chat waits anyway, on the account revision rows, so «not settled after a
   * while» proves nothing; which lock it waits on does). The poll only sets how often it is read.
   */
  async function waitingOn(pid: number, pending: Promise<unknown>): Promise<string> {
    let state = 'pending'
    pending.then(() => (state = 'settled'), () => (state = 'failed'))
    for (;;) {
      if (state !== 'pending') return state
      const { rows } = await monitor.query<{ t: string | null; e: string | null }>(
        'SELECT wait_event_type AS t, wait_event AS e FROM pg_stat_activity WHERE pid = $1', [pid])
      if (rows[0]?.t === 'Lock') return `waiting on ${rows[0].e}`
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const pidOf = async (db: DatabaseClient) => (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid

  it('两条同名插入同时进同一个文件夹:后到的那条等在对话的锁上(advisory),拿到锁时看得见先到的,得到「 (2)」', async () => {
    const group = await committedGroup()
    const folder = await committedPut(group, 'Race', { kind: 'folder' })
    const insert = `INSERT INTO chat.workspace_items (chat_id, parent_id, kind, filename, content_type, inline_text, created_by)
                    VALUES ($1,$2,'document','race.png','image/png','',$3) RETURNING filename`
    const otherPid = await pidOf(other)
    await database.query('BEGIN')
    const first = (await database.query<{ filename: string }>(insert, [group, folder.id, creator])).rows[0]!.filename
    await other.query('BEGIN')
    const second = other.query<{ filename: string }>(insert, [group, folder.id, creator])
    expect(await waitingOn(otherPid, second)).toBe('waiting on advisory')
    await database.query('COMMIT')
    expect((await second).rows[0]!.filename).toBe('race (2).png')
    await other.query('COMMIT')
    expect(first).toBe('race.png')
  })

  it('两个人同时互挪(A 进 B 的子文件夹、B 进 A 的子文件夹):后到的那条等在对话的锁上,拿到锁后被拒,树还挂在根上(复核 L11 要改 1)', async () => {
    const group = await committedGroup()
    const a = await committedPut(group, 'A', { kind: 'folder' })
    const b = await committedPut(group, 'B', { kind: 'folder' })
    const a1 = await committedPut(group, 'A1', { kind: 'folder', parent: a.id })
    const b1 = await committedPut(group, 'B1', { kind: 'folder', parent: b.id })
    await committedPut(group, 'in-a1.md', { parent: a1.id })
    const move = 'UPDATE chat.workspace_items SET parent_id = $1 WHERE id = $2'
    const otherPid = await pidOf(other)
    await database.query('BEGIN')
    await database.query(move, [b1.id, a.id]) // A into B1
    await other.query('BEGIN')
    let refused = ''
    const second = other.query(move, [a1.id, b.id]).catch((error: Error & { hint?: string }) => {
      refused = `${error.message} | hint: ${error.hint ?? ''}`
    }) // B into A1
    expect(await waitingOn(otherPid, second)).toBe('waiting on advisory')
    await database.query('COMMIT')
    await second
    expect(refused).toMatch(/^不能把文件夹放进它自己里面 \| hint: workspace_bad_parent$/)
    await other.query('ROLLBACK')
    // Everything still hangs from the top, each with its path.
    await database.query('BEGIN')
    const listed = (await rpc<{ path: string }>(creator, 'SELECT path FROM chat.workspace_list_as($1,$2)', [group, creator])).map((row) => row.path).sort()
    await database.query('ROLLBACK')
    expect(listed).toEqual(['B', 'B/B1', 'B/B1/A', 'B/B1/A/A1', 'B/B1/A/A1/in-a1.md'])
  })
})
