import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTeamAccountsHandler } from '../../../supabase/functions/_shared/team-accounts-core'
import { teamAccountsDependencies } from '../../../supabase/functions/_shared/team-accounts-dependencies'

// The handler uses real loopback Auth and PostgREST. Only email delivery and
// the separately owned model callback are stubbed; neither is attested here.
let db: pg.Client, admin: SupabaseClient, handle: ReturnType<typeof createTeamAccountsHandler>
let priorRegion: string | null, priorOrigin: string | null
const ownedUsers = new Set<string>(), teams = new Set<string>(), addresses = new Set<string>()
const url = process.env.GUGU_INTEGRATION_SUPABASE_URL ?? '', anon = process.env.VITE_SUPABASE_ANON_KEY ?? ''
const modelRevocations: Record<string, unknown>[] = []
function need(value: unknown, phase: string): asserts value { if (!value) throw Error('Owned workflow fixture: ' + phase) }
const address = () => { const value = randomUUID() + '@workflow-http.invalid'; addresses.add(value); return value }
beforeAll(async () => {
  const api = new URL(url), database = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  need(api.hostname === '127.0.0.1' && database.hostname === '127.0.0.1' && Number(api.port) === Number(database.port) - 1, 'matching loopback services required')
  db = new pg.Client({ connectionString: database.href }); await db.connect()
  priorRegion = (await db.query('SELECT region FROM team_private.deployment WHERE singleton')).rows[0].region
  priorOrigin = (await db.query('SELECT site_origin FROM team_private.delivery_configuration WHERE singleton')).rows[0].site_origin
  await db.query("UPDATE team_private.deployment SET region='cn' WHERE singleton")
  await db.query("UPDATE team_private.delivery_configuration SET site_origin='https://team.example.invalid' WHERE singleton")
  const service = process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY ?? ''
  admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  const deps = teamAccountsDependencies({ url, anonKey: anon, serviceKey: service })
  handle = createTeamAccountsHandler({ ...deps, auth: { ...deps.auth, sendEmailCode: value => deps.auth.ensureAnchor(value) },
    revokeModel: async input => { modelRevocations.push(input); return true } })
})
afterAll(async () => {
  if (!db) return
  // Discover only this fixture's interrupted provisioning, then remove proof
  // references before their operation/member parents. No table-wide cleanup.
  const ownAddresses = [...addresses]
  for (const row of (await db.query('SELECT DISTINCT team_id FROM team_private.members WHERE email_normalized=ANY($1::text[])', [ownAddresses])).rows) teams.add(row.team_id)
  for (const row of (await db.query('SELECT u.id FROM auth.users u JOIN team_private.members m ON m.principal_user_id=u.id WHERE m.team_id=ANY($1::uuid[])', [[...teams]])).rows) ownedUsers.add(row.id)
  await db.query('DELETE FROM team_private.email_challenges WHERE email_normalized=ANY($1::text[])', [ownAddresses])
  for (const team of teams) {
    await db.query('DELETE FROM team_private.email_challenges WHERE team_id=$1', [team])
    await db.query('DELETE FROM team_private.member_operations WHERE team_id=$1', [team])
    await db.query('DELETE FROM team_private.invitations WHERE team_id=$1', [team])
    await db.query('DELETE FROM team_private.asset_custody WHERE team_id=$1', [team])
    await db.query('DELETE FROM team_private.members WHERE team_id=$1', [team])
    await db.query('DELETE FROM team_private.teams WHERE id=$1', [team])
  }
  for (const email of addresses) {
    const users = (await db.query('SELECT id FROM auth.users WHERE email=$1', [email])).rows
    for (const user of users) ownedUsers.add(user.id)
  }
  for (const id of ownedUsers) need(!(await admin.auth.admin.deleteUser(id, false)).error, 'Auth fixture cleanup')
  await db.query('UPDATE team_private.deployment SET region=$1 WHERE singleton', [priorRegion])
  await db.query('UPDATE team_private.delivery_configuration SET site_origin=$1 WHERE singleton', [priorOrigin])
  await db.end()
})
async function call(body: Record<string, unknown>, bearer?: string) {
  const response = await handle(new Request('https://backend.example.invalid/functions/v1/team-accounts', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, body: JSON.stringify(body),
  }))
  const value = await response.json()
  need(response.status === 200 && value.ok === true, 'HTTP ' + body.action + ' status ' + response.status + ' code ' + (value.error?.code ?? 'none'))
  return value.data
}
async function code(email: string) {
  const link = await admin.auth.admin.generateLink({ type: 'recovery', email })
  need(!link.error && link.data.user?.id && /^\d{6}$/.test(link.data.properties?.email_otp ?? ''), 'official synthetic proof')
  ownedUsers.add(link.data.user.id)
  return link.data.properties.email_otp
}
async function proof(email: string, purpose: string, invitation?: string) {
  // Only rate-limit time is advanced in the owned fixture. Expiry is unchanged.
  await db.query("UPDATE team_private.email_challenges SET created_at=created_at-interval '2 minutes' WHERE email_normalized=$1", [email])
  const challenge = await call({ action: 'email_challenge', email, purpose, ...(invitation ? { invitation_token: invitation } : {}) })
  return (await call({ action: 'email_verify', challenge_id: challenge.challenge_id, code: await code(email) })).verification_receipt
}

it('creates, invites, signs in, disables, restores and confirms member email through real Auth sessions', async () => {
  const founderEmail = address(), memberEmail = address(), nextEmail = address()
  const founder = await call({ action: 'create', name: 'HTTP workflow fixture',
    verification_receipt: await proof(founderEmail, 'create'), idempotency_key: randomUUID() })
  teams.add(founder.team.id); ownedUsers.add(founder.session.user.id)
  need(founder.session.user.id === founder.membership.identity_id, 'independent founder binding')
  const invited = await call({ action: 'invite', email: memberEmail, role: 'member', idempotency_key: randomUUID() }, founder.session.access_token)
  const invitation = new URL(invited.invitation_url).hash.slice('#invitation_token='.length)
  const member = await call({ action: 'accept_invitation', invitation_token: invitation,
    verification_receipt: await proof(memberEmail, 'accept_invitation', invitation), idempotency_key: randomUUID() })
  ownedUsers.add(member.session.user.id)
  need(member.session.user.id === member.membership.identity_id && member.session.user.id !== founder.session.user.id, 'independent member binding')
  const disabled = await call({ action: 'disable', member_id: member.membership.id, expected_revision: member.membership.revision,
    idempotency_key: randomUUID() }, founder.session.access_token)
  expect(disabled.revocation.state).toBe('complete'); expect(disabled.handoff.state).toBe('pending')
  expect(modelRevocations.length).toBe(1)
  expect((await db.query('SELECT count(*)::int n FROM auth.sessions WHERE user_id=$1', [member.session.user.id])).rows[0].n).toBe(0)
  const restored = await call({ action: 'restore', member_id: member.membership.id, expected_revision: disabled.membership.revision,
    idempotency_key: randomUUID() }, founder.session.access_token)
  expect(restored.requires_sign_in).toBe(true)
  const signed = await call({ action: 'sign_in', verification_receipt: await proof(memberEmail, 'sign_in'), team_id: founder.team.id })
  const pending = await call({ action: 'change_email', member_id: member.membership.id, new_email: nextEmail,
    expected_revision: signed.membership.revision, idempotency_key: randomUUID() }, founder.session.access_token)
  expect(pending.state).toBe('pending')
  const done = await call({ action: 'confirm_email_change', challenge_id: pending.challenge_id,
    code: await code(nextEmail), idempotency_key: randomUUID() }, signed.session.access_token)
  expect(done.state).toBe('changed'); expect(done.requires_sign_in).toBe(true)
  expect((await db.query('SELECT count(*)::int n FROM auth.sessions WHERE user_id=$1', [member.session.user.id])).rows[0].n).toBe(0)
  need((await db.query('SELECT email_normalized FROM team_private.members WHERE id=$1', [member.membership.id])).rows[0].email_normalized === nextEmail, 'confirmed email applied')
})
