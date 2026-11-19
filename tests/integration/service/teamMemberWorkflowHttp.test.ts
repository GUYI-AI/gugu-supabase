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
const invitationDeliveries: unknown[] = []
const codeDeliveries: string[] = []
let invitationRecipientPolicy: 'allowed' | 'blocked' = 'allowed'
let completionFailure: 'before_commit' | 'after_commit' | null = null, completionChallenge: string | null = null
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
  // SMTP acceptance is an explicit test adapter; this does not attest delivery.
  const deps = teamAccountsDependencies({ url, anonKey: anon, serviceKey: service,
    invitationMailer: { canSend: () => true, recipientPolicy: () => invitationRecipientPolicy, send: async input => {
      invitationDeliveries.push(input); return { state: 'accepted', reason_code: 'smtp_accepted' }
    } } })
  handle = createTeamAccountsHandler({ ...deps, auth: { ...deps.auth, sendEmailCode: async value => {
    codeDeliveries.push(value); return deps.auth.ensureAnchor(value)
  } }, rpc: async (name, args) => {
    if (name === 'team_mail_delivery' && args.p_action === 'complete_code' && completionFailure) {
      const phase = completionFailure; completionFailure = null
      completionChallenge = (args.p_input as { challenge_id: string }).challenge_id
      if (phase === 'before_commit') throw Error('Owned fixture completion before commit')
      await deps.rpc(name, args)
      throw Error('Owned fixture completion acknowledgment lost')
    }
    return deps.rpc(name, args)
  },
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
async function request(body: Record<string, unknown>, bearer?: string) {
  return handle(new Request('https://backend.example.invalid/functions/v1/team-accounts', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, body: JSON.stringify(body),
  }))
}
async function call(body: Record<string, unknown>, bearer?: string) {
  const response = await request(body, bearer)
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
  await db.query(`UPDATE team_private.mail_deliveries d SET admitted_at=d.admitted_at-interval '2 minutes'
    FROM team_private.email_challenges c WHERE d.challenge_id=c.id AND c.email_normalized=$1`, [email])
  const challenge = await call({ action: 'email_challenge', email, purpose, ...(invitation ? { invitation_token: invitation } : {}) })
  return (await call({ action: 'email_verify', challenge_id: challenge.challenge_id, code: await code(email) })).verification_receipt
}

it('creates, invites, signs in, disables, restores and confirms member email through real Auth sessions', async () => {
  const founderEmail = address(), memberEmail = address(), nextEmail = address()
  const founder = await call({ action: 'create', name: 'HTTP workflow fixture',
    verification_receipt: await proof(founderEmail, 'create'), idempotency_key: randomUUID() })
  teams.add(founder.team.id); ownedUsers.add(founder.session.user.id)
  need(founder.session.user.id === founder.membership.identity_id, 'independent founder binding')
  const existing = await admin.auth.admin.createUser({ email: memberEmail, email_confirm: true,
    app_metadata: { gugu_account_kind: 'personal', invitation_sentinel: 'preserve-existing' }, user_metadata: { display_name: 'Existing personal identity' } })
  need(!existing.error && existing.data.user, 'existing personal fixture')
  ownedUsers.add(existing.data.user.id)
  const originalPersonal = existing.data.user
  const inviteIntent = { action: 'invite', email: memberEmail, role: 'member', idempotency_key: randomUUID() }
  const invited = await call(inviteIntent, founder.session.access_token)
  const replay = await call(inviteIntent, founder.session.access_token)
  expect(replay.invitation_id).toBe(invited.invitation_id); expect(replay.delivery.operation_id).toBe(invited.delivery.operation_id)
  expect(replay.delivery.state).toBe('accepted'); expect(invitationDeliveries.length).toBe(1)
  expect(replay).not.toHaveProperty('seed'); expect(replay).not.toHaveProperty('recipient_email')
  const unchanged = await admin.auth.admin.getUserById(originalPersonal.id)
  need(!unchanged.error && unchanged.data.user, 'personal identity readback')
  expect(unchanged.data.user.email).toBe(originalPersonal.email)
  expect(unchanged.data.user.app_metadata).toEqual(originalPersonal.app_metadata)
  expect(unchanged.data.user.user_metadata).toEqual(originalPersonal.user_metadata)
  const invitation = new URL(invited.invitation_url).hash.slice('#invitation_token='.length)
  const member = await call({ action: 'accept_invitation', invitation_token: invitation,
    verification_receipt: await proof(memberEmail, 'accept_invitation', invitation), idempotency_key: randomUUID() })
  ownedUsers.add(member.session.user.id)
  need(member.session.user.id === member.membership.identity_id && member.session.user.id !== founder.session.user.id, 'independent member binding')
  expect(member.session.user.id).not.toBe(originalPersonal.id)
  const directory = await handle(new Request('https://backend.example.invalid/functions/v1/team-accounts?' + new URLSearchParams({
    action: 'directory', query: memberEmail.toUpperCase(), limit: '1',
  }), { headers: { authorization: 'Bearer ' + member.session.access_token } }))
  expect(directory.status).toBe(200)
  expect((await directory.json()).data).toMatchObject({ team_id: founder.team.id, total_count: 2, matching_count: 1,
    next_cursor: null, members: [{ id: member.membership.id, identity_id: member.session.user.id, email: memberEmail, role: 'member' }] })
  for (const limit of ['0', '101']) {
    const invalid = await handle(new Request('https://backend.example.invalid/functions/v1/team-accounts?action=directory&limit=' + limit,
      { headers: { authorization: 'Bearer ' + member.session.access_token } }))
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).error.code).toBe('invalid_request')
  }
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

it.each(['before_commit', 'after_commit'] as const)('recovers change-email code completion %s through a same-intent HTTP retry', async phase => {
  const founderEmail = address(), memberEmail = address(), nextEmail = address()
  const founder = await call({ action: 'create', name: 'Code receipt fixture',
    verification_receipt: await proof(founderEmail, 'create'), idempotency_key: randomUUID() })
  teams.add(founder.team.id); ownedUsers.add(founder.session.user.id)
  const invited = await call({ action: 'invite', email: memberEmail, role: 'member', idempotency_key: randomUUID() }, founder.session.access_token)
  const invitation = new URL(invited.invitation_url).hash.slice('#invitation_token='.length)
  const member = await call({ action: 'accept_invitation', invitation_token: invitation,
    verification_receipt: await proof(memberEmail, 'accept_invitation', invitation), idempotency_key: randomUUID() })
  ownedUsers.add(member.session.user.id)
  const intent = { action: 'change_email', member_id: member.membership.id, new_email: nextEmail,
    expected_revision: member.membership.revision, idempotency_key: randomUUID() }
  completionChallenge = null; completionFailure = phase
  const failed = await request(intent, founder.session.access_token)
  expect(failed.status).toBe(503); await failed.body?.cancel()
  need(completionChallenge, 'completion fault exercised')
  const state = (await db.query(`SELECT c.state challenge,d.state delivery FROM team_private.email_challenges c
    JOIN team_private.mail_deliveries d ON d.challenge_id=c.id WHERE c.id=$1`, [completionChallenge])).rows[0]
  expect(state).toEqual({ challenge: phase === 'before_commit' ? 'sending' : 'challenge', delivery: 'accepted' })
  const replay = await call(intent, founder.session.access_token)
  expect(replay.challenge_id).toBe(completionChallenge)
  expect((await db.query('SELECT state FROM team_private.email_challenges WHERE id=$1', [completionChallenge])).rows[0].state).toBe('challenge')
  expect(codeDeliveries.filter(email => email === nextEmail)).toHaveLength(1)
  expect((await db.query('SELECT count(*)::int n FROM team_private.email_challenges WHERE email_normalized=$1', [nextEmail])).rows[0].n).toBe(1)
  const done = await call({ action: 'confirm_email_change', challenge_id: replay.challenge_id,
    code: await code(nextEmail), idempotency_key: randomUUID() }, member.session.access_token)
  expect(done.state).toBe('changed'); expect(done.requires_sign_in).toBe(true)
})

it('keeps invitation creation but persists a private recipient refusal without SMTP or an Auth anchor', async () => {
  const founderEmail = address(), recipient = address()
  const founder = await call({ action: 'create', name: 'Recipient refusal fixture',
    verification_receipt: await proof(founderEmail, 'create'), idempotency_key: randomUUID() })
  teams.add(founder.team.id); ownedUsers.add(founder.session.user.id)
  const before = invitationDeliveries.length
  invitationRecipientPolicy = 'blocked'
  try {
    const intent = { action: 'invite', email: recipient, role: 'member', idempotency_key: randomUUID() }
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(intent, founder.session.access_token), body = await response.json()
      expect(response.status).toBe(503)
      expect(body.data).toMatchObject({ invitation_created: true,
        delivery: { state: 'failed', reason_code: 'recipient_not_allowed' } })
      expect(JSON.stringify(body)).not.toContain(recipient)
      expect(JSON.stringify(body)).not.toContain(founderEmail)
    }
  } finally { invitationRecipientPolicy = 'allowed' }
  expect(invitationDeliveries.length).toBe(before)
  expect((await db.query('SELECT count(*)::int n FROM auth.users WHERE email=$1', [recipient])).rows[0].n).toBe(0)
  const row = (await db.query(`SELECT i.state,d.state delivery,d.reason_code,d.admitted_at FROM team_private.invitations i
    JOIN team_private.mail_deliveries d ON d.invitation_id=i.id WHERE i.team_id=$1 AND i.email_normalized=$2`, [founder.team.id, recipient])).rows
  expect(row).toEqual([{ state: 'invited', delivery: 'failed', reason_code: 'recipient_not_allowed', admitted_at: null }])
})
