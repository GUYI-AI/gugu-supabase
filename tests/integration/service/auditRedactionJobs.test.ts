import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let db: pg.Client, subject: string, agent: string
const ids = () => [subject, agent]
async function context() {
  await db.query("INSERT INTO identity.account_lifecycle_context(transaction_id,operation,subject_user_id,delete_user_ids) VALUES(pg_current_xact_id(),'privacy_erasure',$1,$2)", [subject, ids()])
}
async function enqueue(mail: string | null = subject + '@job.invalid') {
  return (await db.query('SELECT identity.enqueue_account_audit_redaction($1,$2) id', [ids(), mail])).rows[0].id as string
}
async function refused(sql: string, args: unknown[] = []) {
  await db.query('SAVEPOINT refusal')
  let error: pg.DatabaseError | undefined
  try { await db.query(sql, args) } catch (e) { error = e as pg.DatabaseError }
  await db.query('ROLLBACK TO SAVEPOINT refusal')
  if (!error) throw Error('Expected refusal')
  return error
}
async function worker() {
  await context()
  const id = await enqueue(), token = randomUUID()
  await db.query("UPDATE identity.account_audit_redaction_jobs SET state='running',lease_token=$2,lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1", [id, token])
  await db.query('INSERT INTO identity.account_audit_redaction_context VALUES(pg_current_xact_id(),$1,$2,pg_backend_pid())', [id, token])
  return { id, token }
}
const assertion = 'SELECT (identity.assert_registered_audit_context($1,$2)).id id'
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (url.hostname !== '127.0.0.1') throw Error('Owned loopback fixture required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
beforeEach(async () => { subject = randomUUID(); agent = 'agent-' + randomUUID(); await db.query('BEGIN') })
afterEach(() => db.query('ROLLBACK'))
afterAll(() => db?.end())

it('registers the exact erasure set once and rejects changed or invented criteria', async () => {
  expect((await refused('SELECT identity.enqueue_account_audit_redaction($1,$2)', [ids(), 'synthetic@job.invalid'])).code).toBe('42501')
  await context()
  expect((await refused('SELECT identity.enqueue_account_audit_redaction($1,$2)', [[subject], null])).code).toBe('42501')
  const id = await enqueue(' ' + subject.toUpperCase() + '@JOB.INVALID ')
  expect(await enqueue()).toBe(id)
  expect((await refused('SELECT identity.enqueue_account_audit_redaction($1,$2)', [ids(), 'other@job.invalid'])).code).toBe('42501')
  const row = (await db.query('SELECT *,extract(epoch FROM target_at-deleted_at) target_seconds,extract(epoch FROM hard_due_at-deleted_at) hard_seconds FROM identity.account_audit_redaction_jobs WHERE id=$1', [id])).rows[0]
  expect(row).toMatchObject({ source_subject_id: subject, delete_user_ids: ids(), auth_email: subject + '@job.invalid', scan_round: 1, state: 'pending', phase: 'auth', cursor_id: null, lease_token: null })
  expect(Number(row.target_seconds)).toBe(86400)
  expect(Number(row.hard_seconds)).toBe(15 * 86400)
})
it.each([null, ''])('preserves complete IDs when the trusted email is %s', async mail => {
  await context(); const id = await enqueue(mail)
  expect((await db.query('SELECT auth_email,delete_user_ids FROM identity.account_audit_redaction_jobs WHERE id=$1', [id])).rows[0]).toEqual({ auth_email: null, delete_user_ids: ids() })
})
it('rolls back registration together with the source transaction', async () => {
  await db.query('SAVEPOINT before_registration'); await context(); const id = await enqueue()
  await db.query('ROLLBACK TO SAVEPOINT before_registration')
  expect((await db.query('SELECT id FROM identity.account_audit_redaction_jobs WHERE id=$1', [id])).rowCount).toBe(0)
})
it('requires a current process/transaction context and live lease even for a valid task', async () => {
  await context(); const id = await enqueue()
  expect((await refused(assertion, [id, ['auth']])).code).toBe('42501')
})
it('returns the locked registered criteria only in the allowed worker phase', async () => {
  const { id } = await worker()
  expect((await db.query(assertion, [id, ['auth']])).rows[0].id).toBe(id)
  expect((await refused(assertion, [id, ['file_headers']])).code).toBe('42501')
  await db.query("UPDATE identity.account_audit_redaction_jobs SET state='verifying',phase='verify' WHERE id=$1", [id])
  expect((await db.query(assertion, [id, ['verify']])).rows[0].id).toBe(id)
})
it.each(['pid', 'transaction', 'token', 'expired'])('rejects a stale worker %s', async kind => {
  const { id } = await worker()
  if (kind === 'pid') await db.query('UPDATE identity.account_audit_redaction_context SET backend_pid=backend_pid+1 WHERE job_id=$1', [id])
  if (kind === 'transaction') await db.query("UPDATE identity.account_audit_redaction_context SET transaction_id='1'::xid8 WHERE job_id=$1", [id])
  if (kind === 'token') await db.query('UPDATE identity.account_audit_redaction_context SET lease_token=$2 WHERE job_id=$1', [id, randomUUID()])
  if (kind === 'expired') await db.query("UPDATE identity.account_audit_redaction_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [id])
  expect((await refused(assertion, [id, ['auth']])).code).toBe('42501')
})
it('does not authorize a second scan before the seventh day', async () => {
  const { id } = await worker()
  await db.query("UPDATE identity.account_audit_redaction_jobs SET scan_round=2,first_scan_completed_at=clock_timestamp(),next_scan_at=deleted_at+interval '7 days' WHERE id=$1", [id])
  expect((await refused(assertion, [id, ['auth']])).code).toBe('42501')
  await db.query("UPDATE identity.account_audit_redaction_jobs SET deleted_at=deleted_at-interval '8 days',target_at=target_at-interval '8 days',next_scan_at=next_scan_at-interval '8 days' WHERE id=$1", [id])
  expect((await db.query(assertion, [id, ['auth']])).rows[0].id).toBe(id)
})
it('keeps registrations, email criteria and worker capabilities closed to API roles', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const table of ['account_audit_redaction_jobs', 'account_audit_redaction_context', 'account_audit_redaction_receipts']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) expect((await db.query('SELECT has_table_privilege($1,$2,$3) ok', [role, 'identity.' + table, privilege])).rows[0].ok).toBe(false)
    }
    for (const signature of ['identity.enqueue_account_audit_redaction(text[],text)', 'identity.assert_registered_audit_context(uuid,text[])']) {
      expect((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok).toBe(false)
      expect((await db.query('SELECT prosecdef,pg_get_userbyid(proowner) owner,proconfig FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0]).toMatchObject({ prosecdef: true, owner: 'postgres', proconfig: ['search_path=pg_catalog'] })
    }
  }
})
