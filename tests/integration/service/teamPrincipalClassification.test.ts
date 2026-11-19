import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let db: pg.Client
let admin: SupabaseClient
const ownedAuth = new Set<string>()
const apiUrl = process.env.GUGU_INTEGRATION_SUPABASE_URL ?? '', anon = process.env.VITE_SUPABASE_ANON_KEY ?? ''
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (url.hostname !== '127.0.0.1') throw Error('Disposable loopback database required')
  const api = new URL(apiUrl)
  if (api.hostname !== '127.0.0.1' || Number(api.port) !== Number(url.port) - 1) throw Error('Matching loopback Auth required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
  admin = createClient(apiUrl, process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY ?? '', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
})
beforeEach(() => db.query('BEGIN'))
afterEach(async () => {
  await db.query('ROLLBACK')
  for (const id of ownedAuth) expect((await admin.auth.admin.deleteUser(id)).error).toBeNull()
  ownedAuth.clear()
})
afterAll(() => db?.end())
async function auth(id = randomUUID(), address = id + '@principal.invalid', metadata: unknown = {}, userMetadata: unknown = {}) {
  await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at)
    VALUES($1,'authenticated','authenticated',$2,$3,$4,now())`, [id, address, metadata, userMetadata])
  return id
}
const eligible = async (id: string) => (await db.query('SELECT identity.personal_principal_is_eligible($1) ok', [id])).rows[0].ok
async function denied(run: () => Promise<unknown>) {
  await db.query('SAVEPOINT refused')
  let failure: any
  try { await run() } catch (error) { failure = error }
  await db.query('ROLLBACK TO SAVEPOINT refused')
  if (!failure) throw Error('Expected refusal')
  return failure as Error & { code: string }
}
async function plan() {
  const team = randomUUID(), member = randomUUID(), principal = randomUUID()
  await db.query("INSERT INTO team_private.teams(id,name,region) VALUES($1,'Principal fixture','cn')", [team])
  await db.query(`INSERT INTO team_private.members(id,team_id,email_normalized,planned_principal_id,state)
    VALUES($1,$2,$3,$4,'provisioning')`, [member, team, member + '@member.invalid', principal])
  return { member, principal, alias: 'team-' + member.replaceAll('-', '') + '@team.gugu.invalid' }
}
it('requires exact planned UUID and alias instead of trusting public email or editable metadata', async () => {
  const p = await plan()
  for (const [id, address] of [[randomUUID(), p.alias], [p.principal, 'unplanned@team.gugu.invalid'],
    [p.principal, p.alias.toUpperCase()]]) {
    const error = await denied(() => auth(id, address, {}, { gugu_account_kind: 'team_member' }))
    expect(error.code).toBe('42501'); expect(error.message).toBe('reserved_team_principal_alias')
  }
  await auth(p.principal, p.alias)
  expect(await eligible(p.principal)).toBe(false)
  const ordinary = await auth()
  expect((await denied(() => db.query('UPDATE auth.users SET email=$2 WHERE id=$1', [ordinary, p.alias]))).code).toBe('42501')
  expect(await eligible(ordinary)).toBe(true)
})
it('preserves ordinary personal signup and ignores editable user metadata as an authorization source', async () => {
  expect(await eligible(await auth())).toBe(true)
  expect(await eligible(await auth(randomUUID(), undefined, { gugu_account_kind: 'personal' }))).toBe(true)
  expect(await eligible(await auth(randomUUID(), undefined, {}, { gugu_account_kind: 'team_member', gugu_team_id: randomUUID() }))).toBe(true)
  expect(await eligible(randomUUID())).toBe(false)
})
it('classifies final server markers and private bindings without converting a personal account', async () => {
  for (const kind of ['team_member', 'team_login_anchor', 'future_kind']) {
    const id = await auth(randomUUID(), undefined, { provider: 'email' })
    expect(await eligible(id)).toBe(true)
    await db.query('UPDATE auth.users SET raw_app_meta_data=$2 WHERE id=$1', [id, { provider: 'email', gugu_account_kind: kind }])
    expect(await eligible(id)).toBe(false)
  }
  const partial = await auth(randomUUID(), undefined, { gugu_team_id: randomUUID() })
  expect(await eligible(partial)).toBe(false)
  const p = await plan()
  await auth(p.principal, p.alias, { gugu_account_kind: 'team_member' })
  await db.query('UPDATE team_private.members SET principal_user_id=$2,planned_principal_id=NULL WHERE id=$1', [p.member, p.principal])
  await db.query('UPDATE auth.users SET email=$2 WHERE id=$1', [p.principal, p.alias])
  await db.query("UPDATE auth.users SET raw_app_meta_data='{}',email=$2 WHERE id=$1", [p.principal, p.principal + '@changed.invalid'])
  expect(await eligible(p.principal)).toBe(false)
})
it('keeps arbitrary-principal classification service-only with a fixed owner and search path', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    const privilege = (await db.query("SELECT has_function_privilege($1,'identity.personal_principal_is_eligible(uuid)','EXECUTE') ok", [role])).rows[0].ok
    expect(privilege).toBe(role === 'service_role')
    expect((await db.query("SELECT has_function_privilege($1,'team_private.guard_auth_principal_alias()','EXECUTE') ok", [role])).rows[0].ok).toBe(false)
  }
  const rows = (await db.query(`SELECT pg_get_userbyid(proowner) owner,prosecdef,proconfig FROM pg_proc
    WHERE oid IN ('identity.personal_principal_is_eligible(uuid)'::regprocedure,'team_private.guard_auth_principal_alias()'::regprocedure)`)).rows
  expect(rows).toHaveLength(2)
  for (const row of rows) expect(row).toMatchObject({ owner: 'postgres', prosecdef: true, proconfig: ['search_path=pg_catalog'] })
})

it('classifies real committed Auth creation and rejects public reserved-domain registration', async () => {
  for (const kind of ['personal', 'team_login_anchor']) {
    const created = await admin.auth.admin.createUser({ email: randomUUID() + '@auth-principal.invalid',
      email_confirm: true, app_metadata: { gugu_account_kind: kind } })
    if (created.data.user) ownedAuth.add(created.data.user.id)
    expect(created.error).toBeNull(); expect(created.data.user).not.toBeNull()
    expect(await eligible(created.data.user!.id)).toBe(kind === 'personal')
  }
  const address = 'team-' + randomUUID().replaceAll('-', '') + '@team.gugu.invalid'
  const response = await fetch(apiUrl + '/auth/v1/signup', { method: 'POST',
    headers: { apikey: anon, authorization: 'Bearer ' + anon, 'content-type': 'application/json' },
    body: JSON.stringify({ email: address, password: randomUUID() + randomUUID(),
      data: { gugu_account_kind: 'team_member' } }), signal: AbortSignal.timeout(5000) })
  expect(response.ok).toBe(false); await response.body?.cancel()
  expect((await db.query('SELECT count(*)::int n FROM auth.users WHERE email=$1', [address])).rows[0].n).toBe(0)
})
