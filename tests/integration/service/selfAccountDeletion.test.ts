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

describe('self deletion workflow on the installed schema', () => {
  it('is closed to end users and has no direct private-table grants', async () => {
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query(`SELECT has_function_privilege($1,'public.account_deletion_flow(text,uuid,uuid,uuid,text,text,text,uuid,text)','EXECUTE') allowed`, [role])).rows[0].allowed).toBe(false)
      expect((await db.query(`SELECT has_table_privilege($1,'account_deletion_private.requests','SELECT') allowed`, [role])).rows[0].allowed).toBe(false)
    }
    expect((await db.query(`SELECT has_function_privilege('service_role','public.account_deletion_flow(text,uuid,uuid,uuid,text,text,text,uuid,text)','EXECUTE') allowed`)).rows[0].allowed).toBe(true)
    expect((await db.query(`SELECT has_table_privilege('service_role','account_deletion_private.requests','UPDATE') allowed`)).rows[0].allowed).toBe(false)
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
    expect((await db.query('SELECT test_user_id FROM account_deletion_private.access')).rows[0].test_user_id).toBeNull()
  })
  it('does not allow another overlapping or expired authorized retry', async () => {
    const f = await fixture(), args = await challenge(f), ready = await verify(args)
    expect((await flow('retry', args)).error).toBe('new_verification_required')
    await db.query("UPDATE account_deletion_private.requests SET lease_until=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [args.p_request_id])
    expect((await flow('retry', args)).error).toBe('new_verification_required')
    expect(ready.request.state).toBe('processing')
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
    expect((await db.query('SELECT sender_name FROM chat.messages_view WHERE id=$1', [message])).rows[0].sender_name).toBe('已注销用户')
    expect((await db.query('SELECT sender_name FROM chat.message_history_as($1,$2) WHERE id=$3', [room, peer, message])).rows[0].sender_name).toBe('已注销用户')
    expect((await db.query("SELECT sender_name FROM chat.message_search_as($1,'Retained',$2) WHERE id=$3", [room, peer, message])).rows[0].sender_name).toBe('已注销用户')
    expect((await db.query('SELECT reply_to_sender_name FROM chat.message_reply_preview_row($1,$2)', [message, peer])).rows[0].reply_to_sender_name).toBe('已注销用户')
  })

})
