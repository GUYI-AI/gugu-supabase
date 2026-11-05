import { createFixtureGroup } from '../../support/groupFixture'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 消息指向文件夹里那个条目的那一版(迁移 20261016105500;设计 §3.2–§3.5、§7):
 *   · chat.attachment_commit:消费调用者自己的上传登记,在「附件」里建或复用条目(同会话、同内容、同一系列的名字),
 *     以调用者的身份发一条附件消息(file_item_id、发出时那一版、没有 [URL] 的信封);一个事务,发不出去什么都不留;重试回同一条;
 *   · 消息上的核:条目在这条消息自己的会话里、是文件、正文是那一版的信封;发出去以后不能改指向;删文件留墓碑;
 *   · 修剪跳过被消息钉住的版本;chat.attachment_forward 在目标会话建指向同一个 blob 的条目;
 *   · chat.file_urls_as 只回调用者(或它自己的 agent)是成员的那些;'ai' 会话也有「附件」;
 *   · send_message_idempotent 多三个可选参数,已经发出去的客户端照旧调得通。
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
async function asServiceRole() {
  await database.query('SET LOCAL role TO service_role')
}
async function asOwner() {
  await database.query('RESET role')
}
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
  [id, `${id}@message-file-refs.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'message-file-refs fixture','fixture','darwin')`, [`dev-${id}`, id])
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
    id, 'Message file refs', creator, JSON.stringify(initial.map((user_id) => ({ user_id, role: 'member' }))),
  ])
  await asOwner()
  return id
}
/** A chat of another kind ('ai', 'dm'), or a group whose members are put in directly, as the server does. */
async function chatOf(kind: 'ai' | 'dm' | 'group', members: string[]): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,$2,NULL,$3)`, [id, kind, members[0]])
  // A group needs its one human owner (a deferred check): the first one.
  for (const [i, user] of members.entries()) {
    await database.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,$3)`, [id, user, kind === 'group' && i === 0 ? 'owner' : 'member'])
  }
  return id
}
async function object(chatId: string, by: string, name = 'deck.pptx'): Promise<string> {
  const pointer = `${chatId}/${by}/${randomUUID()}-${name}`
  await asOwner()
  await database.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('workspace',$1)`, [pointer])
  return pointer
}
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
/** A binary made by `by` (a pointer, a 'workspace' blob; written directly, as the server): its item. */
async function binary(chatId: string, by: string): Promise<string> {
  const pointer = await object(chatId, by)
  await asOwner()
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, blob_id, size_bytes, source_message_ids, created_by, version)
     VALUES ($1,'file','deck.pptx',$2,chat.file_blob_for_pointer($3,100,$2,$4),100,'{}',$4,1) RETURNING id`, [chatId, PPTX, pointer, by])
  await asOwner()
  return rows[0]!.id
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
/** What the attachments function does once it has read the bytes: an upload registered for `by` (service_role). */
async function upload(by: string, content: string, type = 'image/png', size = 1234): Promise<{ key: string; blob: string }> {
  const key = `staging/${by}/${randomUUID()}`
  await asServiceRole()
  const { rows } = await database.query<{ blob_id: string }>('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5,$6,$7)', [by, key, sha(content), size, type, 640, 480])
  await asOwner()
  return { key, blob: rows[0]!.blob_id }
}
type Message = { id: string; chat_id: string; sender_user_id: string; content: string; content_type: string; file_item_id: string | null; file_version: number | null; forwarded_from_message_id: string | null }
const COMMIT = 'SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,$7,NULL,$8)'
async function commit(caller: string, key: string, messageId: string, chatId: string, sender: string, name: string, opts: { to?: string[]; whisper?: boolean; caption?: string } = {}): Promise<Message> {
  await asUser(caller)
  const { rows } = await database.query<Message>(COMMIT, [key, messageId, chatId, sender, name, opts.to ?? [], opts.whisper ?? false, opts.caption ?? null])
  await asOwner()
  return rows[0]!
}
type Item = { id: string; chat_id: string; parent_id: string | null; filename: string; kind: string; blob_id: string | null; pointer: string | null; created_by: string; source_message_ids: string[]; version: number; size_bytes: string; content_type: string }
async function item(id: string): Promise<Item> {
  await asOwner()
  return (await database.query<Item>('SELECT id, chat_id, parent_id, filename, kind, blob_id, chat.file_blob_pointer(blob_id) AS pointer, created_by, source_message_ids, version, size_bytes, content_type FROM chat.workspace_items WHERE id = $1', [id])).rows[0]!
}
async function attachmentsFolder(chatId: string): Promise<string | null> {
  await asOwner()
  return (await database.query<{ id: string }>(`SELECT id FROM chat.workspace_items WHERE chat_id = $1 AND system_role = 'attachments'`, [chatId])).rows[0]?.id ?? null
}
async function inAttachments(chatId: string): Promise<string[]> {
  const folder = await attachmentsFolder(chatId)
  if (!folder) return []
  return (await database.query<{ filename: string }>('SELECT filename FROM chat.workspace_items WHERE parent_id = $1 ORDER BY filename', [folder])).rows.map((r) => r.filename)
}
async function consumed(key: string): Promise<string | null> {
  await asOwner()
  return (await database.query<{ message_id: string | null }>('SELECT message_id FROM chat.file_blob_uploads WHERE staging_key = $1', [key])).rows[0]!.message_id
}
const envelope = (name: string, type: string, size: number) =>
  `[附件] ${name} (${type})\n[Size] ${size}\n[Kind] ${type.startsWith('image/') ? 'image' : 'file'}`
const SEND = 'SELECT * FROM chat.send_message_idempotent($1,$2,$3,$4,$5,$6,NULL,NULL,false,false,NULL,$7,$8,NULL)'

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('messageFileRefs.test requires a loopback PostgreSQL database')
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
    await asOwner()
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('提交(chat.attachment_commit)', () => {
  it('消费自己的上传登记:「附件」里建条目(那份字节、挑的名字、来源消息),发一条附件消息(第 1 版、没有 [URL] 的信封);同一条消息 id 重试回同一条;同一份登记换一条消息拒', async () => {
    const group = await newGroup(owner, [member])
    const up = await upload(owner, `shot-${randomUUID()}`)
    const id = randomUUID()
    const sent = await commit(owner, up.key, id, group, owner, 'shot.png')
    expect(sent).toMatchObject({ id, chat_id: group, sender_user_id: owner, content_type: 'attachment', file_version: 1, forwarded_from_message_id: null,
      content: envelope('shot.png', 'image/png', 1234) })
    expect(await item(sent.file_item_id!)).toMatchObject({ kind: 'file', filename: 'shot.png', blob_id: up.blob, pointer: null, created_by: owner,
      source_message_ids: [id], version: 1, size_bytes: '1234', content_type: 'image/png', parent_id: await attachmentsFolder(group) })
    expect(await consumed(up.key)).toBe(id)
    // 重试:同一条消息,不多建。
    expect(await commit(owner, up.key, id, group, owner, 'shot.png')).toMatchObject({ id, file_item_id: sent.file_item_id, file_version: 1 })
    expect(await inAttachments(group)).toEqual(['shot.png'])
    await asUser(owner)
    expect(await fails(COMMIT, [up.key, randomUUID(), group, owner, 'shot.png', [], false, null])).toMatch(/hint: attachment_upload_used/)
    await asOwner()
  })

  it('复用(设计 3.3):同会话、同内容、同一系列的名字 ⇒ 同一个条目、两条消息;名字不同 ⇒ 新条目同一份字节;另一个会话 ⇒ 它自己的条目;条目换过内容 ⇒ 不复用', async () => {
    const group = await newGroup(owner, [member])
    const other = await newGroup(owner, [member])
    const content = `same-${randomUUID()}`
    const first = await commit(owner, (await upload(owner, content)).key, randomUUID(), group, owner, 'shot.png')
    const second = await commit(member, (await upload(member, content)).key, randomUUID(), group, member, 'shot.png')
    const series = await commit(member, (await upload(member, content)).key, randomUUID(), group, member, 'Shot (3).png')
    expect(second.file_item_id).toBe(first.file_item_id)
    expect(series.file_item_id, '同一系列的名字(大小写不算、「 (n)」不算)').toBe(first.file_item_id)
    expect((await item(first.file_item_id!)).source_message_ids).toEqual([first.id, second.id, series.id])
    const renamed = await commit(owner, (await upload(owner, content)).key, randomUUID(), group, owner, 'other.png')
    expect(renamed.file_item_id).not.toBe(first.file_item_id)
    expect((await item(renamed.file_item_id!)).blob_id).toBe((await item(first.file_item_id!)).blob_id)
    const elsewhere = await commit(owner, (await upload(owner, content)).key, randomUUID(), other, owner, 'shot.png')
    expect((await item(elsewhere.file_item_id!))).toMatchObject({ chat_id: other, blob_id: (await item(first.file_item_id!)).blob_id })
    // 条目换过内容(现在那一版不是这份字节):不复用,新条目得「 (2)」。
    await asUser(owner)
    await database.query('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,$4,NULL,NULL)', [first.file_item_id, owner, await object(group, owner, 'new.png'), 9])
    await asOwner()
    const after = await commit(owner, (await upload(owner, content)).key, randomUUID(), group, owner, 'shot.png')
    expect(after.file_item_id).not.toBe(first.file_item_id)
    expect((await item(after.file_item_id!)).filename).toBe('shot (2).png')
  })

  it('以自己的 agent 发(它在群里)可以;拒:别人的 agent、自己的 agent 不在群里、不是成员、登记不是自己的、过期的、发不出去的悄悄话 —— 拒了什么都不留', async () => {
    const group = await newGroup(owner, [member, agent])
    const bare = await newGroup(owner, [member])
    const theirs = await agentOf(member, 'Member Agent')
    const byAgent = await commit(owner, (await upload(owner, `a-${randomUUID()}`)).key, randomUUID(), group, agent, 'a.png')
    expect(byAgent.sender_user_id).toBe(agent)
    expect((await item(byAgent.file_item_id!)).created_by).toBe(agent)

    const tries: [string, string, unknown[], RegExp][] = []
    const mine = await upload(owner, `m-${randomUUID()}`)
    tries.push(['别人的 agent', owner, [mine.key, randomUUID(), group, theirs, 'x.png', [], false], /Not allowed to act as/])
    // Delegation is valid, but the actor has no resource membership.
    tries.push(['自己的 agent 不在这个群', owner, [mine.key, randomUUID(), bare, agent, 'x.png', [], false], /hint: workspace_not_member/])
    const out = await upload(outsider, `o-${randomUUID()}`)
    tries.push(['不是成员', outsider, [out.key, randomUUID(), group, outsider, 'x.png', [], false], /not a chat you are a member of/])
    const theirsUpload = await upload(member, `t-${randomUUID()}`)
    tries.push(['登记不是自己的', owner, [theirsUpload.key, randomUUID(), group, owner, 'x.png', [], false], /hint: attachment_upload_not_found/])
    const stale = await upload(owner, `s-${randomUUID()}`)
    await database.query(`UPDATE chat.file_blob_uploads SET expires_at = now() - interval '1 second' WHERE staging_key = $1`, [stale.key])
    tries.push(['过期的', owner, [stale.key, randomUUID(), group, owner, 'x.png', [], false], /hint: attachment_upload_not_found/])
    tries.push(['悄悄话没有收件人(发消息那一步拒)', owner, [mine.key, randomUUID(), group, owner, 'x.png', [], true], /A whisper goes to exactly one person/])
    const before = await inAttachments(group)
    for (const [why, caller, args, expected] of tries) {
      await asUser(caller)
      expect(await fails(COMMIT, [...args, null]), why).toMatch(expected)
      await asOwner()
    }
    expect(await inAttachments(group), '拒了什么都不留').toEqual(before)
    expect(await consumed(mine.key)).toBeNull()
    // 对照:同一份登记,好好地发出去。
    expect((await commit(owner, mine.key, randomUUID(), group, owner, 'x.png')).file_version).toBe(1)
  })

  it('AI 单聊和私聊也有「附件」:提交照样建条目、发消息', async () => {
    const ai = await chatOf('ai', [owner, agent])
    const sent = await commit(owner, (await upload(owner, `ai-${randomUUID()}`)).key, randomUUID(), ai, owner, 'chart.png')
    expect(await inAttachments(ai)).toEqual(['chart.png'])
    expect(sent.chat_id).toBe(ai)
    const dm = await chatOf('dm', [owner, member])
    await commit(member, (await upload(member, `dm-${randomUUID()}`)).key, randomUUID(), dm, member, 'note.png')
    expect(await inAttachments(dm)).toEqual(['note.png'])
  })
})

describe('消息上的核', () => {
  it('直接发一条指向文件夹里文件的附件(本会话的文件、正文是它的信封)收下;拒:别的会话的文件、文件夹、正文对不上、只有版本没有文件;发出去以后不能改指向', async () => {
    const group = await newGroup(owner, [member])
    const other = await newGroup(owner, [member])
    const file = await binary(group, owner)
    const elsewhere = await binary(other, owner)
    const right = envelope('deck.pptx', PPTX, 100)
    const folder = await attachmentsFolderOr(group)
    await asUser(member)
    const [shared] = (await database.query<Message>(SEND, [randomUUID(), group, member, [], right, 'attachment', file, null])).rows
    expect(shared).toMatchObject({ file_item_id: file, file_version: 1, content: right })
    expect(await fails(SEND, [randomUUID(), group, member, [], right, 'attachment', elsewhere, null])).toMatch(/hint: message_file_not_here/)
    expect(await fails(SEND, [randomUUID(), group, member, [], right, 'attachment', folder, null])).toMatch(/hint: message_file_not_here/)
    expect(await fails(SEND, [randomUUID(), group, member, [], right.replace('100', '99'), 'attachment', file, null])).toMatch(/hint: message_file_envelope/)
    expect(await fails(SEND, [randomUUID(), group, member, [], right, 'text', file, null])).toMatch(/hint: message_file_envelope/)
    expect(await fails(SEND, [randomUUID(), group, member, [], right, 'attachment', null, 1])).toMatch(/hint: message_file_not_here/)
    await asOwner()
    expect(await fails('UPDATE chat.messages SET file_version = 2 WHERE id = $1', [shared!.id])).toMatch(/hint: message_file_fixed/)
    expect(await fails('UPDATE chat.messages SET file_item_id = $2 WHERE id = $1', [shared!.id, await binary(group, owner)])).toMatch(/hint: message_file_fixed/)
  })

  it('附件消息发出去以后正文、类型都不能改(删了文件留下的墓碑也一样);撤回照常;普通消息照常能编辑(复核 L11 要改 4)', async () => {
    const group = await newGroup(owner, [member])
    const file = await binary(group, owner)
    const right = envelope('deck.pptx', PPTX, 100)
    await asUser(owner)
    const [sent] = (await database.query<Message>(SEND, [randomUUID(), group, owner, [], right, 'attachment', file, null])).rows
    const lie = `[附件] invoice.pdf (application/pdf)\n[Size] 1\n[Kind] file\n[URL] https://example.invalid/invoice.pdf`
    const EDIT = 'UPDATE chat.messages SET content = $2, edited_at = now() WHERE id = $1'
    // 发送人本来就能改自己消息的正文(编辑):附件的不行。
    expect(await fails(EDIT, [sent!.id, lie])).toMatch(/^an attachment's text is fixed once it is sent \| hint: message_file_fixed/)
    await asOwner()
    // 类型 authenticated 改不了(列上没授权),换个能改的身份照样拒。
    expect(await fails(`UPDATE chat.messages SET content_type = 'text' WHERE id = $1`, [sent!.id])).toMatch(/hint: message_file_fixed/)
    await asUser(owner)
    expect((await database.query('UPDATE chat.messages SET retracted_at = now() WHERE id = $1', [sent!.id])).rowCount, '撤回只写 retracted_at').toBe(1)
    await database.query('SELECT id FROM chat.workspace_delete_as($1,$2)', [file, owner])
    expect(await fails(EDIT, [sent!.id, lie]), '墓碑').toMatch(/hint: message_file_fixed/)
    // 对照:普通消息照常编辑。
    const [text] = (await database.query<Message>(SEND, [randomUUID(), group, owner, [], 'hi', 'text', null, null])).rows
    expect((await database.query(EDIT, [text!.id, 'hello'])).rowCount).toBe(1)
    await asOwner()
    expect((await database.query<Message>('SELECT * FROM chat.messages WHERE id = $1', [sent!.id])).rows[0]).toMatchObject({ content: right, content_type: 'attachment', file_item_id: null, file_version: 1 })
  })

  it('删了文件:消息留墓碑(file_item_id 变空,版本和正文还在),条目、历史一起没了', async () => {
    const group = await newGroup(owner, [member])
    const sent = await commit(owner, (await upload(owner, `tomb-${randomUUID()}`)).key, randomUUID(), group, owner, 'gone.png')
    await asUser(owner)
    await database.query('SELECT id FROM chat.workspace_delete_as($1,$2)', [sent.file_item_id, owner])
    await asOwner()
    const { rows } = await database.query<Message>('SELECT * FROM chat.messages WHERE id = $1', [sent.id])
    expect(rows[0]).toMatchObject({ file_item_id: null, file_version: 1, content: envelope('gone.png', 'image/png', 1234), content_type: 'attachment' })
    expect(await inAttachments(group)).toEqual([])
  })

  it('修剪跳过被钉住的版本:换到第 52 版,被消息钉着的第 1 版还在历史里;没被钉的第 2 版照常裁掉', async () => {
    const group = await newGroup(owner, [member])
    const file = await binary(group, owner)
    await asUser(owner)
    await database.query(SEND, [randomUUID(), group, owner, [], envelope('deck.pptx', PPTX, 100), 'attachment', file, 1])
    for (let n = 2; n <= 52; n++) {
      await asUser(owner)
      await database.query('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,$4,NULL,NULL)', [file, owner, await object(group, owner), n])
    }
    await asOwner()
    const kept = (await database.query<{ n: number }>('SELECT n FROM chat.workspace_item_versions WHERE item_id = $1 ORDER BY n', [file])).rows.map((r) => r.n)
    expect(kept).toEqual([1, ...Array.from({ length: 50 }, (_, i) => i + 3)])
  })
})

describe('回收认得附件的引用', () => {
  it('附件进来的文件换了内容:旧的那份字节只剩历史那一版指着(没有 pointer),领回收的时候核出还有人用、出队;历史那一版也没了才回收', async () => {
    const group = await newGroup(owner, [member])
    const up = await upload(owner, `swap-${randomUUID()}`)
    const sent = await commit(owner, up.key, randomUUID(), group, owner, 'swap.png')
    await asUser(owner)
    await database.query('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,$4,NULL,NULL)', [sent.file_item_id, owner, await object(group, owner, 'swap.png'), 5])
    await asOwner()
    // 上传登记过期清掉:旧那份字节现在只有历史第 1 版指着(blob_id)。
    await database.query(`UPDATE chat.file_blob_uploads SET expires_at = now() - interval '1 second' WHERE staging_key = $1`, [up.key])
    await asServiceRole()
    await database.query('SELECT chat.file_blob_sweep()')
    await asOwner()
    const history = (await database.query<{ n: number; blob_id: string; pointer: string | null }>(
      'SELECT n, blob_id, chat.file_blob_pointer(blob_id) AS pointer FROM chat.workspace_item_versions WHERE item_id = $1 ORDER BY n', [sent.file_item_id])).rows
    expect(history[0]).toEqual({ n: 1, blob_id: up.blob, pointer: null })
    const claimAll = async () => {
      await database.query(`UPDATE chat.file_blob_gc SET next_attempt_at = now() - interval '1 second' WHERE blob_id = $1`, [up.blob])
      // 回收队列全库共享:见 fileBlobs.test.ts 的 claim。
      await database.query(`SELECT pg_advisory_xact_lock(hashtextextended('tests:file_blob_gc', 0))`)
      await asServiceRole()
      const { rows } = await database.query<{ blob_id: string }>('SELECT blob_id FROM chat.file_blob_gc_claim(50, 600)')
      await asOwner()
      return rows.map((r) => r.blob_id)
    }
    expect((await database.query('SELECT 1 FROM chat.file_blob_gc WHERE blob_id = $1', [up.blob])).rowCount, '进了队列').toBe(1)
    expect(await claimAll(), '历史还指着:不领').toEqual([])
    expect((await database.query('SELECT 1 FROM chat.file_blob_gc WHERE blob_id = $1', [up.blob])).rowCount, '出队').toBe(0)
    // 对照:文件整个删掉(历史随它走),它又进队列,这次领得到。
    await asUser(owner)
    await database.query('SELECT id FROM chat.workspace_delete_as($1,$2)', [sent.file_item_id, owner])
    await asOwner()
    expect(await claimAll()).toEqual([up.blob])
  })
})

/** The attachments folder's id (made if the chat has none yet): a folder to point a message at. */
async function attachmentsFolderOr(chatId: string): Promise<string> {
  await asOwner()
  return (await database.query<{ id: string }>(`SELECT chat.workspace_system_folder($1, 'attachments') AS id`, [chatId])).rows[0]!.id
}

describe('转发(chat.attachment_forward)', () => {
  it('目标会话的「附件」里建一个指向同一份字节的条目、发一条附件消息,记着转自哪一条;原消息的文件删了、不在原会话里,都拒', async () => {
    const source = await newGroup(owner, [member])
    const target = await newGroup(member, [owner])
    const sent = await commit(owner, (await upload(owner, `fwd-${randomUUID()}`, 'application/pdf', 4321)).key, randomUUID(), source, owner, 'report.pdf')
    const FORWARD = 'SELECT * FROM chat.attachment_forward($1,$2,$3,$4)'
    await asUser(member)
    const [moved] = (await database.query<Message>(FORWARD, [sent.id, randomUUID(), target, member])).rows
    await asOwner()
    expect(moved).toMatchObject({ chat_id: target, sender_user_id: member, forwarded_from_message_id: sent.id, file_version: 1,
      content: envelope('report.pdf', 'application/pdf', 4321) })
    expect(await item(moved!.file_item_id!)).toMatchObject({ chat_id: target, blob_id: (await item(sent.file_item_id!)).blob_id, created_by: member, filename: 'report.pdf' })

    const stranger = await newGroup(outsider, [member])
    await asUser(outsider)
    expect(await fails(FORWARD, [sent.id, randomUUID(), stranger, outsider])).toMatch(/hint: attachment_source_not_found/)
    await asUser(owner)
    await database.query('SELECT id FROM chat.workspace_delete_as($1,$2)', [sent.file_item_id, owner])
    await asUser(member)
    expect(await fails(FORWARD, [sent.id, randomUUID(), target, member])).toMatch(/hint: attachment_source_gone/)
    await asOwner()
  })

  it('和客户端 forwardCanonicalMessage 同一条判据:撤回的、没发给自己的悄悄话、以自己的 agent 转一条自己读不到的,都拒;单独调 definer 那一半也拒(复核 L11 要改 3)', async () => {
    const third = await human('Third')
    const source = await newGroup(owner, [member, third])
    const target = await chatOf('group', [third, member, owner, agent])
    const FORWARD = 'SELECT * FROM chat.attachment_forward($1,$2,$3,$4)'
    const PLACE = 'SELECT * FROM chat.attachment_place_forward($1,$2,$3,$4)'

    const retracted = await commit(owner, (await upload(owner, `retract-${randomUUID()}`)).key, randomUUID(), source, owner, 'oops.png')
    await asUser(owner)
    await database.query('UPDATE chat.messages SET retracted_at = now() WHERE id = $1', [retracted.id])
    await asUser(member)
    expect(await fails(FORWARD, [retracted.id, randomUUID(), target, member])).toMatch(/^message \S+ was retracted \| hint: attachment_source_retracted/)
    expect(await fails(PLACE, [retracted.id, target, member, randomUUID()]), '单独调').toMatch(/hint: attachment_source_retracted/)

    const whisper = await commit(owner, (await upload(owner, `whisper-${randomUUID()}`, 'application/pdf', 777)).key, randomUUID(), source, owner, 'salary.pdf', { to: [member], whisper: true })
    await asUser(third)
    expect(await fails(FORWARD, [whisper.id, randomUUID(), target, third])).toMatch(/^message \S+ is not one you can read \| hint: attachment_source_not_found/)
    expect(await fails(PLACE, [whisper.id, target, third, randomUUID()]), '单独调').toMatch(/hint: attachment_source_not_found/)
    await asOwner()
    expect(await inAttachments(target), '拒了什么都没放').toEqual([])

    // 以自己的 agent 转:读原消息的是登录的那个人(与客户端一样)。agent 在、人不在的群里那一条,人读不到 ⇒ 拒。
    const agentsOnly = await chatOf('group', [member, agent])
    const there = await commit(member, (await upload(member, `there-${randomUUID()}`)).key, randomUUID(), agentsOnly, member, 'there.png')
    await asUser(owner)
    expect(await fails(FORWARD, [there.id, randomUUID(), target, agent])).toMatch(/hint: attachment_source_not_found/)

    // 对照:收件人转那条悄悄话、没撤回的照常转。
    await asUser(member)
    const [moved] = (await database.query<Message>(FORWARD, [whisper.id, randomUUID(), target, member])).rows
    await asOwner()
    expect(moved).toMatchObject({ chat_id: target, forwarded_from_message_id: whisper.id, content: envelope('salary.pdf', 'application/pdf', 777) })
  })

  it('转发今天传的文件(pointer、workspace blob):原文件删了,老的两条引用判断也认转过去的那份,桶的删除策略谁都不让删;那份也没了才放开(复核 L11 要改 1)', async () => {
    const source = await newGroup(owner, [member])
    const target = await newGroup(member, [owner])
    const file = await binary(source, owner)
    const { pointer, blob_id: blob } = await item(file)
    await asUser(owner)
    const [pinned] = (await database.query<Message>(SEND, [randomUUID(), source, owner, [], envelope('deck.pptx', PPTX, 100), 'attachment', file, 1])).rows
    await asUser(member)
    const [moved] = (await database.query<Message>('SELECT * FROM chat.attachment_forward($1,$2,$3,$4)', [pinned!.id, randomUUID(), target, member])).rows
    const copy = moved!.file_item_id!
    // pointer 由 blob 推:转过去的那份指同一个 blob,也就是同一个桶对象。
    expect(await item(copy)).toMatchObject({ blob_id: blob, pointer })
    // App 删文件:先删行(上传者,经 workspace_delete_as),再删字节。
    await asUser(owner)
    await database.query('SELECT id FROM chat.workspace_delete_as($1,$2)', [file, owner])
    const judged = async () => {
      await asOwner()
      const row = (await database.query<{ gc: boolean; pointer_in_use: boolean; referenced: boolean }>(
        `SELECT chat.file_blob_in_use($1) AS gc, chat.workspace_pointer_in_use($2) AS pointer_in_use,
                identity.storage_object_is_referenced('workspace', $2) AS referenced`, [blob, pointer])).rows[0]!
      return { ...row, uploader_may_delete: await deletePolicyAllows(owner, pointer!), member_may_delete: await deletePolicyAllows(member, pointer!) }
    }
    const held = { gc: true, pointer_in_use: true, referenced: true, uploader_may_delete: false, member_may_delete: false }
    expect(await judged(), '转过去的那份还指着').toEqual(held)
    // 那份换了内容:旧字节只剩它的历史第 1 版指着,照样算。
    await asUser(member)
    await database.query('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,$4,NULL,NULL)', [copy, member, await object(target, member), 7])
    expect(await judged(), '只剩历史那一版指着').toEqual(held)
    // 对照:那份也删了 ⇒ 没人用,上传者、成员都能删。
    await asUser(member)
    await database.query('SELECT id FROM chat.workspace_delete_as($1,$2)', [copy, member])
    expect(await judged()).toEqual({ gc: false, pointer_in_use: false, referenced: false, uploader_may_delete: true, member_may_delete: true })
  })
})

/** The storage bucket's own delete policy (pg_policies), evaluated as `as` for the object `name`. */
async function deletePolicyAllows(as: string, name: string): Promise<boolean> {
  await asOwner()
  const qual = (await database.query<{ qual: string }>(
    `SELECT qual FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'workspace_delete_owner'`)).rows[0]!.qual
  await asUser(as)
  const may = (await database.query<{ may: boolean }>(`SELECT (${qual}) AS may FROM (SELECT 'workspace'::text AS bucket_id, $1::text AS name) AS objects`, [name])).rows[0]!.may
  await asOwner()
  return may
}

describe('字节在哪(chat.file_urls_as)', () => {
  it('回成员看得见的那些:版本不给是现在那一版,给了是那一版;不是成员、没有的条目、坏的 id 不回;以自己的 agent 问照样', async () => {
    const group = await newGroup(owner, [member, agent])
    const up = await upload(owner, `urls-${randomUUID()}`)
    const sent = await commit(owner, up.key, randomUUID(), group, owner, 'pic.png')
    const legacy = await binary(group, owner)
    const next = await object(group, owner)
    await asUser(owner)
    await database.query('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,$4,NULL,NULL)', [legacy, owner, next, 2])
    await asOwner()
    const refs = JSON.stringify([{ item_id: sent.file_item_id }, { item_id: legacy, version: 1 }, { item_id: legacy }, { item_id: randomUUID() }, { item_id: 'not-an-id' }])
    type Url = { item_id: string; version: number; bucket_id: string; object_name: string; sha256: string | null; size_bytes: string; content_type: string; width: number | null; height: number | null; file_name: string }
    const ask = async (caller: string, as: string) => {
      await asUser(caller)
      const { rows } = await database.query<Url>('SELECT * FROM chat.file_urls_as($1::jsonb,$2) ORDER BY item_id, version', [refs, as])
      await asOwner()
      return rows
    }
    const rows = await ask(member, member)
    const oss = rows.find((r) => r.item_id === sent.file_item_id)!
    const digest = (await database.query<{ sha256: string }>('SELECT sha256 FROM chat.file_blobs WHERE id = $1', [up.blob])).rows[0]!.sha256
    expect(oss).toMatchObject({ version: 1, bucket_id: 'oss', object_name: `${digest.slice(0, 2)}/${digest}`, sha256: digest, size_bytes: '1234',
      content_type: 'image/png', width: 640, height: 480, file_name: 'pic.png' })
    const old = rows.filter((r) => r.item_id === legacy).map((r) => [r.version, r.bucket_id, r.object_name.endsWith('-deck.pptx'), r.object_name === next])
    expect(old).toEqual([[1, 'workspace', true, false], [2, 'workspace', true, true]])
    expect(rows).toHaveLength(3)
    expect(await ask(outsider, outsider), '不是成员').toEqual([])
    expect((await ask(owner, agent)).length, '自己的 agent(它在群里)').toBe(3)
    await asUser(owner)
    expect(await fails('SELECT * FROM chat.file_urls_as($1::jsonb,$2)', [JSON.stringify({ item_id: legacy }), owner])).toMatch(/refs is an array/)
    expect(await fails('SELECT * FROM chat.file_urls_as($1::jsonb,$2)', [JSON.stringify(Array.from({ length: 201 }, () => ({ item_id: legacy }))), owner])).toMatch(/at most 200/)
    expect(await fails('SELECT * FROM chat.file_urls_as($1::jsonb,$2)', [refs, member])).toMatch(/Not allowed to act as/)
    await asOwner()
  })
})

describe('attachment message metadata', () => {
  const read = async (id: string, actor = member) => {
    await asUser(actor)
    return (await database.query<{ file_metadata: Record<string, unknown> | null }>(
      'SELECT file_metadata FROM chat.messages_view WHERE id=$1', [id])).rows
  }

  it('carries verified dimensions and SHA in commit, history and revision arrivals without changing the envelope', async () => {
    const group = await newGroup(owner, [member])
    const content = `image-${randomUUID()}`
    const sent = await commit(owner, (await upload(owner, content)).key, randomUUID(), group, owner, 'shot.png')
    const expected = { status: 'ready', source: 'managed-object', sha256: sha(content), width: 640, height: 480 }
    expect(sent).toMatchObject({ file_metadata: expected, content: envelope('shot.png', 'image/png', 1234) })
    for (const actor of [owner, member]) {
      const [row] = await read(sent.id, actor)
      expect(row!.file_metadata).toMatchObject(expected)
      const resolved = (await database.query<{ r: Record<string, unknown> }>(
        "SELECT chat.file_resolve_as(jsonb_build_object('message_id',$1::text),$2) AS r", [sent.id, actor])).rows[0]!.r
      const { bucket_id: _bucket, object_name: _object, ...display } = resolved
      expect(row!.file_metadata).toEqual(display)
      const page = (await database.query<{ r: { operations: { event: string; payload: { message?: { id: string; file_metadata: unknown } } }[] } }>(
        'SELECT chat.sync_since(0,500) AS r')).rows[0]!.r
      expect(page.operations.find(op => op.event === 'message_created' && op.payload.message?.id === sent.id)?.payload.message?.file_metadata).toEqual(display)
    }
    expect(await read(sent.id, outsider)).toEqual([])
    await asOwner()
    expect((await database.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('authenticated','chat.file_blobs','SELECT') AS allowed")).rows[0]!.allowed).toBe(false)
  })

  it('keeps the sent version after replacement and gives ordinary text no metadata', async () => {
    const group = await newGroup(owner, [member])
    const content = `pinned-${randomUUID()}`
    const sent = await commit(owner, (await upload(owner, content)).key, randomUUID(), group, owner, 'shot.png')
    const next = await object(group, owner, 'new.png')
    await asUser(owner)
    await database.query('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,$4,NULL,NULL)', [sent.file_item_id, owner, next, 9])
    expect((await read(sent.id))[0]!.file_metadata).toMatchObject({ version: 1, sha256: sha(content), width: 640, height: 480 })
    await asOwner()
    const text = randomUUID()
    await database.query('INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,$4)', [text, group, owner, 'ordinary text'])
    expect((await read(text))[0]!.file_metadata).toBeNull()
  })

  it.each([
    { whisper: true, caption: 'hi' },
    { whisper: true, caption: undefined },
    { whisper: false, caption: 'hi' },
  ])('preserves attachment names with whisper=$whisper and caption=$caption', async ({ whisper, caption }) => {
    const group = await newGroup(owner, [member, outsider])
    const content = `caption-${randomUUID()}`
    const sent = await commit(owner, (await upload(owner, content)).key, randomUUID(), group, owner, 'shot.png',
      { whisper, to: whisper ? [member] : [], caption })
    const expected = { status: 'ready', file_name: 'shot.png', width: 640, height: 480 }
    expect(sent).toMatchObject({ file_metadata: expected,
      content: envelope('shot.png', 'image/png', 1234) + (caption ? `\n[Caption]\n${caption}` : '') })
    expect((await read(sent.id))[0]!.file_metadata).toMatchObject(expected)
    if (whisper) {
      const ask = async (actor: string) => {
        await asUser(actor)
        return (await database.query('SELECT * FROM chat.file_urls_as($1::jsonb,$2)',
          [JSON.stringify([{ message_id: sent.id }]), actor])).rows
      }
      expect(await ask(member)).toMatchObject([{ file_name: 'shot.png', width: 640, height: 480 }])
      expect(await read(sent.id, outsider)).toEqual([])
      expect(await ask(outsider)).toEqual([])
    }
  })

  it.each([false, true])('forwards a captioned whisper to another group with whisper=%s', async (whisper) => {
    const source = await newGroup(owner, [member])
    const target = await newGroup(member, [owner, outsider])
    const sent = await commit(owner, (await upload(owner, `forward-caption-${randomUUID()}`)).key,
      randomUUID(), source, owner, 'shot.png', { whisper: true, to: [member], caption: 'hi' })
    await asUser(member)
    const [moved] = (await database.query<Message>(
      'SELECT * FROM chat.attachment_forward($1,$2,$3,$4,$5,NULL,false,$6)',
      [sent.id, randomUUID(), target, member, whisper ? [owner] : [], whisper])).rows
    expect(moved).toMatchObject({ forwarded_from_message_id: sent.id,
      content: envelope('shot.png', 'image/png', 1234) + '\n[Caption]\nhi',
      file_metadata: { status: 'ready', file_name: 'shot.png', width: 640, height: 480 } })
    expect((await read(moved!.id, owner))[0]!.file_metadata).toMatchObject({ file_name: 'shot.png' })
    if (whisper) expect(await read(moved!.id, outsider)).toEqual([])
  })

  it.each<[string, string, string | null]>([
    ['shot.png', '', 'shot.png'],
    ['shot.png', '\n[Caption]\nhi', 'shot.png'],
    ['shot.png', '\n[Caption]\n hi', null],
    ['shot.png', '\n[Caption]\nhi ', null],
    ['shot\n.png', '', null],
    ['shot\n.png', '\n[Caption]\nhi', null],
  ])('parses envelope name %j with suffix %j as %j', async (name, suffix, expected) => {
    await asOwner()
    const [row] = (await database.query<{ name: string | null }>(
      'SELECT chat.attachment_envelope_name($1,1234,\'image/png\') AS name',
      [envelope(name, 'image/png', 1234) + suffix])).rows
    expect(row!.name).toBe(expected)
  })

  it('preserves whisper visibility and stops advertising a ready file after retraction or deletion', async () => {
    const group = await newGroup(owner, [member, outsider])
    const sent = await commit(owner, (await upload(owner, `whisper-${randomUUID()}`)).key, randomUUID(), group, owner, 'shot.png', { whisper: true, to: [member] })
    expect((await read(sent.id))[0]!.file_metadata).toMatchObject({ status: 'ready', width: 640, height: 480 })
    expect(await read(sent.id, outsider)).toEqual([])
    await asOwner()
    await database.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1', [sent.id])
    expect((await read(sent.id))[0]!.file_metadata).toEqual({ status: 'gone' })
    const ordinary = await commit(owner, (await upload(owner, `deleted-${randomUUID()}`)).key, randomUUID(), group, owner, 'deleted.png')
    await asUser(owner)
    await database.query('SELECT chat.workspace_delete_as($1,$2)', [ordinary.file_item_id, owner])
    expect((await read(ordinary.id))[0]!.file_metadata).toEqual({ status: 'gone' })
  })
})

describe('已经发出去的客户端与执行权', () => {
  it('messages_view 原有文件列位置不变;按参数名、不带新参数调 send_message_idempotent 照旧,重放回同一条;它只有一个签名', async () => {
    await asOwner()
    const cols = (await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'chat' AND table_name = 'messages_view' ORDER BY ordinal_position`)).rows.map((r) => r.column_name)
    // 后续功能可以追加列，已发布的文件列仍保持原来的位置。
    expect(cols.slice(24, 27)).toEqual(['via_app', 'file_item_id', 'file_version'])
    const group = await newGroup(owner, [member])
    const id = randomUUID()
    const call = `SELECT id, content, file_item_id FROM chat.send_message_idempotent(p_message_id => $1, p_chat_id => $2, p_sender_user_id => $3,
      p_to_user_ids => '{}', p_content => 'hi', p_content_type => 'text', p_reply_to_message_id => NULL, p_thread_root_id => NULL,
      p_is_thread_root => false, p_is_whisper => false, p_via_app => NULL)`
    await asUser(owner)
    const first = (await database.query(call, [id, group, owner])).rows
    const again = (await database.query(call, [id, group, owner])).rows
    await asOwner()
    expect(first).toEqual([{ id, content: 'hi', file_item_id: null }])
    expect(again).toEqual(first)
    expect((await database.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'chat' AND p.proname = 'send_message_idempotent'`)).rowCount).toBe(1)
  })

  it('上线不扫 chat.messages:外键和两个 CHECK 都是 NOT VALID,新写的行照样核(复核 L11 要改 6)', async () => {
    await asOwner()
    const { rows } = await database.query<{ conname: string; contype: string; convalidated: boolean; confdeltype: string }>(
      `SELECT conname, contype, convalidated, confdeltype FROM pg_constraint
        WHERE conrelid = 'chat.messages'::regclass AND conname IN ('messages_file_item_id_fkey', 'messages_file_version_check', 'messages_file_ref_shape')
        ORDER BY conname`)
    expect(rows).toEqual([
      { conname: 'messages_file_item_id_fkey', contype: 'f', convalidated: false, confdeltype: 'n' },
      { conname: 'messages_file_ref_shape', contype: 'c', convalidated: false, confdeltype: ' ' },
      { conname: 'messages_file_version_check', contype: 'c', convalidated: false, confdeltype: ' ' },
    ])
    // 新行照样核:指着条目、又带一个(真的在桶里的)老式存储引用的附件,形状那一条拒(触发器不看这两列)。
    const group = await newGroup(owner, [member])
    const file = await binary(group, owner)
    const media = `${group}/${randomUUID()}.png`
    await database.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('chat-media',$1)`, [media])
    expect(await fails(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, file_item_id, file_version, storage_bucket_id, storage_object_name)
      VALUES ($1,$2,$3,$4,'attachment',$5,1,'chat-media',$6)`, [randomUUID(), group, owner, envelope('deck.pptx', PPTX, 100), file, media]))
      .toMatch(/messages_file_ref_shape/)
  })

  it('文件服务的门也认 AI 单聊:那里的活文档 files_authorize 回一行;私聊对照;不是成员不回(复核 L11 要改 7)', async () => {
    const ai = await chatOf('ai', [owner, agent])
    const dm = await chatOf('dm', [owner, member])
    const doc = async (chatId: string) => (await database.query<{ id: string }>(
      `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, inline_text, created_by) VALUES ($1,'document','notes.md','text/markdown','',$2) RETURNING id`,
      [chatId, owner])).rows[0]!.id
    const inAi = await doc(ai)
    const inDm = await doc(dm)
    const authorize = async (itemId: string, user: string) =>
      (await database.query<{ chat_id: string; kind: string }>('SELECT chat_id, kind FROM chat.files_authorize($1, $2)', [itemId, user])).rows
    expect(await authorize(inAi, owner)).toEqual([{ chat_id: ai, kind: 'document' }])
    expect(await authorize(inDm, owner)).toEqual([{ chat_id: dm, kind: 'document' }])
    expect(await authorize(inAi, outsider), '不是成员').toEqual([])
  })

  it('执行权:提交、转发、file_urls_as、send_message_idempotent 和两个放条目的 definer 给 authenticated;内部件谁都不给', async () => {
    await asOwner()
    const { rows } = await database.query<{ fn: string; anon: boolean; auth: boolean; service: boolean }>(`
      SELECT p.proname AS fn,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'chat' AND p.proname IN (
         'attachment_commit','attachment_forward','file_urls_as','send_message_idempotent','attachment_place','attachment_place_forward',
         'workspace_version_blob','attachment_envelope','workspace_version_envelope','messages_file_ref','workspace_same_series',
         'attachment_sender_check','attachment_item_for','workspace_require_room_member','workspace_item_for',
         'workspace_bytes_pinned','attachment_envelope_name')
       ORDER BY 1`)
    const by = Object.fromEntries(rows.map((row) => [row.fn, row]))
    expect(Object.keys(by)).toHaveLength(17)
    for (const fn of ['attachment_commit', 'attachment_forward', 'file_urls_as', 'send_message_idempotent', 'attachment_place', 'attachment_place_forward']) {
      expect(by[fn], fn).toMatchObject({ anon: false, auth: true })
    }
    for (const fn of ['workspace_version_blob', 'attachment_envelope', 'workspace_version_envelope', 'messages_file_ref', 'workspace_same_series',
      'attachment_sender_check', 'attachment_item_for', 'workspace_require_room_member', 'workspace_item_for',
      'workspace_bytes_pinned', 'attachment_envelope_name']) {
      expect(by[fn], fn).toMatchObject({ anon: false, auth: false })
    }
  })
})
