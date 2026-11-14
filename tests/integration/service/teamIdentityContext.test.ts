import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: pg.Client
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
beforeEach(async () => { await db.query('BEGIN') })
afterEach(async () => { await db.query('ROLLBACK') })
afterAll(async () => { await db?.end() })
async function auth(kind?: string) {
  const id = randomUUID()
  await db.query(`INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,raw_app_meta_data)
    VALUES($1,'authenticated','authenticated',$2,now(),now(),$3)`, [id, `${id}@team-context.invalid`, JSON.stringify(kind ? { gugu_account_kind: kind } : {})])
  return id
}
async function team() {
  const id = randomUUID()
  await db.query("INSERT INTO team_private.teams(id,name,region,state) VALUES($1,'Fixture team','cn','active')", [id])
  return id
}
async function seat(teamId: string, role = 'member', state = 'active') {
  const principal = await auth('team_member'), id = randomUUID()
  await db.query('INSERT INTO team_private.members(id,team_id,principal_user_id,email_normalized,role,state) VALUES($1,$2,$3,$4,$5,$6)', [id, teamId, principal, `${id}@member.invalid`, role, state])
  return { id, principal }
}
async function context(actor: string, target: string | null = null) {
  return (await db.query('SELECT identity.team_context_for($1,$2) c', [actor, target])).rows[0].c
}
async function refusal(sql: string, args: unknown[]) {
  await db.query('SAVEPOINT refused')
  try { await db.query(sql, args); throw Error('Expected refusal') }
  catch (error) { await db.query('ROLLBACK TO SAVEPOINT refused'); return error as Error }
}
describe('service-only team identity context', () => {
  it('keeps private rows and arbitrary-actor resolution closed to client roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const signature of ['identity.team_context_for(uuid,uuid)', 'identity.team_billing_members_for(uuid,uuid)']) {
        expect((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, signature])).rows[0].allowed).toBe(false)
      }
      expect((await db.query("SELECT has_table_privilege($1,'team_private.members','SELECT') allowed", [role])).rows[0].allowed).toBe(false)
    }
    expect((await db.query("SELECT has_function_privilege('service_role','identity.team_context_for(uuid,uuid)','EXECUTE') allowed")).rows[0].allowed).toBe(true)
  })
  it('resolves a real separate team principal without making a personal actor a member', async () => {
    const organization = await team(), m = await seat(organization), personal = await auth()
    expect(await context(m.principal, organization)).toMatchObject({ kind: 'team', team_id: organization, member_id: m.id, member_identity_id: m.principal, role: 'member', state: 'active', membership_revision: 1, region: 'cn' })
    expect(await context(personal)).toMatchObject({ kind: 'personal', team_id: null, member_id: null })
    expect((await refusal('SELECT identity.team_context_for($1,$2)', [personal, organization])).message).toBe('team_context_required')
  })
  it('refuses stale, disabled, missing and cross-team contexts instead of falling back to a personal payer', async () => {
    const organization = await team(), other = await team(), m = await seat(organization)
    expect((await refusal('SELECT identity.team_context_for($1,$2)', [m.principal, other])).message).toBe('team_context_mismatch')
    await db.query("UPDATE team_private.members SET state='disabled',revision=revision+1 WHERE id=$1", [m.id])
    expect((await refusal('SELECT identity.team_context_for($1)', [m.principal])).message).toBe('team_membership_disabled')
    const orphaned = await auth('team_member'), anchor = await auth('team_login_anchor'), future = await auth('team_member_v2')
    for (const actor of [orphaned, anchor, future]) expect((await refusal('SELECT identity.team_context_for($1)', [actor])).message).toBe('team_context_required')
    expect((await refusal('SELECT identity.team_context_for($1)', [randomUUID()])).message).toBe('team_context_unauthenticated')
  })
  it('enumerates no-usage and disabled members for administrators without returning private metadata', async () => {
    const organization = await team(), admin = await seat(organization, 'superadmin'), ordinary = await seat(organization), disabled = await seat(organization, 'member', 'disabled')
    const rows = (await db.query('SELECT identity.team_billing_members_for($1,$2) r', [admin.principal, organization])).rows[0].r
    expect(rows).toHaveLength(3)
    expect(rows).toContainEqual({ member_id: disabled.id, member_identity_id: disabled.principal, state: 'disabled' })
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['member_id', 'member_identity_id', 'state'])
    expect((await refusal('SELECT identity.team_billing_members_for($1,$2)', [ordinary.principal, organization])).message).toBe('team_administrator_required')
  })
  it('protects the team principal from personal erasure without blocking deletion of a separate personal account', async () => {
    const organization = await team(), m = await seat(organization), personal = await auth()
    expect((await refusal('DELETE FROM auth.users WHERE id=$1', [m.principal])).message).toBe('team_identity_erasure_requires_team_workflow')
    await db.query('DELETE FROM auth.users WHERE id=$1', [personal])
    expect(await context(m.principal)).toMatchObject({ kind: 'team', team_id: organization })
  })
})
