import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { beginDeletionFixture, endDeletionFixture } from './accountDeletionFixtureLock'

let db: pg.Client, database: string
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
type Args = Record<string, string | number | null>
const fields = ['p_operation_digest', 'p_receipt_digest', 'p_user_id', 'p_session_id', 'p_email_digest', 'p_consent_version',
  'p_generation', 'p_confirmation_id', 'p_lease_token', 'p_error_code', 'p_device_id', 'p_native_generation', 'p_server_generation']
async function flow(action: string, args: Args, client = db) {
  return (await client.query(`SELECT public.account_deletion_operation_flow(p_action:=$1,${fields.map((name, i) => `${name}:=$${i + 2}`).join(',')}) reply`,
    [action, ...fields.map(name => args[name] ?? null)])).rows[0].reply
}
async function fixture(client = db): Promise<Args> {
  const user = randomUUID(), session = randomUUID(), email = user + '@policy.invalid'
  await client.query("INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at) VALUES($1,'authenticated','authenticated',$2,now(),now())", [user, email])
  await client.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [session, user])
  await client.query('UPDATE account_deletion_private.access SET test_only=true,test_user_id=$1', [user])
  await client.query('UPDATE account_deletion_private.operation_access SET enabled=true')
  await client.query('UPDATE account_deletion_private.device_preparation_access SET enabled=true')
  return { p_user_id: user, p_session_id: session, p_email_digest: hash(email), p_operation_digest: hash(randomUUID()), p_receipt_digest: hash(randomUUID()),
    p_consent_version: 'immediate-forfeit-v1', p_generation: 1, p_confirmation_id: randomUUID(), p_native_generation: randomUUID(), p_server_generation: randomUUID() }
}
async function team(args: Args, client = db) {
  await client.query(`UPDATE auth.users SET raw_app_meta_data='{"gugu_account_kind":"team_member"}' WHERE id=$1`, [args.p_user_id])
}
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (url.hostname !== '127.0.0.1') throw Error('Owned disposable loopback database required')
  database = url.href
  db = new pg.Client({ connectionString: database }); await db.connect()
})
beforeEach(() => beginDeletionFixture(db), 25_000)
afterEach(() => endDeletionFixture(db))
afterAll(() => db?.end())

const combinations = Array.from({ length: 16 }, (_, mask) => [!!(mask & 1), !!(mask & 2), !!(mask & 4), !!(mask & 8)] as const)
it.each(combinations)('reads both gates, allowlist and personal identity: operation=%s preparation=%s allowed=%s personal=%s', async (operation, preparation, allowed, personal) => {
  const f = await fixture()
  await db.query('UPDATE account_deletion_private.operation_access SET enabled=$1', [operation])
  await db.query('UPDATE account_deletion_private.device_preparation_access SET enabled=$1', [preparation])
  if (!allowed) await db.query('UPDATE account_deletion_private.access SET test_user_id=NULL')
  if (!personal) await team(f)
  const result = await flow('status', { p_user_id: f.p_user_id, p_session_id: f.p_session_id, p_email_digest: f.p_email_digest })
  expect(result).toEqual({ ok: true, policy: { protocol_version: 2, available: operation && preparation && allowed && personal,
    deletion: 'immediate', credit_treatment: 'forfeit_remaining', consent_version: 'immediate-forfeit-v1', device_preparation_required: true } })
  for (const table of ['operations', 'requests']) expect((await db.query(`SELECT count(*)::int n FROM account_deletion_private.${table} WHERE user_id=$1`, [f.p_user_id])).rows[0].n).toBe(0)
})
it('requires a current original session and email, including expiry and bans', async () => {
  const f = await fixture()
  expect((await flow('status', { ...f, p_session_id: randomUUID() })).error).toBe('unauthorized')
  expect((await flow('status', { ...f, p_email_digest: hash('different') })).error).toBe('unauthorized')
  await db.query("UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id=$1", [f.p_session_id])
  expect((await flow('status', f)).error).toBe('unauthorized')
  await db.query('UPDATE auth.sessions SET not_after=NULL WHERE id=$1', [f.p_session_id])
  await db.query("UPDATE auth.users SET banned_until=clock_timestamp()+interval '1 hour' WHERE id=$1", [f.p_user_id])
  expect((await flow('status', f)).error).toBe('unauthorized')
})
it('keeps missing classification unavailable and private helper privileges closed', async () => {
  const f = await fixture()
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const signature of ['account_deletion_private.operation_policy(uuid,uuid,text)', 'account_deletion_private.operation_personal_is_eligible(uuid)']) {
      expect((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, signature])).rows[0].allowed).toBe(false)
    }
  }
  await db.query('ALTER FUNCTION identity.personal_principal_is_eligible(uuid) RENAME TO policy_fixture_classifier_unavailable')
  expect(await flow('status', f)).toEqual({ ok: false, error: 'unavailable', status: 503 })
  expect(await flow('register', f)).toEqual({ ok: false, error: 'unavailable', status: 503 })
})
it('rechecks changed server markers before email/device admission while preserving safe cancellation', async () => {
  const f = await fixture()
  expect((await flow('register', f)).ok).toBe(true)
  await team(f)
  for (const action of ['begin', 'prepare_device']) expect(await flow(action, f)).toMatchObject({ ok: false, error: 'personal_account_required', status: 403 })
  expect((await flow('cancel_operation', { ...f, p_server_generation: null })).operation).toMatchObject({ state: 'closed_before_confirm', can_release_preparation: true })
  expect((await db.query('SELECT count(*)::int n FROM account_deletion_private.requests WHERE user_id=$1', [f.p_user_id])).rows[0].n).toBe(0)
})
it('checks the stored operation actor again before execution, not a substituted eligible identity', async () => {
  const f = await fixture(), other = await fixture()
  await db.query('UPDATE account_deletion_private.access SET test_user_id=$1', [f.p_user_id])
  await db.query(`CREATE OR REPLACE FUNCTION account_deletion_private.device_preparation_read(p_operation_id uuid,p_native_generation uuid,p_server_generation uuid)
    RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('prepared',true,'native_generation',p_native_generation,'server_generation',p_server_generation) $$`)
  const begun = await flow('begin', f)
  expect((await flow('sent', { ...f, p_lease_token: begun.lease_token })).ok).toBe(true)
  const claimed = await flow('claim_confirmation', f)
  expect(claimed.dispatch_required).toBe(true)
  const ready = await flow('verified', { ...f, p_lease_token: claimed.lease_token })
  expect(ready.ok).toBe(true)
  await team(f)
  expect(await flow('execute', { ...f, p_user_id: other.p_user_id, p_lease_token: ready.lease_token })).toMatchObject({ ok: false, error: 'personal_account_required', status: 403 })
  expect((await db.query('SELECT count(*)::int n FROM auth.users WHERE id=$1', [f.p_user_id])).rows[0].n).toBe(1)
})
it('retains receipt-only recovery after deletion with both gates closed', async () => {
  const f = await fixture()
  expect((await flow('register', f)).ok).toBe(true)
  await db.query('DELETE FROM auth.users WHERE id=$1', [f.p_user_id])
  await db.query('UPDATE account_deletion_private.operation_access SET enabled=false')
  await db.query('UPDATE account_deletion_private.device_preparation_access SET enabled=false')
  const proof = { p_operation_digest: f.p_operation_digest, p_receipt_digest: f.p_receipt_digest }
  expect((await flow('result', proof)).operation.state).toBe('deleted')
  expect((await flow('result', { ...proof, p_receipt_digest: hash('wrong') })).error).toBe('not_found')
})
it('recovers a committed preparation generation with closed gates without replaying prepare', async () => {
  const f = await fixture(), registered = await flow('register', f), device = 'policy-' + randomUUID()
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,auth_session_id,capabilities)
    VALUES($1,$2,'Policy fixture','Policy fixture','android',$3,'{"host_kind":"phone"}')`, [device, f.p_user_id, f.p_session_id])
  const prepared = await flow('prepare_device', { ...f, p_device_id: device })
  expect(prepared.preparation.prepared).toBe(true)
  await db.query('UPDATE account_deletion_private.operation_access SET enabled=false')
  await db.query('UPDATE account_deletion_private.device_preparation_access SET enabled=false')
  const proof = { p_operation_digest: f.p_operation_digest, p_receipt_digest: f.p_receipt_digest }
  const result = await flow('result', proof)
  expect(result.operation.operation_id).toBe(registered.operation.operation_id)
  expect(result.preparation).toEqual({ prepared: true, cancelled: false, native_generation: f.p_native_generation,
    server_generation: prepared.preparation.server_generation })
  expect((await db.query('SELECT count(*)::int n FROM account_deletion_private.device_preparations WHERE operation_id=$1', [registered.operation.operation_id])).rows[0].n).toBe(1)
  const bad = await flow('result', { ...proof, p_receipt_digest: hash('wrong') })
  expect(bad.error).toBe('not_found'); expect(bad).not.toHaveProperty('preparation')
  expect((await flow('cancel_operation', { ...f, p_server_generation: prepared.preparation.server_generation })).operation.can_release_preparation).toBe(true)
  expect((await flow('result', proof)).preparation).toEqual({ prepared: false, cancelled: true,
    native_generation: f.p_native_generation, server_generation: prepared.preparation.server_generation })
})
