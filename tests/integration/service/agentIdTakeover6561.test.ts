import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * nmhjklnm/gugu#6561:agent_profiles → identity.users 的同步触发器不许改写别人的身份。
 *
 * 旧触发器 id 冲突时无条件把那行改成 type='agent'、owner=插入者。三条入口都能让调用方指定 id:
 * 直接 INSERT agent_profiles、create_owned_agent(p_agent_id)、provision_taskpage_agent(p_agent_id)。
 * 本文件:三条入口拿真人账号的 id、以及拿别人名下 agent 的 id,都必须被拒且目标行逐字不变;
 * 正常开户 / 同 id 重发 / 改名 / 删了再建 / 同主人重新同步 必须照常。
 *
 * 跑法:loopback `GUGU_INTEGRATION_DATABASE_URL`(跑过全部迁移的库)。每条用例 BEGIN…ROLLBACK。
 */

interface QueryResult<Row> { rows: Row[] }
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>
}

const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}

const DATABASE_URL = (
  process.env.GUGU_INTEGRATION_DATABASE_URL
  ?? process.env.GUGU_DATABASE_URL
  ?? ''
).trim()

const VICTIM = '65610000-0000-4000-8000-000000000001'
const ATTACKER = '65610000-0000-4000-8000-000000000002'
const OTHER_OWNER = '65610000-0000-4000-8000-000000000003'
const ATTACKER_DEVICE = 'dev-it-6561-attacker'
const OTHER_DEVICE = 'dev-it-6561-other'

let database: DatabaseClient

function requireLoopbackDatabase(): void {
  let parsed: URL
  try {
    parsed = new URL(DATABASE_URL)
  } catch {
    throw new Error('GUGU_INTEGRATION_DATABASE_URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`agentIdTakeover6561.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`agentIdTakeover6561.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

beforeAll(async () => {
  requireLoopbackDatabase()
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})

afterAll(async () => {
  await database?.end()
})

async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

// auth.users 那一行会顺带建出 identity.users(human)。
async function seedHuman(user: string, device?: string): Promise<void> {
  await database.query('INSERT INTO auth.users (id, created_at) VALUES ($1, now())', [user])
  if (device) {
    await database.query(
      `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
       VALUES ($1, $2, 'it-6561', 'it-6561', 'darwin')`,
      [device, user],
    )
  }
}

async function claimsFor(user: string): Promise<void> {
  await database.query(
    "SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)",
    [user],
  )
  await database.query('SET LOCAL role authenticated')
}

async function asUser<Row>(user: string, sql: string, values: unknown[]): Promise<Row[]> {
  await claimsFor(user)
  try {
    return (await database.query<Row>(sql, values)).rows
  } finally {
    await database.query('RESET role')
  }
}

// 被拒的调用会让事务进入 aborted:角色与 claims 都在保存点之后设,回滚到保存点一并撤掉。
async function rejectedAs(user: string, sql: string, values: unknown[]): Promise<string> {
  await database.query('SAVEPOINT probe')
  try {
    await claimsFor(user)
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT probe')
    return String((error as Error)?.message ?? error)
  }
  await database.query('RESET role')
  await database.query('RELEASE SAVEPOINT probe')
  throw new Error(`expected this to be rejected, but it succeeded: ${sql}`)
}

interface IdentityRow { type: string; owner_user_id: string | null; display_name: string | null; device_id: string | null }

async function identity(id: string): Promise<IdentityRow | undefined> {
  const result = await database.query<IdentityRow>(
    'SELECT type, owner_user_id, display_name, device_id FROM identity.users WHERE id = $1',
    [id],
  )
  return result.rows[0]
}

const CREATE = `SELECT id FROM identity.create_owned_agent($1, NULL, 'claude-code', $2, NULL, NULL, true, NULL, $3::uuid)`
const PROVISION = `SELECT agent_id, display_name FROM identity.provision_taskpage_agent($1::uuid, $2, 'explicit', 'claude-code', $3)`
const DIRECT_INSERT = `INSERT INTO identity.agent_profiles (id, owner_id, display_name, agent_type) VALUES ($1::uuid, $2::uuid, $3, 'claude-code')`

describe('#6561 agent ids never rewrite someone else\'s identity', () => {
  it('rejects a human account id on all three entry points, and leaves the account untouched', async () => {
    await inRollback(async () => {
      await seedHuman(VICTIM)
      await seedHuman(ATTACKER, ATTACKER_DEVICE)
      const before = await identity(VICTIM)
      expect(before).toMatchObject({ type: 'human', owner_user_id: null })

      expect(await rejectedAs(ATTACKER, DIRECT_INSERT, [VICTIM, ATTACKER, 'Victim'])).toMatch(/permission denied|already taken/)
      expect(await rejectedAs(ATTACKER, CREATE, ['Victim', ATTACKER_DEVICE, VICTIM])).toMatch(/already taken/)
      expect(await rejectedAs(ATTACKER, PROVISION, [VICTIM, 'Victim', ATTACKER_DEVICE])).toMatch(/already taken/)

      expect(await identity(VICTIM)).toEqual(before)
      const profiles = await database.query('SELECT 1 FROM identity.agent_profiles WHERE id = $1::uuid', [VICTIM])
      expect(profiles.rows).toHaveLength(0)
    })
  })

  it('rejects another owner\'s agent id, and leaves that agent with its owner', async () => {
    await inRollback(async () => {
      await seedHuman(ATTACKER, ATTACKER_DEVICE)
      await seedHuman(OTHER_OWNER, OTHER_DEVICE)
      const theirs = randomUUID()
      await asUser(OTHER_OWNER, CREATE, ['Theirs', OTHER_DEVICE, theirs])
      // 只删 profile、留下 users 行:这是冲突分支唯一能被外人撞到的形状(否则 agent_profiles 主键先挡住)。
      await database.query('DELETE FROM identity.agent_profiles WHERE id = $1::uuid', [theirs])
      const before = await identity(theirs)
      expect(before).toMatchObject({ type: 'agent', owner_user_id: OTHER_OWNER })

      // 直插是旧库上真能得手的那条(两个 RPC 在旧库上会被 device_id 不可改的护栏碰巧拦下,报的不是这个原因)。
      expect(await rejectedAs(ATTACKER, DIRECT_INSERT, [theirs, ATTACKER, 'Stolen'])).toMatch(/permission denied|already taken/)
      expect(await rejectedAs(ATTACKER, CREATE, ['Stolen', ATTACKER_DEVICE, theirs])).toMatch(/already taken/)
      expect(await rejectedAs(ATTACKER, PROVISION, [theirs, 'Stolen', ATTACKER_DEVICE])).toMatch(/already taken/)

      expect(await identity(theirs)).toEqual(before)
    })
  })

  it('closes the direct table write: no INSERT grant, no insert policy', async () => {
    const grant = await database.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('authenticated', 'identity.agent_profiles', 'INSERT') AS allowed",
    )
    expect(grant.rows[0].allowed).toBe(false)
    const policy = await database.query(
      `SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'identity' AND c.relname = 'agent_profiles' AND p.polname = 'agent_profiles_insert_owned'`,
    )
    expect(policy.rows).toHaveLength(0)
  })

  it('keeps every legitimate path: mint, same-id retry, rename, new identity after removal, same-owner resync', async () => {
    await inRollback(async () => {
      await seedHuman(OTHER_OWNER, OTHER_DEVICE)
      const mine = randomUUID()

      const minted = await asUser<{ agent_id: string; display_name: string }>(OTHER_OWNER, PROVISION, [mine, 'Mine', OTHER_DEVICE])
      expect(minted[0]).toMatchObject({ agent_id: mine, display_name: 'Mine' })
      expect(await identity(mine)).toMatchObject({ type: 'agent', owner_user_id: OTHER_OWNER, device_id: OTHER_DEVICE })

      const retried = await asUser<{ agent_id: string; display_name: string }>(OTHER_OWNER, PROVISION, [mine, 'Mine', OTHER_DEVICE])
      expect(retried[0]).toMatchObject({ agent_id: mine, display_name: 'Mine' })

      await asUser(OTHER_OWNER, 'UPDATE identity.agent_profiles SET display_name = $2 WHERE id = $1::uuid', [mine, 'Renamed'])
      expect(await identity(mine)).toMatchObject({ type: 'agent', owner_user_id: OTHER_OWNER, display_name: 'Renamed' })

      await asUser(OTHER_OWNER, 'SELECT identity.remove_owned_agent($1)', [mine])
      expect(await identity(mine)).toMatchObject({ type: 'agent', owner_user_id: OTHER_OWNER, display_name: 'Renamed' })
      expect(await rejectedAs(OTHER_OWNER, CREATE, ['Again', OTHER_DEVICE, mine])).toContain('identity_removed')
      const fresh = randomUUID()
      await asUser(OTHER_OWNER, CREATE, ['Again', OTHER_DEVICE, fresh])
      expect(await identity(fresh)).toMatchObject({ type: 'agent', owner_user_id: OTHER_OWNER, display_name: 'Again' })

      // 同主人的 users 行还在、profile 丢了:重新开户走冲突分支,必须放行(这是冲突分支唯一合法的用途)。
      await database.query('DELETE FROM identity.agent_profiles WHERE id = $1::uuid', [fresh])
      await asUser(OTHER_OWNER, CREATE, ['Resynced', OTHER_DEVICE, fresh])
      expect(await identity(fresh)).toMatchObject({ type: 'agent', owner_user_id: OTHER_OWNER, display_name: 'Resynced' })
    })
  })
})
