import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let db: pg.Client
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
beforeEach(async () => {
  await db.query('BEGIN')
  await db.query("UPDATE team_private.deployment SET region='cn' WHERE singleton")
})
afterEach(async () => { await db.query('ROLLBACK') })
afterAll(async () => { await db?.end() })

async function team() {
  const id = randomUUID()
  await db.query("INSERT INTO team_private.teams(id,name,region,state) VALUES($1,'Directory fixture','cn','active')", [id])
  return id
}
async function member(teamId: string, name: string, email: string, role = 'member', state = 'active') {
  const id = randomUUID(), principal = randomUUID(), session = randomUUID()
  await db.query(`INSERT INTO team_private.members(id,team_id,planned_principal_id,email_normalized,role,state)
    VALUES($1,$2,$3,$4,$5,'provisioning')`, [id, teamId, principal, email, role])
  await db.query(`INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,raw_app_meta_data)
    VALUES($1,'authenticated','authenticated',$2,now(),now(),'{"gugu_account_kind":"team_member"}')`,
  [principal, `team-${id.replaceAll('-', '')}@team.gugu.invalid`])
  await db.query('UPDATE identity.users SET display_name=$2 WHERE id=$1', [principal, name])
  await db.query('UPDATE team_private.members SET principal_user_id=$2,state=$3 WHERE id=$1', [id, principal, state])
  await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [session, principal])
  return { id, principal, session }
}
type Actor = Awaited<ReturnType<typeof member>>
async function page(actor: Actor, query: string | null = null, cursor: string | null = null, limit: number | null = 50, target: string | null = null) {
  return (await db.query('SELECT identity.team_directory_page_for($1,$2,$3,$4,$5,$6) r',
    [actor.principal, actor.session, target, query, cursor, limit])).rows[0].r
}
async function refused(operation: () => Promise<unknown>) {
  await db.query('SAVEPOINT refused')
  try { await operation() } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT refused')
    return error as Error & { hint?: string }
  }
  throw Error('Expected refusal')
}

it('exposes only active same-team people to both ordinary members and administrators', async () => {
  const id = await team(), other = await team()
  const owner = await member(id, 'Owner', 'owner@directory.invalid', 'superadmin')
  const ordinary = await member(id, 'Lin', 'lin@directory.invalid')
  await member(id, 'Disabled', 'disabled@directory.invalid', 'member', 'disabled')
  await member(id, 'Invited', 'invited@directory.invalid', 'member', 'invited')
  const removed = await member(id, 'Removed', 'removed@directory.invalid')
  await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1', [removed.principal])
  await member(other, 'Other team', 'other@directory.invalid')
  const result = await page(ordinary)
  expect(result).toEqual(await page(owner))
  expect(result).toMatchObject({ team_id: id, total_count: 2, matching_count: 2, next_cursor: null })
  expect(result.members.map((row: any) => row.id).sort()).toEqual([owner.id, ordinary.id].sort())
  for (const row of result.members) {
    expect(Object.keys(row).sort()).toEqual(['avatar', 'email', 'id', 'identity_id', 'name', 'revision', 'role'])
    expect(row.email).not.toContain('team.gugu.invalid')
  }
  const existing = (await db.query("SELECT public.team_account_read('directory',$1,$2) r", [ordinary.principal, ordinary.session])).rows[0].r
  expect(existing).toEqual(result)
  expect((await refused(() => db.query("SELECT public.team_account_read('members',$1,$2)", [ordinary.principal, ordinary.session]))).hint).toBe('forbidden')
})

it('searches names and canonical emails case-insensitively without treating wildcards as patterns', async () => {
  const id = await team(), actor = await member(id, '林晓', 'linxiao@directory.invalid')
  await member(id, 'Name has 100%_literal', 'percent@directory.invalid')
  await member(id, 'Another person', 'email-only@directory.invalid')
  expect((await page(actor, '林')).members.map((row: any) => row.id)).toEqual([actor.id])
  expect((await page(actor, 'LINXIAO')).members.map((row: any) => row.id)).toEqual([actor.id])
  expect((await page(actor, ' EMAIL-ONLY '))).toMatchObject({ total_count: 3, matching_count: 1 })
  expect((await page(actor, '%_')).matching_count).toBe(1)
  expect((await page(actor, "' OR true --"))).toMatchObject({ total_count: 3, matching_count: 0, members: [], next_cursor: null })
  expect((await page(actor, '   ')).matching_count).toBe(3)
})

it('continues only when another matching row exists and keeps counts independent of the cursor', async () => {
  const id = await team(), actor = await member(id, 'One', 'one@directory.invalid')
  await member(id, 'Two', 'two@directory.invalid')
  await member(id, 'Three', 'three@directory.invalid')
  const first = await page(actor, null, null, 2)
  expect(first.members).toHaveLength(2)
  expect(first).toMatchObject({ total_count: 3, matching_count: 3, next_cursor: first.members[1].id })
  const last = await page(actor, null, first.next_cursor, 1)
  expect(last.members).toHaveLength(1)
  expect(last).toMatchObject({ total_count: 3, matching_count: 3, next_cursor: null })
  const ids = [...first.members, ...last.members].map((row: any) => row.id)
  expect(new Set(ids).size).toBe(3)
  expect(ids).toEqual([...ids].sort())
  expect((await page(actor, null, last.members[0].id, 2))).toMatchObject({ members: [], next_cursor: null, total_count: 3 })
  expect((await page(actor, 'One', null, 1))).toMatchObject({ matching_count: 1, next_cursor: null })
})

it('pages a 128-person team and finds an email outside the first page', async () => {
  const id = await team(), actor = await member(id, 'Caller', 'caller@directory.invalid')
  const principals = Array.from({ length: 127 }, () => randomUUID())
  const seats = principals.map(() => randomUUID())
  await db.query(`INSERT INTO team_private.members(id,team_id,planned_principal_id,email_normalized,role,state)
    SELECT seat,$3,principal,seat::text||'@directory.invalid','member','provisioning'
    FROM unnest($1::uuid[],$2::uuid[]) t(principal,seat)`, [principals, seats, id])
  await db.query(`INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,raw_app_meta_data)
    SELECT principal,'authenticated','authenticated','team-'||replace(seat::text,'-','')||'@team.gugu.invalid',
      now(),now(),'{"gugu_account_kind":"team_member"}'::jsonb FROM unnest($1::uuid[],$2::uuid[]) t(principal,seat)`, [principals, seats])
  await db.query("UPDATE team_private.members SET principal_user_id=planned_principal_id,state='active' WHERE id=ANY($1::uuid[])", [seats])
  const first = await page(actor, null, null, 100)
  const last = await page(actor, null, first.next_cursor, 100)
  expect(first).toMatchObject({ total_count: 128, matching_count: 128 })
  expect(first.members).toHaveLength(100)
  expect(last.members).toHaveLength(28)
  expect(last.next_cursor).toBeNull()
  expect(new Set([...first.members, ...last.members].map((row: any) => row.id)).size).toBe(128)
  const found = await page(actor, last.members[27].email)
  expect(found).toMatchObject({ total_count: 128, matching_count: 1, next_cursor: null })
  expect(found.members.map((row: any) => row.id)).toEqual([last.members[27].id])
})

it.each([0, 101, -1, null])('refuses invalid page size %s instead of silently clamping it', async limit => {
  const actor = await member(await team(), 'Caller', 'caller@directory.invalid')
  expect((await refused(() => page(actor, null, null, limit))).hint).toBe('invalid_request')
})

it('refuses malformed cursors, oversized searches and another team', async () => {
  const actor = await member(await team(), 'Caller', 'caller@directory.invalid')
  for (const cursor of ['', 'not-a-uuid', '0'.repeat(36)])
    expect((await refused(() => page(actor, null, cursor))).hint).toBe('invalid_request')
  expect((await refused(() => page(actor, 'a'.repeat(255)))).hint).toBe('invalid_request')
  const other = await team()
  expect((await refused(() => page(actor, null, null, 50, other))).hint).toBe('forbidden')
})

it('binds every page to the original live Auth session and current membership', async () => {
  const id = await team(), actor = await member(id, 'Caller', 'caller@directory.invalid')
  const peer = await member(id, 'Peer', 'peer@directory.invalid')
  expect((await refused(() => page({ ...actor, session: peer.session }))).hint).toBe('unauthenticated')
  await db.query('UPDATE auth.sessions SET not_after=now()-interval \'1 second\' WHERE id=$1', [actor.session])
  expect((await refused(() => page(actor))).hint).toBe('unauthenticated')
  await db.query('UPDATE auth.sessions SET not_after=NULL WHERE id=$1', [actor.session])
  await db.query("UPDATE team_private.members SET state='disabled',revision=revision+1 WHERE id=$1", [actor.id])
  expect((await refused(() => page(actor))).hint).toBe('membership_disabled')
})

it('keeps arbitrary-actor directory access service-only with a postgres-owned function', async () => {
  const signature = 'identity.team_directory_page_for(uuid,uuid,uuid,text,text,integer)'
  for (const role of ['anon', 'authenticated'])
    expect((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0].allowed).toBe(false)
  expect((await db.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') allowed", [signature])).rows[0].allowed).toBe(true)
  expect((await db.query('SELECT pg_get_userbyid(proowner) owner FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0].owner).toBe('postgres')
})
