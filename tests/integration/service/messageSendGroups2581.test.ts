import { createFixtureGroup } from '../../support/groupFixture'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * Files sent at once are one message (migration *_message_send_groups, gugu#2581): each file commits as its own row,
 * the rows of one send share send_group_id and say how many files the send holds. The view, the chat list preview,
 * the agent inbox and the unread counts read the group; rows sent on their own read as before.
 * Every case runs inside BEGIN…ROLLBACK.
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
let sender: string
let reader: string
let agent: string
let group: string

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
    const e = error as Error & { hint?: string }
    return `${e.message} | hint: ${e.hint ?? ''}`
  }
  await database.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
async function human(name: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@message-send-groups.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'message-send-groups fixture','fixture','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(ownerId: string, name: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id)
    VALUES ($1,'agent',$2,$3,true,$4)`, [id, name, ownerId, `dev-${ownerId}`])
  return id
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
/** What the attachments function does once it has read the bytes: an upload registered for `by` (service_role). */
async function upload(by: string, type = 'image/png'): Promise<string> {
  const key = `staging/${by}/${randomUUID()}`
  await asServiceRole()
  await database.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5,$6,$7)', [by, key, sha(randomUUID()), 1234, type, 640, 480])
  await asOwner()
  return key
}
type Sent = { id: string; send_group_id: string | null; send_group_size: number | null; content: string }
const COMMIT = 'SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,false,NULL,$7,NULL,NULL,$8,$9)'
/** One file of a send, committed by `sender` as the composer does: `to` addresses, `caption` on the last file. */
async function commit(name: string, sendGroup: { id: string; size: number } | null, opts: { to?: string[]; caption?: string } = {}): Promise<Sent> {
  const key = await upload(sender)
  await asUser(sender)
  const { rows } = await database.query<Sent>(COMMIT,
    [key, randomUUID(), group, sender, name, opts.to ?? [], opts.caption ?? null, sendGroup?.id ?? null, sendGroup?.size ?? null])
  await asOwner()
  return rows[0]!
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('messageSendGroups2581.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  sender = await human('Sender')
  reader = await human('Reader')
  agent = await agentOf(reader, 'Reader Agent')
  group = randomUUID()
  await asUser(sender)
  await createFixtureGroup(database, [group, 'Send groups', sender, JSON.stringify([reader, agent].map((user_id) => ({ user_id, role: 'member' })))])
  await asOwner()
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

describe('#2581 a send of several files', () => {
  it('every file row carries the send and its size; a file sent on its own, and the commit after a send, carry neither', async () => {
    const send = { id: randomUUID(), size: 3 }
    const rows = [await commit('a.png', send), await commit('b.png', send), await commit('c.png', send, { caption: 'three of them' })]
    expect(rows.map((row) => [row.send_group_id, row.send_group_size])).toEqual([[send.id, 3], [send.id, 3], [send.id, 3]])
    expect(rows[2]!.content).toContain('three of them')
    const alone = await commit('d.png', null)
    expect([alone.send_group_id, alone.send_group_size]).toEqual([null, null])
    await asUser(reader)
    const seen = await database.query<Sent>('SELECT id, send_group_id, send_group_size, content FROM chat.messages_view WHERE chat_id = $1 ORDER BY seq', [group])
    await asOwner()
    expect(seen.rows.map((row) => row.send_group_id)).toEqual([send.id, send.id, send.id, null])
  })

  it('a send names its group and its size together, two to ten files', async () => {
    const key = await upload(sender)
    await asUser(sender)
    const args = (id: string | null, size: number | null) => [key, randomUUID(), group, sender, 'a.png', [], null, id, size]
    expect(await fails(COMMIT, args(randomUUID(), null))).toMatch(/hint: send_group_invalid/)
    expect(await fails(COMMIT, args(null, 3))).toMatch(/hint: send_group_invalid/)
    expect(await fails(COMMIT, args(randomUUID(), 1))).toMatch(/hint: send_group_invalid/)
    expect(await fails(COMMIT, args(randomUUID(), 11))).toMatch(/hint: send_group_invalid/)
    // Positive control: the same upload commits with a valid send.
    const ok = (await database.query<Sent>(COMMIT, args(randomUUID(), 10))).rows[0]!
    await asOwner()
    expect(ok.send_group_size).toBe(10)
  })

  it('unread counts a send once; the chat list preview says how many files the latest send holds', async () => {
    const send = { id: randomUUID(), size: 3 }
    await commit('a.png', send)
    await commit('b.png', send)
    await commit('c.png', send)
    await asUser(reader)
    const unread = await database.query<{ unread_count: string }>("SELECT unread_count FROM chat.list_unread_locators($1) WHERE stream_kind = 'main'", [group])
    expect(unread.rows.map((row) => Number(row.unread_count))).toEqual([1])
    const preview = await database.query<{ send_group_size: number | null }>('SELECT send_group_size FROM chat.list_chat_previews($1)', [[group]])
    expect(preview.rows.map((row) => row.send_group_size)).toEqual([3])
    await asOwner()
    // A file sent on its own still counts as one more, and is the latest preview without a size.
    await commit('d.png', null)
    await asUser(reader)
    const after = await database.query<{ unread_count: string }>("SELECT unread_count FROM chat.list_unread_locators($1) WHERE stream_kind = 'main'", [group])
    expect(after.rows.map((row) => Number(row.unread_count))).toEqual([2])
    const latest = await database.query<{ send_group_size: number | null }>('SELECT send_group_size FROM chat.list_chat_previews($1)', [[group]])
    expect(latest.rows.map((row) => row.send_group_size)).toEqual([null])
    const snapshot = (await database.query<{ s: { previews?: Array<{ chat_id: string; send_group_size?: number | null }> } }>('SELECT chat.sync_snapshot() AS s')).rows[0]!.s
    expect(snapshot.previews?.find((row) => row.chat_id === group)).toHaveProperty('send_group_size', null)
    await asOwner()
  })

  it('files forwarded together are one send where they land; a file forwarded on its own is not', async () => {
    const send = { id: randomUUID(), size: 2 }
    const sources = [await commit('a.png', send), await commit('b.png', send, { caption: 'both' })]
    const target = randomUUID()
    await asUser(sender)
    await createFixtureGroup(database, [target, 'Forwarded to', sender, JSON.stringify([{ user_id: reader, role: 'member' }])])
    const FORWARD = 'SELECT * FROM chat.attachment_forward($1,$2,$3,$4,$5,NULL,false,false,$6,$7)'
    const landed = { id: randomUUID(), size: 2 }
    const copies: Sent[] = []
    for (const source of sources) copies.push((await database.query<Sent>(FORWARD, [source.id, randomUUID(), target, sender, [], landed.id, landed.size])).rows[0]!)
    const alone = (await database.query<Sent>(FORWARD, [sources[0]!.id, randomUUID(), target, sender, [], null, null])).rows[0]!
    expect(await fails(FORWARD, [sources[0]!.id, randomUUID(), target, sender, [], landed.id, null])).toMatch(/hint: send_group_invalid/)
    await asOwner()
    expect(copies.map((row) => [row.send_group_id, row.send_group_size])).toEqual([[landed.id, 2], [landed.id, 2]])
    expect(copies[1]!.content).toContain('both')
    expect([alone.send_group_id, alone.send_group_size]).toEqual([null, null])
  })

  it('the agent inbox hands each row over with its send', async () => {
    const send = { id: randomUUID(), size: 2 }
    await commit('a.png', send, { to: [agent] })
    await commit('b.png', send, { to: [agent], caption: 'for you' })
    await asUser(reader)
    const rows = await database.query<{ send_group_id: string | null; send_group_size: number | null; content: string }>(
      'SELECT send_group_id, send_group_size, content FROM identity.pull_agent_inbox_v2($1,$2)', [agent, group])
    await asOwner()
    expect(rows.rows.map((row) => [row.send_group_id, row.send_group_size])).toEqual([[send.id, 2], [send.id, 2]])
    expect(rows.rows[1]!.content).toContain('for you')
  })
})
