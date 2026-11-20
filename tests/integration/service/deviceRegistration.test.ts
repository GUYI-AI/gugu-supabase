import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let database: string
let owner: string, other: string
const committedOwners: string[] = []
const payload = (overrides: Record<string, unknown> = {}) => ({
  device_id: randomUUID(), machine_id: randomUUID(), tier: 'beta',
  label: 'Registration fixture', hostname: 'fixture', platform: 'linux',
  capabilities: { host_kind: 'desktop', terminals: [], runtimes: [] }, ...overrides,
})
async function account(client: Client) {
  const id = randomUUID()
  await client.query("INSERT INTO auth.users(id,email,raw_app_meta_data,raw_user_meta_data) VALUES($1,$2,'{}','{}')",
    [id, `${id}@device-registration.invalid`])
  return id
}
async function asUser(client = db, id = owner, extra: Record<string, unknown> = {}) {
  await client.query('SET LOCAL ROLE authenticated')
  await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated', ...extra })])
}
async function register(input: unknown, client = db) {
  return (await client.query('SELECT identity.register_gugu_device($1::jsonb) result', [JSON.stringify(input)])).rows[0].result as {
    device_id: string; created: boolean
  }
}
async function rejected(input: unknown, code: string, message?: string) {
  await db.query('SAVEPOINT refused_registration')
  try {
    await expect(register(input)).rejects.toMatchObject({ code, ...(message ? { message } : {}) })
  } finally { await db.query('ROLLBACK TO SAVEPOINT refused_registration') }
}
async function snapshot(id: string) {
  return (await db.query('SELECT to_jsonb(d) row,d.ctid::text tuple FROM identity.gugu_devices d WHERE device_id=$1', [id])).rows[0]
}
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Device registration requires disposable loopback PostgreSQL')
  }
  database = url.href; db = new Client({ connectionString: database }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN'); owner = await account(db); other = await account(db); await asUser()
})
afterEach(async () => {
  await db.query('ROLLBACK')
  for (const id of committedOwners.splice(0)) await db.query('DELETE FROM auth.users WHERE id=$1', [id])
})

describe('atomic owner/machine/tier registration', () => {
  it('reserves offline once and returns the same row without any update', async () => {
    const input = payload({ reserve_only: true })
    expect(await register(input)).toEqual({ device_id: input.device_id, created: true })
    const before = await snapshot(input.device_id)
    expect(before.row.status).toBe('offline')
    expect(await register({ ...input, device_id: randomUUID(), label: 'Different', hostname: 'Different' }))
      .toEqual({ device_id: input.device_id, created: false })
    expect(await snapshot(input.device_id)).toEqual(before)
  })

  it('retains references, customized label, creation time and omitted digest on full registration', async () => {
    const input = payload({ session_digest: [{ id: 'retained' }] })
    await register(input)
    await db.query('SELECT identity.rename_device($1,$2)', [input.device_id, 'Chosen name'])
    await db.query('RESET ROLE')
    await db.query(`INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at)
      VALUES($1,$2,'retained','Retained project','/fixture',now())`, [input.device_id, owner])
    const agent = randomUUID()
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Retained agent',$2,$3)",
      [agent, owner, input.device_id])
    const created = (await snapshot(input.device_id)).row.created_at
    await asUser()
    const changed = payload({ machine_id: input.machine_id, capabilities: { host_kind: 'desktop', runtimes: ['fixture'] } })
    expect(await register(changed)).toEqual({ device_id: input.device_id, created: false })
    const row = (await snapshot(input.device_id)).row
    expect(row).toMatchObject({ label: 'Chosen name', created_at: created, status: 'online', session_digest: [{ id: 'retained' }] })
    expect(row.capabilities).toEqual(changed.capabilities)
    await db.query('RESET ROLE')
    expect((await db.query('SELECT device_id FROM identity.device_projects WHERE user_id=$1', [owner])).rows).toEqual([{ device_id: input.device_id }])
    expect((await db.query('SELECT device_id FROM identity.users WHERE id=$1', [agent])).rows).toEqual([{ device_id: input.device_id }])
  })

  it('does not touch an online row or its lease while reserving', async () => {
    const input = payload(); await register(input)
    const before = await snapshot(input.device_id)
    await register({ ...input, device_id: randomUUID(), reserve_only: true })
    expect(await snapshot(input.device_id)).toEqual(before)
  })

  it('keeps owners and tiers separate', async () => {
    const input = payload(); await register(input)
    const beta = await register({ ...input, device_id: randomUUID(), tier: 'production' })
    expect(beta.created).toBe(true); expect(beta.device_id).not.toBe(input.device_id)
    await asUser(db, other)
    const peer = await register({ ...input, device_id: randomUUID() })
    expect(peer.created).toBe(true); expect(peer.device_id).not.toBe(input.device_id)
  })

  it('refuses a candidate belonging to another owner even when the caller already has the tuple', async () => {
    const input = payload(); await register(input)
    await asUser(db, other)
    const theirs = payload(); await register(theirs)
    await asUser()
    const before = await snapshot(input.device_id)
    await rejected({ ...input, device_id: theirs.device_id }, 'P0001', 'DEVICE_REGISTRATION_SCOPE_CONFLICT')
    expect(await snapshot(input.device_id)).toEqual(before)
  })

  it('refuses moving a candidate to another machine or tier', async () => {
    const input = payload(); await register(input)
    await rejected({ ...input, machine_id: randomUUID() }, 'P0001', 'DEVICE_REGISTRATION_SCOPE_CONFLICT')
    await rejected({ ...input, tier: 'production' }, 'P0001', 'DEVICE_REGISTRATION_SCOPE_CONFLICT')
  })

  it('enforces the phone formula and leaves historical conflicting rows byte-for-byte unchanged', async () => {
    const input = payload({ platform: 'android', capabilities: { host_kind: 'phone' } })
    await db.query('RESET ROLE')
    await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,machine_id,tier,label,hostname,platform)
      VALUES($1,$2,$3,$4,'Historical','fixture','android')`, [input.device_id, owner, input.machine_id, input.tier])
    await asUser(); const before = await snapshot(input.device_id)
    const expected = `phone-${input.machine_id}-${owner}`
    await rejected({ ...input, device_id: expected }, 'P0001', 'PHONE_DEVICE_ID_CONFLICT')
    await rejected({ ...input, device_id: expected, reserve_only: true }, 'P0001', 'PHONE_DEVICE_ID_CONFLICT')
    expect(await snapshot(input.device_id)).toEqual(before)
    await rejected({ ...input, machine_id: randomUUID() }, 'P0001', 'PHONE_DEVICE_ID_CONFLICT')
  })

  it('accepts the same fixed phone identity twice', async () => {
    const input = payload({ platform: 'android', capabilities: { host_kind: 'phone' } })
    input.device_id = `phone-${input.machine_id}-${owner}`
    expect(await register(input)).toEqual({ device_id: input.device_id, created: true })
    expect(await register(input)).toEqual({ device_id: input.device_id, created: false })
  })

  it('names an unlabeled machine with the platform default and keeps that name on later registrations', async () => {
    const reserved = payload({ label: '', reserve_only: true })
    expect(await register(reserved)).toEqual({ device_id: reserved.device_id, created: true })
    const named = (await snapshot(reserved.device_id)).row.label
    expect(named).toMatch(/^Linux \d+$/)
    expect(await register(payload({ machine_id: reserved.machine_id, label: '' })))
      .toEqual({ device_id: reserved.device_id, created: false })
    expect((await snapshot(reserved.device_id)).row).toMatchObject({ label: named, status: 'online' })
    const full = payload({ label: '' })
    expect(await register(full)).toEqual({ device_id: full.device_id, created: true })
    expect((await snapshot(full.device_id)).row.label).toMatch(/^Linux \d+$/)
  })

  it.each([
    null, [], { machine_id: null }, { tier: '' }, { label: null }, { user_id: 'forged' },
    { status: 'online' }, { auth_session_id: 'forged' }, { reserve_only: 'true' },
    { reserve_only: true, capabilities: {} },
    { reserve_only: true, capabilities: { host_kind: 'desktop', runtimes: ['not-empty'] } },
    { reserve_only: true, capabilities: { host_kind: 'desktop', actions: {} } },
  ])('rejects malformed or unauthorized input %j', async patch => {
    const input = patch && !Array.isArray(patch) ? payload(patch) : patch
    await rejected(input, patch && 'user_id' in patch ? '42501' : '22023')
  })

  it('rejects a missing or nonexistent human principal and retains the restrictive team policy', async () => {
    await asUser(db, randomUUID())
    await rejected(payload(), '42501', 'DEVICE_REGISTRATION_FORBIDDEN')
    await db.query("SELECT set_config('request.jwt.claims','{}',true)")
    await rejected(payload(), '42501', 'DEVICE_REGISTRATION_FORBIDDEN')
    await asUser(db, owner, { app_metadata: { gugu_account_kind: 'team_member' } })
    await rejected(payload(), '42501')
  })

  it('retains the removal guard and exposes only the intended RPC', async () => {
    const input = payload(); await register(input)
    await db.query('RESET ROLE')
    await db.query('INSERT INTO identity.gugu_device_removals(device_id,user_id) VALUES($1,$2)', [input.device_id, owner])
    await asUser()
    await rejected(input, 'P0001')
    await db.query('RESET ROLE')
    const result = (await db.query(`SELECT p.prosecdef,p.proowner='postgres'::regrole owned,
      has_function_privilege('authenticated',p.oid,'EXECUTE') allowed,
      has_function_privilege('anon',p.oid,'EXECUTE') anonymous,
      has_function_privilege('service_role',p.oid,'EXECUTE') service
      FROM pg_proc p WHERE p.oid='identity.register_gugu_device(jsonb)'::regprocedure`)).rows[0]
    expect(result).toEqual({ prosecdef: false, owned: true, allowed: true, anonymous: false, service: false })
    expect((await db.query(`SELECT EXISTS(SELECT 1 FROM pg_db_role_setting s,
      LATERAL unnest(s.setconfig) setting WHERE s.setrole='authenticator'::regrole
      AND setting LIKE 'pgrst.db_schemas=%' AND setting LIKE '%device_private%') exposed`)).rows[0].exposed).toBe(false)
  })

  it('charges an unused offline server reservation to the existing total-machine limit', async () => {
    await db.query('RESET ROLE')
    await db.query('UPDATE identity.installation_machine_limits SET max_machines=1,max_tunnel_machines=1 WHERE id')
    await asUser()
    const input = payload({ reserve_only: true, capabilities: { host_kind: 'server' } })
    expect((await register(input)).created).toBe(true)
    await db.query('RESET ROLE')
    await db.query("UPDATE identity.gugu_devices SET last_seen_at=now()-interval '8 days' WHERE device_id=$1", [input.device_id])
    await asUser()
    const next = payload({ reserve_only: true, capabilities: { host_kind: 'server' } })
    await db.query('SAVEPOINT limited_registration')
    await expect(register(next)).rejects.toMatchObject({ code: 'P0001', message: expect.stringContaining('DEVICE_LIMIT_REACHED') })
    await db.query('ROLLBACK TO SAVEPOINT limited_registration')
    expect((await db.query('SELECT device_id FROM identity.gugu_devices WHERE user_id=$1', [owner])).rows)
      .toEqual([{ device_id: input.device_id }])
  })
})

describe('real independent-connection registration races', () => {
  it.each([[false, true], [true, true], [false, false], [true, false]])(
    'serializes two registrations (same candidate=%s, reserve=%s)', async (same, reserve) => {
    const a = new Client({ connectionString: database }), b = new Client({ connectionString: database })
    await a.connect(); await b.connect()
    let pending: Promise<{ result?: Awaited<ReturnType<typeof register>>; error?: unknown }> | undefined
    try {
      const id = await account(a); committedOwners.push(id)
      await a.query('BEGIN'); await asUser(a, id)
      const input = payload({ reserve_only: reserve })
      expect(await register(input, a)).toEqual({ device_id: input.device_id, created: true })
      const firstPid = (await a.query('SELECT pg_backend_pid() pid')).rows[0].pid
      await b.query('BEGIN'); await asUser(b, id)
      const secondPid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid
      pending = register({ ...input, device_id: same ? input.device_id : randomUUID() }, b)
        .then(result => ({ result }), error => ({ error }))
      let blocked = false
      for (let i = 0; i < 100 && !blocked; i++) {
        blocked = (await db.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) blocked', [firstPid, secondPid])).rows[0].blocked
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      await a.query('COMMIT')
      const outcome = await pending
      if (outcome.error) throw outcome.error
      expect(outcome.result).toEqual({ device_id: input.device_id, created: false })
      await b.query('COMMIT')
      // The observer starts as another fixture owner: retain that RLS denial,
      // then read the committed result as the owner of these two connections.
      expect((await db.query('SELECT device_id FROM identity.gugu_devices WHERE user_id=$1', [id])).rows).toEqual([])
      await asUser(db, id)
      expect((await db.query('SELECT device_id FROM identity.gugu_devices WHERE user_id=$1', [id])).rows)
        .toEqual([{ device_id: input.device_id }])
    } finally {
      await a.query('ROLLBACK'); await b.query('ROLLBACK')
      await pending; await a.end(); await b.end()
    }
  })
})
