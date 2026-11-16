import { randomUUID, createHash } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: pg.Client
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
type Args = Record<string, string | number | null>
const consent = 'immediate-forfeit-v1'
const names = ['p_operation_digest', 'p_receipt_digest', 'p_user_id', 'p_session_id', 'p_email_digest', 'p_consent_version', 'p_generation', 'p_confirmation_id', 'p_lease_token', 'p_error_code', 'p_device_id', 'p_native_generation', 'p_server_generation']
async function flow(action: string, args: Args) {
  return (await db.query(`SELECT public.account_deletion_operation_flow(p_action:=$1,${names.map((n, i) => `${n}:=$${i + 2}`).join(',')}) r`, [action, ...names.map(n => args[n] ?? null)])).rows[0].r
}
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
beforeEach(async () => { await db.query('BEGIN') })
afterEach(async () => { await db.query('ROLLBACK') })
afterAll(async () => { await db?.end() })
async function fixture() {
  const user = randomUUID(), session = randomUUID(), email = `${user}@operation.invalid`
  await db.query("INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at) VALUES($1,'authenticated','authenticated',$2,now(),now())", [user, email])
  await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [session, user])
  await db.query('UPDATE account_deletion_private.access SET test_only=true,test_user_id=$1', [user])
  await db.query('UPDATE account_deletion_private.operation_access SET enabled=true')
  return { p_operation_digest: hash(randomUUID()), p_receipt_digest: hash(randomUUID()), p_user_id: user, p_session_id: session,
    p_email_digest: hash(email), p_consent_version: consent, p_generation: 1, p_native_generation: randomUUID(), p_server_generation: randomUUID(), p_confirmation_id: randomUUID() }
}
async function challenge(args: Args) {
  const begun = await flow('begin', args); expect(begun.ok).toBe(true)
  expect((await flow('sent', { ...args, p_lease_token: begun.lease_token })).ok).toBe(true)
  return begun
}
async function preparationContractFixture() {
  // Transaction-local contract stub; this is not device/heartbeat validation.
  await db.query(`CREATE OR REPLACE FUNCTION account_deletion_private.device_preparation_read(p_operation_id uuid,p_native_generation uuid,p_server_generation uuid)
    RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('prepared',true,'native_generation',p_native_generation,'server_generation',p_server_generation) $$`)
  await db.query(`CREATE OR REPLACE FUNCTION account_deletion_private.device_preparation_cancel(p_operation_id uuid,p_native_generation uuid,p_server_generation uuid)
    RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM account_deletion_private.operations WHERE id=p_operation_id AND state='closed_before_confirm' AND confirm_started_at IS NULL) THEN RAISE EXCEPTION 'Parent is not closed'; END IF;
      RETURN jsonb_build_object('cancelled',true,'native_generation',p_native_generation,'server_generation',p_server_generation);
    END $$`)
}
describe('recoverable deletion operation authority', () => {
  it('installs disabled and grants only the service entry, never private tables', async () => {
    expect((await db.query('SELECT enabled FROM account_deletion_private.operation_access')).rows[0].enabled).toBe(false)
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await db.query("SELECT has_table_privilege($1,'account_deletion_private.operations','UPDATE') allowed", [role])).rows[0].allowed).toBe(false)
    }
    const f = await fixture(); await db.query('UPDATE account_deletion_private.operation_access SET enabled=false')
    expect((await flow('register', f)).error).toBe('operation_unavailable')
    expect((await db.query('SELECT count(*)::int n FROM account_deletion_private.operations')).rows[0].n).toBe(0)
  })
  it('binds one operation and refuses changed capabilities or a new SID', async () => {
    const f = await fixture(), first = await flow('register', f)
    expect((await flow('register', f)).operation.operation_id).toBe(first.operation.operation_id)
    expect((await flow('register', { ...f, p_receipt_digest: hash('wrong') })).error).toBe('not_found')
    const second = randomUUID()
    await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [second, f.p_user_id])
    expect((await flow('register', { ...f, p_session_id: second })).error).toBe('scope_conflict')
    expect((await db.query('SELECT count(*)::int n FROM account_deletion_private.operations')).rows[0].n).toBe(1)
  })
  it('recovers a lost challenge response without another dispatch or renewed expiry', async () => {
    const f = await fixture(), first = await flow('begin', f), replay = await flow('begin', f)
    expect(first.dispatch_required).toBe(true); expect(replay.dispatch_required).toBe(false)
    expect(replay.operation.request_id).toBe(first.operation.request_id)
    expect(replay.operation.request.expires_at).toBe(first.operation.request.expires_at)
    expect((await flow('result', { p_operation_digest: f.p_operation_digest, p_receipt_digest: f.p_receipt_digest })).operation.request_id).toBe(first.operation.request_id)
    expect((await db.query("SELECT count(*)::int n FROM account_deletion_private.events WHERE event='send_started'")).rows[0].n).toBe(1)
  })
  it('does not turn an unknown send into an expired-lease resend', async () => {
    const f = await fixture(), first = await flow('begin', f)
    await flow('sent', { ...f, p_lease_token: first.lease_token, p_error_code: 'email_outcome_unknown' })
    expect((await flow('begin', f)).dispatch_required).toBe(false)
    await db.query("UPDATE account_deletion_private.requests SET created_at=now()-interval '2 minutes' WHERE id=$1", [first.operation.request_id])
    expect((await flow('begin', { ...f, p_generation: 2 })).error).toBe('request_active')
  })
  it('blocks the legacy RPC from confirming a V2 child', async () => {
    const f = await fixture(), c = await challenge(f)
    const result = (await db.query("SELECT public.account_deletion_flow(p_action:='attempt',p_user_id:=$1,p_session_id:=$2,p_request_id:=$3,p_receipt_digest:=$4,p_email_digest:=$5,p_consent_version:=$6) r", [f.p_user_id, f.p_session_id, c.operation.request_id, f.p_receipt_digest, f.p_email_digest, consent])).rows[0].r
    expect(result.error).toBe('operation_protocol_required')
  })
  it('deduplicates final intent and never permits cancellation after confirmation starts', async () => {
    const f = await fixture(); await challenge(f); await preparationContractFixture()
    const first = await flow('claim_confirmation', f), replay = await flow('claim_confirmation', f)
    expect(first.dispatch_required).toBe(true); expect(replay.dispatch_required).toBe(false)
    expect((await db.query('SELECT verification_attempts FROM account_deletion_private.requests WHERE id=$1', [first.operation.request_id])).rows[0].verification_attempts).toBe(1)
    expect((await flow('cancel_preparation', f)).error).toBe('request_active')
    const verified = await flow('verified', { ...f, p_lease_token: first.lease_token })
    expect(verified.operation.state).toBe('processing')
    await flow('finish', { ...f, p_lease_token: verified.lease_token, p_error_code: 'auth_delete_failed' })
    expect((await flow('begin', { ...f, p_generation: 2 })).error).toBe('request_active')
    expect((await flow('claim_confirmation', f)).dispatch_required).toBe(false)
  })
  it('atomically closes only before confirmation and rejects a late claim', async () => {
    const f = await fixture(); await challenge(f); await preparationContractFixture()
    const closed = await flow('cancel_preparation', f)
    expect(closed.operation).toMatchObject({ state: 'closed_before_confirm', can_release_preparation: true })
    expect((await flow('claim_confirmation', f)).error).toBe('request_active')
    expect((await db.query('SELECT count(*)::int n FROM account_deletion_private.confirmation_intents')).rows[0].n).toBe(0)
  })
  it('recovers committed absence without Auth and clears original identity links', async () => {
    const f = await fixture(); await challenge(f)
    await db.query('DELETE FROM auth.users WHERE id=$1', [f.p_user_id])
    const capability = { p_operation_digest: f.p_operation_digest, p_receipt_digest: f.p_receipt_digest }
    expect((await flow('result', capability)).operation.state).toBe('deleted')
    expect((await flow('result', capability)).operation.state).toBe('deleted')
    expect((await flow('result', { ...capability, p_receipt_digest: hash('other') })).error).toBe('not_found')
    expect((await db.query('SELECT user_id,session_id,email_digest FROM account_deletion_private.operations')).rows[0]).toEqual({ user_id: null, session_id: null, email_digest: null })
  })
})
