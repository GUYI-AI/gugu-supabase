import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let db: pg.Client
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
beforeEach(async () => { await db.query('BEGIN'); await db.query("UPDATE team_private.deployment SET region='cn' WHERE singleton") })
afterEach(async () => { await db.query('ROLLBACK') })
afterAll(async () => { await db?.end() })
const rpc = async (name: string, args: unknown[]) => (await db.query(`SELECT public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) r`, args)).rows[0].r
async function founder() {
  const address = randomUUID() + '@admission.invalid'
  const challenge = await rpc('team_email_workflow', ['begin', { email: address, purpose: 'create' }])
  await rpc('team_email_workflow', ['sent', { challenge_id: challenge.challenge_id, sent: true }])
  const claim = await rpc('team_email_workflow', ['claim', { challenge_id: challenge.challenge_id }]), digest = hash(randomUUID())
  await rpc('team_email_workflow', ['verified', { challenge_id: challenge.challenge_id, lease_token: claim.lease_token, verified_email: address, receipt_digest: digest }])
  const p = await rpc('team_account_provision', ['create', { receipt_digest: digest, name: 'Admission fixture', idempotency_key: randomUUID() }])
  await db.query(`INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,raw_app_meta_data)
    VALUES($1,'authenticated','authenticated',$2,now(),now(),$3)`, [p.plan.principal_id, p.plan.alias, {
    gugu_account_kind: 'team_member', gugu_team_id: p.plan.team_id, gugu_member_id: p.plan.member_id, gugu_team_region: 'cn',
  }])
  await rpc('team_account_provision', ['activate', { member_id: p.plan.member_id, principal_id: p.plan.principal_id }])
  const session = randomUUID(); await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [session, p.plan.principal_id])
  return { id: p.plan.principal_id, session, team: p.plan.team_id, member: p.plan.member_id }
}
type Actor = Awaited<ReturnType<typeof founder>>
async function invitation(actor: Actor, email = randomUUID() + '@recipient.invalid', key = randomUUID()) {
  const result = await rpc('team_member_workflow', ['invite', actor.id, actor.session, { email, role: 'member', idempotency_key: key }])
  await rpc('team_member_workflow', ['bind_invitation', actor.id, actor.session, { invitation_id: result.invitation_id, token_digest: hash(result.invitation_id) }])
  return { ...result, actor, email, key }
}
type Invitation = Awaited<ReturnType<typeof invitation>>
const delivery = (i: Invitation, action = 'claim', ip: string | null = null) => rpc('team_mail_delivery', [action, { kind: 'invitation', invitation_id: i.invitation_id }, i.actor.id, i.actor.session, ip])
const policy = (values: Record<string, number>) => db.query('UPDATE team_private.delivery_configuration SET mail_policy=mail_policy||$1::jsonb WHERE singleton', [values])
async function refused(run: () => Promise<unknown>) {
  await db.query('SAVEPOINT denied')
  let failure: any
  try { await run() } catch (error) { failure = error }
  await db.query('ROLLBACK TO SAVEPOINT denied')
  if (!failure) throw Error('Expected refusal')
  return failure as Error & { hint?: string; code?: string }
}

it('keeps mail state and private workflow implementation closed to API roles', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    expect((await db.query("SELECT has_table_privilege($1,'team_private.mail_deliveries','SELECT') ok", [role])).rows[0].ok).toBe(false)
    expect((await db.query("SELECT has_function_privilege($1,'team_private.member_workflow_before_mail_admission(text,uuid,uuid,jsonb)','EXECUTE') ok", [role])).rows[0].ok).toBe(false)
    expect((await db.query("SELECT has_function_privilege($1,'public.team_mail_delivery(text,jsonb,uuid,uuid,inet)','EXECUTE') ok", [role])).rows[0].ok).toBe(role === 'service_role')
  }
  const f = (await db.query(`SELECT pg_get_userbyid(proowner) owner,prosecdef,proconfig FROM pg_proc
    WHERE oid='public.team_mail_delivery(text,jsonb,uuid,uuid,inet)'::regprocedure`)).rows[0]
  expect(f).toMatchObject({ owner: 'postgres', prosecdef: true, proconfig: ['search_path=pg_catalog'] })
})

it('limits pending invitations atomically while preserving original replay and expiry release', async () => {
  await policy({ max_pending: 1 })
  const owner = await founder(), first = await invitation(owner)
  const replay = await invitation(owner, first.email, first.key)
  expect(replay.invitation_id).toBe(first.invitation_id)
  expect((await refused(() => invitation(owner))).hint).toBe('invitation_limit_reached')
  expect((await refused(() => invitation(owner, randomUUID() + '@recipient.invalid', first.key))).hint).toBe('idempotency_conflict')
  await db.query("UPDATE team_private.invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [first.invitation_id])
  expect((await invitation(owner)).invitation_id).not.toBe(first.invitation_id)
})

it('requires a live administrator and a bound valid invitation before claiming', async () => {
  const owner = await founder(), other = await founder(), i = await invitation(owner)
  expect((await refused(() => delivery({ ...i, actor: other }))).hint).toBe('forbidden')
  await db.query("UPDATE team_private.members SET role='member' WHERE id=$1", [owner.member])
  expect((await refused(() => delivery(i))).hint).toBe('forbidden')
  await db.query("UPDATE team_private.members SET state='disabled',revision=revision+1 WHERE id=$1", [owner.member])
  expect((await refused(() => delivery(i))).hint).toBe('membership_disabled')
})

it('claims once and never counts a replay as another send attempt', async () => {
  const i = await invitation(await founder()), first = await delivery(i)
  expect(first).toMatchObject({ state: 'sending', claimed: true, delivery_key: 'team-invitation-v1:' + i.invitation_id })
  const replay = await delivery(i)
  expect(replay).toMatchObject({ delivery_id: first.delivery_id, state: 'sending', claimed: false, lease_token: null })
  expect((await db.query('SELECT count(*)::int n FROM team_private.mail_deliveries WHERE admitted_at IS NOT NULL')).rows[0].n).toBe(1)
  expect((await refused(() => rpc('team_mail_delivery', ['finish', { delivery_id: first.delivery_id, lease_token: randomUUID(), state: 'accepted', reason_code: 'smtp_accepted' }]))).hint).toBe('version_conflict')
  const result = await rpc('team_mail_delivery', ['finish', { delivery_id: first.delivery_id, lease_token: first.lease_token, state: 'accepted', reason_code: 'smtp_accepted' }])
  expect(result.state).toBe('accepted')
  expect(await delivery(i)).toMatchObject({ state: 'accepted', claimed: false })
})

it('does not automatically reclaim unknown outcomes or expired sending leases', async () => {
  const owner = await founder(), first = await invitation(owner), claimed = await delivery(first)
  await rpc('team_mail_delivery', ['finish', { delivery_id: claimed.delivery_id, lease_token: claimed.lease_token, state: 'unknown', reason_code: 'smtp_result_unknown' }])
  expect(await delivery(first)).toMatchObject({ state: 'unknown', claimed: false })
  const second = await invitation(owner), pending = await delivery(second)
  await db.query("UPDATE team_private.mail_deliveries SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [pending.delivery_id])
  expect(await delivery(second)).toMatchObject({ state: 'unknown', reason_code: 'lease_expired', claimed: false })
})

it('records a legitimate late send result even after its original caller is disabled', async () => {
  const i = await invitation(await founder()), claimed = await delivery(i)
  await db.query("UPDATE team_private.members SET state='disabled',revision=revision+1 WHERE id=$1", [i.actor.member])
  expect(await rpc('team_mail_delivery', ['finish', { delivery_id: claimed.delivery_id, lease_token: claimed.lease_token, state: 'accepted', reason_code: 'smtp_accepted' }])).toMatchObject({ state: 'accepted' })
})

it.each(['global_short', 'global_daily', 'team_short', 'team_daily', 'inviter_short', 'inviter_daily'])('enforces the configured %s bucket without any IP', async dimension => {
  await policy({ [dimension]: 1 })
  const owner = await founder(), first = await invitation(owner), second = await invitation(owner)
  expect((await delivery(first)).claimed).toBe(true)
  expect((await refused(() => delivery(second))).hint).toBe('rate_limited')
})

it('shares recipient cooldown and daily admission across teams and preserves other recipients', async () => {
  const one = await founder(), two = await founder(), address = randomUUID() + '@recipient.invalid'
  const first = await invitation(one, address), second = await invitation(two, address)
  const claimed = await delivery(first)
  expect((await refused(() => delivery(second))).hint).toBe('rate_limited')
  await db.query("UPDATE team_private.mail_deliveries SET admitted_at=now()-interval '2 minutes' WHERE id=$1", [claimed.delivery_id])
  await policy({ recipient_daily: 1 })
  expect((await refused(() => delivery(second))).hint).toBe('rate_limited')
  expect((await delivery(await invitation(two))).claimed).toBe(true)
})

it('adds the configured IP bucket without weakening mandatory global admission', async () => {
  await policy({ ip_short: 1 })
  const owner = await founder(), one = await invitation(owner), two = await invitation(owner), three = await invitation(owner)
  expect((await delivery(one, 'claim', '2001:db8::1')).claimed).toBe(true)
  expect((await refused(() => delivery(two, 'claim', '2001:0db8:0000::1'))).hint).toBe('rate_limited')
  expect((await delivery(two, 'claim', '2001:db8::2')).claimed).toBe(true)
  await policy({ global_short: 2 })
  expect((await refused(() => delivery(three, 'claim', null))).hint).toBe('rate_limited')
})

it('does not let an unauthenticated code challenge invent a team admission scope', async () => {
  const owner = await founder(), challenge = await rpc('team_email_workflow', ['begin', { purpose: 'sign_in', email: randomUUID() + '@signin.invalid', team_id: owner.team }])
  const result = await rpc('team_mail_delivery', ['claim', { kind: 'code', challenge_id: challenge.challenge_id }])
  expect(result.claimed).toBe(true)
  expect((await db.query('SELECT team_id,inviter_member_id FROM team_private.mail_deliveries WHERE id=$1', [result.delivery_id])).rows[0]).toEqual({ team_id: null, inviter_member_id: null })
})

it('rejects incomplete or nonpositive policy changes rather than disabling admission', async () => {
  expect((await refused(() => policy({ global_short: 0 }))).code).toBe('23514')
  expect((await refused(() => db.query("UPDATE team_private.delivery_configuration SET mail_policy='{}'"))).code).toBe('23514')
})
