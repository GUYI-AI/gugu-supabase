import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A project is its project group, and the group records it (migration 20261109210000_project_is_group).
 *
 *   · a device row bound to a group its account owns marks the group; someone else's device row does not;
 *   · a group created under an id a device row already reserved is marked on creation;
 *   · publishing never clears the mark: removing every folder leaves the project;
 *   · identity.list_my_projects lists the caller's projects by the group's own name and status, with the folders of the
 *     caller's devices (none is a valid answer), and nothing to anyone else.
 * Every case runs in BEGIN…ROLLBACK.
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
      await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)`, [id, name])
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

async function createGroup(id: string, creator: string, name = 'work'): Promise<void> {
  await database.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group',$2,$3)`, [id, name, creator])
  await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner')`, [id, creator])
}

async function bind(account: string, device: 'a' | 'b', chatId: string, localId = randomUUID(), path = '/work'): Promise<string> {
  await database.query(
    `INSERT INTO identity.device_projects (device_id, user_id, local_project_id, name, root_path, created_at, chat_id, folders)
     VALUES ($1,$2,$3,'local-name',$4,now(),$5,$6::jsonb)`,
    [`dev-${device}-${account}`, account, localId, path, chatId,
      JSON.stringify([{ workspace_id: `ws-${localId}`, kind: 'root', path, attached_at: new Date().toISOString() }])],
  )
  return localId
}

async function isProject(chatId: string): Promise<boolean> {
  return (await database.query<{ p: boolean }>('SELECT is_project AS p FROM chat.chats WHERE id=$1', [chatId])).rows[0]!.p
}

type Listed = { chat_id: string; name: string; status: string; bindings: { device_id: string; local_project_id: string; root_path: string }[] }

async function listAs(account: string): Promise<Listed[]> {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: account, role: 'authenticated' })])
  const { rows } = await database.query<{ r: Listed[] }>('SELECT identity.list_my_projects() AS r')
  await database.query('RESET role')
  return rows[0]!.r
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('projectIsGroup.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })

describe('the project group records that it is a project', () => {
  it('a device row of the group owner marks the group; an ordinary group stays ordinary', () => inRollback(async () => {
    const work = randomUUID()
    const plain = randomUUID()
    await createGroup(work, owner)
    await createGroup(plain, owner, 'chat')
    expect(await isProject(work)).toBe(false)
    await bind(owner, 'a', work)
    expect(await isProject(work)).toBe(true)
    expect(await isProject(plain)).toBe(false)
  }))

  it("another account's device row naming my group does not make it a project", () => inRollback(async () => {
    const mine = randomUUID()
    await createGroup(mine, owner)
    await bind(colleague, 'a', mine)
    expect(await isProject(mine)).toBe(false)
  }))

  it('a group created under an id already reserved by its creator is a project from creation', () => inRollback(async () => {
    const reserved = randomUUID()
    await bind(owner, 'a', reserved)
    await createGroup(reserved, owner)
    expect(await isProject(reserved)).toBe(true)
  }))

  it('rebinding an existing row to a group marks that group (UPDATE OF chat_id)', () => inRollback(async () => {
    const first = randomUUID()
    const second = randomUUID()
    await createGroup(first, owner)
    await createGroup(second, owner, 'second')
    const local = await bind(owner, 'a', first)
    await database.query('UPDATE identity.device_projects SET chat_id=$1 WHERE local_project_id=$2', [second, local])
    expect(await isProject(second)).toBe(true)
  }))

  it('removing every folder binding keeps the project', () => inRollback(async () => {
    const work = randomUUID()
    await createGroup(work, owner)
    await bind(owner, 'a', work)
    await bind(owner, 'b', work)
    await database.query('DELETE FROM identity.device_projects WHERE chat_id=$1', [work])
    expect(await isProject(work)).toBe(true)
    expect((await listAs(owner)).map((p) => [p.chat_id, p.bindings.length])).toEqual([[work, 0]])
  }))
})

describe('identity.list_my_projects', () => {
  it("lists one project per group with every device's folder, under the group's own name", () => inRollback(async () => {
    const work = randomUUID()
    await createGroup(work, owner)
    const onA = await bind(owner, 'a', work, undefined, '/root/work')
    const onB = await bind(owner, 'b', work, undefined, '/home/me/work')
    await database.query("UPDATE chat.chats SET name='work renamed' WHERE id=$1", [work])
    const listed = await listAs(owner)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ chat_id: work, name: 'work renamed', status: 'active' })
    expect(listed[0]!.bindings.map((b) => [b.device_id, b.local_project_id, b.root_path]).sort()).toEqual([
      [`dev-a-${owner}`, onA, '/root/work'],
      [`dev-b-${owner}`, onB, '/home/me/work'],
    ])
  }))

  it('shows nothing of my projects to another account, even a member of the group', () => inRollback(async () => {
    const work = randomUUID()
    await createGroup(work, owner)
    await bind(owner, 'a', work)
    await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`, [work, colleague])
    expect(await listAs(colleague)).toEqual([])
  }))

  it('reports an archived project group as archived rather than dropping it', () => inRollback(async () => {
    const work = randomUUID()
    await createGroup(work, owner)
    await bind(owner, 'a', work)
    await database.query("UPDATE chat.chats SET status='archived' WHERE id=$1", [work])
    expect((await listAs(owner)).map((p) => p.status)).toEqual(['archived'])
  }))

  it('is not callable anonymously', () => inRollback(async () => {
    const { rows } = await database.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('anon','identity.list_my_projects()','EXECUTE') AS allowed")
    expect(rows[0]!.allowed).toBe(false)
  }))
})
