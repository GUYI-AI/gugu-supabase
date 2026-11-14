import { randomUUID, createHash } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: pg.Client
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
beforeEach(async () => { await db.query('BEGIN') })
afterEach(async () => { await db.query('ROLLBACK') })
afterAll(async () => { await db?.end() })
type Args = Record<string, string | null>
async function flow(action: string, args: Args = {}) {
  const names = ['p_user_id', 'p_session_id', 'p_request_id', 'p_receipt_digest', 'p_email_digest', 'p_policy_version', 'p_lease_token', 'p_error_code']
  return (await db.query(`SELECT public.account_deletion_flow(p_action:=$1,${names.map((n, i) => `${n}:=$${i + 2}`).join(',')}) r`, [action, ...names.map(n => args[n] ?? null)])).rows[0].r
}
async function fixture(mode = 'immediate') {
  const user = randomUUID(), session = randomUUID(), policy = randomUUID(), receipt = hash(randomUUID()), email = `${user}@deletion.invalid`
  await db.query(`INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at) VALUES($1,'authenticated','authenticated',$2,now(),now())`, [user, email])
  await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [session, user])
  await db.query(`UPDATE account_deletion_private.policy SET enabled=true,test_only=true,test_user_id=$1,mode=$2,
    delay_seconds=$3,credit_treatment_key='fixture-policy',version=$4,worker_seen_at=NULL,worker_owner=NULL,worker_until=NULL WHERE singleton`, [user, mode, mode === 'immediate' ? 0 : 86400, policy])
  const args = { p_user_id: user, p_session_id: session, p_email_digest: hash(email), p_receipt_digest: receipt, p_policy_version: policy }
  return { user, session, policy, receipt, email, args }
}
async function challenge(f: Awaited<ReturnType<typeof fixture>>) {
  const start = await flow('begin', f.args); expect(start.ok).toBe(true)
  const id = start.request.request_id
  expect((await flow('sent', { p_request_id: id })).ok).toBe(true)
  return { ...f.args, p_request_id: id }
}
async function verify(args: Args) {
  const attempt = await flow('attempt', args); expect(attempt.ok).toBe(true)
  return flow('verified', { p_request_id: args.p_request_id, p_lease_token: attempt.lease_token })
}

describe('self deletion workflow on the installed schema', () => {
  it('is closed to end users and has no direct private-table grants', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query(`SELECT has_function_privilege($1,'public.account_deletion_flow(text,uuid,uuid,uuid,text,text,uuid,uuid,text)','EXECUTE') allowed`, [role])).rows[0].allowed).toBe(false)
      expect((await db.query(`SELECT has_table_privilege($1,'account_deletion_private.requests','SELECT') allowed`, [role])).rows[0].allowed).toBe(false)
    }
    expect((await db.query(`SELECT has_function_privilege('service_role','public.account_deletion_flow(text,uuid,uuid,uuid,text,text,uuid,uuid,text)','EXECUTE') allowed`)).rows[0].allowed).toBe(true)
    expect((await db.query(`SELECT has_table_privilege('service_role','account_deletion_private.requests','UPDATE') allowed`)).rows[0].allowed).toBe(false)
  })
  it('rejects disabled policy, a stale policy, the wrong live session, and unconfigured pending execution', async () => {
    const f = await fixture()
    await db.query('UPDATE account_deletion_private.policy SET enabled=false')
    expect((await flow('begin', f.args)).error).toBe('disabled')
    await db.query('UPDATE account_deletion_private.policy SET enabled=true')
    expect((await flow('begin', { ...f.args, p_policy_version: randomUUID() })).error).toBe('policy_changed')
    expect((await flow('begin', { ...f.args, p_session_id: randomUUID() })).error).toBe('unauthorized')
    await db.query(`UPDATE account_deletion_private.policy SET mode='pending',delay_seconds=86400`)
    expect((await flow('begin', f.args)).error).toBe('worker_unavailable')
  })
  it('keeps a test-only policy closed to everyone else, including after the test identity is erased', async () => {
    const f = await fixture(), other = randomUUID(), session = randomUUID()
    await db.query(`INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at) VALUES($1,'authenticated','authenticated',$2,now(),now())`, [other, `${other}@deletion.invalid`])
    await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [session, other])
    const args = { ...f.args, p_user_id: other, p_session_id: session, p_email_digest: hash(`${other}@deletion.invalid`) }
    expect((await flow('begin', args)).error).toBe('disabled')
    await db.query('DELETE FROM auth.users WHERE id=$1', [f.user])
    expect((await flow('begin', args)).error).toBe('disabled')
  })
  it('expires codes at five minutes and serializes confirmation to one attempt', async () => {
    const f = await fixture(), args = await challenge(f)
    expect((await flow('attempt', { ...args, p_receipt_digest: hash('wrong') })).error).toBe('invalid_proof')
    const one = await flow('attempt', args); expect(one.ok).toBe(true)
    expect((await flow('attempt', args)).error).toBe('state_conflict')
    await flow('verification_failed', { p_request_id: args.p_request_id, p_lease_token: one.lease_token })
    await db.query(`UPDATE account_deletion_private.requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [args.p_request_id])
    expect((await flow('attempt', args)).error).toBe('expired')
  })
  it('stops after five failed verification attempts and limits email sends', async () => {
    const f = await fixture(), args = await challenge(f)
    expect((await flow('begin', f.args)).error).toBe('rate_limited')
    for (let n = 0; n < 5; n++) {
      const attempt = await flow('attempt', args); expect(attempt.ok).toBe(true)
      await flow('verification_failed', { p_request_id: args.p_request_id, p_lease_token: attempt.lease_token })
    }
    expect((await flow('attempt', args)).ok).toBe(false)
    expect((await db.query('SELECT state,verification_attempts FROM account_deletion_private.requests WHERE id=$1', [args.p_request_id])).rows[0]).toEqual({ state: 'failed', verification_attempts: 5 })
  })
  it('rejects email or policy changes after a successful external proof', async () => {
    const f = await fixture(), args = await challenge(f), attempt = await flow('attempt', args)
    await db.query('UPDATE auth.users SET email=$2 WHERE id=$1', [f.user, 'changed@deletion.invalid'])
    expect((await flow('verified', { p_request_id: args.p_request_id, p_lease_token: attempt.lease_token })).error).toBe('authorization_expired')
  })
  it('does not claim deletion while Auth still exists and permits a bound retry after rollback', async () => {
    const f = await fixture(), args = await challenge(f), ready = await verify(args)
    expect(ready.request.state).toBe('processing')
    expect((await flow('finish', { p_request_id: args.p_request_id, p_lease_token: ready.lease_token })).error).toBe('auth_user_still_exists')
    const failed = await flow('finish', { p_request_id: args.p_request_id, p_lease_token: ready.lease_token, p_error_code: 'auth_delete_failed' })
    expect(failed.request.state).toBe('retry_wait')
    const retry = await flow('retry', args); expect(retry.request.state).toBe('processing')
    expect(retry.lease_token).not.toBe(ready.lease_token)
  })
  it('reconciles committed Auth deletion and removes all new original identity links', async () => {
    const f = await fixture(), args = await challenge(f), ready = await verify(args)
    // State-machine/compatibility test only. A separate HTTP test exercises Auth Admin.
    await db.query('DELETE FROM auth.users WHERE id=$1', [f.user])
    const done = await flow('finish', { p_request_id: args.p_request_id, p_lease_token: ready.lease_token })
    expect(done.request.state).toBe('deleted')
    expect((await flow('result', { p_request_id: args.p_request_id, p_receipt_digest: f.receipt })).request.state).toBe('deleted')
    expect((await flow('result', { p_request_id: args.p_request_id, p_receipt_digest: hash('wrong') })).error).toBe('not_found')
    const row = (await db.query('SELECT user_id,session_id,email_digest,verified_at FROM account_deletion_private.requests WHERE id=$1', [args.p_request_id])).rows[0]
    expect(row).toEqual({ user_id: null, session_id: null, email_digest: null, verified_at: null })
    expect((await db.query('SELECT count(*)::int n FROM account_deletion_private.events WHERE actor_user_id=$1', [f.user])).rows[0].n).toBe(0)
    expect((await db.query('SELECT test_user_id FROM account_deletion_private.policy')).rows[0].test_user_id).toBeNull()
  })
  it('schedules without partial erasure, permits explicit cancellation and never cancels an acquired deletion', async () => {
    const f = await fixture('pending'); await flow('heartbeat')
    const args = await challenge(f), pending = await verify(args)
    expect(pending.request.state).toBe('pending'); expect(pending.request.can_cancel).toBe(true)
    expect((await db.query('SELECT id FROM auth.users WHERE id=$1', [f.user])).rows).toHaveLength(1)
    expect((await flow('cancel', args)).request.state).toBe('cancelled')
    expect((await flow('claim_due', { p_lease_token: randomUUID() })).claims).toEqual([])
  })
  it('claims due pending work once, leases one consumer and backs off failures', async () => {
    const f = await fixture('pending'); await flow('heartbeat')
    const args = await challenge(f); await verify(args)
    await db.query(`UPDATE account_deletion_private.requests SET delete_after=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [args.p_request_id])
    expect((await flow('cancel', args)).error).toBe('cancellation_closed')
    const worker = randomUUID(), claim = await flow('claim_due', { p_lease_token: worker })
    expect(claim.claims).toHaveLength(1)
    expect((await flow('claim_due', { p_lease_token: randomUUID() })).claims).toEqual([])
    expect((await flow('claim_due', { p_lease_token: worker })).claims).toEqual([])
    await flow('finish', { p_request_id: args.p_request_id, p_lease_token: claim.claims[0].lease_token, p_error_code: 'auth_delete_failed' })
    expect((await flow('claim_due', { p_lease_token: worker })).claims).toEqual([])
  })
})
