import { createFixtureGroup } from '../../support/groupFixture'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 字节按内容只存一份(迁移 20261016104500;gugu-base notes/2026-10-15-attachments-into-folder/设计.md §3.1):
 *   · 带 pointer 写进来的条目 / 历史(App 直接插、agent 的 create_file_as、replace_file_as)都记上那个 pointer 的 'workspace' blob,
 *     同一个 pointer 一行;客户端写不了 blob_id,三张新表谁也不能直接读写;
 *   · chat.file_blob_register(只给 service_role):新内容建一行 'oss' blob(路径 u/<上传者>/<哈希>)并登记这次上传,同一个人的同内容复用;
 *   · 回收:失去最后一个引用才进队列,24 小时以后才领;领的时候再核一次,还有人用就出队;领走的标 deleting,
 *     这期间谁也用不上它(HINT file_blob_deleting);完成删掉 blob 行,失败退避,租约过期收回;
 *   · 过期的上传登记由 chat.file_blob_sweep 清,注销账号时随人删掉,它们的 blob 进回收队列。
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
let agent: string

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asServiceRole() {
  await database.query('SET LOCAL role TO service_role')
}
async function asOwner() {
  await database.query('RESET role')
}
/** The refusal as one line: message | hint | SQLSTATE. */
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
async function human(name: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@file-blobs.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'file-blobs fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id)
    VALUES ($1,'agent',$2,$3,true,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}
async function newGroup(creator: string, initial: string[]): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await createFixtureGroup(database, [
    id, 'File blobs', creator, JSON.stringify(initial.map((user_id) => ({ user_id, role: 'member' }))),
  ])
  await asOwner()
  return id
}
/** An object in the workspace bucket (its uploader the path's second part): its pointer. */
async function object(chatId: string, by: string, name = 'deck.pptx'): Promise<string> {
  const pointer = `${chatId}/${by}/${randomUUID()}-${name}`
  await asOwner()
  await database.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('workspace',$1)`, [pointer])
  return pointer
}
/** A binary in the folder, made by `by`: the object in the bucket, then the row pointing at it (written directly, as the server). */
async function binary(chatId: string, by: string): Promise<{ id: string; pointer: string }> {
  const pointer = await object(chatId, by)
  await asOwner()
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, blob_id, size_bytes, source_message_ids, created_by, version)
     VALUES ($1,'file','deck.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation',chat.file_blob_for_pointer($2,100,'application/vnd.openxmlformats-officedocument.presentationml.presentation',$3),100,'{}',$3,1) RETURNING id`,
    [chatId, pointer, by],
  )
  await asOwner()
  return { id: rows[0]!.id, pointer }
}
type Blob = { id: string; bucket_id: string; object_name: string; sha256: string | null; size_bytes: string | null; content_type: string; state: string; created_by: string | null }
async function blobOf(where: string, values: unknown[]): Promise<Blob[]> {
  await asOwner()
  return (await database.query<Blob>(`SELECT id, bucket_id, object_name, sha256, size_bytes, content_type, state, created_by FROM chat.file_blobs WHERE ${where}`, values)).rows
}
async function itemBlob(itemId: string): Promise<string | null> {
  await asOwner()
  return (await database.query<{ blob_id: string | null }>('SELECT blob_id FROM chat.workspace_items WHERE id = $1', [itemId])).rows[0]!.blob_id
}
async function queued(blobId: string): Promise<{ status: string; due_in_s: number; attempt_count: number } | null> {
  await asOwner()
  return (await database.query<{ status: string; due_in_s: number; attempt_count: number }>(
    `SELECT status, round(extract(epoch FROM next_attempt_at - now()))::int AS due_in_s, attempt_count FROM chat.file_blob_gc WHERE blob_id = $1`, [blobId])).rows[0] ?? null
}
async function due(blobId: string) {
  await asOwner()
  await database.query(`UPDATE chat.file_blob_gc SET next_attempt_at = now() - interval '1 second' WHERE blob_id = $1`, [blobId])
}
type Claimed = { blob_id: string; claim_token: string; bucket_id: string; object_name: string; attempt_count: number }
async function claim(stale = 600): Promise<Claimed[]> {
  // 回收队列全库共享:并发用例(messageFileRefsConcurrency)提交的到期行拿着这把锁的时候才存在,领之前排它后面。
  await database.query(`SELECT pg_advisory_xact_lock(hashtextextended('tests:file_blob_gc', 0))`)
  await asServiceRole()
  const { rows } = await database.query<Claimed>('SELECT * FROM chat.file_blob_gc_claim(50, $1)', [stale])
  await asOwner()
  return rows
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const staging = (uploader: string) => `staging/${uploader}/${randomUUID()}`
type Registered = { blob_id: string; object_name: string; created: boolean }
async function register(uploader: string, key: string, digest: string, size = 1234, type = 'image/png'): Promise<Registered> {
  await asServiceRole()
  const { rows } = await database.query<Registered>('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5,$6,$7)', [uploader, key, digest, size, type, 640, 480])
  await asOwner()
  return rows[0]!
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('fileBlobs.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner')
  member = await human('Member')
  agent = await agentOf(owner, 'Owner Agent')
})
afterEach(async () => {
  if (!database) return
  try {
    await asOwner()
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('条目和历史记它用的 blob', () => {
  it('带 pointer 写进来的行都指着那个 pointer 的 workspace blob:create_file_as、replace_file_as 的两版;同一个 pointer 一行;活文档没有', async () => {
    const group = await newGroup(owner, [member, agent])
    const file = await binary(group, member)
    const [first] = await blobOf('bucket_id = $1 AND object_name = $2', ['workspace', file.pointer])
    expect(first).toMatchObject({ bucket_id: 'workspace', sha256: null, size_bytes: '100', state: 'live', created_by: member,
      content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
    expect(await itemBlob(file.id)).toBe(first!.id)

    // replace_file_as:条目指新 pointer 的 blob,历史两版各指各的;旧 pointer 仍是那一行。
    const next = await object(group, owner)
    await asUser(owner)
    await database.query('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,$4,NULL,NULL)', [file.id, owner, next, 2])
    const [second] = await blobOf('bucket_id = $1 AND object_name = $2', ['workspace', next])
    expect(second).toMatchObject({ size_bytes: '2', created_by: owner })
    expect(await itemBlob(file.id)).toBe(second!.id)
    await asOwner()
    const versions = (await database.query<{ n: number; blob_id: string }>(
      'SELECT n, blob_id FROM chat.workspace_item_versions WHERE item_id = $1 ORDER BY n', [file.id])).rows
    expect(versions).toEqual([{ n: 1, blob_id: first!.id }, { n: 2, blob_id: second!.id }])
    expect(await blobOf('object_name = $1', [file.pointer])).toHaveLength(1)

    // agent 登记一个已经传进桶的文件:blob 记在 agent 名下。
    const agents = await object(group, owner, 'agent.bin')
    await asUser(owner)
    const [made] = (await database.query<{ id: string }>(
      'SELECT id FROM chat.workspace_create_file_as($1,$2,$3,$4,$5,$6)', [group, agent, 'agent.bin', 'application/octet-stream', 7, agents])).rows
    const [agentBlob] = await blobOf('object_name = $1', [agents])
    expect(agentBlob).toMatchObject({ created_by: agent, size_bytes: '7' })
    expect(await itemBlob(made!.id)).toBe(agentBlob!.id)

    // 对照:活文档没有 blob。
    await asUser(owner)
    const [doc] = (await database.query<{ id: string }>(
      'SELECT id FROM chat.workspace_create_document_as($1,$2,$3,$4)', [group, owner, 'notes.md', 'body'])).rows
    expect(await itemBlob(doc!.id)).toBeNull()
  })

  it('pointer 只由 blob 推:两张表没有 pointer 列,门回的 pointer = blob 在 workspace 桶里的对象名;登记桶里没有的对象被拒', async () => {
    const group = await newGroup(owner, [member, agent])
    await asOwner()
    expect((await database.query(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = 'chat' AND column_name = 'pointer'
          AND table_name IN ('workspace_items', 'workspace_item_versions')`)).rows).toEqual([])
    const file = await binary(group, member)
    await asUser(member)
    expect((await database.query<{ pointer: string | null }>('SELECT pointer FROM chat.workspace_get_as($1,$2)', [file.id, member])).rows)
      .toEqual([{ pointer: file.pointer }])
    // 对照:对象在桶里就登记得上(上一条);不在就拒,条目和 blob 都没有。
    const missing = `${group}/${owner}/${randomUUID()}-missing.bin`
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_create_file_as($1,$2,$3,$4,$5,$6)', [group, agent, 'missing.bin', 'application/octet-stream', 7, missing]))
      .toMatch(/workspace storage reference target does not exist/)
    expect(await blobOf('object_name = $1', [missing])).toEqual([])
  })

  it('客户端写不了 blob_id;三张新表谁也不能直接读写,service_role 也不行(只经函数)', async () => {
    const group = await newGroup(owner, [member])
    const file = await binary(group, owner)
    const other = await binary(group, owner)
    const blob = await itemBlob(other.id)
    await asUser(owner)
    expect(await fails('UPDATE chat.workspace_items SET blob_id = $1 WHERE id = $2', [blob, file.id])).toMatch(/permission denied/)
    expect(await fails(
      `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, inline_text, size_bytes, source_message_ids, created_by, version, blob_id)
       VALUES ($1,'document','x.md','text/markdown','x',1,'{}',$2,1,$3)`, [group, owner, blob])).toMatch(/permission denied/)
    for (const table of ['chat.file_blobs', 'chat.file_blob_uploads', 'chat.file_blob_gc']) {
      expect(await fails(`SELECT 1 FROM ${table} LIMIT 1`), table).toMatch(/permission denied/)
    }
    await asServiceRole()
    for (const table of ['chat.file_blobs', 'chat.file_blob_uploads', 'chat.file_blob_gc']) {
      expect(await fails(`SELECT 1 FROM ${table} LIMIT 1`), `service_role: ${table}`).toMatch(/permission denied/)
    }
    await asOwner()
    // 对照:成员照样读得到条目上的 blob_id(只是一个 id)。
    await asUser(owner)
    expect((await database.query<{ blob_id: string }>('SELECT blob_id FROM chat.workspace_items WHERE id = $1', [other.id])).rows[0]!.blob_id).toBe(blob)
    await asOwner()
  })
})

describe('上传登记(chat.file_blob_register,只给 service_role)', () => {
  it('新内容建一行 oss blob(路径 = u/上传者/哈希)并登记;同一个人再传同样的内容复用这一行;别人传同样的内容得到自己的一行;同一个暂存对象再登记一次回同一行', async () => {
    const digest = sha(`png-${randomUUID()}`)
    const mine = staging(owner)
    const made = await register(owner, mine, digest)
    expect(made).toMatchObject({ object_name: `u/${owner}/${digest}`, created: true })
    expect(await blobOf('id = $1', [made.blob_id])).toEqual([expect.objectContaining({ bucket_id: 'oss', sha256: digest, size_bytes: '1234', content_type: 'image/png', created_by: owner })])
    expect(await register(owner, mine, digest), '重试:同一个 blob,这一次没新建').toEqual({ ...made, created: false })
    expect(await register(owner, staging(owner), digest), '同一个人另一次上传:复用自己的 blob').toEqual({ ...made, created: false })
    const theirs = await register(member, staging(member), digest.toUpperCase())
    expect(theirs).toEqual({ blob_id: expect.any(String), object_name: `u/${member}/${digest}`, created: true })
    expect(theirs.blob_id).not.toBe(made.blob_id)
    expect(await blobOf('id = $1', [theirs.blob_id])).toEqual([expect.objectContaining({ bucket_id: 'oss', sha256: digest, created_by: member })])
    await asOwner()
    const uploads = (await database.query<{ uploader: string; blob_id: string; minutes: number }>(
      `SELECT uploader, blob_id, round(extract(epoch FROM expires_at - now()) / 60)::int AS minutes FROM chat.file_blob_uploads WHERE blob_id = ANY($1::uuid[]) ORDER BY uploader = $2 DESC`,
      [[made.blob_id, theirs.blob_id], owner])).rows
    expect(uploads).toEqual([
      { uploader: owner, blob_id: made.blob_id, minutes: 60 }, { uploader: owner, blob_id: made.blob_id, minutes: 60 },
      { uploader: member, blob_id: theirs.blob_id, minutes: 60 },
    ])
  })

  it('rejects invalid hash, empty bytes, foreign staging and changed replay identity; configured upload permits own the size ceiling', async () => {
    const digest = sha(`x-${randomUUID()}`)
    await asServiceRole()
    const call = 'SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)'
    expect(await fails(call, [owner, staging(owner), 'abc', 10, 'image/png'])).toMatch(/64 hex digits/)
    // The public configured permit enforces the ceiling (fileTransferPolicy.test.ts); internal registration supports larger files.
    expect((await database.query(call, [owner, staging(owner), sha(`over-25-${randomUUID()}`), 26214401, 'image/png'])).rows[0]).toMatchObject({created:true})
    expect(await fails(call, [owner, staging(owner), digest, 0, 'image/png'])).toMatch(/hint: file_too_large/)
    expect(await fails(call, [owner, staging(member), digest, 10, 'image/png'])).toMatch(/file_blob_uploads_own_key/)
    expect(await fails(call, [owner, `staging/${owner}/not-a-uuid`, digest, 10, 'image/png'])).toMatch(/file_blob_uploads_staging_key_check/)
    const key = staging(owner)
    await asOwner()
    await register(owner, key, digest, 10)
    await asServiceRole()
    expect(await fails(call, [owner, key, sha('other'), 10, 'image/png'])).toMatch(/already registered for other content/)
    // 对照:正好 25 MiB 收下。
    await asOwner()
    expect((await register(owner, staging(owner), sha(`big-${randomUUID()}`), 26214400)).created).toBe(true)
    await asUser(owner)
    expect(await fails(call, [owner, staging(owner), sha('y'), 10, 'image/png'])).toMatch(/permission denied/)
    await asOwner()
  })
})

describe('回收', () => {
  it('删了文件:它的 blob 进队列,24 小时以后才领;领走标 deleting、发租约;报完成删掉 blob 行和队列那一行', async () => {
    const group = await newGroup(owner, [member])
    const file = await binary(group, owner)
    const blob = (await itemBlob(file.id))!
    expect(await queued(blob), '还有人用:不进队列').toBeNull()
    await asUser(owner)
    await database.query('SELECT id FROM chat.workspace_delete_as($1,$2)', [file.id, owner])
    await asOwner()
    expect(await queued(blob)).toMatchObject({ status: 'pending', due_in_s: 86400, attempt_count: 0 })
    expect(await claim(), '还没到时间').toEqual([])
    await due(blob)
    const [taken] = await claim()
    expect(taken).toMatchObject({ blob_id: blob, bucket_id: 'workspace', object_name: file.pointer, attempt_count: 1 })
    expect((await blobOf('id = $1', [blob]))[0]!.state).toBe('deleting')
    expect(await claim(), '已经领走的不再领').toEqual([])
    await asServiceRole()
    expect(await fails('SELECT chat.file_blob_gc_finish($1,$2)', [blob, randomUUID()])).toMatch(/lease .* is stale/)
    await database.query('SELECT chat.file_blob_gc_finish($1,$2)', [blob, taken!.claim_token])
    await asOwner()
    expect(await blobOf('id = $1', [blob])).toEqual([])
    expect(await queued(blob)).toBeNull()
  })

  it('领的时候再核一次:还有人用(历史还指着、另一行还指着同一个 pointer)就出队,blob 照旧 live', async () => {
    const group = await newGroup(owner, [member])
    const file = await binary(group, owner)
    const old = (await itemBlob(file.id))!
    await asUser(owner)
    await database.query('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,$4,NULL,NULL)', [file.id, owner, await object(group, owner), 2])
    await asOwner()
    // 条目换了内容:旧 blob 失去了条目这个引用,进队列;历史第 1 版还指着它。
    expect(await queued(old)).toMatchObject({ status: 'pending' })
    await due(old)
    expect(await claim()).toEqual([])
    expect(await queued(old), '还有人用:出队').toBeNull()
    expect((await blobOf('id = $1', [old]))[0]!.state).toBe('live')
  })

  it('失败退避、blob 仍是 deleting;租约过期收回重领,旧租约报不了完成', async () => {
    const group = await newGroup(owner, [member])
    const file = await binary(group, owner)
    const blob = (await itemBlob(file.id))!
    await asUser(owner)
    await database.query('SELECT id FROM chat.workspace_delete_as($1,$2)', [file.id, owner])
    await due(blob)
    const [first] = await claim()
    await asServiceRole()
    await database.query('SELECT chat.file_blob_gc_fail($1,$2,$3)', [blob, first!.claim_token, 'oss 503'])
    await asOwner()
    expect(await queued(blob)).toMatchObject({ status: 'failed', due_in_s: 10, attempt_count: 1 })
    expect((await blobOf('id = $1', [blob]))[0]!.state).toBe('deleting')
    await due(blob)
    const [second] = await claim()
    expect(second).toMatchObject({ blob_id: blob, attempt_count: 2 })
    // 调用者死了:租约过期(这里把领的时间往前拨),下一次领收回它、换新租约。
    await database.query(`UPDATE chat.file_blob_gc SET claimed_at = now() - interval '1 hour' WHERE blob_id = $1`, [blob])
    const [third] = await claim(30)
    expect(third).toMatchObject({ blob_id: blob, attempt_count: 3 })
    expect(third!.claim_token).not.toBe(second!.claim_token)
    await asServiceRole()
    expect(await fails('SELECT chat.file_blob_gc_finish($1,$2)', [blob, second!.claim_token])).toMatch(/lease .* is stale/)
    await database.query('SELECT chat.file_blob_gc_finish($1,$2)', [blob, third!.claim_token])
    await asOwner()
    expect(await blobOf('id = $1', [blob])).toEqual([])
  })

  it('deleting 的 blob 谁也用不上:同一个人登记同样的内容、带同一个 pointer 写进来,都拒(HINT file_blob_deleting);别人的同样内容是自己的 blob;对照:live 的照常复用', async () => {
    const group = await newGroup(owner, [member, agent])
    // OSS:登记过、上传登记过期清掉以后被领走。
    const digest = sha(`gone-${randomUUID()}`)
    const made = await register(owner, staging(owner), digest)
    await database.query(`UPDATE chat.file_blob_uploads SET expires_at = now() - interval '1 second' WHERE blob_id = $1`, [made.blob_id])
    await asServiceRole()
    expect((await database.query<{ n: number }>('SELECT chat.file_blob_sweep() AS n')).rows[0]!.n).toBe(1)
    await asOwner()
    await due(made.blob_id)
    expect((await claim()).map((c) => c.blob_id)).toEqual([made.blob_id])
    await asServiceRole()
    expect(await fails('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)', [owner, staging(owner), digest, 1234, 'image/png']))
      .toMatch(/is being collected.*hint: file_blob_deleting \| code: 55000/)
    await asOwner()
    // 别人传同样的字节:放在自己名下,和正在回收的那一行无关。
    expect(await register(member, staging(member), digest)).toMatchObject({ object_name: `u/${member}/${digest}`, created: true })
    // workspace:文件删了、blob 被领走,这时又有人拿同一个 pointer 登记。
    const file = await binary(group, owner)
    const blob = (await itemBlob(file.id))!
    await asUser(owner)
    await database.query('SELECT id FROM chat.workspace_delete_as($1,$2)', [file.id, owner])
    await due(blob)
    await claim()
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.workspace_create_file_as($1,$2,$3,$4,$5,$6)', [group, agent, 'again.bin', 'application/octet-stream', 1, file.pointer]))
      .toMatch(/hint: file_blob_deleting/)
    await asOwner()
    // 对照:live 的同内容(同一个人)照常复用。
    const live = sha(`live-${randomUUID()}`)
    const a = await register(owner, staging(owner), live)
    expect(await register(owner, staging(owner), live)).toMatchObject({ blob_id: a.blob_id, created: false })
  })

  it('过期的上传登记由 sweep 清掉、blob 进队列;没过期的护着它的 blob;注销账号时登记随人删掉,blob 的作者清空', async () => {
    const stale = await register(owner, staging(owner), sha(`stale-${randomUUID()}`))
    const fresh = await register(owner, staging(owner), sha(`fresh-${randomUUID()}`))
    await database.query(`UPDATE chat.file_blob_uploads SET expires_at = now() - interval '1 second' WHERE blob_id = $1`, [stale.blob_id])
    await asServiceRole()
    expect((await database.query<{ n: number }>('SELECT chat.file_blob_sweep() AS n')).rows[0]!.n).toBe(1)
    await asOwner()
    expect(await queued(stale.blob_id)).toMatchObject({ status: 'pending' })
    expect(await queued(fresh.blob_id)).toBeNull()
    // 没过期的登记护着它:就算排进了队列也到了时间,领的时候核出有人用。
    await database.query('SELECT chat.file_blob_enqueue($1)', [fresh.blob_id])
    await due(fresh.blob_id)
    await due(stale.blob_id)
    expect((await claim()).map((c) => c.blob_id)).toEqual([stale.blob_id])
    expect(await queued(fresh.blob_id)).toBeNull()

    // 注销:上传登记随人删掉(外键 CASCADE),blob 进队列;blob 的作者清空。
    const gone = await register(member, staging(member), sha(`erased-${randomUUID()}`))
    await database.query('DELETE FROM auth.users WHERE id = $1::uuid', [member])
    expect((await database.query('SELECT 1 FROM chat.file_blob_uploads WHERE uploader = $1', [member])).rowCount).toBe(0)
    expect(await queued(gone.blob_id)).toMatchObject({ status: 'pending' })
    expect((await blobOf('id = $1', [gone.blob_id]))[0]!.created_by).toBeNull()
  })
})

// 收尾单 (a)(*_blob_in_use_one_answer):「这份字节还有人用吗」按 blob 判 —— workspace 桶的删除策略、注销 / 回收用的那个,
// 都落到 file_blob_in_use 上;中间那个重复的谓词删了。
describe('有没有人用,按 blob 判', () => {
  it('pointer 的 blob 还被没过期的上传登记护着:条目删了也算在用(删除策略、注销都不删字节);登记过期就没人用了', async () => {
    const group = await newGroup(owner, [member])
    const { id, pointer } = await binary(group, owner)
    const blob = (await itemBlob(id))!
    const inUse = async () => {
      await asOwner()
      return (await database.query<{ p: boolean; s: boolean }>(
        `SELECT chat.workspace_pointer_in_use($1) AS p, identity.storage_object_is_referenced('workspace', $1) AS s`, [pointer])).rows[0]!
    }
    expect(await inUse()).toEqual({ p: true, s: true })
    const key = staging(owner)
    await database.query('INSERT INTO chat.file_blob_uploads (staging_key, uploader, blob_id) VALUES ($1, $2, $3)', [key, owner, blob])
    await database.query('DELETE FROM chat.workspace_items WHERE id = $1', [id])
    expect(await inUse(), 'the item is gone, an upload registration still holds its bytes').toEqual({ p: true, s: true })
    await database.query(`UPDATE chat.file_blob_uploads SET expires_at = now() - interval '1 second' WHERE staging_key = $1`, [key])
    expect(await inUse()).toEqual({ p: false, s: false })
    expect((await database.query<{ f: string | null }>(`SELECT to_regprocedure('chat.storage_object_blob_referenced(text,text)') AS f`)).rows[0]!.f).toBeNull()
  })

  it('从没登记成 blob 的对象(群头像):只剩老式引用那一支;对照:没人指着就没人用', async () => {
    const group = await newGroup(owner, [member])
    const avatar = `${owner}/group-avatar/${randomUUID()}.png`
    await asOwner()
    await database.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('chat-media', $1)`, [avatar])
    const referenced = async () => (await database.query<{ s: boolean }>(`SELECT identity.storage_object_is_referenced('chat-media', $1) AS s`, [avatar])).rows[0]!.s
    expect(await referenced()).toBe(false)
    await database.query('UPDATE chat.chats SET avatar_url = $1, avatar_storage_bucket_id = $2, avatar_storage_object_name = $3 WHERE id = $4',
      [`http://127.0.0.1:54321/storage/v1/object/public/chat-media/${avatar}`, 'chat-media', avatar, group])
    expect(await referenced()).toBe(true)
  })
})

describe('执行权与定时', () => {
  it('register / gc 三件 / sweep 只给 service_role;内部件谁都不给', async () => {
    await asOwner()
    const { rows } = await database.query<{ fn: string; anon: boolean; auth: boolean; service: boolean }>(`
      SELECT p.proname AS fn,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'chat' AND p.proname IN (
         'file_blob_register','file_blob_gc_claim','file_blob_gc_finish','file_blob_gc_fail','file_blob_sweep',
         'file_blob_take','file_blob_for_pointer','file_blob_pointer','file_blob_in_use','file_blob_enqueue','file_blob_lost_reference',
         'workspace_pointer_in_use')
       ORDER BY 1`)
    const by = Object.fromEntries(rows.map((row) => [row.fn, row]))
    expect(Object.keys(by)).toHaveLength(12)
    // 桶的删除策略以调用者的身份叫它:照旧给 authenticated。
    expect(by.workspace_pointer_in_use).toMatchObject({ anon: false, auth: true })
    for (const fn of ['file_blob_register', 'file_blob_gc_claim', 'file_blob_gc_finish', 'file_blob_gc_fail', 'file_blob_sweep']) {
      expect(by[fn], fn).toMatchObject({ anon: false, auth: false, service: true })
    }
    for (const fn of ['file_blob_take', 'file_blob_for_pointer', 'file_blob_pointer', 'file_blob_in_use', 'file_blob_enqueue', 'file_blob_lost_reference']) {
      expect(by[fn], fn).toMatchObject({ anon: false, auth: false, service: false })
    }
  })

  it('过期登记的清扫在 pg_cron 里,每 10 分钟一次(本库是 pg_cron 调度的那个库时)', async () => {
    await asOwner()
    const cronDb = (await database.query<{ db: string | null }>(`SELECT current_setting('cron.database_name', true) AS db`)).rows[0]!.db
    const here = (await database.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db
    if (cronDb !== here) return
    const { rows } = await database.query<{ schedule: string; command: string }>(`SELECT schedule, command FROM cron.job WHERE jobname = 'file-blob-upload-sweep'`)
    expect(rows).toEqual([{ schedule: '*/10 * * * *', command: 'SELECT chat.file_blob_sweep()' }])
  })
})
