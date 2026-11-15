import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
let db: pg.Client
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
beforeEach(async () => { await db.query('BEGIN'); await db.query("UPDATE team_private.deployment SET region='cn' WHERE singleton") })
afterEach(async () => { await db.query('ROLLBACK') })
afterAll(async () => { await db?.end() })
const emailFlow = async (action: string, input: unknown) => (await db.query('SELECT public.team_email_workflow($1,$2) r', [action, input])).rows[0].r
const provision = async (action: string, input: unknown) => (await db.query('SELECT public.team_account_provision($1,$2) r', [action, input])).rows[0].r
const memberFlow = async (actor: any, action: string, input: unknown) => (await db.query('SELECT public.team_member_workflow($1,$2,$3,$4) r', [action, actor.id, actor.session, input])).rows[0].r
async function refused(sql: string, args: unknown[]) {
  await db.query('SAVEPOINT denied')
  try { await db.query(sql, args); throw Error('Expected refusal') }
  catch (error) { await db.query('ROLLBACK TO SAVEPOINT denied'); return error as Error & { hint?: string } }
}
// SQL state-machine fixtures only: these service transitions do not attest
// official email delivery, Auth HTTP verification or a deployed Edge lifecycle.
async function receipt(address: string, purpose = 'create', extra: Record<string, unknown> = {}) {
  const c = await emailFlow('begin', { email: address, purpose, ...extra })
  await emailFlow('sent', { challenge_id: c.challenge_id, sent: true })
  const claim = await emailFlow('claim', { challenge_id: c.challenge_id })
  const digest = hash(randomUUID())
  await emailFlow('verified', { challenge_id: c.challenge_id, lease_token: claim.lease_token, verified_email: address, receipt_digest: digest })
  return { digest, challenge: c.challenge_id }
}
async function activate(prepared: any) {
  const p = prepared.plan
  await db.query(`INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,raw_app_meta_data)
    VALUES($1,'authenticated','authenticated',$2,now(),now(),$3)`, [p.principal_id, p.alias, {
    gugu_account_kind: 'team_member', gugu_team_id: p.team_id, gugu_member_id: p.member_id, gugu_team_region: p.region,
  }])
  const active = await provision('activate', { member_id: p.member_id, principal_id: p.principal_id })
  const session = randomUUID(); await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [session, p.principal_id])
  return { ...active, id: p.principal_id, session, address: p.alias }
}
async function founder() {
  const address = randomUUID() + '@workflow.invalid', proof = await receipt(address)
  const prepared = await provision('create', { receipt_digest: proof.digest, name: 'Workflow team', idempotency_key: randomUUID() })
  return { ...(await activate(prepared)), email: address }
}

it('keeps every workflow RPC server-only and all private state inaccessible to API roles', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const signature of ['public.team_email_workflow(text,jsonb)', 'public.team_account_provision(text,jsonb)',
      'public.team_account_read(text,uuid,uuid,jsonb)', 'public.team_member_workflow(text,uuid,uuid,jsonb)']) {
      expect((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') ok', [role, signature])).rows[0].ok).toBe(false)
    }
    for (const table of ['email_challenges', 'invitations', 'member_operations', 'asset_custody'])
      expect((await db.query('SELECT has_table_privilege($1,$2,\'SELECT\') ok', [role, 'team_private.' + table])).rows[0].ok).toBe(false)
  }
})

it('expires verification without extending the original deadline and refuses the wrong lease', async () => {
  const c = await emailFlow('begin', { email: randomUUID() + '@workflow.invalid', purpose: 'create' })
  await emailFlow('sent', { challenge_id: c.challenge_id, sent: true })
  await emailFlow('claim', { challenge_id: c.challenge_id })
  const error = await refused('SELECT public.team_email_workflow($1,$2)', ['verified', { challenge_id: c.challenge_id, lease_token: randomUUID(), verified_email: 'wrong@workflow.invalid', receipt_digest: hash(randomUUID()) }])
  expect(error.hint).toBe('version_conflict')
  await db.query("UPDATE team_private.email_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [c.challenge_id])
  expect((await refused('SELECT public.team_email_workflow($1,$2)', ['claim', { challenge_id: c.challenge_id }])).hint).toBe('verification_expired')
})

it('reuses one pending team/principal on same-key creation and rejects changed parameters', async () => {
  const address = randomUUID() + '@workflow.invalid', proof = await receipt(address), key = randomUUID()
  const input = { receipt_digest: proof.digest, name: 'One team', idempotency_key: key }
  const first = await provision('create', input), replay = await provision('create', input)
  expect(replay).toEqual(first)
  expect((await refused('SELECT public.team_account_provision($1,$2)', ['create', { ...input, name: 'Changed team' }])).hint).toBe('idempotency_conflict')
  expect((await db.query('SELECT count(*)::int n FROM team_private.members WHERE email_normalized=$1', [address])).rows[0].n).toBe(1)
  const active = await activate(first)
  expect(active.context.member_identity_id).toBe(first.plan.principal_id)
  const profile = (await db.query("SELECT public.team_account_read('profile',$1,$2) r", [active.id, active.session])).rows[0].r
  expect(profile.membership_revision).toBe(profile.membership.revision)
  expect(profile.profile.email).toBe(address)
  expect(profile.realtime_namespace).toContain('session:' + active.session + ':')
})

it('does not consume a verified login receipt when the member must choose a team', async () => {
  const owner = await founder(), second = randomUUID(), secondMember = randomUUID(), secondPrincipal = randomUUID()
  await db.query("INSERT INTO team_private.teams(id,name,region,state) VALUES($1,'Other same-email team','cn','active')", [second])
  await db.query(`INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,raw_app_meta_data)
    VALUES($1,'authenticated','authenticated',$2,now(),now(),$3)`, [secondPrincipal, 'team-' + secondMember.replaceAll('-', '') + '@team.gugu.invalid', {
    gugu_account_kind: 'team_member', gugu_team_id: second, gugu_member_id: secondMember, gugu_team_region: 'cn',
  }])
  await db.query("INSERT INTO team_private.members(id,team_id,principal_user_id,planned_principal_id,email_normalized,role,state) VALUES($1,$2,$3,$3,$4,'superadmin','active')", [secondMember, second, secondPrincipal, owner.email])
  await db.query("UPDATE team_private.email_challenges SET created_at=created_at-interval '2 minutes',expires_at=expires_at-interval '2 minutes' WHERE email_normalized=$1", [owner.email])
  const proof = await receipt(owner.email, 'sign_in')
  const choose = await provision('sign_in', { receipt_digest: proof.digest })
  expect(choose.refusal).toBe('context_required'); expect(choose.contexts).toHaveLength(2)
  expect((await db.query('SELECT state FROM team_private.email_challenges WHERE id=$1', [proof.challenge])).rows[0].state).toBe('verified')
  const selected = await provision('sign_in', { receipt_digest: proof.digest, team_id: owner.context.team_id })
  expect(selected.membership.identity_id).toBe(owner.id)
})

it('replays disable with its original revision without transferring legacy chat authority or claiming handoff complete', async () => {
  const owner = await founder(), address = randomUUID() + '@workflow.invalid', key = randomUUID()
  const invitation = await memberFlow(owner, 'invite', { email: address, role: 'member', idempotency_key: key })
  const tokenDigest = hash(randomUUID())
  await memberFlow(owner, 'bind_invitation', { invitation_id: invitation.invitation_id, token_digest: tokenDigest })
  const proof = await receipt(address, 'accept_invitation', { invitation_digest: tokenDigest })
  const seat = await activate(await provision('accept_invitation', { receipt_digest: proof.digest, invitation_digest: tokenDigest, idempotency_key: randomUUID() }))
  const args = { member_id: seat.membership.id, expected_revision: 1, idempotency_key: randomUUID() }
  const first = await memberFlow(owner, 'disable', args), replay = await memberFlow(owner, 'disable', args)
  expect(replay).toEqual(first); expect(first.membership.state).toBe('disabled'); expect(first.membership.revision).toBe(2)
  const state = await memberFlow(owner, 'revocation_result', { operation_id: first.operation_id })
  expect(state.state).toBe('revoking'); expect(state.handoff_complete).toBe(false)
  expect((await refused("SELECT public.team_account_read('profile',$1,$2)", [seat.id, seat.session])).hint).toBe('membership_disabled')
  expect((await db.query('SELECT principal_user_id FROM team_private.members WHERE id=$1', [seat.membership.id])).rows[0].principal_user_id).toBe(seat.id)
  const restore = { member_id: seat.membership.id, expected_revision: 2, idempotency_key: randomUUID() }
  expect((await refused('SELECT public.team_member_workflow($1,$2,$3,$4)', ['restore', owner.id, owner.session, restore])).hint).toBe('revocation_pending')
  await memberFlow(owner, 'revocation_checkpoint', { operation_id: first.operation_id, auth_sessions_revoked: true,
    auth_banned: true, model_authorization_revoked: true })
  const revoked = await memberFlow(owner, 'revocation_result', { operation_id: first.operation_id })
  expect(revoked.state).toBe('complete'); expect(revoked.handoff_complete).toBe(false)
  const restoring = await memberFlow(owner, 'restore', restore)
  expect(restoring.membership.state).toBe('disabled')
  expect((await refused('SELECT public.team_member_workflow($1,$2,$3,$4)', ['restore_finish', owner.id, owner.session,
    { operation_id: restoring.operation_id }])).hint).toBe('version_conflict')
  await db.query('DELETE FROM auth.sessions WHERE user_id=$1', [seat.id])
  const restored = await memberFlow(owner, 'restore_finish', { operation_id: restoring.operation_id })
  expect(restored.membership.state).toBe('active'); expect(restored.membership.revision).toBe(3)
  expect(restored.requires_sign_in).toBe(true); expect(restored.handoff_state).toBe('pending')
  const replayRestore = await memberFlow(owner, 'restore', restore)
  expect(replayRestore.operation_state).toBe('complete'); expect(replayRestore.membership.revision).toBe(3)
})
