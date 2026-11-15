import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'

const api = process.env.GUGU_INTEGRATION_SUPABASE_URL ?? ''
const anon = process.env.VITE_SUPABASE_ANON_KEY ?? ''
const service = process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY ?? ''
let db: pg.Client
const users: string[] = [], auditRows: string[] = [], fileRows: string[] = [], rooms: string[] = []
async function auth(path: string, method = 'GET', body?: unknown, token = service) {
  return fetch(api + '/auth/v1/' + path, { method, signal: AbortSignal.timeout(15_000),
    headers: { apikey: token === service ? service : anon, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function create() {
  const email = randomUUID() + '@unified-audit.invalid', password = randomUUID()
  const response = await auth('admin/users', 'POST', { email, password, email_confirm: true })
  expect(response.status).toBe(200)
  const user = await response.json(); expect(typeof user.id).toBe('string'); users.push(user.id)
  return { id: user.id as string, email, password }
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
beforeAll(async () => {
  const target = new URL(api), database = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  const owner = JSON.parse(readFileSync('.local/test-db/owner.json', 'utf8'))
  if (target.hostname !== '127.0.0.1' || database.hostname !== '127.0.0.1'
    || Number(database.port) !== owner.port || Number(target.port) !== owner.port - 1
    || owner.root !== process.cwd() + '/') throw Error('Owned checkout loopback fixture required')
  db = new pg.Client({ connectionString: database.href }); await db.connect()
})
afterEach(async () => {
  await db.query('ALTER TABLE file_private.storage_action_audit DROP CONSTRAINT IF EXISTS unified_audit_late_failure')
  for (const id of users) {
    const result = await auth('admin/users/' + id, 'DELETE', { should_soft_delete: false })
    expect([200, 404]).toContain(result.status); await result.body?.cancel()
  }
  await db.query('DELETE FROM chat.chats WHERE id=ANY($1::text[])', [rooms])
  await db.query('DELETE FROM file_private.storage_action_audit WHERE id=ANY($1::uuid[])', [fileRows])
  await db.query(`DELETE FROM auth.audit_log_entries WHERE id=ANY($1::uuid[])
    OR payload->>'actor_id'=ANY($2::text[]) OR payload#>>'{traits,user_id}'=ANY($2::text[])`, [auditRows, users])
  users.length = auditRows.length = fileRows.length = rooms.length = 0
})
afterAll(async () => { await db?.end() })

it('redacts both audits through actual Auth HTTP hard deletion, keeping security IDs and other users', async () => {
  const owner = await create(), peer = await create(), agent = randomUUID(), device = 'unified-' + randomUUID()
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,status)
    VALUES($1,$2,'fixture','fixture','linux','offline')`, [device, owner.id])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,desired_status)
    VALUES($1,'agent','fixture',$2,$3,'offline')`, [agent, owner.id, device])
  const securityIdentity = randomUUID()
  const actor = await audit({ actor_id: owner.id, actor_username: owner.email.toUpperCase(), actor_name: 'Synthetic', action: 'login',
    traits: { provider: 'email', provider_id: securityIdentity } })
  const ownedAgent = await audit({ actor_id: agent, actor_username: 'synthetic@unified-audit.invalid', actor_name: 'Agent' })
  const emailOnly = await audit({ actor_id: randomUUID(), actor_username: owner.email.toUpperCase(), actor_name: 'Synthetic' })
  const otherPayload = { actor_id: peer.id, actor_username: peer.email, actor_name: 'Unrelated', action: 'login' }
  const other = await audit(otherPayload), operation = await fileAudit(owner.id, agent)
  const signed = await auth('token?grant_type=password', 'POST', { email: owner.email, password: owner.password })
  expect(signed.status).toBe(200); const session = await signed.json()
  const removed = await auth('admin/users/' + owner.id, 'DELETE', { should_soft_delete: false })
  expect(removed.status).toBe(200); await removed.body?.cancel()
  const absent = await auth('admin/users/' + owner.id)
  expect(absent.status).toBe(404); await absent.body?.cancel()
  expect(await row('SELECT id FROM identity.users WHERE id=ANY($1::text[])', [[owner.id, agent]])).toBeUndefined()
  expect(await row('SELECT * FROM identity.account_lifecycle_context WHERE subject_user_id=$1', [owner.id])).toBeUndefined()
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [actor])).payload).toEqual({ actor_id: owner.id, action: 'login',
    traits: { provider: 'email', provider_id: securityIdentity } })
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [ownedAgent])).payload).toEqual({ actor_id: agent })
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [emailOnly])).payload.actor_username).toBeUndefined()
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [other])).payload).toEqual(otherPayload)
  const stored = await row('SELECT * FROM file_private.storage_action_audit WHERE id=$1', [operation])
  expect(stored.actor_user_id).toMatch(/^erased:/); expect(stored.effective_actor_id).toBe(stored.actor_user_id)
  expect(stored.requested_message_ids).toEqual([]); expect(stored.action).toBe('permanent')
  expect(await row('SELECT id FROM auth.users WHERE id=$1', [peer.id])).toBeDefined()
  const oldSession = await auth('user', 'GET', undefined, session.access_token)
  expect([401, 403]).toContain(oldSession.status); await oldSession.body?.cancel()
})

it('rolls back Auth, identity, group and early audit redaction when the late file helper fails', async () => {
  const owner = await create(), peer = await create(), room = randomUUID(), message = randomUUID()
  rooms.push(room)
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','fixture',$2)", [room, owner.id])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [room, owner.id, peer.id])
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,'fixture','text')", [message, room, owner.id])
  const payload = { actor_id: owner.id, actor_username: owner.email, actor_name: 'Synthetic', action: 'login' }
  const before = await audit(payload), operation = await fileAudit(owner.id)
  // A real later constraint failure, confined to this synthetic row. The Auth
  // request uses another connection and must roll back all earlier triggers.
  await db.query(`ALTER TABLE file_private.storage_action_audit ADD CONSTRAINT unified_audit_late_failure
    CHECK(id<>'${operation}'::uuid OR actor_user_id NOT LIKE 'erased:%') NOT VALID`)
  const response = await auth('admin/users/' + owner.id, 'DELETE', { should_soft_delete: false })
  expect(response.status).toBeGreaterThanOrEqual(500); await response.body?.cancel()
  expect(await row('SELECT id FROM auth.users WHERE id=$1', [owner.id])).toBeDefined()
  expect(await row('SELECT id FROM identity.users WHERE id=$1', [owner.id])).toBeDefined()
  expect((await row('SELECT creator_user_id FROM chat.chats WHERE id=$1', [room])).creator_user_id).toBe(owner.id)
  expect((await row('SELECT sender_user_id FROM chat.messages WHERE id=$1', [message])).sender_user_id).toBe(owner.id)
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [before])).payload).toEqual(payload)
  expect((await row('SELECT actor_user_id FROM file_private.storage_action_audit WHERE id=$1', [operation])).actor_user_id).toBe(owner.id)
  expect(await row('SELECT * FROM identity.account_lifecycle_context WHERE subject_user_id=$1', [owner.id])).toBeUndefined()
})

it.each([null, ''])('actual Auth DELETE still redacts complete IDs when OLD.email is %s', async email => {
  const id = randomUUID(); users.push(id)
  await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}',now(),now())`, [id, email])
  const event = await audit({ actor_id: id, actor_username: 'synthetic@unified-audit.invalid', actor_name: 'Synthetic' })
  const operation = await fileAudit(id)
  const response = await auth('admin/users/' + id, 'DELETE', { should_soft_delete: false })
  expect(response.status).toBe(200); await response.body?.cancel()
  expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [event])).payload).toEqual({ actor_id: id })
  expect((await row('SELECT actor_user_id FROM file_private.storage_action_audit WHERE id=$1', [operation])).actor_user_id).toMatch(/^erased:/)
})

it('keeps the private one-argument capability and closes both signatures to API roles', async () => {
  const owner = await create(), event = await audit({ actor_id: owner.id, actor_username: owner.email })
  const operation = await fileAudit(owner.id)
  await db.query('BEGIN')
  try {
    await db.query('SELECT identity.erase_human_account($1)', [owner.id])
    expect((await row('SELECT payload FROM auth.audit_log_entries WHERE id=$1', [event])).payload).toEqual({ actor_id: owner.id })
    expect((await row('SELECT actor_user_id FROM file_private.storage_action_audit WHERE id=$1', [operation])).actor_user_id).toMatch(/^erased:/)
  } finally { await db.query('ROLLBACK') }
  expect(await row('SELECT id FROM identity.users WHERE id=$1', [owner.id])).toBeDefined()
  for (const signature of ['identity.erase_human_account(text)', 'identity.erase_human_account(text,text)', 'identity.handle_deleted_auth_user()']) {
    expect(await row(`SELECT prosecdef,pg_get_userbyid(proowner) owner,proconfig FROM pg_proc WHERE oid=$1::regprocedure`, [signature]))
      .toMatchObject({ prosecdef: true, owner: 'postgres', proconfig: ['search_path=pg_catalog'] })
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await row('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, signature])).allowed).toBe(false)
    }
  }
})
