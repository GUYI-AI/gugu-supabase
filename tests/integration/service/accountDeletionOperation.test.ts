import { randomUUID, createHash } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { beginDeletionFixture, endDeletionFixture } from './accountDeletionFixtureLock'

let db: pg.Client
let database: string
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
type Args = Record<string, string | number | null>
const consent = 'immediate-forfeit-v1'
const names = ['p_operation_digest', 'p_receipt_digest', 'p_user_id', 'p_session_id', 'p_email_digest', 'p_consent_version', 'p_generation', 'p_confirmation_id', 'p_lease_token', 'p_error_code', 'p_device_id', 'p_native_generation', 'p_server_generation']
async function flowOn(client: pg.Client, action: string, args: Args) {
  return (await client.query(`SELECT public.account_deletion_operation_flow(p_action:=$1,${names.map((n, i) => `${n}:=$${i + 2}`).join(',')}) r`, [action, ...names.map(n => args[n] ?? null)])).rows[0].r
}
const flow = (action: string, args: Args) => flowOn(db, action, args)
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  database = url.href
  db = new pg.Client({ connectionString: database }); await db.connect()
})

type Committed = Awaited<ReturnType<typeof committedOperation>>
async function committedOperation(a: pg.Client, prepare = true) {
  await a.query('BEGIN')
  const previous = (await a.query(`SELECT o.enabled operation_enabled,d.enabled preparation_enabled,v.test_only,v.test_user_id
    FROM account_deletion_private.operation_access o CROSS JOIN account_deletion_private.device_preparation_access d
    CROSS JOIN account_deletion_private.access v`)).rows[0]
  const f = await fixture(a), machine = randomUUID(), device = `phone-${machine}-${f.p_user_id}`
  await a.query('UPDATE account_deletion_private.device_preparation_access SET enabled=true')
  await a.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.p_user_id, session_id: f.p_session_id, role: 'authenticated' })])
  await a.query(`INSERT INTO identity.gugu_devices(device_id,user_id,machine_id,tier,label,hostname,platform,auth_session_id,capabilities)
    VALUES($1,$2,$3,'fixture','phone','phone','android',$4,'{"host_kind":"phone","runtimes":["pi"],"actions":{"actions":[]}}')`, [device, f.p_user_id, machine, f.p_session_id])
  const registered = await flowOn(a, 'register', f); expect(registered.ok).toBe(true)
  let serverGeneration: string | null = null
  if (prepare) {
    const prepared = await flowOn(a, 'prepare_device', { ...f, p_device_id: device })
    expect(prepared.preparation.prepared).toBe(true)
    serverGeneration = prepared.preparation.server_generation
  }
  const args = { ...f, p_server_generation: serverGeneration }
  const begun = await flowOn(a, 'begin', args); expect(begun.dispatch_required).toBe(true)
  expect((await flowOn(a, 'sent', { ...args, p_lease_token: begun.lease_token })).ok).toBe(true)
  const result = { args, previous, device, operation: registered.operation.operation_id as string, request: begun.operation.request_id as string }
  await a.query('COMMIT')
  return result
}
async function disposeCommitted(a: pg.Client, f: Committed) {
  await a.query('BEGIN')
  await a.query('DELETE FROM auth.users WHERE id=$1', [f.args.p_user_id])
  await a.query('DELETE FROM account_deletion_private.confirmation_intents WHERE operation_id=$1', [f.operation])
  await a.query('UPDATE account_deletion_private.operations SET request_id=NULL WHERE id=$1', [f.operation])
  await a.query('DELETE FROM account_deletion_private.requests WHERE operation_id=$1', [f.operation])
  await a.query('DELETE FROM account_deletion_private.operations WHERE id=$1', [f.operation])
  await a.query('UPDATE account_deletion_private.operation_access SET enabled=$1', [f.previous.operation_enabled])
  await a.query('UPDATE account_deletion_private.device_preparation_access SET enabled=$1', [f.previous.preparation_enabled])
  await a.query('UPDATE account_deletion_private.access SET test_only=$1,test_user_id=$2', [f.previous.test_only, f.previous.test_user_id])
  await a.query('COMMIT')
}
async function waitForBlock(holder: pg.Client, waiter: pg.Client) {
  const holderPid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid
  // pg.Client queues queries, so get the waiter's PID before starting its RPC.
  const waiterPid = (await waiter.query('SELECT pg_backend_pid() pid')).rows[0].pid
  return async () => {
    for (let n = 0; n < 200; n++) {
      if ((await db.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) blocked', [holderPid, waiterPid])).rows[0].blocked) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Expected account-admission wait was not observed')
  }
}
async function withContenders(run: (a: pg.Client, b: pg.Client, f: Committed) => Promise<void>, prepare = true) {
  const a = new pg.Client({ connectionString: database }), b = new pg.Client({ connectionString: database })
  let f: Committed | undefined
  try {
    await a.connect(); await b.connect()
    f = await committedOperation(a, prepare)
    await run(a, b, f)
  } finally {
    await Promise.allSettled([a.query('ROLLBACK'), b.query('ROLLBACK')])
    try { if (f) await disposeCommitted(a, f) }
    finally { await Promise.allSettled([a.end(), b.end()]) }
  }
}
describe('operation admission independent-connection fences', () => {
  it.each(['cancel_operation', 'prepare_device'])('serializes unprepared %s against the competing prepare/cancel', async first => {
    await withContenders(async (a, b, f) => {
      await a.query('BEGIN'); await b.query('BEGIN'); await b.query("SET LOCAL statement_timeout='5s'")
      const blocked = await waitForBlock(a, b)
      const args = { ...f.args, p_device_id: f.device }
      expect((await flowOn(a, first, args)).ok).toBe(true)
      const second = first === 'cancel_operation' ? 'prepare_device' : 'cancel_operation'
      const pending = flowOn(b, second, args).then(value => ({ value }), error => ({ error }))
      await blocked(); await a.query('COMMIT')
      const completed = await pending
      if ('error' in completed) throw completed.error
      expect(completed.value).toMatchObject({ ok: false, error: first === 'cancel_operation' ? 'request_active' : 'scope_conflict', status: 409 })
      await b.query('COMMIT')
      expect((await flowOn(a, 'result', f.args)).operation.state).toBe(first === 'cancel_operation' ? 'closed_before_confirm' : 'open')
      expect((await db.query('SELECT count(*)::int n FROM auth.users WHERE id=$1', [f.args.p_user_id])).rows[0].n).toBe(1)
    }, false)
  })
  it('requires the real prepared generations instead of cancelling an existing seal as unprepared', async () => {
    await withContenders(async (a, _b, f) => {
      expect((await flowOn(a, 'cancel_operation', { ...f.args, p_server_generation: null })).error).toBe('scope_conflict')
      expect((await db.query('SELECT state FROM account_deletion_private.device_preparations WHERE operation_id=$1', [f.operation])).rows[0].state).toBe('prepared')
      expect((await flowOn(a, 'cancel_operation', f.args)).operation).toMatchObject({ state: 'closed_before_confirm', can_release_preparation: true })
      expect((await db.query('SELECT state FROM account_deletion_private.device_preparations WHERE operation_id=$1', [f.operation])).rows[0].state).toBe('released')
    })
  })
  it.each(['cancel_preparation', 'claim_confirmation'])('serializes %s winning before the competing confirmation/cancel', async first => {
    await withContenders(async (a, b, f) => {
      await a.query('BEGIN'); await b.query('BEGIN'); await b.query("SET LOCAL statement_timeout='5s'")
      const blocked = await waitForBlock(a, b)
      const winner = await flowOn(a, first, f.args)
      expect(winner.ok).toBe(true)
      const second = first === 'cancel_preparation' ? 'claim_confirmation' : 'cancel_preparation'
      const pending = flowOn(b, second, f.args).then(value => ({ value }), error => ({ error }))
      await blocked()
      await a.query('COMMIT')
      const completed = await pending
      if ('error' in completed) throw completed.error
      expect(completed.value).toMatchObject({ ok: false, error: 'request_active', status: 409 })
      await b.query('COMMIT')
      // Autocommit on a contender: the observer's outer transaction must not
      // retain result-RPC Auth/parent locks while finally erases the fixture.
      const parent = (await flowOn(a, 'result', f.args)).operation
      expect(parent).toMatchObject(first === 'cancel_preparation'
        ? { state: 'closed_before_confirm', can_release_preparation: true }
        : { state: 'confirming', can_release_preparation: false })
      expect((await db.query('SELECT count(*)::int n FROM account_deletion_private.confirmation_intents WHERE operation_id=$1', [f.operation])).rows[0].n).toBe(first === 'cancel_preparation' ? 0 : 1)
      expect((await db.query('SELECT verification_attempts FROM account_deletion_private.requests WHERE id=$1', [f.request])).rows[0].verification_attempts).toBe(first === 'cancel_preparation' ? 0 : 1)
    })
  })
  it('refuses cancellation when the original SID expires after initial admission while waiting for the account lock', async () => {
    await withContenders(async (a, b, f) => {
      await a.query('BEGIN'); await b.query('BEGIN'); await b.query("SET LOCAL statement_timeout='5s'")
      await a.query("SELECT pg_advisory_xact_lock(hashtextextended('account-deletion:'||$1::text,0))", [f.args.p_user_id])
      const blocked = await waitForBlock(a, b)
      const pending = flowOn(b, 'cancel_preparation', f.args).then(value => ({ value }), error => ({ error }))
      await blocked()
      // The waiter has passed initial Auth admission but cannot yet lock Auth.
      await a.query("UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id=$1", [f.args.p_session_id])
      await a.query('COMMIT')
      const completed = await pending
      if ('error' in completed) throw completed.error
      expect(completed.value).toMatchObject({ ok: false, error: 'unauthorized', status: 401 })
      await b.query('COMMIT')
      expect((await flowOn(a, 'result', f.args)).operation).toMatchObject({ state: 'open', can_release_preparation: false })
      expect((await db.query('SELECT state FROM account_deletion_private.device_preparations WHERE operation_id=$1', [f.operation])).rows[0].state).toBe('prepared')
      expect((await db.query('SELECT state FROM account_deletion_private.requests WHERE id=$1', [f.request])).rows[0].state).toBe('challenge')
    })
  })
})
beforeEach(async () => { await beginDeletionFixture(db) }, 25_000)
afterEach(async () => { await endDeletionFixture(db) })
afterAll(async () => { await db?.end() })
async function fixture(client = db) {
  const user = randomUUID(), session = randomUUID(), email = `${user}@operation.invalid`
  await client.query("INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at) VALUES($1,'authenticated','authenticated',$2,now(),now())", [user, email])
  await client.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [session, user])
  await client.query('UPDATE account_deletion_private.access SET test_only=true,test_user_id=$1', [user])
  await client.query('UPDATE account_deletion_private.operation_access SET enabled=true')
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
  it('closes a registered operation with no device preparation, including while admission is disabled', async () => {
    const f = { ...await fixture(), p_server_generation: null }
    await flow('register', f)
    await db.query('UPDATE account_deletion_private.operation_access SET enabled=false')
    const closed = await flow('cancel_operation', f)
    expect(closed.operation).toMatchObject({ state: 'closed_before_confirm', can_release_preparation: true })
    expect(closed.preparation).toMatchObject({ cancelled: true, native_generation: f.p_native_generation, server_generation: null })
    expect((await flow('cancel_operation', f)).operation.revision).toBe(closed.operation.revision)
    expect((await db.query('SELECT count(*)::int n FROM account_deletion_private.device_preparations')).rows[0].n).toBe(0)
    expect((await db.query('SELECT count(*)::int n FROM auth.users WHERE id=$1', [f.p_user_id])).rows[0].n).toBe(1)
  })
  it.each(['sending', 'challenge'])('cancels an unprepared %s without reviving its late callback or resetting send limits', async state => {
    const f = { ...await fixture(), p_server_generation: null }, begun = await flow('begin', f)
    if (state === 'challenge') await flow('sent', { ...f, p_lease_token: begun.lease_token })
    expect((await flow('cancel_operation', f)).operation.state).toBe('closed_before_confirm')
    expect((await db.query('SELECT state FROM account_deletion_private.requests WHERE id=$1', [begun.operation.request_id])).rows[0].state).toBe('expired')
    expect((await flow('sent', { ...f, p_lease_token: begun.lease_token })).error).toBe('state_conflict')
    const next = { ...f, p_operation_digest: hash(randomUUID()), p_receipt_digest: hash(randomUUID()) }
    expect((await flow('register', next)).ok).toBe(true)
    expect((await flow('begin', next)).error).toBe('rate_limited')
  })
  it('refuses unprepared cancellation with a different capability, SID or a started confirmation', async () => {
    const f = { ...await fixture(), p_server_generation: null }
    await flow('register', f)
    expect((await flow('cancel_operation', { ...f, p_receipt_digest: hash('wrong') })).error).toBe('not_found')
    const sid = randomUUID()
    await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [sid, f.p_user_id])
    expect((await flow('cancel_operation', { ...f, p_session_id: sid })).error).toBe('scope_conflict')
    await db.query("UPDATE account_deletion_private.operations SET confirm_started_at=clock_timestamp() WHERE operation_digest=$1", [f.p_operation_digest])
    expect((await flow('cancel_operation', f)).error).toBe('request_active')
    expect((await db.query('SELECT state,preparation_cancelled FROM account_deletion_private.operations')).rows[0]).toEqual({ state: 'open', preparation_cancelled: false })
  })
  it('installs disabled and grants only the service entry, never private tables', async () => {
    expect((await db.query('SELECT enabled FROM account_deletion_private.operation_access')).rows[0].enabled).toBe(false)
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await db.query("SELECT has_table_privilege($1,'account_deletion_private.operations','UPDATE') allowed", [role])).rows[0].allowed).toBe(false)
      expect((await db.query("SELECT has_function_privilege($1,'account_deletion_private.operation_caller_is_current(uuid,uuid,text)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false)
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
  it('rolls back whole-operation closure when the real helper contract refuses with 42501', async () => {
    const f = await fixture(); await challenge(f)
    await db.query(`CREATE OR REPLACE FUNCTION account_deletion_private.device_preparation_cancel(p_operation_id uuid,p_native_generation uuid,p_server_generation uuid)
      RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CLOSURE_PREPARATION_CANNOT_CANCEL' USING ERRCODE='42501'; END $$`)
    expect((await flow('cancel_preparation', f))).toMatchObject({ ok: false, error: 'preparation_unavailable', status: 503 })
    expect((await db.query('SELECT state,confirm_started_at,preparation_cancelled FROM account_deletion_private.operations')).rows[0]).toEqual({ state: 'open', confirm_started_at: null, preparation_cancelled: false })
  })
  it.each(['sending', 'challenge'])('retires only a cancelled pre-confirmation %s and allows a new operation after the existing cooldown', async state => {
    const f = await fixture(), begun = await flow('begin', f)
    if (state === 'challenge') await flow('sent', { ...f, p_lease_token: begun.lease_token })
    await preparationContractFixture()
    const closed = await flow('cancel_preparation', f)
    expect(closed.operation).toMatchObject({ state: 'closed_before_confirm', can_release_preparation: true })
    expect((await db.query('SELECT state,lease_token,lease_until FROM account_deletion_private.requests WHERE id=$1', [begun.operation.request_id])).rows[0]).toEqual({ state: 'expired', lease_token: null, lease_until: null })
    expect((await flow('sent', { ...f, p_lease_token: begun.lease_token })).error).toBe('state_conflict')
    expect((await flow('claim_confirmation', f)).error).toBe('request_active')
    const next = { ...f, p_operation_digest: hash(randomUUID()), p_receipt_digest: hash(randomUUID()) }
    expect((await flow('register', next)).ok).toBe(true)
    expect((await flow('begin', next)).error).toBe('rate_limited')
    await db.query("UPDATE account_deletion_private.requests SET created_at=clock_timestamp()-interval '6 minutes' WHERE id=$1", [begun.operation.request_id])
    expect((await flow('begin', next))).toMatchObject({ ok: true, dispatch_required: true })
    expect((await db.query('SELECT count(*)::int n FROM account_deletion_private.requests WHERE user_id=$1', [f.p_user_id])).rows[0].n).toBe(2)
    expect((await flow('result', f)).operation.state).toBe('closed_before_confirm')
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
