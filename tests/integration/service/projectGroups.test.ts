import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A project is its project group, and the account records which groups are projects
 * (migration 20261109210000_project_groups).
 *
 *   · publishing a project bound to a group the account owns records the group; binding someone else's group does not;
 *   · an id reserved before its group exists is recorded, and is a project group once the group is created;
 *   · publishing never unrecords: a project whose every folder is gone is still a project;
 *   · identity.list_my_projects lists the caller's projects by the group's own name and status, with the folders of the
 *     caller's devices (none is a valid answer), and nothing to anyone else.
 * Every case runs in BEGIN…ROLLBACK, through the real publish_device_projects RPC as the device's owner.
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
let colleague: string

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    owner = randomUUID()
    colleague = randomUUID()
    for (const [id, name] of [[owner, 'owner'], [colleague, 'colleague']]) {
      await database.query('INSERT INTO auth.users (id) VALUES ($1)', [id])
      await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2) ON CONFLICT (id) DO NOTHING`, [id, name])
      for (const suffix of ['a', 'b']) {
        await database.query(
          `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1,$2,'pg','pg','linux')`,
          [`dev-${suffix}-${id}`, id],
        )
      }
    }
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

async function as<T>(account: string, body: () => Promise<T>): Promise<T> {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: account, role: 'authenticated' })])
  try {
    return await body()
  } finally {
    await database.query('RESET role')
  }
}

async function createGroup(id: string, creator: string, name = 'work'): Promise<void> {
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group',$2,$3)`, [id, name, creator])
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner')`, [id, creator])
}

type Published = { local: string; chat: string | null; path?: string }

/** The device's whole project list, as its host publishes it. */
async function publish(account: string, device: 'a' | 'b', projects: Published[]): Promise<void> {
  const payload = projects.map(({ local, chat, path = '/work' }) => ({
    local_project_id: local, name: 'local-name', root_path: path, created_at: new Date().toISOString(), chat_id: chat,
    folders: [{ workspace_id: `ws-${local}`, kind: 'root', path, attached_at: new Date().toISOString() }],
  }))
  await as(account, () => database.query('SELECT identity.publish_device_projects($1,$2::jsonb)', [`dev-${device}-${account}`, JSON.stringify(payload)]))
}

async function recorded(chatId: string): Promise<boolean> {
  return (await database.query<{ p: boolean }>('SELECT EXISTS (SELECT 1 FROM chat.project_groups WHERE chat_id=$1) AS p', [chatId])).rows[0]!.p
}

type Listed = { chat_id: string; name: string; status: string; bindings: { device_id: string; local_project_id: string; root_path: string }[] }

async function listAs(account: string): Promise<Listed[]> {
  return as(account, async () => (await database.query<{ r: Listed[] }>('SELECT identity.list_my_projects() AS r')).rows[0]!.r)
}

async function infoAs(chatId: string, account: string): Promise<Record<string, unknown>> {
  return as(account, async () => (await database.query<{ i: Record<string, unknown> }>('SELECT chat.group_info_as($1,$2) AS i', [chatId, account])).rows[0]!.i)
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('projectGroups.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })

describe('publishing records the project group', () => {
  it("a project bound to the owner's group records it; an ordinary group stays ordinary", () => inRollback(async () => {
    const work = randomUUID()
    const plain = randomUUID()
    await createGroup(work, owner)
    await createGroup(plain, owner, 'chat')
    expect(await recorded(work)).toBe(false)
    await publish(owner, 'a', [{ local: 'p1', chat: work }, { local: 'p2', chat: null }])
    expect(await recorded(work)).toBe(true)
    expect(await recorded(plain)).toBe(false)
    expect((await infoAs(work, owner)).is_project_group).toBe(true)
    expect((await infoAs(plain, owner)).is_project_group).toBe(false)
  }))

  it("binding a project to another account's group does not make it a project group", () => inRollback(async () => {
    const theirs = randomUUID()
    await createGroup(theirs, owner)
    await publish(colleague, 'a', [{ local: 'p1', chat: theirs }])
    expect(await recorded(theirs)).toBe(false)
  }))

  // 20261112011000: v2 is the only implementation and reports the rows whose group was refused; the old name wraps it.
  it('publish_device_projects_v2 reports the refused bindings; the old name answers whether anything changed', () => inRollback(async () => {
    const mine = randomUUID()
    const theirs = randomUUID()
    await createGroup(mine, colleague, 'mine')
    await createGroup(theirs, owner)
    const payload = (rows: Published[]) => JSON.stringify(rows.map(({ local, chat, path = '/work' }) => ({
      local_project_id: local, name: 'n', root_path: path, created_at: '2026-11-01T00:00:00.000Z', chat_id: chat,
      folders: [{ workspace_id: `ws-${local}`, kind: 'root', path, attached_at: null }],
    })))
    const v2 = await as(colleague, async () => (await database.query<{ r: { changed: boolean; rejected: string[] } }>(
      'SELECT identity.publish_device_projects_v2($1,$2::jsonb) AS r', [`dev-a-${colleague}`, payload([{ local: 'own', chat: mine }, { local: 'foreign', chat: theirs }])])).rows[0]!.r)
    expect(v2).toEqual({ changed: true, rejected: ['foreign'] })
    const again = await as(colleague, async () => (await database.query<{ r: boolean }>(
      'SELECT identity.publish_device_projects($1,$2::jsonb) AS r', [`dev-a-${colleague}`, payload([{ local: 'own', chat: mine }, { local: 'foreign', chat: theirs }])])).rows[0]!.r)
    expect(again).toBe(false)
  }))

  it("in one publish, a row naming someone else's group is kept without it; the other rows are written as sent", () => inRollback(async () => {
    const mine = randomUUID()
    const theirs = randomUUID()
    await createGroup(mine, colleague, 'mine')
    await createGroup(theirs, owner)
    await publish(colleague, 'a', [{ local: 'own', chat: mine }, { local: 'foreign', chat: theirs }, { local: 'plain', chat: null }])
    const rows = (await database.query<{ local_project_id: string; chat_id: string | null }>(
      'SELECT local_project_id, chat_id FROM identity.device_projects WHERE device_id=$1 ORDER BY local_project_id', [`dev-a-${colleague}`])).rows
    expect(rows).toEqual([
      { local_project_id: 'foreign', chat_id: null },
      { local_project_id: 'own', chat_id: mine },
      { local_project_id: 'plain', chat_id: null },
    ])
    expect(await recorded(mine)).toBe(true)
    expect(await recorded(theirs)).toBe(false)
  }))

  it("a former member who knows the group id learns nothing about the owner's project by binding it", () => inRollback(async () => {
    const work = randomUUID()
    await createGroup(work, owner)
    await publish(owner, 'a', [{ local: 'p1', chat: work }])
    // The colleague was in the group once and kept its id.
    await publish(colleague, 'a', [{ local: 'stolen', chat: work }])
    expect(await listAs(colleague)).toEqual([])
    expect((await database.query('SELECT chat_id FROM identity.device_projects WHERE local_project_id=$1', ['stolen'])).rows).toEqual([{ chat_id: null }])
  }))

  it('an id reserved before its group exists is a project group once the group is created', () => inRollback(async () => {
    const reserved = randomUUID()
    await publish(owner, 'a', [{ local: 'p1', chat: reserved }])
    expect(await recorded(reserved)).toBe(true)
    await createGroup(reserved, owner)
    expect((await infoAs(reserved, owner)).is_project_group).toBe(true)
  }))

  it('a project whose every folder is gone is still a project', () => inRollback(async () => {
    const work = randomUUID()
    await createGroup(work, owner)
    await publish(owner, 'a', [{ local: 'p1', chat: work }])
    await publish(owner, 'b', [{ local: 'p2', chat: work }])
    await publish(owner, 'a', [])
    await publish(owner, 'b', [])
    expect((await database.query('SELECT 1 FROM identity.device_projects WHERE chat_id=$1', [work])).rows).toHaveLength(0)
    expect(await recorded(work)).toBe(true)
    expect((await infoAs(work, owner)).is_project_group).toBe(true)
    expect((await listAs(owner)).map((p) => [p.chat_id, p.bindings.length])).toEqual([[work, 0]])
  }))
})

describe('identity.list_my_projects', () => {
  it("lists one project per group with every device's folder, under the group's own name", () => inRollback(async () => {
    const work = randomUUID()
    await createGroup(work, owner)
    await publish(owner, 'a', [{ local: 'onA', chat: work, path: '/root/work' }])
    await publish(owner, 'b', [{ local: 'onB', chat: work, path: '/home/me/work' }])
    await database.query("UPDATE chat.chats SET name='work renamed' WHERE id=$1", [work])
    const listed = await listAs(owner)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ chat_id: work, name: 'work renamed', status: 'active' })
    expect(listed[0]!.bindings.map((b) => [b.device_id, b.local_project_id, b.root_path]).sort()).toEqual([
      [`dev-a-${owner}`, 'onA', '/root/work'],
      [`dev-b-${owner}`, 'onB', '/home/me/work'],
    ])
  }))

  // 20261112010000: an id reserved before its group exists is a project too; it is listed by its device row's name.
  it('lists a reserved project whose group does not exist yet, by the name on my device row', () => inRollback(async () => {
    const reserved = randomUUID()
    await publish(owner, 'a', [{ local: 'early', chat: reserved, path: '/early' }])
    const listed = await listAs(owner)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ chat_id: reserved, name: 'local-name', status: 'active' })
    expect(listed[0]!.bindings.map((b) => [b.device_id, b.local_project_id])).toEqual([[`dev-a-${owner}`, 'early']])
    // Not someone else's: another account sees nothing of it.
    expect(await listAs(colleague)).toEqual([])
    // Once the group exists it is listed once, by the group's own name.
    await createGroup(reserved, owner, 'grown up')
    expect((await listAs(owner)).map((p) => [p.chat_id, p.name])).toEqual([[reserved, 'grown up']])
  }))

  it('shows nothing of my projects to another account, even a member of the group', () => inRollback(async () => {
    const work = randomUUID()
    await createGroup(work, owner)
    await publish(owner, 'a', [{ local: 'p1', chat: work }])
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`, [work, colleague])
    expect(await listAs(colleague)).toEqual([])
  }))

  it('reports an archived project group as archived rather than dropping it', () => inRollback(async () => {
    const work = randomUUID()
    await createGroup(work, owner)
    await publish(owner, 'a', [{ local: 'p1', chat: work }])
    await database.query("UPDATE chat.chats SET status='archived' WHERE id=$1", [work])
    expect((await listAs(owner)).map((p) => p.status)).toEqual(['archived'])
  }))

  it('the record table and helpers are not reachable by clients', () => inRollback(async () => {
    const { rows } = await database.query<{ anon: boolean; table: boolean; helper: boolean }>(`SELECT
      has_function_privilege('anon','identity.list_my_projects()','EXECUTE') AS anon,
      has_table_privilege('authenticated','chat.project_groups','SELECT') AS table,
      has_function_privilege('authenticated','chat.is_project_group(text)','EXECUTE') AS helper`)
    expect(rows[0]).toEqual({ anon: false, table: false, helper: false })
  }))
})
