// Manual, disposable-loopback-only contract test. Real GoTrue + mail catcher,
// the exact Edge handler served over loopback HTTP, and installed DB triggers.
// This does not substitute for a deployed Edge smoke test.
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { randomUUID, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import pg from 'pg'
import { createAccountDeletionHandler } from '../supabase/functions/_shared/account-deletion-core.ts'
import { accountDeletionDependencies } from '../supabase/functions/_shared/account-deletion-auth.ts'

async function main() {
const owner = JSON.parse(readFileSync(new URL('../.local/test-db/owner.json', import.meta.url)))
const port = owner.port, origin = 'http://127.0.0.1:' + (port - 1), mail = 'http://127.0.0.1:' + (port + 1)
if (!Number.isInteger(port) || owner.root !== new URL('../', import.meta.url).pathname) throw Error('Owned loopback fixture required')
const cli = new URL('../node_modules/.bin/supabase', import.meta.url).pathname
const raw = execFileSync(cli, ['status', '--workdir', new URL('../.local/test-db/', import.meta.url).pathname, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const keys = JSON.parse(raw), service = keys.SERVICE_ROLE_KEY, anon = keys.ANON_KEY
if (typeof service !== 'string' || typeof anon !== 'string') throw Error('Fixture credentials unavailable')
const db = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres' })
const handler = createAccountDeletionHandler(accountDeletionDependencies({ url: origin, anonKey: anon, serviceKey: service }))
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk)
    const response = await handler(new Request('http://127.0.0.1' + incoming.url, {
      method: incoming.method, headers: incoming.headers,
      ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }),
    }))
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch { outgoing.writeHead(503); outgoing.end('{"error":"unavailable"}') }
})
const evidence = { scope: 'owned loopback HTTP handler + real Auth/email/installed triggers; not deployed Edge', cases: [], ok: false }
let api, stage = 'connect'
function assert(condition, label) { if (!condition) { stage = label; throw Error('assertion_failed') } }
async function auth(path, method, key, body) {
  const response = await fetch(origin + '/auth/v1' + path, { method, signal: AbortSignal.timeout(30_000),
    headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json().catch(() => null) }
}
async function call(route, token, body) {
  const response = await fetch(api + '/' + route, { method: route === 'status' ? 'GET' : 'POST', signal: AbortSignal.timeout(120_000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(route === 'status' ? {} : { body: JSON.stringify(body ?? {}) }) })
  return { status: response.status, data: await response.json() }
}
async function newUser() {
  stage = 'create_fixture'
  const email = 'deletion-' + randomUUID() + '@fixture.invalid', password = randomBytes(32).toString('base64url')
  const created = await auth('/admin/users', 'POST', service, { email, password, email_confirm: true })
  assert(created.status === 200 && created.data?.id, 'create_fixture_result')
  const login = await auth('/token?grant_type=password', 'POST', anon, { email, password })
  assert(login.status === 200 && login.data?.access_token, 'login_fixture_result')
  const user = { id: created.data.id, email, token: login.data.access_token, consent: 'immediate-forfeit-v1' }
  await db.query('UPDATE account_deletion_private.access SET test_only=true,test_user_id=$1 WHERE singleton', [user.id])
  return user
}
async function codeFor(email) {
  stage = 'read_local_mail'
  for (let n = 0; n < 30; n++) {
    const response = await fetch(mail + '/api/v1/messages', { signal: AbortSignal.timeout(5000) })
    if (response.ok) {
      const list = await response.json()
      const item = list.messages?.find(m => m.To?.some(to => to.Address === email))
      if (item) {
        const detail = await fetch(mail + '/api/v1/message/' + item.ID).then(r => r.json())
        const match = (detail.Text ?? detail.HTML ?? '').match(/Code:\s*(\d{6,10})/)
        if (match) return match[1]
      }
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw Error('local_mail_unavailable')
}
async function start(user) {
  stage = 'send_challenge'
  const sent = await call('challenge', user.token, { consent_version: user.consent, acknowledge_forfeit: true })
  assert(sent.status === 201 && sent.data.receipt_token, 'send_challenge_result')
  return { request_id: sent.data.request.request_id, receipt_token: sent.data.receipt_token, consent_version: user.consent, acknowledge_forfeit: true, code: await codeFor(user.email) }
}
async function gone(user) { return (await auth('/admin/users/' + user.id, 'GET', service)).status === 404 }
try {
  await db.connect(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); api = 'http://127.0.0.1:' + server.address().port + '/account-deletion'
  const immediate = await newUser(), proof = await start(immediate)
  const wrong = (Number(proof.code[0]) + 1) % 10 + proof.code.slice(1)
  assert((await call('confirm', immediate.token, { ...proof, code: wrong })).status === 422, 'wrong_code_rejected')
  stage = 'immediate_delete'; const began = performance.now(), deleted = await call('confirm', immediate.token, proof)
  assert(deleted.status === 200 && deleted.data.request?.state === 'deleted' && await gone(immediate), 'immediate_readback')
  const elapsed = performance.now() - began
  assert((await call('result', null, proof)).data.request?.state === 'deleted', 'idempotent_receipt')
  assert((await call('confirm', immediate.token, proof)).status === 401, 'deleted_session_rejected')
  const links = await db.query(`SELECT (SELECT count(*) FROM account_deletion_private.requests WHERE user_id=$1 OR session_id IN(SELECT id FROM auth.sessions WHERE user_id=$1))::int
    +(SELECT count(*) FROM account_deletion_private.events WHERE actor_user_id=$1)::int n`, [immediate.id])
  assert(links.rows[0].n === 0, 'original_identity_erased')
  evidence.cases.push({ case: 'immediate', wrong_code_rejected: true, deleted: true, result_idempotent: true, original_links: 0, interface_to_absent_ms: +elapsed.toFixed(3) })

  const failed = await newUser(), fp = await start(failed)
  await db.query(`CREATE TABLE public.deletion_failure_fixture(id uuid PRIMARY KEY);
    CREATE FUNCTION public.deletion_failure_fixture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    BEGIN IF EXISTS(SELECT 1 FROM public.deletion_failure_fixture f WHERE f.id=OLD.id) THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN OLD; END $$;
    CREATE TRIGGER zz_deletion_failure_fixture AFTER DELETE ON auth.users FOR EACH ROW EXECUTE FUNCTION public.deletion_failure_fixture();`)
  await db.query('INSERT INTO public.deletion_failure_fixture VALUES($1)', [failed.id])
  stage = 'failure_rollback'
  const rejection = await call('confirm', failed.token, fp)
  assert(rejection.status === 202 && rejection.data.request?.state === 'processing' && !await gone(failed), 'failure_unresolved_readback')
  const reuse = await auth('/verify', 'POST', anon, { type: 'email', email: failed.email, token: fp.code })
  assert(reuse.status !== 200, 'official_otp_replay_rejected')
  assert((await db.query('SELECT count(*)::int n FROM auth.sessions WHERE user_id=$1', [failed.id])).rows[0].n === 1, 'temporary_verification_session_revoked')
  assert((await db.query('SELECT user_id FROM account_deletion_private.requests WHERE id=$1', [fp.request_id])).rows[0].user_id === failed.id, 'workflow_identity_rollback')
  await db.query('DROP TRIGGER zz_deletion_failure_fixture ON auth.users;DROP FUNCTION public.deletion_failure_fixture();DROP TABLE public.deletion_failure_fixture;')
  const retried = await call('retry', failed.token, fp)
  assert(retried.status === 409 && !await gone(failed), 'uncertain_retry_refused')
  // Fixture cleanup is explicit and separate from the product's retry protocol.
  assert((await auth('/admin/users/' + failed.id, 'DELETE', service, { should_soft_delete: false })).status === 200, 'fixture_cleanup')
  assert((await call('result', null, fp)).data.request?.state === 'deleted', 'late_absence_reconciled')
  evidence.cases.push({ case: 'failure_unresolved', real_auth_failure: true, rollback_preserved_account: true,
    official_otp_replay_rejected: true, temporary_session_revoked: true, uncertain_retry_refused: true,
    separate_fixture_cleanup_reconciled: true })
  evidence.ok = true
} catch {
  evidence.failed_stage = stage; process.exitCode = 1
} finally {
  await db.query('UPDATE account_deletion_private.access SET test_only=true,test_user_id=NULL').catch(() => {})
  await db.end(); await new Promise(resolve => server.close(resolve))
  writeFileSync('account-deletion-http-result.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence))
}

}
main().catch(() => { console.log(JSON.stringify({ ok: false, failed_stage: 'startup_or_cleanup' })); process.exitCode = 1 })
