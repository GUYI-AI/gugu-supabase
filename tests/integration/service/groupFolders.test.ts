import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BEGIN_READING_REVISIONS } from '../../support/revisionTransaction'

/**
 * A group is the only container; folders on a device are an optional attribute of a group
 * (20261120130000_group_folders).
 *
 *   · identity.publish_chat_folders binds a device's folders to groups the caller is an active member of, replaces the
 *     device's whole set, refuses the rest by folder id, and advances the account revision only on a change;
 *   · identity.my_chat_folders lists the caller's folders by group, and nothing to anyone else;
 *   · any group holding folders admits anyone the ordinary rules admit (no owner-only rule), and group_info_as no longer
 *     classifies groups;
 *   · a device-held version is held while its device binds, in its chat, the folder it names: a folder id, or a root
 *     folder that came from the released client's project the version names — not an attached one, and not after the
 *     root is detached;
 *   · the removed project objects are gone.
 * Every negative assertion has a positive control; every case runs inside BEGIN…ROLLBACK.
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let db: DatabaseClient

async function as(account: string | null): Promise<void> {
  await db.query(`SET LOCAL role TO ${account ? 'authenticated' : 'anon'}`)
  await db.query("SELECT set_config('request.jwt.claims', $1, true)",
    [JSON.stringify(account ? { sub: account, role: 'authenticated' } : { role: 'anon' })])
}
async function service(): Promise<void> { await db.query('RESET role') }
async function fails(sql: string, values?: unknown[]): Promise<string> {
  await db.query('SAVEPOINT expected_failure')
  try { await db.query(sql, values) } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT expected_failure')
    return String((error as Error).message)
  }
  await db.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
async function human(name = 'person'): Promise<string> {
  await service()
  const id = randomUUID()
  await db.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`, [id, `${id}@group-folders.invalid`])
  await db.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human',$2) ON CONFLICT (id) DO NOTHING`, [id, name])
  return id
}
async function device(owner: string): Promise<string> {
  await service()
  const id = `group-folders-${randomUUID()}`
  await db.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform) VALUES ($1,$2,'Studio','host','linux')`, [id, owner])
  return id
}
async function group(owner: string, name = 'Work'): Promise<string> {
  await service()
  const id = randomUUID()
  await db.query(`INSERT INTO chat.chats (id,kind,name,creator_user_id) VALUES ($1,'group',$2,$3)`, [id, name, owner])
  await db.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'owner')`, [id, owner])
  return id
}
async function join(chat: string, user: string): Promise<void> {
  await service()
  await db.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')`, [chat, user])
}
type Folder = { folder_id: string; chat_id: string; path: string; attached_at?: string | null }
async function publish(owner: string, deviceId: string, folders: Folder[], applied: Record<string, string> = {}) {
  await as(owner)
  const { rows } = await db.query<{ r: { changed: boolean; rejected: string[] } }>(
    'SELECT identity.publish_chat_folders($1,$2::jsonb,$3::jsonb) AS r', [deviceId, JSON.stringify(folders), JSON.stringify(applied)])
  await service()
  return rows[0]!.r
}
async function mine(account: string) {
  await as(account)
  const { rows } = await db.query<{ r: { chat_id: string; name: string; folders: { device_id: string; folder_id: string; path: string; position: number }[] }[] }>(
    'SELECT identity.my_chat_folders() AS r')
  await service()
  return rows[0]!.r
}
async function revisions(owner: string, deviceId: string): Promise<number> {
  await service()
  return Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM chat.account_revisions WHERE user_id = $1 AND event = 'device_changed'
    AND resource_key = jsonb_build_object('device_id', $2::text, 'kind', 'projects')`, [owner, deviceId])).rows[0]!.n)
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('groupFolders.test requires a loopback PostgreSQL database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => { await db.query(BEGIN_READING_REVISIONS) })
afterEach(async () => { if (db) { await service(); await db.query('ROLLBACK') } })

describe('identity.publish_chat_folders / identity.my_chat_folders', () => {
  it('binds folders to groups the caller is a member of, in the order given, for the caller only', async () => {
    const owner = await human(), laptop = await device(owner)
    const [work, home] = [await group(owner, 'Work'), await group(owner, 'Home')]
    expect(await publish(owner, laptop, [
      { folder_id: 'ws-api', chat_id: work, path: '/code/api' },
      { folder_id: 'ws-notes', chat_id: home, path: '/notes' },
      { folder_id: 'ws-web', chat_id: work, path: '/code/web', attached_at: '2026-11-19T10:00:00+00:00' },
    ])).toEqual({ changed: true, rejected: [] })
    const listed = await mine(owner)
    expect(listed.map((g) => g.name).sort()).toEqual(['Home', 'Work'])
    expect(listed.find((g) => g.chat_id === work)!.folders.map(({ folder_id, position }) => ({ folder_id, position })))
      .toEqual([{ folder_id: 'ws-api', position: 1 }, { folder_id: 'ws-web', position: 2 }])
    expect(await mine(await human())).toEqual([])
    await as(await human())
    expect((await db.query('SELECT * FROM identity.chat_folders')).rows).toEqual([])
    await service()
  })

  it('refuses a group the caller is not an active member of, and an id with no group (control: a member binds it)', async () => {
    const owner = await human(), stranger = await human(), laptop = await device(owner)
    const theirs = await group(stranger)
    expect(await publish(owner, laptop, [
      { folder_id: 'ws-a', chat_id: theirs, path: '/a' },
      { folder_id: 'ws-b', chat_id: randomUUID(), path: '/b' },
    ])).toEqual({ changed: false, rejected: ['ws-a', 'ws-b'] })
    expect(await mine(owner)).toEqual([])
    await join(theirs, owner)
    expect(await publish(owner, laptop, [{ folder_id: 'ws-a', chat_id: theirs, path: '/a' }])).toEqual({ changed: true, rejected: [] })
    expect((await mine(owner)).map((g) => g.chat_id)).toEqual([theirs])
  })

  it('replaces the device set and advances the account revision only on a change', async () => {
    const owner = await human(), laptop = await device(owner), server = await device(owner), work = await group(owner)
    await publish(owner, server, [{ folder_id: 'ws-srv', chat_id: work, path: '/srv' }])
    const before = await revisions(owner, laptop)
    expect((await publish(owner, laptop, [{ folder_id: 'ws-a', chat_id: work, path: '/a' }])).changed).toBe(true)
    expect(await revisions(owner, laptop)).toBe(before + 1)
    expect((await publish(owner, laptop, [{ folder_id: 'ws-a', chat_id: work, path: '/a' }])).changed).toBe(false)
    expect(await revisions(owner, laptop)).toBe(before + 1)
    expect((await publish(owner, laptop, [{ folder_id: 'ws-b', chat_id: work, path: '/b' }])).changed).toBe(true)
    expect((await mine(owner))[0]!.folders.map((f) => f.folder_id).sort()).toEqual(['ws-b', 'ws-srv'])
  })

  it("refuses another account's device, anonymous callers and malformed lists (control: the owner publishes)", async () => {
    const owner = await human(), laptop = await device(owner), work = await group(owner)
    await as(await human())
    expect(await fails('SELECT identity.publish_chat_folders($1,$2::jsonb)', [laptop, '[]'])).toMatch(/not owned by current user/)
    await as(null)
    expect(await fails('SELECT identity.publish_chat_folders($1,$2::jsonb)', [laptop, '[]'])).toMatch(/permission denied/)
    await as(null)
    expect(await fails('SELECT * FROM identity.chat_folders')).toMatch(/permission denied/)
    for (const [bad, message] of [
      [{ not: 'array' }, /must be an array/],
      [[{ folder_id: 'x', chat_id: work, path: '/x' }, { folder_id: 'x', chat_id: work, path: '/y' }], /published once/],
      [[{ folder_id: 'device-store', chat_id: work, path: '/x' }], /Invalid folder/],
      [[{ folder_id: 'x', chat_id: work, path: '' }], /Invalid folder/],
      [[{ folder_id: 'x', chat_id: work, path: '/x', attached_at: 'soon' }], /Invalid folder/],
    ] as [unknown, RegExp][]) {
      await as(owner)
      expect(await fails('SELECT identity.publish_chat_folders($1,$2::jsonb)', [laptop, JSON.stringify(bad)])).toMatch(message)
    }
    await as(owner)
    expect(await fails("INSERT INTO identity.chat_folders (device_id,user_id,folder_id,chat_id,path,position,created_at) VALUES ($1,$2,'x',$3,'/x',1,now())",
      [laptop, owner, work])).toMatch(/permission denied/)
    expect((await publish(owner, laptop, [{ folder_id: 'x', chat_id: work, path: '/x' }])).changed).toBe(true)
  })

  it('goes with its device and with its group', async () => {
    const owner = await human(), laptop = await device(owner), [a, b] = [await group(owner), await group(owner)]
    await publish(owner, laptop, [{ folder_id: 'ws-a', chat_id: a, path: '/a' }, { folder_id: 'ws-b', chat_id: b, path: '/b' }])
    await db.query('DELETE FROM chat.chats WHERE id = $1', [a])
    expect((await mine(owner)).map((g) => g.chat_id)).toEqual([b])
    await db.query('DELETE FROM identity.gugu_devices WHERE device_id = $1', [laptop])
    expect(await mine(owner)).toEqual([])
  })
})

describe('a group holding folders is an ordinary group', () => {
  it('admits other people and their agents under the ordinary rules', async () => {
    const owner = await human(), colleague = await human(), laptop = await device(owner), work = await group(owner)
    const theirAgent = randomUUID()
    await db.query(`INSERT INTO identity.users (id,type,display_name,owner_user_id,device_id) VALUES ($1,'agent','theirs',$2,$3)`,
      [theirAgent, colleague, await device(colleague)])
    await publish(owner, laptop, [{ folder_id: 'ws', chat_id: work, path: '/w' }])
    const denial = async (user: string, consent = false) => (await db.query<{ d: string | null }>(
      'SELECT chat.group_add_denial($1,$2,$3,true,$4) AS d', [work, user, owner, consent])).rows[0]!.d
    expect(await denial(colleague)).toBeNull()
    // Another person's agent still needs its owner's consent, as in any group.
    expect(await denial(theirAgent)).toBe('agent_not_owned')
    expect(await denial(theirAgent, true)).toBeNull()
  })

  it('no longer classifies groups in group_info_as', async () => {
    const owner = await human(), laptop = await device(owner), work = await group(owner)
    await publish(owner, laptop, [{ folder_id: 'ws', chat_id: work, path: '/w' }])
    await as(owner)
    const info = (await db.query<{ i: Record<string, unknown> }>('SELECT chat.group_info_as($1,$2) AS i', [work, owner])).rows[0]!.i
    expect(info).toMatchObject({ id: work, name: 'Work' })
    expect(info).not.toHaveProperty('is_project_group')
  })

  it('has no project marker left', async () => {
    const leftovers = (await db.query<{ name: string }>(`SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'chat' AND p.proname IN ('is_project_group','is_project_owner','may_bind_project_group')`)).rows
    expect(leftovers).toEqual([])
    expect((await db.query<{ t: string | null }>("SELECT to_regclass('chat.project_groups')::text AS t")).rows[0]!.t).toBeNull()
  })
})

describe('chat.device_holds', () => {
  const holds = async (deviceId: string, ref: string, chat: string) =>
    (await db.query<{ h: boolean }>('SELECT chat.device_holds($1,$2,$3) AS h', [deviceId, ref, chat])).rows[0]!.h
  const released = (id: string, chat: string, folders: { workspace_id: string; kind: 'root' | 'attached'; path: string }[]) => ({
    local_project_id: id, name: id, root_path: '/p', created_at: '2026-11-01T00:00:00+00:00', chat_id: chat, folders,
  })
  const v2 = async (owner: string, deviceId: string, projects: unknown[]) => {
    await as(owner)
    await db.query('SELECT identity.publish_device_projects_v2($1,$2::jsonb)', [deviceId, JSON.stringify(projects)])
    await service()
  }

  it('holds a folder id, and a released project id through its root folder only', async () => {
    const owner = await human(), laptop = await device(owner), work = await group(owner), other = await group(owner)
    await v2(owner, laptop, [released('proj', work, [{ workspace_id: 'ws-root', kind: 'root', path: '/p' }, { workspace_id: 'ws-att', kind: 'attached', path: '/q' }])])
    expect(await holds(laptop, 'ws-root', work)).toBe(true)
    expect(await holds(laptop, 'ws-att', work)).toBe(true)
    expect(await holds(laptop, 'proj', work)).toBe(true)
    expect(await holds(laptop, 'proj', other)).toBe(false)
    expect(await holds(laptop, 'device-store', other)).toBe(true)
    // The root detached: versions named by the project (relative to its root) are no longer held; the attached folder is.
    await v2(owner, laptop, [released('proj', work, [{ workspace_id: 'ws-att', kind: 'attached', path: '/q' }])])
    expect(await holds(laptop, 'proj', work)).toBe(false)
    expect(await holds(laptop, 'ws-att', work)).toBe(true)
  })

  it('keeps a folder that came from a released project holding that project when a newer client republishes it', async () => {
    const owner = await human(), laptop = await device(owner), work = await group(owner)
    await v2(owner, laptop, [released('proj', work, [{ workspace_id: 'ws-root', kind: 'root', path: '/p' }])])
    expect((await publish(owner, laptop, [{ folder_id: 'ws-root', chat_id: work, path: '/p' }])).changed).toBe(false)
    expect(await holds(laptop, 'proj', work)).toBe(true)
    expect(await holds(laptop, 'ws-root', work)).toBe(true)
  })

  it('shows a released client only its own rows of the old view', async () => {
    const owner = await human(), laptop = await device(owner), work = await group(owner)
    await publish(owner, laptop, [{ folder_id: 'ws-new', chat_id: work, path: '/home/me/new' }])
    await as(owner)
    expect((await db.query('SELECT local_project_id, name, root_path, chat_id FROM identity.device_projects')).rows)
      .toEqual([{ local_project_id: 'ws-new', name: 'new', root_path: '/home/me/new', chat_id: work }])
    await as(await human())
    expect((await db.query('SELECT * FROM identity.device_projects')).rows).toEqual([])
    await service()
  })
})
