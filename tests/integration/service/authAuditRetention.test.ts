import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let db: pg.Client, subject: string, agent: string
const ids = () => [subject, agent]
const email = () => subject + '@audit.invalid'
async function context(values = ids()) {
  await db.query("INSERT INTO identity.account_lifecycle_context(transaction_id,operation,subject_user_id,delete_user_ids) VALUES(pg_current_xact_id(),'privacy_erasure',$1,$2)", [values[0], values])
}
async function entry(payload: unknown, age = '0 days', ip = '192.0.2.11') {
  const id = randomUUID()
  await db.query('INSERT INTO auth.audit_log_entries(id,payload,created_at,ip_address) VALUES($1,$2,now()-$3::interval,$4)', [id, JSON.stringify(payload), age, ip])
  return id
}
const read = async (id: string) => (await db.query('SELECT payload,created_at,ip_address FROM auth.audit_log_entries WHERE id=$1', [id])).rows[0]
const erase = (values = ids(), mail: string | null = email()) => db.query('SELECT identity.erase_auth_audit_actor($1,$2)', [values, mail])
const prune = async (limit: number | null = 100) => Number((await db.query('SELECT identity.prune_auth_audit_log($1) AS n', [limit])).rows[0].n)
async function refused(sql: string, args: unknown[] = []) {
  await db.query('SAVEPOINT refusal')
  try { await db.query(sql, args) } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT refusal'); return error as pg.DatabaseError
  }
  throw Error('Expected refusal')
}
beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw Error('Auth audit tests require an owned loopback fixture')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  subject = randomUUID(); agent = 'agent-' + randomUUID()
  await db.query('BEGIN')
  await db.query("SET LOCAL statement_timeout='2s'")
})
afterEach(async () => { await db.query('ROLLBACK') })

describe('closed Auth audit actor redaction', () => {
  it('removes actor email/name while retaining security evidence and unrelated fields', async () => {
    const payload = { actor_id: subject, actor_username: email(), actor_name: 'Synthetic Actor', action: 'login', log_type: 'account', actor_via_sso: false, traits: { provider: 'email', provider_id: email(), identity_id: randomUUID(), unrelated: 'keep' } }
    const id = await entry(payload), before = await read(id)
    await context(); await erase()
    const after = await read(id)
    expect(after).toEqual({ ...before, payload: { actor_id: subject, action: 'login', log_type: 'account', actor_via_sso: false, traits: { provider: 'email', identity_id: payload.traits.identity_id, unrelated: 'keep' } } })
    await erase(); expect(await read(id)).toEqual(after)
  })
  it('redacts target email/phone without erasing another administrator actor', async () => {
    const payload = { actor_id: randomUUID(), actor_username: 'administrator@audit.invalid', actor_name: 'Synthetic Administrator', action: 'user_deleted', traits: { user_id: subject, user_email: email(), user_phone: '+19999999999', provider: 'email' } }
    const id = await entry(payload)
    await context(); await erase()
    expect((await read(id)).payload).toEqual({ ...payload, traits: { user_id: subject, provider: 'email' } })
  })
  it.each([null, ''])('still matches every ID when email is %s', async mail => {
    const one = await entry({ actor_id: subject.toUpperCase(), actor_username: email(), actor_name: 'Subject' })
    const two = await entry({ actor_id: agent, actor_username: 'agent@audit.invalid', actor_name: 'Agent' })
    await context(); await erase(ids(), mail)
    expect((await read(one)).payload).toEqual({ actor_id: subject.toUpperCase() })
    expect((await read(two)).payload).toEqual({ actor_id: agent })
  })
  it('matches a full normalized email without an ID match, but not a shared prefix', async () => {
    const match = await entry({ actor_id: randomUUID(), actor_username: email().toUpperCase(), actor_name: 'Synthetic' })
    const untouched = { actor_id: randomUUID(), actor_username: subject + '@different.invalid', actor_name: 'Different' }
    const other = await entry(untouched)
    await context(); await erase(ids(), ' ' + email() + ' ')
    expect((await read(match)).payload.actor_username).toBeUndefined()
    expect((await read(other)).payload).toEqual(untouched)
  })
  it('matches target and email provider paths independently of an administrator actor', async () => {
    const payload = { actor_id: randomUUID(), actor_username: 'other@audit.invalid', traits: { user_email: email().toUpperCase(), user_phone: '+19999999999', provider: 'email', provider_id: email() } }
    const id = await entry(payload)
    await context(); await erase()
    expect((await read(id)).payload).toEqual({ ...payload, traits: { provider: 'email' } })
  })
  it('does not recursively rewrite unknown JSON or another provider opaque ID', async () => {
    const payload = { actor_id: subject, actor_username: email(), traits: { provider: 'custom', provider_id: 'opaque-value', unknown: { label: 'keep' } } }
    const id = await entry(payload)
    await context(); await erase()
    expect((await read(id)).payload).toEqual({ actor_id: subject, traits: payload.traits })
  })
  it('requires the exact full ordered current-transaction identity context', async () => {
    expect((await refused('SELECT identity.erase_auth_audit_actor($1,$2)', [ids(), email()])).code).toBe('42501')
    await context()
    for (const values of [[subject], [agent, subject], [], null]) {
      expect((await refused('SELECT identity.erase_auth_audit_actor($1,$2)', [values, email()])).code).toBe('42501')
    }
  })
  it.each(['anon', 'authenticated', 'service_role'])('closes both helpers to %s', async role => {
    await context(); await db.query('SET LOCAL ROLE ' + role)
    expect((await refused('SELECT identity.erase_auth_audit_actor($1,$2)', [ids(), email()])).code).toBe('42501')
    expect((await refused('SELECT identity.prune_auth_audit_log(100)')).code).toBe('42501')
  })
  it('rolls back redaction with the caller transaction', async () => {
    const payload = { actor_id: subject, actor_username: email(), actor_name: 'Synthetic' }, id = await entry(payload)
    await context(); await db.query('SAVEPOINT deletion'); await erase()
    expect((await read(id)).payload.actor_username).toBeUndefined()
    await db.query('ROLLBACK TO SAVEPOINT deletion')
    expect((await read(id)).payload).toEqual(payload)
  })
})

describe('bounded Auth audit retention', () => {
  it('deletes strictly older rows and preserves the exact boundary, new and NULL dates', async () => {
    const old = await entry({}, '180 days 0.000001 seconds')
    const boundary = await entry({}, '180 days'), fresh = await entry({}, '179 days'), undated = await entry({})
    await db.query('UPDATE auth.audit_log_entries SET created_at=NULL WHERE id=$1', [undated])
    expect(await prune()).toBe(1); expect(await read(old)).toBeUndefined()
    for (const id of [boundary, fresh, undated]) expect(await read(id)).toBeDefined()
  })
  it('keeps a full 180 UTC days when the caller uses a daylight-saving timezone', async () => {
    await db.query("SET LOCAL TimeZone='America/New_York'")
    const boundary=await entry({},'15552000 seconds'),older=await entry({},'15552000.000001 seconds')
    expect(await prune()).toBe(1)
    expect(await read(boundary)).toBeDefined();expect(await read(older)).toBeUndefined()
  })
  it('limits each default batch and converges without touching new records', async () => {
    await db.query("INSERT INTO auth.audit_log_entries(id,payload,created_at) SELECT gen_random_uuid(),'{}',now()-interval '181 days' FROM generate_series(1,150)")
    const fresh = await entry({})
    expect(await prune()).toBe(100); expect(await prune()).toBe(50); expect(await prune()).toBe(0)
    expect(await read(fresh)).toBeDefined()
  })
  it('refuses invalid batch sizes and a missing or excessive query deadline', async () => {
    for (const limit of [null, 0, 1001]) expect((await refused('SELECT identity.prune_auth_audit_log($1)', [limit])).message).toContain('Invalid')
    for (const setting of ['0', '3s']) {
      await db.query("SELECT set_config('statement_timeout',$1,true)", [setting])
      expect((await refused('SELECT identity.prune_auth_audit_log(100)')).message).toContain('timeout')
    }
  })
  it('skips a locked expired row and processes it after the owner releases it', async () => {
    const locker = new pg.Client({ connectionString: url }), rows = [randomUUID(), randomUUID()]
    await locker.connect()
    try {
      await locker.query("SET statement_timeout='2s'")
      await locker.query("INSERT INTO auth.audit_log_entries(id,payload,created_at) SELECT unnest($1::uuid[]),'{}',now()-interval '181 days'", [rows])
      await locker.query('BEGIN'); await locker.query('SELECT id FROM auth.audit_log_entries WHERE id=$1 FOR UPDATE', [rows[0]])
      expect(await prune()).toBe(1)
      await db.query('COMMIT'); await locker.query('COMMIT')
      await db.query("SET statement_timeout='2s'")
      expect(await prune()).toBe(1)
    } finally {
      await db.query('ROLLBACK'); await locker.query('ROLLBACK')
      await locker.query('DELETE FROM auth.audit_log_entries WHERE id=ANY($1)', [rows]); await locker.end()
    }
  })
  it('checks that the installed index is valid and the Auth owner is unchanged', async () => {
    const { rows } = await db.query("SELECT pg_get_userbyid(c.relowner) owner,x.indisvalid,x.indisready FROM pg_class c JOIN pg_index x ON x.indrelid=c.oid WHERE c.oid='auth.audit_log_entries'::regclass AND x.indexrelid='auth.audit_log_entries_created_at_id_idx'::regclass")
    expect(rows).toEqual([{ owner: 'supabase_auth_admin', indisvalid: true, indisready: true }])
  })
})
