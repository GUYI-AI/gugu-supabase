import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'

const api = process.env.GUGU_INTEGRATION_SUPABASE_URL ?? ''
const anon = process.env.VITE_SUPABASE_ANON_KEY ?? ''
const service = process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY ?? ''
let db: pg.Client
const users: string[] = [], auditRows: string[] = [], fileRows: string[] = [], rooms: string[] = [], jobs: string[] = []
const scaleInstances: string[] = []
let schedules: { jobname: string; schedule: string; command: string }[] = []
async function auth(path: string, method = 'GET', body?: unknown, token = service) {
  return fetch(api + '/auth/v1/' + path, { method, signal: AbortSignal.timeout(15_000),
    headers: { apikey: token === service ? service : anon, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function create(address = randomUUID() + '@unified-audit.invalid') {
  const password = randomUUID(), response = await auth('admin/users', 'POST', { email: address, password, email_confirm: true })
  expect(response.status).toBe(200)
  const user = await response.json(); users.push(user.id)
  return { id: user.id as string, email: address, password }
}
async function audit(payload: unknown) {
  const id = randomUUID(); auditRows.push(id)
  await db.query('INSERT INTO auth.audit_log_entries(id,payload,created_at) VALUES($1,$2,now())', [id, JSON.stringify(payload)])
  return id
}
async function fileAudit(owner: string, actor = owner) {
  const id = randomUUID(); fileRows.push(id)
  await db.query(`INSERT INTO file_private.storage_action_audit(id,actor_user_id,effective_actor_id,action,
    requested_ref_count,requested_message_ids) VALUES($1,$2,$3,'permanent',1,$4)`, [id, owner, actor, [actor]])
  return id
}
const row = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0]
async function jobFor(subject: string) {
  const job = await row('SELECT * FROM identity.account_audit_redaction_jobs WHERE source_subject_id=$1', [subject])
  expect(job).toBeDefined(); if (!jobs.includes(job.id)) jobs.push(job.id)
  return job
}
async function batch(id: string) {
  return (await row('SELECT identity.process_account_audit_redaction($1,1000) result', [id])).result
}
async function drain(id: string) {
  for (let i = 0; i < 2000; i++) {
    const result = await batch(id)
    if (['waiting_rescan', 'closed', 'manual_review', 'retry_wait'].includes(result.state)) return result
  }
  throw Error('Bounded fixture did not drain')
}
async function daySeven(id: string) {
  // Advance only this retained fixture's clock, rather than wait seven days.
  await db.query(`UPDATE identity.account_audit_redaction_jobs SET deleted_at=deleted_at-interval '8 days',
    target_at=target_at-interval '8 days',hard_due_at=hard_due_at-interval '8 days',
    first_scan_completed_at=first_scan_completed_at-interval '8 days',next_scan_at=next_scan_at-interval '8 days'
    WHERE id=$1`, [id])
}
beforeAll(async () => {
  const target = new URL(api), database = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  const owner = JSON.parse(readFileSync('.local/test-db/owner.json', 'utf8'))
  if (target.hostname !== '127.0.0.1' || database.hostname !== '127.0.0.1'
    || Number(database.port) !== owner.port || Number(target.port) !== owner.port - 1
    || owner.root !== process.cwd() + '/') throw Error('Owned checkout loopback fixture required')
  db = new pg.Client({ connectionString: database.href }); await db.connect()
  const names = ['account-audit-redaction-nightly', 'account-audit-redaction-retry', 'account-audit-redaction-daily', 'account-audit-redaction-daily-guard']
  schedules = (await db.query('SELECT jobname,schedule,command FROM cron.job WHERE jobname=ANY($1::text[])', [names])).rows
  expect(schedules).toHaveLength(4)
  // Pause only this new worker in the owned fixture so it cannot race DDL faults.
  for (const schedule of schedules) await db.query('SELECT cron.unschedule($1)', [schedule.jobname])
})
afterEach(async () => {
  await db.query('ALTER TABLE file_private.storage_action_audit DROP CONSTRAINT IF EXISTS unified_audit_late_failure')
  await db.query('ALTER TABLE identity.account_audit_redaction_jobs DROP CONSTRAINT IF EXISTS unified_audit_enqueue_failure')
  await db.query('ALTER TABLE chat.messages DROP CONSTRAINT IF EXISTS unified_audit_core_failure')
  for (const id of users) {
    const result = await auth('admin/users/' + id, 'DELETE', { should_soft_delete: false })
    expect([200, 404]).toContain(result.status); await result.body?.cancel()
  }
  const owned = (await db.query('SELECT id FROM identity.account_audit_redaction_jobs WHERE source_subject_id=ANY($1::text[])', [users])).rows
  for (const item of owned) if (!jobs.includes(item.id)) jobs.push(item.id)
  await db.query('DELETE FROM identity.account_audit_redaction_jobs WHERE source_subject_id=ANY($1::text[])', [users])
  await db.query('DELETE FROM identity.account_audit_redaction_receipts WHERE operation_id=ANY($1::uuid[])', [jobs])
  await db.query('DELETE FROM chat.chats WHERE id=ANY($1::text[])', [rooms])
  await db.query('DELETE FROM file_private.storage_action_audit WHERE id=ANY($1::uuid[])', [fileRows])
  await db.query(`DELETE FROM auth.audit_log_entries WHERE id=ANY($1::uuid[])
    OR payload->>'actor_id'=ANY($2::text[]) OR payload#>>'{traits,user_id}'=ANY($2::text[])`, [auditRows, users])
  await db.query('DELETE FROM auth.audit_log_entries WHERE instance_id=ANY($1::uuid[])', [scaleInstances])
  users.length = auditRows.length = fileRows.length = rooms.length = jobs.length = 0
  scaleInstances.length = 0
})
afterAll(async () => {
  await db.query('SELECT identity.check_account_audit_redaction_daily(true)')
  for (const schedule of schedules) await db.query('SELECT cron.schedule($1,$2,$3)', [schedule.jobname, schedule.schedule, schedule.command])
  await db?.end()
})

it.each([218987, 466000])('deletes through real Auth with %i synthetic audit rows, then proves both rounds', async auditCount => {
  const instance = randomUUID(); scaleInstances.push(instance)
  const seeded = await db.query(`INSERT INTO auth.audit_log_entries(id,instance_id,payload,created_at,ip_address)
    SELECT gen_random_uuid(),$1,json_build_object('actor_id',gen_random_uuid()::text,
      'actor_username','synthetic@scale.invalid','actor_name','Synthetic','action','login',
      'traits',json_build_object('provider','email','provider_id',gen_random_uuid()::text)),now(),'192.0.2.1'
    FROM generate_series(1,$2::integer)`, [instance, auditCount])
  expect(seeded.rowCount).toBe(auditCount)
  const owner = await create(), peer = await create(), agent = randomUUID(), device = 'unified-' + randomUUID()
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,status)
    VALUES($1,$2,'fixture','fixture','linux','offline')`, [device, owner.id])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,desired_status)
    VALUES($1,'agent','fixture',$2,$3,'offline')`, [agent, owner.id, device])
  const provider = randomUUID(), actor = await audit({ actor_id: owner.id, actor_username: owner.email, actor_name: 'Synthetic',
    traits: { provider: 'email', provider_id: provider } })
  const ownedAgent = await audit({ actor_id: agent, actor_username: 'synthetic@unified-audit.invalid' })
  const emailOnly = await audit({ actor_username: owner.email.toUpperCase(), actor_name: 'Legacy' })
  const otherPayload = { actor_id: peer.id, actor_username: peer.email, actor_name: 'Unrelated' }
  const other = await audit(otherPayload), operation = await fileAudit(owner.id, agent)
  const signed = await auth('token?grant_type=password', 'POST', { email: owner.email, password: owner.password })
  expect(signed.status).toBe(200); const session = await signed.json()
  expect(typeof session.access_token).toBe('string')
  const started = performance.now()
  const removed = await auth('admin/users/' + owner.id, 'DELETE', { should_soft_delete: false })
  expect(removed.status).toBe(200); await removed.body?.cancel()
  const deletionMs = performance.now() - started, absent = await auth('admin/users/' + owner.id)
  expect(absent.status).toBe(404); await absent.body?.cancel()
  console.info(JSON.stringify({ benchmark: 'audit-enqueue-auth-http', fixture: 'synthetic-audit-scale-one-owned-agent',
    synthetic_audit_rows: auditCount, delete_http_ms: deletionMs, delete_to_absent_ms: performance.now() - started }))
  expect(await row('SELECT id FROM identity.users WHERE id=ANY($1::text[])', [[owner.id, agent]])).toBeUndefined()
  const job = await jobFor(owner.id)
  expect(job.delete_user_ids).toEqual(expect.arrayContaining([owner.id, agent])); expect(job.auth_email).toBe(owner.email)
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [actor])).payload.actor_username).toBe(owner.email)
  expect((await row('SELECT actor_user_id FROM file_private.storage_action_audit WHERE id=$1', [operation])).actor_user_id).toBe(owner.id)
  const replacement = await create(owner.email)
  const replacementPayload = { actor_id: replacement.id, actor_username: owner.email, actor_name: 'New account' }
  const replacementEvent = await audit(replacementPayload)
  expect((await drain(job.id)).state).toBe('waiting_rescan')
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [actor])).payload).toEqual({ actor_id: owner.id, traits: { provider: 'email', provider_id: provider } })
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [ownedAgent])).payload).toEqual({ actor_id: agent })
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [emailOnly])).payload.actor_username).toBeUndefined()
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [other])).payload).toEqual(otherPayload)
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [replacementEvent])).payload).toEqual(replacementPayload)
  expect((await jobFor(owner.id)).auth_email).toBe(owner.email)
  expect((await row('SELECT state FROM identity.account_audit_redaction_receipts WHERE operation_id=$1 AND scan_round=1', [job.id])).state).toBe('redacted')
  expect((await batch(job.id)).state).toBe('waiting_rescan')
  const late = await audit({ actor_username: owner.email, actor_name: 'Late legacy' })
  await daySeven(job.id)
  expect((await drain(job.id)).state).toBe('closed')
  expect(await row('SELECT id FROM identity.account_audit_redaction_jobs WHERE id=$1', [job.id])).toBeUndefined()
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [late])).payload.actor_username).toBeUndefined()
  expect((await row('SELECT state FROM identity.account_audit_redaction_receipts WHERE operation_id=$1 AND scan_round=2', [job.id])).state).toBe('closed')
  const stored = await row('SELECT * FROM file_private.storage_action_audit WHERE id=$1', [operation])
  expect(stored.actor_user_id).toMatch(/^erased:/); expect(stored.effective_actor_id).toBe(stored.actor_user_id)
  expect(stored.requested_message_ids).toEqual([])
  const oldSession = await auth('user', 'GET', undefined, session.access_token)
  expect([401, 403]).toContain(oldSession.status); await oldSession.body?.cancel()
}, 90000)

it.each(['registration', 'core'])('rolls back real Auth and its registration on %s failure', async point => {
  const owner = await create(), peer = await create(), room = randomUUID(), message = randomUUID()
  rooms.push(room)
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','fixture',$2)", [room, owner.id])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [room, owner.id, peer.id])
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,'fixture','text')", [message, room, owner.id])
  if (point === 'registration') await db.query(`ALTER TABLE identity.account_audit_redaction_jobs ADD CONSTRAINT unified_audit_enqueue_failure CHECK(source_subject_id<>'${owner.id}') NOT VALID`)
  else await db.query(`ALTER TABLE chat.messages ADD CONSTRAINT unified_audit_core_failure CHECK(id<>'${message}'::uuid OR sender_user_id IS NOT NULL) NOT VALID`)
  const response = await auth('admin/users/' + owner.id, 'DELETE', { should_soft_delete: false })
  expect(response.status).toBeGreaterThanOrEqual(500); await response.body?.cancel()
  expect(await row('SELECT id FROM auth.users WHERE id=$1', [owner.id])).toBeDefined()
  expect(await row('SELECT id FROM identity.users WHERE id=$1', [owner.id])).toBeDefined()
  expect((await row('SELECT sender_user_id FROM chat.messages WHERE id=$1', [message])).sender_user_id).toBe(owner.id)
  expect(await row('SELECT id FROM identity.account_audit_redaction_jobs WHERE source_subject_id=$1', [owner.id])).toBeUndefined()
})

it('retains recovery after an asynchronous failure without restoring deleted Auth', async () => {
  const owner = await create(), event = await audit({ actor_id: owner.id, actor_username: owner.email }), operation = await fileAudit(owner.id)
  const removed = await auth('admin/users/' + owner.id, 'DELETE', { should_soft_delete: false })
  expect(removed.status).toBe(200); await removed.body?.cancel()
  const job = await jobFor(owner.id)
  await db.query(`ALTER TABLE file_private.storage_action_audit ADD CONSTRAINT unified_audit_late_failure CHECK(id<>'${operation}'::uuid OR actor_user_id NOT LIKE 'erased:%') NOT VALID`)
  expect(await drain(job.id)).toMatchObject({ state: 'retry_wait', error_code: '23514' })
  expect(await row('SELECT id FROM auth.users WHERE id=$1', [owner.id])).toBeUndefined()
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [event])).payload.actor_username).toBeUndefined()
  expect((await jobFor(owner.id)).auth_email).toBe(owner.email)
  expect(await row('SELECT * FROM identity.account_audit_redaction_context WHERE job_id=$1', [job.id])).toBeUndefined()
  await db.query('ALTER TABLE file_private.storage_action_audit DROP CONSTRAINT unified_audit_late_failure')
  await db.query('UPDATE identity.account_audit_redaction_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1', [job.id])
  expect((await drain(job.id)).state).toBe('waiting_rescan')
})

it('checks actual overdue logs during the rescan wait and fails the daily guard', async () => {
  const owner = await create(), removed = await auth('admin/users/' + owner.id, 'DELETE', { should_soft_delete: false })
  expect(removed.status).toBe(200); await removed.body?.cancel()
  const job = await jobFor(owner.id); expect((await drain(job.id)).state).toBe('waiting_rescan')
  await db.query("UPDATE identity.account_audit_redaction_jobs SET deleted_at=deleted_at-interval '2 days',target_at=target_at-interval '2 days' WHERE id=$1", [job.id])
  await audit({ actor_username: owner.email })
  const check = (await row('SELECT identity.check_account_audit_redaction_daily(true) result')).result
  expect(check.state).toBe('alert'); expect(Number(check.auth_residual_count)).toBeGreaterThan(0)
  await expect(db.query('SELECT identity.assert_account_audit_redaction_daily(true)')).rejects.toMatchObject({ code: 'P0001' })
  expect((await jobFor(owner.id)).state).toBe('waiting_rescan')
})

it('keeps second-round residuals for manual review rather than writing a false closure', async () => {
  const owner = await create(), removed = await auth('admin/users/' + owner.id, 'DELETE', { should_soft_delete: false })
  expect(removed.status).toBe(200); await removed.body?.cancel()
  const job = await jobFor(owner.id); expect((await drain(job.id)).state).toBe('waiting_rescan')
  await daySeven(job.id)
  for (let i = 0; i < 100; i++) {
    if ((await jobFor(owner.id)).phase === 'verify') break
    expect((await batch(job.id)).state).toBe('pending')
  }
  expect((await jobFor(owner.id)).phase).toBe('verify')
  await audit({ actor_username: owner.email, actor_name: 'Late after the cursor' })
  expect((await batch(job.id)).state).toBe('manual_review')
  expect((await jobFor(owner.id)).auth_email).toBe(owner.email)
  expect(await row('SELECT * FROM identity.account_audit_redaction_receipts WHERE operation_id=$1 AND scan_round=2', [job.id])).toBeUndefined()
})

it('does not advance a skip-locked page or issue a completion proof', async () => {
  const owner = await create(), removed = await auth('admin/users/' + owner.id, 'DELETE', { should_soft_delete: false })
  expect(removed.status).toBe(200); await removed.body?.cancel()
  const job = await jobFor(owner.id), event = '00000000-0000-0000-0000-' + randomUUID().replaceAll('-', '').slice(-12)
  auditRows.push(event)
  await db.query('INSERT INTO auth.audit_log_entries(id,payload,created_at) VALUES($1,$2,now())', [event, { actor_id: owner.id, actor_username: owner.email }])
  const locker = new pg.Client({ connectionString: process.env.GUGU_INTEGRATION_DATABASE_URL }); await locker.connect()
  try {
    await locker.query('BEGIN'); await locker.query('SELECT id FROM auth.audit_log_entries WHERE id=$1 FOR UPDATE', [event])
    expect(await batch(job.id)).toMatchObject({ state: 'retry_wait', blocked: true })
    expect(await jobFor(owner.id)).toMatchObject({ phase: 'auth', cursor_id: null })
    expect(await row('SELECT * FROM identity.account_audit_redaction_receipts WHERE operation_id=$1', [job.id])).toBeUndefined()
  } finally { await locker.query('ROLLBACK'); await locker.end() }
  await db.query('UPDATE identity.account_audit_redaction_jobs SET next_attempt_at=clock_timestamp() WHERE id=$1', [job.id])
  expect((await drain(job.id)).state).toBe('waiting_rescan')
})

it('commits retry information before surfacing a real procedure failure', async () => {
  const owner = await create(), operation = await fileAudit(owner.id)
  const removed = await auth('admin/users/' + owner.id, 'DELETE', { should_soft_delete: false })
  expect(removed.status).toBe(200); await removed.body?.cancel()
  const job = await jobFor(owner.id)
  await db.query("UPDATE identity.account_audit_redaction_jobs SET target_at=deleted_at+interval '1 hour' WHERE id=$1", [job.id])
  await db.query(`ALTER TABLE file_private.storage_action_audit ADD CONSTRAINT unified_audit_late_failure CHECK(id<>'${operation}'::uuid OR actor_user_id NOT LIKE 'erased:%') NOT VALID`)
  expect(schedules.find(item => item.jobname === 'account-audit-redaction-retry')!.command.startsWith('CALL ')).toBe(true)
  await expect(db.query('CALL identity.run_account_audit_redactions(1000,10,true)')).rejects.toMatchObject({ code: 'P0001' })
  expect(await jobFor(owner.id)).toMatchObject({ state: 'retry_wait', last_error_code: '23514' })
  expect(await row('SELECT id FROM auth.users WHERE id=$1', [owner.id])).toBeUndefined()
})

it.each([null, ''])('queues complete identities through actual Auth when OLD.email is %s', async email => {
  const { id } = await create(); await db.query('UPDATE auth.users SET email=$2 WHERE id=$1', [id, email])
  const readable = await auth('admin/users/' + id)
  expect(readable.status).toBe(200); await readable.body?.cancel()
  const event = await audit({ actor_id: id, actor_username: 'synthetic@unified-audit.invalid' })
  const response = await auth('admin/users/' + id, 'DELETE', { should_soft_delete: false })
  expect(response.status).toBe(200); await response.body?.cancel()
  const job = await jobFor(id); expect(job.auth_email).toBeNull()
  expect((await drain(job.id)).state).toBe('waiting_rescan')
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [event])).payload).toEqual({ actor_id: id })
})

it('preserves the one-argument capability and closes worker capabilities to API roles', async () => {
  const owner = await create()
  await db.query('BEGIN')
  try {
    await db.query('SELECT identity.erase_human_account($1)', [owner.id])
    expect((await jobFor(owner.id)).auth_email).toBeNull()
  } finally { await db.query('ROLLBACK') }
  expect(await row('SELECT id FROM identity.users WHERE id=$1', [owner.id])).toBeDefined()
  for (const signature of ['identity.erase_human_account(text)', 'identity.erase_human_account(text,text)',
    'identity.handle_deleted_auth_user()', 'identity.process_account_audit_redaction(uuid,integer)',
    'identity.run_account_audit_redactions(integer,integer,boolean)', 'identity.check_account_audit_redaction_daily(boolean)',
    'identity.assert_account_audit_redaction_daily(boolean)']) {
    for (const role of ['anon', 'authenticated', 'service_role']) expect((await row("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).allowed).toBe(false)
  }
})
