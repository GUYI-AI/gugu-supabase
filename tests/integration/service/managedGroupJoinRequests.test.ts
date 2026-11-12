import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * `list_managed_group_join_requests` = `list_group_join_requests` over every group the actor manages, in one read.
 * The rows, their order and the authority are the per-group function's: the equality case compares them directly.
 * Each case runs in BEGIN…ROLLBACK; every exclusion has a positive control.
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
type Request = { id: string; chat_id: string; created_at: Date; requester_user_id: string; status: string; requester_type: string; requested_by_user_id: string | null; requested_by_name: string | null }
let database: DatabaseClient
let owner: string
let admin: string
let member: string
let stranger: string

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asService() { await database.query('RESET role') }
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
  [id, `${id}@managed-join-requests.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  return id
}
/** A group owned by `owner`, with `admin` as admin and `member` as member. */
async function newGroup(name: string): Promise<string> {
  const id = randomUUID()
  await asUser(owner)
  await createFixtureGroup(database, [id, name, owner, JSON.stringify([{ user_id: admin, role: 'admin' }, { user_id: member, role: 'member' }])])
  await asService()
  return id
}
async function request(chatId: string, requester: string, status = 'pending', minutesAgo = 0): Promise<string> {
  await asService()
  const id = randomUUID()
  await database.query(`INSERT INTO chat.group_join_requests (id,chat_id,requester_user_id,status,created_at,updated_at)
    VALUES ($1,$2,$3,$4,now() - make_interval(mins => $5),now())`, [id, chatId, requester, status, minutesAgo])
  return id
}
async function managed(actor: string, includeDecided: boolean, as = actor): Promise<Request[]> {
  await asUser(actor)
  return (await database.query<Request>('SELECT * FROM chat.list_managed_group_join_requests($1,$2)', [includeDecided, as])).rows
}
async function perGroup(actor: string, chatId: string, includeDecided: boolean): Promise<Request[]> {
  await asUser(actor)
  return (await database.query<Request>('SELECT * FROM chat.list_group_join_requests($1,$2,auth.uid()::text)', [chatId, includeDecided])).rows
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('managedGroupJoinRequests.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  owner = await human('Owner'); admin = await human('Admin'); member = await human('Member'); stranger = await human('Stranger')
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

describe('join requests of every managed group in one read', () => {
  it('equals the per-group reads over the groups the actor manages, in the same order', async () => {
    const first = await newGroup('First'), second = await newGroup('Second')
    await request(first, stranger, 'pending', 5)
    await request(second, stranger, 'pending', 1)
    await request(second, await human('Old'), 'rejected', 30)
    for (const actor of [owner, admin]) for (const includeDecided of [false, true]) {
      const union = [...await perGroup(actor, first, includeDecided), ...await perGroup(actor, second, includeDecided)]
      union.sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.created_at.getTime() - a.created_at.getTime())
      expect(await managed(actor, includeDecided)).toEqual(union)
    }
    expect((await managed(owner, false)).map(row => row.chat_id)).toEqual([second, first])
    expect((await managed(owner, true)).map(row => row.status)).toEqual(['pending', 'pending', 'rejected'])
  })

  it('leaves out groups the actor does not manage: a plain member sees none, the manager sees them (positive control)', async () => {
    const group = await newGroup('Members only')
    await request(group, stranger)
    expect(await managed(member, true)).toEqual([])
    expect(await fails('SELECT * FROM chat.list_group_join_requests($1,false,auth.uid()::text)', [group])).toMatch(/group_manager_required/)
    expect((await managed(admin, false)).map(row => row.chat_id)).toEqual([group])
    expect(await managed(stranger, true)).toEqual([])
  })

  it('leaves out an archived group and a demoted admin, like the per-group read refuses them', async () => {
    const kept = await newGroup('Kept'), archived = await newGroup('Archived')
    await request(kept, stranger); await request(archived, stranger)
    expect((await managed(admin, false)).map(row => row.chat_id).sort()).toEqual([kept, archived].sort())
    await asService()
    await database.query("UPDATE chat.chats SET status='archived' WHERE id=$1", [archived])
    expect((await managed(admin, false)).map(row => row.chat_id)).toEqual([kept])
    await asService()
    await database.query("UPDATE chat.chat_members SET role='member' WHERE chat_id=$1 AND user_id=$2", [kept, admin])
    expect(await managed(admin, false)).toEqual([])
    expect((await managed(owner, false)).map(row => row.chat_id)).toEqual([kept])
  })

  it('refuses an actor the caller cannot act as, and is not callable anonymously', async () => {
    await asUser(member)
    expect(await fails('SELECT * FROM chat.list_managed_group_join_requests(false,$1)', [owner])).toMatch(/group_actor_not_authorized/)
    await asService()
    await database.query('SET LOCAL role TO anon')
    expect(await fails('SELECT * FROM chat.list_managed_group_join_requests(false,$1)', [owner])).toMatch(/permission denied/)
  })
})
