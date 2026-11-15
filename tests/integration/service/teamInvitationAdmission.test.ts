import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let db: pg.Client
let previousRegion: string | null
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
beforeEach(async () => {
  await db.query('BEGIN')
  previousRegion = (await db.query('SELECT region FROM team_private.deployment WHERE singleton')).rows[0].region
  await db.query("UPDATE team_private.deployment SET region='cn' WHERE singleton")
})
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
  return { id: p.plan.principal_id, session, team: p.plan.team_id, member: p.plan.member_id, email: address }
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
  await db.query("UPDATE team_private.invitations SET state='accepted',expires_at=now()-interval '1 second' WHERE id=$1", [i.invitation_id])
  expect(await delivery(i, 'prepare')).toMatchObject({ state: 'accepted', claimed: false })
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

it('cannot recreate an erased delivery through a late finish', async () => {
  const i = await invitation(await founder()), claimed = await delivery(i)
  await db.query('DELETE FROM team_private.invitations WHERE id=$1', [i.invitation_id])
  expect((await refused(() => rpc('team_mail_delivery', ['finish', { delivery_id: claimed.delivery_id,
    lease_token: claimed.lease_token, state: 'accepted', reason_code: 'smtp_accepted' }]))).hint).toBe('version_conflict')
  expect((await db.query('SELECT count(*)::int n FROM team_private.mail_deliveries WHERE id=$1', [claimed.delivery_id])).rows[0].n).toBe(0)
})

it.each(['global_short', 'global_daily', 'team_short', 'team_daily', 'inviter_short', 'inviter_daily'])('enforces the configured %s bucket without any IP', async dimension => {
  await policy({ [dimension]: dimension.startsWith('global') ? 2 : 1, invitation_global_percent: 50 })
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

it('requires an accepted code receipt before idempotent completion and never resets verification progress', async () => {
  const challenge = await rpc('team_email_workflow', ['begin', { purpose: 'create', email: randomUUID() + '@completion.invalid' }])
  const input = { kind: 'code', challenge_id: challenge.challenge_id }
  const complete = () => rpc('team_mail_delivery', ['complete_code', input])
  expect((await refused(complete)).hint).toBe('version_conflict')
  const claimed = await rpc('team_mail_delivery', ['claim', input])
  expect((await refused(complete)).hint).toBe('version_conflict')
  await rpc('team_mail_delivery', ['finish', { delivery_id: claimed.delivery_id, lease_token: claimed.lease_token,
    state: 'accepted', reason_code: 'code_accepted' }])
  expect(await complete()).toMatchObject({ state: 'challenge' })
  expect(await complete()).toMatchObject({ state: 'challenge' })
  const verification = await rpc('team_email_workflow', ['claim', { challenge_id: challenge.challenge_id }])
  expect(await complete()).toMatchObject({ state: 'verifying' })
  expect((await db.query('SELECT attempts,lease_token FROM team_private.email_challenges WHERE id=$1', [challenge.challenge_id])).rows[0])
    .toEqual({ attempts: 1, lease_token: verification.lease_token })
  await rpc('team_email_workflow', ['verified', { challenge_id: challenge.challenge_id, lease_token: verification.lease_token,
    verified_email: challenge.email, receipt_digest: hash(randomUUID()) }])
  expect(await complete()).toMatchObject({ state: 'verified' })
  await db.query("UPDATE team_private.email_challenges SET state='consumed' WHERE id=$1", [challenge.challenge_id])
  expect(await complete()).toMatchObject({ state: 'consumed' })
  await db.query('DELETE FROM team_private.email_challenges WHERE id=$1', [challenge.challenge_id])
  expect((await refused(complete)).hint).toBe('verification_expired')
})

it('does not revive expired, failed or exhausted challenges or accept the wrong code receipt', async () => {
  const begin = () => rpc('team_email_workflow', ['begin', { purpose: 'create', email: randomUUID() + '@code-negative.invalid' }])
  const challenge = await begin(), other = await begin()
  const complete = (id = challenge.challenge_id) => rpc('team_mail_delivery', ['complete_code', { kind: 'code', challenge_id: id }])
  const claimed = await rpc('team_mail_delivery', ['claim', { kind: 'code', challenge_id: challenge.challenge_id }])
  await rpc('team_mail_delivery', ['finish', { delivery_id: claimed.delivery_id, lease_token: claimed.lease_token,
    state: 'accepted', reason_code: 'code_accepted' }])
  expect((await refused(() => complete(other.challenge_id))).hint).toBe('version_conflict')
  await db.query("UPDATE team_private.mail_deliveries SET reason_code='smtp_accepted' WHERE id=$1", [claimed.delivery_id])
  expect((await refused(() => complete())).hint).toBe('version_conflict')
  await db.query("UPDATE team_private.mail_deliveries SET reason_code='code_accepted' WHERE id=$1", [claimed.delivery_id])
  await db.query("UPDATE team_private.email_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [challenge.challenge_id])
  expect((await refused(() => complete())).hint).toBe('verification_expired')
  await db.query("UPDATE team_private.email_challenges SET expires_at=now()+interval '5 minutes',state='failed' WHERE id=$1", [challenge.challenge_id])
  expect((await refused(() => complete())).hint).toBe('verification_expired')
  for (const state of ['sending', 'challenge']) {
    await db.query('UPDATE team_private.email_challenges SET state=$2,attempts=5 WHERE id=$1', [challenge.challenge_id, state])
    expect((await refused(() => complete())).hint).toBe('invalid_code')
    expect((await db.query('SELECT state,attempts FROM team_private.email_challenges WHERE id=$1', [challenge.challenge_id])).rows[0])
      .toEqual({ state, attempts: 5 })
  }
  expect((await db.query('SELECT count(*)::int n FROM team_private.mail_deliveries WHERE challenge_id=$1', [other.challenge_id])).rows[0].n).toBe(0)
})

it('keeps independent recipient cooldowns and reserves global capacity for OTP', async () => {
  await policy({ global_short: 5, invitation_global_percent: 60 })
  const owner = await founder(), address = randomUUID() + '@recipient.invalid'
  await delivery(await invitation(owner, address))
  await delivery(await invitation(owner))
  await delivery(await invitation(owner))
  expect((await refused(async () => delivery(await invitation(owner)))).hint).toBe('rate_limited')
  const challenge = await rpc('team_email_workflow', ['begin', { purpose: 'sign_in', email: address }])
  expect(await rpc('team_mail_delivery', ['claim', { kind: 'code', challenge_id: challenge.challenge_id }])).toMatchObject({ claimed: true })
  expect((await db.query('SELECT count(*)::int n FROM team_private.mail_deliveries WHERE admitted_at IS NOT NULL')).rows[0].n).toBe(4)
})

it('rejects incomplete or nonpositive policy changes rather than disabling admission', async () => {
  expect((await refused(() => policy({ global_short: 0 }))).code).toBe('23514')
  expect((await refused(() => db.query("UPDATE team_private.delivery_configuration SET mail_policy='{}'"))).code).toBe('23514')
})

async function overlapping(firstSql: string, firstArgs: unknown[], secondSql: string, secondArgs: unknown[]) {
  const a = new pg.Client({ connectionString: process.env.GUGU_INTEGRATION_DATABASE_URL }), b = new pg.Client({ connectionString: process.env.GUGU_INTEGRATION_DATABASE_URL })
  try {
    await a.connect(); await b.connect()
    const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid
    await a.query('BEGIN'); await b.query('BEGIN')
    const first = (await a.query(firstSql, firstArgs)).rows[0].r
    const second = b.query(secondSql, secondArgs).then(value => ({ value, error: null }), error => ({ value: null, error }))
    let blocked = false
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if ((await db.query("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.blocked) { blocked = true; break }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(blocked, 'the second independent connection must actually wait for the first transaction').toBe(true)
    await a.query('COMMIT')
    const outcome = await second
    await b.query('ROLLBACK')
    return { first, outcome }
  } finally {
    await Promise.allSettled([a.query('ROLLBACK'), b.query('ROLLBACK')])
    await Promise.allSettled([a.end(), b.end()])
  }
}
async function removeCommittedFixture(owner: Actor, previousPolicy: unknown) {
  await db.query('BEGIN')
  await db.query('DELETE FROM team_private.mail_deliveries WHERE team_id=$1', [owner.team])
  await db.query('DELETE FROM team_private.email_challenges WHERE team_id=$1 OR email_normalized=$2', [owner.team, owner.email])
  await db.query('DELETE FROM team_private.member_operations WHERE team_id=$1', [owner.team])
  await db.query('DELETE FROM team_private.asset_custody WHERE team_id=$1', [owner.team])
  await db.query('DELETE FROM team_private.invitations WHERE team_id=$1', [owner.team])
  await db.query('DELETE FROM team_private.members WHERE team_id=$1', [owner.team])
  await db.query('DELETE FROM team_private.teams WHERE id=$1', [owner.team])
  await db.query('DELETE FROM auth.users WHERE id=$1', [owner.id])
  await db.query('UPDATE team_private.delivery_configuration SET mail_policy=$1::jsonb WHERE singleton', [previousPolicy])
  await db.query('UPDATE team_private.deployment SET region=$1 WHERE singleton', [previousRegion])
  await db.query('COMMIT')
  await db.query('BEGIN') // afterEach retains its normal rollback boundary.
}

it('prevents simultaneous invitation creation from exceeding a one-slot team cap', async () => {
  const previous = (await db.query('SELECT mail_policy FROM team_private.delivery_configuration WHERE singleton')).rows[0].mail_policy
  const owner = await founder(); await policy({ max_pending: 1 }); await db.query('COMMIT')
  try {
    const body = () => ({ email: randomUUID() + '@concurrent.invalid', role: 'member', idempotency_key: randomUUID() })
    const result = await overlapping('SELECT public.team_member_workflow($1,$2,$3,$4) r', ['invite', owner.id, owner.session, body()],
      'SELECT public.team_member_workflow($1,$2,$3,$4) r', ['invite', owner.id, owner.session, body()])
    expect(result.first.invitation_id).toBeTruthy(); expect(result.outcome.error?.hint).toBe('invitation_limit_reached')
    expect((await db.query('SELECT count(*)::int n FROM team_private.invitations WHERE team_id=$1', [owner.team])).rows[0].n).toBe(1)
  } finally { await removeCommittedFixture(owner, previous) }
})

it('serializes simultaneous claims at the invitation share of the global bucket', async () => {
  const previous = (await db.query('SELECT mail_policy FROM team_private.delivery_configuration WHERE singleton')).rows[0].mail_policy
  const owner = await founder(), first = await invitation(owner), second = await invitation(owner)
  await policy({ global_short: 2, invitation_global_percent: 50 }); await db.query('COMMIT')
  try {
    const sql = "SELECT public.team_mail_delivery('claim',$1,$2,$3,NULL) r"
    const args = (i: Invitation) => [{ kind: 'invitation', invitation_id: i.invitation_id }, owner.id, owner.session]
    const result = await overlapping(sql, args(first), sql, args(second))
    expect(result.first.claimed).toBe(true); expect(result.outcome.error?.hint).toBe('rate_limited')
    expect((await db.query('SELECT count(*)::int n FROM team_private.mail_deliveries WHERE team_id=$1 AND admitted_at IS NOT NULL', [owner.team])).rows[0].n).toBe(1)
  } finally { await removeCommittedFixture(owner, previous) }
})
