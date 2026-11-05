import { createFixtureGroup } from '../../support/groupFixture'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 群文件夹里的文件按引用发成附件、改过的文件发成它的下一版(迁移 20261025080000_attachment_share):
 *   · chat.attachment_share:消息钉住那个文件的那一版,不搬字节、不建条目;另一个会话的文件 ⇒ 这里的「附件」里一个指向同一份字节的条目;
 *   · chat.attachment_commit 带 p_item_id + p_expected_version:上传成为那个文件的下一版、消息钉住它;字节和那一版一样 ⇒ 不出新版;
 *     版本对不上 ⇒ 拒,什么都不留;
 *   · chat.attachment_forward 转进放着这个文件的会话 ⇒ 钉住同一个文件;
 *   · chat.message_history_as / message_search_as 回 file_item_id / file_version。
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
  [id, `${id}@attachment-share.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'attachment-share fixture','fixture','darwin')`, [`dev-${id}`, id])
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
    id, 'Attachment share', creator, JSON.stringify(initial.map((user_id) => ({ user_id, role: 'member' }))),
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
const COMMIT = 'SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,$7)'
async function commit(caller: string, key: string, messageId: string, chatId: string, sender: string, name: string, opts: { to?: string[]; whisper?: boolean } = {}): Promise<Message> {
  await asUser(caller)
  const { rows } = await database.query<Message>(COMMIT, [key, messageId, chatId, sender, name, opts.to ?? [], opts.whisper ?? false])
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
const COMMIT_VERSION = 'SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,false,NULL,NULL,$7,$8)'
const SHARE = 'SELECT * FROM chat.attachment_share($1,$2,$3,$4,$5,$6)'
const FORWARD = 'SELECT * FROM chat.attachment_forward($1,$2,$3,$4)'
async function nextVersion(caller: string, key: string, messageId: string, chatId: string, sender: string, itemId: string, expected: number | null): Promise<Message> {
  await asUser(caller)
  const { rows } = await database.query<Message>(COMMIT_VERSION, [key, messageId, chatId, sender, 'ignored.bin', [], itemId, expected])
  await asOwner()
  return rows[0]!
}
async function share(caller: string, itemId: string, version: number | null, messageId: string, chatId: string, sender: string): Promise<Message> {
  await asUser(caller)
  const { rows } = await database.query<Message>(SHARE, [itemId, version, messageId, chatId, sender, []])
  await asOwner()
  return rows[0]!
}
async function itemCount(chatId: string): Promise<number> {
  await asOwner()
  return Number((await database.query<{ n: string }>(`SELECT count(*) AS n FROM chat.workspace_items WHERE chat_id = $1 AND kind = 'file'`, [chatId])).rows[0]!.n)
}
async function topicIn(chatId: string): Promise<string> {
  await asOwner()
  const anchor = randomUUID(), id = randomUUID()
  await database.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'source message')`, [anchor, chatId, owner])
  await database.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id) VALUES ($1,'topic','topic',$2,$3,$4)`, [id, owner, chatId, anchor])
  await database.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner')`, [id, owner])
  return id
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('attachmentShare.test requires a loopback PostgreSQL database')
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

describe('按引用发(chat.attachment_share)', () => {
  it('同一个会话:钉住那个文件的那一版(不给版本 = 现在这一版),不建条目、不登记上传;以自己在群里的 agent 发也一样', async () => {
    const group = await newGroup(owner, [member, agent])
    const sent = await commit(owner, (await upload(owner, `deck-${randomUUID()}`, PPTX, 5000)).key, randomUUID(), group, owner, 'deck.pptx')
    const before = await itemCount(group)
    const id = randomUUID()
    const shared = await share(owner, sent.file_item_id!, null, id, group, agent)
    expect(shared).toMatchObject({ id, chat_id: group, sender_user_id: agent, content_type: 'attachment', file_item_id: sent.file_item_id, file_version: 1,
      forwarded_from_message_id: null, content: envelope('deck.pptx', PPTX, 5000) })
    expect(await itemCount(group), '不建条目').toBe(before)
    // 重试同一条消息:回同一条。
    expect(await share(owner, sent.file_item_id!, null, id, group, agent)).toMatchObject({ id, file_version: 1 })
  })

  it('钉住发出时那一版:文件换了版本以后,按旧版本发的仍是旧的那一版(那一版的大小);没有的版本拒', async () => {
    const group = await newGroup(owner, [member])
    const sent = await commit(owner, (await upload(owner, `v1-${randomUUID()}`, PPTX, 100)).key, randomUUID(), group, owner, 'deck.pptx')
    const v2 = await nextVersion(owner, (await upload(owner, `v2-${randomUUID()}`, PPTX, 200)).key, randomUUID(), group, owner, sent.file_item_id!, 1)
    expect(v2.file_version).toBe(2)
    expect(await share(member, sent.file_item_id!, 1, randomUUID(), group, member)).toMatchObject({ file_version: 1, content: envelope('deck.pptx', PPTX, 100) })
    expect(await share(member, sent.file_item_id!, null, randomUUID(), group, member)).toMatchObject({ file_version: 2, content: envelope('deck.pptx', PPTX, 200) })
    await asUser(member)
    expect(await fails(SHARE, [sent.file_item_id, 7, randomUUID(), group, member, []])).toMatch(/hint: attachment_source_gone/)
    await asOwner()
  })

  it('话题:钉住来源群文件夹里的那个文件(不在「附件」里另建)', async () => {
    const group = await newGroup(owner, [member])
    const sent = await commit(owner, (await upload(owner, `t-${randomUUID()}`, PPTX, 300)).key, randomUUID(), group, owner, 'deck.pptx')
    const topic = await topicIn(group)
    const before = await itemCount(group)
    const shared = await share(owner, sent.file_item_id!, null, randomUUID(), topic, owner)
    expect(shared).toMatchObject({ chat_id: topic, file_item_id: sent.file_item_id, file_version: 1 })
    expect(await itemCount(group)).toBe(before)
  })

  it('另一个会话的文件(发送者读得到):这里的「附件」里一个指向同一份字节的条目;读不到的拒;未发布字节的文本文件需先快照、文件夹拒', async () => {
    const source = await newGroup(owner, [member])
    const target = await newGroup(member, [owner])
    const sent = await commit(owner, (await upload(owner, `x-${randomUUID()}`, 'application/pdf', 400)).key, randomUUID(), source, owner, 'report.pdf')
    const shared = await share(member, sent.file_item_id!, 1, randomUUID(), target, member)
    expect(shared.chat_id).toBe(target)
    expect(shared.file_item_id).not.toBe(sent.file_item_id)
    expect(await item(shared.file_item_id!)).toMatchObject({ chat_id: target, blob_id: (await item(sent.file_item_id!)).blob_id, parent_id: await attachmentsFolder(target) })

    const stranger = await newGroup(outsider, [])
    await asUser(outsider)
    expect(await fails(SHARE, [sent.file_item_id, 1, randomUUID(), stranger, outsider, []])).toMatch(/hint: workspace_item_not_found/)
    await asOwner()
    const { rows: [text] } = await database.query<{ id: string }>(
      `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, inline_text, created_by) VALUES ($1,'document','notes.md','text/markdown','hi',$2) RETURNING id`, [source, owner])
    await asUser(owner)
    // A text document's version is text: it is sent through attachments/share (a snapshot with bytes), never "gone".
    expect(await fails(SHARE, [text!.id, null, randomUUID(), source, owner, []])).toMatch(/hint: attachment_forward_needs_bytes/)
    await asOwner()
  })
})

describe('文本文件按引用发(chat.attachment_document_snapshot,迁移 20261030120000)', () => {
  const SNAPSHOT = 'SELECT chat.attachment_document_snapshot($1,$2,$3,$4) AS n'
  /** A document edited in the editor: its versions are text only, recorded as the file service records rounds. */
  async function editedDocument(chatId: string, texts: string[]): Promise<string> {
    await asOwner()
    const { rows: [doc] } = await database.query<{ id: string }>(
      `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, inline_text, created_by, version) VALUES ($1,'document','周报','text/markdown',$2,$3,2) RETURNING id`,
      [chatId, texts.at(-1), owner])
    for (const [i, text] of texts.entries()) {
      await database.query(`INSERT INTO chat.workspace_item_versions (item_id, n, inline_text, content_type, size_bytes) VALUES ($1,$2,$3,'text/markdown',octet_length($3))`, [doc!.id, i + 1, text])
    }
    return doc!.id
  }
  async function snapshot(caller: string, itemId: string, text: string, key: string | null): Promise<number> {
    await asUser(caller)
    const { rows } = await database.query<{ n: number }>(SNAPSHOT, [itemId, caller, text, key])
    await asOwner()
    return rows[0]!.n
  }
  async function versions(itemId: string) {
    await asOwner()
    return (await database.query<{ n: number; blob_id: string | null; inline_text: string }>(
      'SELECT n, blob_id, inline_text FROM chat.workspace_item_versions WHERE item_id = $1 ORDER BY n', [itemId])).rows
  }

  it('编辑过的文本文件:没有字节先要字节;带上这段正文的上传 ⇒ 带字节的下一版(一版的字节不改)、钉住它;另一个群收到的是这段正文', async () => {
    const source = await newGroup(owner, [member])
    const target = await newGroup(member, [owner])
    const text = `# 周报 ${randomUUID()}`
    const doc = await editedDocument(source, ['# 周报 草稿', text])
    await asUser(owner)
    expect(await fails(SNAPSHOT, [doc, owner, text, null])).toMatch(/hint: attachment_forward_needs_bytes/)
    await asOwner()
    const up = await upload(owner, text, 'text/markdown', Buffer.byteLength(text))
    // A version's bytes never change: the text becomes the next version, with bytes (the list's version 2 is not it).
    expect(await snapshot(owner, doc, text, up.key)).toBe(3)
    expect(await versions(doc)).toMatchObject([{ n: 1, blob_id: null }, { n: 2, blob_id: null }, { n: 3, blob_id: up.blob, inline_text: text }])

    const own = await share(owner, doc, 3, randomUUID(), source, owner)
    expect(own).toMatchObject({ file_item_id: doc, file_version: 3 })
    const sent = await share(owner, doc, 3, randomUUID(), target, owner)
    expect(sent.chat_id).toBe(target)
    await asOwner()
    const { rows: [placed] } = await database.query<{ kind: string; inline_text: string }>('SELECT kind, inline_text FROM chat.workspace_items WHERE id = $1', [sent.file_item_id])
    expect(placed).toEqual({ kind: 'document', inline_text: text })
  })

  it('正文没变再发:就是上次那一版,不要字节、不加版本;正文变了 ⇒ 下一版(编号接着最大的)', async () => {
    const group = await newGroup(owner, [member])
    const text = `# 周报 ${randomUUID()}`
    const doc = await editedDocument(group, [text])
    const first = await upload(owner, text, 'text/markdown', Buffer.byteLength(text))
    expect(await snapshot(owner, doc, text, first.key)).toBe(2)
    expect(await snapshot(member, doc, text, null)).toBe(2)
    expect(await versions(doc)).toHaveLength(2)

    const newer = `${text}\n\n还没存成一轮的改动`
    const second = await upload(member, newer, 'text/markdown', Buffer.byteLength(newer))
    expect(await snapshot(member, doc, newer, second.key)).toBe(3)
    expect(await versions(doc)).toMatchObject([{ n: 1, blob_id: null }, { n: 2, blob_id: first.blob }, { n: 3, blob_id: second.blob, inline_text: newer }])
  })

  it('字节不是这段正文、别人的上传、存的文件:都拒,什么都不改', async () => {
    const group = await newGroup(owner, [member])
    const text = `# 周报 ${randomUUID()}`
    const doc = await editedDocument(group, [text])
    const other = await upload(owner, 'something else', 'text/markdown', 14)
    await asUser(owner)
    expect(await fails(SNAPSHOT, [doc, owner, text, other.key])).toMatch(/hint: file_place_invalid/)
    await asOwner()
    const mine = await upload(owner, text, 'text/markdown', Buffer.byteLength(text))
    await asUser(member)
    expect(await fails(SNAPSHOT, [doc, member, text, mine.key])).toMatch(/hint: attachment_upload_not_found/)
    await asUser(outsider)
    expect(await fails(SNAPSHOT, [doc, outsider, text, null])).toMatch(/hint: workspace_item_not_found/)
    await asOwner()
    const stored = await binary(group, owner)
    await asUser(owner)
    expect(await fails(SNAPSHOT, [stored, owner, text, null])).toMatch(/hint: file_place_invalid/)
    await asOwner()
    expect(await versions(doc)).toMatchObject([{ n: 1, blob_id: null }])
  })
})

describe('下一版(chat.attachment_commit 带 p_item_id)', () => {
  it('上传成为那个文件的下一版,消息钉住新版;同一个文件、不建条目;同一条消息重试回同一条', async () => {
    const group = await newGroup(owner, [member, agent])
    const sent = await commit(owner, (await upload(owner, `a-${randomUUID()}`, PPTX, 100)).key, randomUUID(), group, owner, 'deck.pptx')
    const before = await itemCount(group)
    const up = await upload(owner, `b-${randomUUID()}`, PPTX, 222)
    const id = randomUUID()
    const v2 = await nextVersion(owner, up.key, id, group, agent, sent.file_item_id!, 1)
    expect(v2).toMatchObject({ id, sender_user_id: agent, file_item_id: sent.file_item_id, file_version: 2, content: envelope('deck.pptx', PPTX, 222) })
    expect(await item(sent.file_item_id!)).toMatchObject({ version: 2, blob_id: up.blob })
    expect(await itemCount(group)).toBe(before)
    expect(await consumed(up.key)).toBe(id)
    expect(await nextVersion(owner, up.key, id, group, agent, sent.file_item_id!, 1)).toMatchObject({ id, file_version: 2 })
    expect((await item(sent.file_item_id!)).version, '重试不多出一版').toBe(2)
  })

  it('字节和起点那一版一样:不出新版,钉住那一版', async () => {
    const group = await newGroup(owner, [member])
    const content = `same-${randomUUID()}`
    const sent = await commit(owner, (await upload(owner, content, PPTX, 100)).key, randomUUID(), group, owner, 'deck.pptx')
    const again = await nextVersion(owner, (await upload(owner, content, PPTX, 100)).key, randomUUID(), group, owner, sent.file_item_id!, 1)
    expect(again).toMatchObject({ file_item_id: sent.file_item_id, file_version: 1 })
    expect((await item(sent.file_item_id!)).version).toBe(1)
  })

  it('拒,什么都不留:起点不是现在这一版(有人先存了新版)、没给起点、文件在别的会话、悄悄话;对照:起点对了就成', async () => {
    const group = await newGroup(owner, [member])
    const other = await newGroup(owner, [member])
    const sent = await commit(owner, (await upload(owner, `a-${randomUUID()}`, PPTX, 100)).key, randomUUID(), group, owner, 'deck.pptx')
    await nextVersion(member, (await upload(member, `m-${randomUUID()}`, PPTX, 150)).key, randomUUID(), group, member, sent.file_item_id!, 1)
    const mine = await upload(owner, `o-${randomUUID()}`, PPTX, 160)
    await asUser(owner)
    expect(await fails(COMMIT_VERSION, [mine.key, randomUUID(), group, owner, 'x', [], sent.file_item_id, 1])).toMatch(/hint: workspace_version_conflict/)
    expect(await fails(COMMIT_VERSION, [mine.key, randomUUID(), group, owner, 'x', [], sent.file_item_id, null])).toMatch(/hint: file_place_invalid/)
    expect(await fails(COMMIT_VERSION, [mine.key, randomUUID(), other, owner, 'x', [], sent.file_item_id, 2])).toMatch(/hint: message_file_not_here/)
    expect(await fails('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,true,NULL,NULL,$7,$8)',
      [mine.key, randomUUID(), group, owner, 'x', [member], sent.file_item_id, 2])).toMatch(/hint: file_place_invalid/)
    await asOwner()
    expect(await consumed(mine.key)).toBeNull()
    expect((await item(sent.file_item_id!)).version).toBe(2)
    expect((await nextVersion(owner, mine.key, randomUUID(), group, owner, sent.file_item_id!, 2)).file_version).toBe(3)
  })

  it('不带 p_item_id:和原来一样在「附件」里建条目', async () => {
    const group = await newGroup(owner, [member])
    const sent = await commit(owner, (await upload(owner, `p-${randomUUID()}`)).key, randomUUID(), group, owner, 'shot.png')
    expect(await inAttachments(group)).toEqual(['shot.png'])
    expect(sent.file_version).toBe(1)
  })
})

describe('转发进放着这个文件的会话', () => {
  it('同一个群(改过名的也一样):钉住原来那个文件的那一版,不另建;转去别的群照旧建自己的条目', async () => {
    const group = await newGroup(owner, [member])
    const target = await newGroup(member, [owner])
    const sent = await commit(owner, (await upload(owner, `f-${randomUUID()}`, PPTX, 100)).key, randomUUID(), group, owner, 'deck.pptx')
    // 名字和信封里的不是同一系列了(原来的同会话转发会因此在「附件」里另建一个)。
    await asOwner()
    await database.query(`UPDATE chat.workspace_items SET filename = 'renamed.pptx' WHERE id = $1`, [sent.file_item_id])
    const before = await itemCount(group)
    await asUser(member)
    const [inside] = (await database.query<Message>(FORWARD, [sent.id, randomUUID(), group, member])).rows
    const [outside] = (await database.query<Message>(FORWARD, [sent.id, randomUUID(), target, member])).rows
    await asOwner()
    expect(inside).toMatchObject({ chat_id: group, file_item_id: sent.file_item_id, file_version: sent.file_version, forwarded_from_message_id: sent.id })
    expect(await itemCount(group)).toBe(before)
    expect(outside!.file_item_id).not.toBe(sent.file_item_id)
    expect((await item(outside!.file_item_id!)).chat_id).toBe(target)
  })
})

describe('历史与搜索带上条目', () => {
  it('message_history_as / message_search_as 回 file_item_id、file_version;普通消息两列为空', async () => {
    const group = await newGroup(owner, [member, agent])
    const sent = await commit(owner, (await upload(owner, `h-${randomUUID()}`, PPTX, 100)).key, randomUUID(), group, owner, 'deck.pptx')
    await asUser(owner)
    await database.query(SEND, [randomUUID(), group, owner, [], 'plain words', 'text', null, null])
    const history = (await database.query<{ id: string; file_item_id: string | null; file_version: number | null }>('SELECT * FROM chat.message_history_as($1,$2)', [group, agent])).rows
    const found = (await database.query<{ id: string; file_item_id: string | null; file_version: number | null }>('SELECT * FROM chat.message_search_as($1,$2,$3)', [group, 'deck', agent])).rows
    await asOwner()
    expect(history.find((r) => r.id === sent.id)).toMatchObject({ file_item_id: sent.file_item_id, file_version: 1 })
    expect(history.find((r) => r.id !== sent.id)).toMatchObject({ file_item_id: null, file_version: null })
    expect(found).toEqual([expect.objectContaining({ id: sent.id, file_item_id: sent.file_item_id, file_version: 1 })])
  })
})

describe('执行权', () => {
  it('attachment_share、attachment_document_snapshot 和两个放条目的 definer 给 authenticated、不给 anon;重建的 attachment_commit / attachment_place_forward 照旧给 authenticated', async () => {
    await asOwner()
    const { rows } = await database.query<{ fn: string; anon: boolean; auth: boolean }>(`
      SELECT p.proname AS fn, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'chat' AND p.proname IN ('attachment_document_snapshot','attachment_share','attachment_place_share','attachment_place_version','attachment_commit','attachment_place_forward','message_history_as','message_search_as')
       ORDER BY 1`)
    expect(rows.map((row) => row.fn)).toEqual(['attachment_commit', 'attachment_document_snapshot', 'attachment_place_forward', 'attachment_place_share', 'attachment_place_version', 'attachment_share', 'message_history_as', 'message_search_as'])
    for (const row of rows) expect(row, row.fn).toMatchObject({ anon: false, auth: true })
  })
})
