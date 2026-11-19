import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { accountDeletionDependencies } from '../../../supabase/functions/_shared/account-deletion-auth'
import { createAccountDeletionHandler } from '../../../supabase/functions/_shared/account-deletion-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { beginDeletionFixture, endDeletionFixture } from './accountDeletionFixtureLock'

let db: pg.Client
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
beforeEach(async () => { await beginDeletionFixture(db) }, 25_000)
afterEach(async () => { await endDeletionFixture(db) })
afterAll(async () => { await db?.end() })
type Args = Record<string, string | null>
async function flow(action: string, args: Args = {}) {
  const names = ['p_user_id', 'p_session_id', 'p_request_id', 'p_receipt_digest', 'p_email_digest', 'p_consent_version', 'p_lease_token', 'p_error_code']
  return (await db.query(`SELECT public.account_deletion_flow(p_action:=$1,${names.map((n, i) => `${n}:=$${i + 2}`).join(',')}) r`, [action, ...names.map(n => args[n] ?? null)])).rows[0].r
}
async function fixture() {
  const user = randomUUID(), session = randomUUID(), consent = 'immediate-forfeit-v1', receipt = hash(randomUUID()), email = `${user}@deletion.invalid`
  await db.query(`INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at) VALUES($1,'authenticated','authenticated',$2,now(),now())`, [user, email])
  await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [session, user])
  await db.query('UPDATE account_deletion_private.access SET test_only=true,test_user_id=$1 WHERE singleton', [user])
  const args = { p_user_id: user, p_session_id: session, p_email_digest: hash(email), p_receipt_digest: receipt, p_consent_version: consent }
  return { user, session, consent, receipt, email, args }
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
async function gateScript(name: 'open' | 'close') {
  const body = readFileSync(`ops/${name}-account-deletion-test-gate.sql`, 'utf8')
    .replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, '')
  await db.query('SAVEPOINT gate_script')
  try { return await db.query(body) }
  catch (error) { await db.query('ROLLBACK TO SAVEPOINT gate_script'); throw error }
}

describe('self deletion workflow on the installed schema', () => {
  it('is closed to end users and has no direct private-table grants', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query(`SELECT has_function_privilege($1,'public.account_deletion_flow(text,uuid,uuid,uuid,text,text,text,uuid,text)','EXECUTE') allowed`, [role])).rows[0].allowed).toBe(false)
      expect((await db.query(`SELECT has_table_privilege($1,'account_deletion_private.requests','SELECT') allowed`, [role])).rows[0].allowed).toBe(false)
    }
    expect((await db.query(`SELECT has_function_privilege('service_role','public.account_deletion_flow(text,uuid,uuid,uuid,text,text,text,uuid,text)','EXECUTE') allowed`)).rows[0].allowed).toBe(true)
    expect((await db.query(`SELECT has_table_privilege('service_role','account_deletion_private.requests','UPDATE') allowed`)).rows[0].allowed).toBe(false)
    for (const signature of ['chat.message_history_as(text,text,text,bigint,integer)', 'chat.message_search_as(text,text,text,bigint,integer)', 'identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint)']) {
      expect((await db.query(`SELECT has_function_privilege('authenticated',$1,'EXECUTE') allowed`, [signature])).rows[0].allowed).toBe(true)
      expect((await db.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') allowed`, [signature])).rows[0].allowed).toBe(false)
    }
  })
  it('rejects an unavailable rollout, stale consent and the wrong live session', async () => {
    const f = await fixture()
    await db.query('UPDATE account_deletion_private.access SET test_user_id=NULL')
    expect((await flow('begin', f.args)).error).toBe('rollout_unavailable')
    await db.query('UPDATE account_deletion_private.access SET test_user_id=$1', [f.user])
    expect((await flow('begin', { ...f.args, p_consent_version: 'old' })).error).toBe('consent_changed')
    expect((await flow('begin', { ...f.args, p_session_id: randomUUID() })).error).toBe('unauthorized')
  })
  it('keeps a test-only policy closed to everyone else, including after the test identity is erased', async () => {
    const f = await fixture(), other = randomUUID(), session = randomUUID()
    await db.query(`INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at) VALUES($1,'authenticated','authenticated',$2,now(),now())`, [other, `${other}@deletion.invalid`])
    await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [session, other])
    const args = { ...f.args, p_user_id: other, p_session_id: session, p_email_digest: hash(`${other}@deletion.invalid`) }
    expect((await flow('begin', args)).error).toBe('rollout_unavailable')
    await db.query('DELETE FROM auth.users WHERE id=$1', [f.user])
    expect((await flow('begin', args)).error).toBe('rollout_unavailable')
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
  it('rejects an email change after a successful external proof', async () => {
    const f = await fixture(), args = await challenge(f), attempt = await flow('attempt', args)
    await db.query('UPDATE auth.users SET email=$2 WHERE id=$1', [f.user, 'changed@deletion.invalid'])
    expect((await flow('verified', { p_request_id: args.p_request_id, p_lease_token: attempt.lease_token })).error).toBe('authorization_expired')
  })
  it('keeps a present account unresolved even when a legacy caller labels the DELETE failed', async () => {
    const f = await fixture(), args = await challenge(f), ready = await verify(args)
    expect(ready.request.state).toBe('processing')
    expect((await flow('finish', { p_request_id: args.p_request_id, p_lease_token: ready.lease_token })).error).toBe('auth_user_still_exists')
    const failed = await flow('finish', { p_request_id: args.p_request_id, p_lease_token: ready.lease_token, p_error_code: 'auth_delete_failed' })
    expect(failed.request.state).toBe('processing')
    expect(failed.request.can_retry).toBe(false)
    expect((await flow('retry', args)).error).toBe('request_active')
    expect((await db.query('SELECT deletion_attempts FROM account_deletion_private.requests WHERE id=$1', [args.p_request_id])).rows[0].deletion_attempts).toBe(1)
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
    expect((await db.query('SELECT test_user_id FROM account_deletion_private.access')).rows[0].test_user_id).toBeNull()
  })
  it('does not allow another overlapping or expired authorized retry', async () => {
    const f = await fixture(), args = await challenge(f), ready = await verify(args)
    expect((await flow('retry', args)).error).toBe('request_active')
    await db.query("UPDATE account_deletion_private.requests SET lease_until=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [args.p_request_id])
    expect((await flow('retry', args)).error).toBe('request_active')
    expect(ready.request.state).toBe('processing')
  })
  it('never replaces an unknown processing request when its lease and verification window expire', async () => {
    const f = await fixture(), args = await challenge(f), ready = await verify(args)
    await db.query("UPDATE account_deletion_private.requests SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '5 minutes',lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1", [args.p_request_id])
    const begin = await flow('begin', { ...f.args, p_receipt_digest: hash('another-operation') })
    expect(begin.error).toBe('request_active')
    const pending = await flow('result', { p_request_id: args.p_request_id, p_receipt_digest: f.receipt })
    expect(pending.request.state).toBe('processing')
    expect(pending.request.can_retry).toBe(false)
    expect((await flow('retry', args)).error).toBe('request_active')
    expect((await flow('execute', { p_request_id: args.p_request_id, p_lease_token: ready.lease_token })).error).toBe('state_conflict')
    // Deterministic late commit, without timers or an overlapping real request.
    await db.query('DELETE FROM auth.users WHERE id=$1', [f.user])
    expect((await flow('result', { p_request_id: args.p_request_id, p_receipt_digest: f.receipt })).request.state).toBe('deleted')
  })
  it.each([['expired', 'result'], ['expired', 'finish'], ['failed', 'result'], ['failed', 'finish']])('reconciles a late Auth commit over legacy %s through %s', async (state, action) => {
    const f = await fixture(), args = await challenge(f), ready = await verify(args)
    await db.query('UPDATE account_deletion_private.requests SET state=$2,lease_token=NULL,lease_until=NULL WHERE id=$1', [args.p_request_id, state])
    await db.query('DELETE FROM auth.users WHERE id=$1', [f.user])
    const done = await flow(action, { p_request_id: args.p_request_id, p_lease_token: ready.lease_token, p_receipt_digest: f.receipt })
    expect(done.request.state).toBe('deleted')
    expect((await flow('finish', { p_request_id: args.p_request_id, p_lease_token: ready.lease_token })).request.state).toBe('deleted')
    expect((await flow('result', { p_request_id: args.p_request_id, p_receipt_digest: f.receipt })).request.state).toBe('deleted')
    expect((await flow('result', { p_request_id: args.p_request_id, p_receipt_digest: hash('wrong') })).error).toBe('not_found')
    expect((await db.query("SELECT count(*)::int n FROM account_deletion_private.events WHERE request_id=$1 AND event='deleted'", [args.p_request_id])).rows[0].n).toBe(1)
  })
  it('keeps an expired request expired while its account still exists', async () => {
    const f = await fixture(), args = await challenge(f)
    await db.query("UPDATE account_deletion_private.requests SET state='expired' WHERE id=$1", [args.p_request_id])
    expect((await flow('result', { p_request_id: args.p_request_id, p_receipt_digest: f.receipt })).request.state).toBe('expired')
    expect((await db.query('SELECT count(*)::int n FROM auth.users WHERE id=$1', [f.user])).rows[0].n).toBe(1)
  })
  it('rechecks the execution lease, unchanged identity and original session before dispatch', async () => {
    const f = await fixture(), args = await challenge(f), ready = await verify(args)
    expect((await flow('execute', { p_request_id: args.p_request_id, p_lease_token: randomUUID() })).error).toBe('state_conflict')
    expect((await flow('execute', { p_request_id: args.p_request_id, p_lease_token: ready.lease_token })).user_id).toBe(f.user)
    await db.query('DELETE FROM auth.sessions WHERE id=$1', [f.session])
    expect((await flow('execute', { p_request_id: args.p_request_id, p_lease_token: ready.lease_token })).error).toBe('authorization_expired')
    expect((await flow('result', { p_request_id: args.p_request_id, p_receipt_digest: f.receipt })).request.state).toBe('processing')
  })
  it('blocks execution of an unresolved attempt when the dedicated-account gate is closed', async () => {
    const f = await fixture(), args = await challenge(f), ready = await verify(args)
    await flow('finish', { p_request_id: args.p_request_id, p_lease_token: ready.lease_token!, p_error_code: 'auth_delete_failed' })
    await db.query('UPDATE account_deletion_private.access SET test_user_id=NULL')
    expect((await flow('execute', { p_request_id: args.p_request_id, p_lease_token: ready.lease_token })).error).toBe('authorization_expired')
    expect((await db.query('SELECT count(*)::int n FROM auth.users WHERE id=$1', [f.user])).rows[0].n).toBe(1)
  })
  it.each([null, 'future', 'boundary', 'past'])('checks session not_after at execution (%s)', async expiry => {
    const f = await fixture(), args = await challenge(f), ready = await verify(args)
    const sql = expiry === null ? 'NULL' : expiry === 'future' ? "clock_timestamp()+interval '1 hour'" : expiry === 'boundary' ? 'clock_timestamp()' : "clock_timestamp()-interval '1 hour'"
    await db.query(`UPDATE auth.sessions SET not_after=${sql} WHERE id=$1`, [f.session])
    const execution = await flow('execute', { p_request_id: args.p_request_id, p_lease_token: ready.lease_token })
    if (expiry === null || expiry === 'future') expect(execution.user_id).toBe(f.user)
    else expect(execution).toMatchObject({ ok: false, error: 'authorization_expired', status: 410 })
    expect((await db.query('SELECT state,deletion_attempts FROM account_deletion_private.requests WHERE id=$1', [args.p_request_id])).rows[0]).toEqual({ state: 'processing', deletion_attempts: 1 })
  })
  it('does not dispatch or expire a legacy retry_wait request without authoritative recovery', async () => {
    const f = await fixture(), args = await challenge(f)
    await db.query("UPDATE account_deletion_private.requests SET state='retry_wait',created_at=clock_timestamp()-interval '2 minutes',lease_token=NULL,lease_until=NULL WHERE id=$1", [args.p_request_id])
    expect((await flow('status', f.args)).request).toMatchObject({ state: 'processing', can_retry: false })
    expect((await flow('begin', { ...f.args, p_receipt_digest: hash('new') })).error).toBe('request_active')
    await expect(gateScript('close')).rejects.toThrow('Deletion outcome must be reconciled')
    expect((await flow('result', { p_request_id: args.p_request_id, p_receipt_digest: hash('wrong') })).error).toBe('not_found')
    expect((await db.query('SELECT state FROM account_deletion_private.requests WHERE id=$1', [args.p_request_id])).rows[0].state).toBe('retry_wait')
    expect((await flow('retry', args)).error).toBe('request_active')
    expect((await flow('result', { p_request_id: args.p_request_id, p_receipt_digest: f.receipt })).request).toMatchObject({ state: 'processing', can_retry: false })
  })
  it.each([502, 503, 504])('coordinates actual adapter HTTP %s, present readback, blocked retries and a late commit', async status => {
    const f = await fixture(), rawReceipt = 'a'.repeat(64)
    f.receipt = hash(rawReceipt); f.args.p_receipt_digest = f.receipt
    const args = await challenge(f)
    let deletes = 0, committed = false
    const token = 'synthetic.' + Buffer.from(JSON.stringify({ session_id: f.session })).toString('base64url') + '.fixture'
    const transport = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      const reply = (body: unknown, code = 200) => new Response(body === null ? null : JSON.stringify(body), { status: code })
      if (path === '/rest/v1/rpc/account_deletion_flow') {
        const rpc = JSON.parse(String(init?.body)); return reply(await flow(rpc.p_action, rpc))
      }
      const user = { id: f.user, email: f.email, email_confirmed_at: '2026-01-01T00:00:00Z' }
      if (path === '/auth/v1/user') return reply(user)
      if (path === '/auth/v1/verify') return reply({ access_token: 'temporary', user })
      if (path === '/auth/v1/logout') return reply(null, 204)
      if (path === '/auth/v1/admin/users/' + f.user) {
        if (init?.method === 'DELETE') { deletes++; return reply({ error: 'upstream_unavailable' }, status) }
        return committed ? reply(null, 404) : reply(user)
      }
      throw new Error('Unexpected synthetic transport path')
    }) as typeof fetch
    const handler = createAccountDeletionHandler(accountDeletionDependencies({ url: 'http://fixture.invalid', anonKey: 'synthetic', serviceKey: 'synthetic', fetch: transport }))
    const call = (route: string, body: unknown) => handler(new Request('http://fixture.invalid/account-deletion/' + route, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const proof = { request_id: args.p_request_id, receipt_token: rawReceipt }
    const response = await call('confirm', { ...proof, code: '123456', consent_version: f.consent, acknowledge_forfeit: true })
    expect(response.status).toBe(202)
    expect((await response.json()).request).toMatchObject({ state: 'processing', can_retry: false })
    expect((await call('retry', proof)).status).toBe(409)
    await db.query("UPDATE account_deletion_private.requests SET created_at=clock_timestamp()-interval '2 minutes' WHERE id=$1", [args.p_request_id])
    expect((await call('challenge', { consent_version: f.consent })).status).toBe(409)
    expect(deletes).toBe(1)
    // The fixture commits the original operation after its HTTP outcome was lost.
    await db.query('DELETE FROM auth.users WHERE id=$1', [f.user]); committed = true
    expect((await (await call('result', proof)).json()).request.state).toBe('deleted')
    expect((await (await call('result', proof)).json()).request.state).toBe('deleted')
    expect(deletes).toBe(1)
  })
  it('opens only one new server-marked verified fixture and never lifts the restriction', async () => {
    const f = await fixture()
    await db.query('UPDATE account_deletion_private.access SET test_user_id=NULL')
    await db.query("UPDATE auth.users SET raw_user_meta_data=jsonb_build_object('gugu_self_deletion_fixture','v1') WHERE id=$1", [f.user])
    await expect(gateScript('open')).rejects.toThrow('Exactly one new verified fixture')
    await db.query("UPDATE auth.users SET raw_app_meta_data=jsonb_build_object('gugu_self_deletion_fixture','v1') WHERE id=$1", [f.user])
    await gateScript('open')
    expect((await db.query('SELECT test_only,test_user_id FROM account_deletion_private.access')).rows[0]).toEqual({ test_only: true, test_user_id: f.user })
    const second = randomUUID()
    await db.query("INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,raw_app_meta_data) VALUES($1,'authenticated','authenticated',$2,now(),now(),'{\"gugu_self_deletion_fixture\":\"v1\"}')", [second, `${second}@deletion.invalid`])
    await expect(gateScript('open')).rejects.toThrow('Exactly one new verified fixture')
  })
  it('refuses closure with an unreconciled deletion and expires other capabilities on closure', async () => {
    const f = await fixture(), args = await challenge(f), ready = await verify(args)
    await expect(gateScript('close')).rejects.toThrow('Deletion outcome must be reconciled')
    await flow('finish', { p_request_id: args.p_request_id, p_lease_token: ready.lease_token!, p_error_code: 'auth_delete_failed' })
    await expect(gateScript('close')).rejects.toThrow('Deletion outcome must be reconciled')
    await db.query('DELETE FROM auth.users WHERE id=$1', [f.user])
    expect((await flow('result', { p_request_id: args.p_request_id, p_receipt_digest: f.receipt })).request.state).toBe('deleted')
    await gateScript('close')
    expect((await db.query('SELECT test_only,test_user_id FROM account_deletion_private.access')).rows[0]).toEqual({ test_only: true, test_user_id: null })
    expect((await db.query('SELECT state FROM account_deletion_private.requests WHERE id=$1', [args.p_request_id])).rows[0].state).toBe('deleted')
  })
  it('keeps group message bodies and replies while anonymizing the deleted author in view/history/search', async () => {
    const f = await fixture(), peer = randomUUID(), room = randomUUID(), message = randomUUID(), reply = randomUUID()
    await db.query("INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at) VALUES($1,'authenticated','authenticated',$2,now(),now())", [peer, `${peer}@deletion.invalid`])
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Retained group',$2)", [room, f.user])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin')", [room, f.user, peer])
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Retained authored body')", [message, room, f.user])
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,reply_to_message_id) VALUES($1,$2,$3,'Retained reply',$4)", [reply, room, peer, message])
    await db.query("INSERT INTO chat.message_reactions(message_id,user_id,emoji) VALUES($1,$2,'reaction')", [message, f.user])
    await db.query('DELETE FROM auth.users WHERE id=$1', [f.user])
    expect((await db.query('SELECT sender_user_id,content FROM chat.messages WHERE id=$1', [message])).rows[0]).toEqual({ sender_user_id: null, content: 'Retained authored body' })
    expect((await db.query('SELECT role FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [room, peer])).rows[0].role).toBe('owner')
    expect((await db.query('SELECT count(*)::int n FROM chat.message_reactions WHERE message_id=$1', [message])).rows[0].n).toBe(0)
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: peer, role: 'authenticated' })])
    await db.query('SET LOCAL ROLE authenticated')
    expect((await db.query('SELECT sender_name FROM chat.messages_view WHERE id=$1', [message])).rows[0].sender_name).toBe('已注销用户')
    expect((await db.query('SELECT sender_name FROM chat.message_history_as($1,$2) WHERE id=$3', [room, peer, message])).rows[0].sender_name).toBe('已注销用户')
    expect((await db.query("SELECT sender_name FROM chat.message_search_as($1,'Retained',$2) WHERE id=$3", [room, peer, message])).rows[0].sender_name).toBe('已注销用户')
    expect((await db.query('SELECT reply_to_sender_name FROM chat.message_reply_preview_for($1,$2)', [message, peer])).rows[0].reply_to_sender_name).toBe('已注销用户')
  })

})
