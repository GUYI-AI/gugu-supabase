import { randomUUID, randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let db: pg.Client
let worker: pg.Client
let workerUrl: string
const workerLogin = `push_test_${randomBytes(6).toString('hex')}`
let workerLoginCreated = false
type Fixture = { owner: string; other: string; session: string; otherSession: string; install: string; chat: string; agent: string; device: string }
beforeAll(async () => {
  const target = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
    throw new Error('Mobile push contracts require an installed disposable loopback backend')
  }
  db = new pg.Client({ connectionString: url }); await db.connect()
  await db.query("SET statement_timeout='10s'")
  // Model the operator-provisioned login, not an assumed admin SET ROLE grant.
  const password = randomBytes(18).toString('hex')
  await db.query(`CREATE ROLE ${workerLogin} LOGIN NOINHERIT PASSWORD '${password}' IN ROLE gugu_push`)
  workerLoginCreated = true
  const connection = new URL(url); connection.username = workerLogin; connection.password = password
  workerUrl = connection.href
  worker = new pg.Client({ connectionString: workerUrl }); await worker.connect()
})
afterAll(async () => {
  await worker?.end()
  if (workerLoginCreated) await db.query(`DROP ROLE ${workerLogin}`)
  await db?.end()
})

async function fixture(body: (f: Fixture) => Promise<void>, kind = 'dm') {
  const f: Fixture = { owner: randomUUID(), other: randomUUID(), session: randomUUID(),
    otherSession: randomUUID(), install: randomUUID(), chat: randomUUID(), agent: randomUUID(), device: `push-fixture-${randomUUID()}` }
  try {
    for (const [owner, session] of [[f.owner, f.session], [f.other, f.otherSession]]) {
      await db.query(`INSERT INTO auth.users(id,email) VALUES($1,$2)`, [owner, owner + '@push.invalid'])
      await db.query(`INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Push fixture') ON CONFLICT DO NOTHING`, [owner])
      await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [session, owner])
    }
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Push fixture host','fixture','linux')", [f.device, f.owner])
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Push fixture agent',$2,$3)", [f.agent, f.owner, f.device])
    await db.query("INSERT INTO identity.agent_runtime_states(agent_user_id,owner_user_id,agent_status,agent_status_detail,runtime_status,last_seen_at) VALUES($1,$2,'idle','plain','online',now())", [f.agent, f.owner])
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,$2,'Push fixture',$3)", [f.chat, kind, f.owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [f.chat, f.owner, f.other])
    await body(f)
  } finally {
    await db.query('ROLLBACK'); await db.query('RESET ROLE')
    await db.query('DELETE FROM chat.chats WHERE id=$1', [f.chat])
    await db.query('DELETE FROM identity.agent_runtime_states WHERE agent_user_id=$1', [f.agent])
    await db.query('DELETE FROM identity.users WHERE id=$1', [f.agent])
    await db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1', [f.device])
    await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[f.owner, f.other]])
    await db.query('DELETE FROM identity.users WHERE id=ANY($1::text[])', [[f.owner, f.other]])
    await db.query('DELETE FROM chat.account_revision_heads WHERE user_id=ANY($1::text[])', [[f.owner, f.other, f.agent]])
  }
}
async function rpc(client: pg.Client, role: string, sql: string, values: unknown[], claims?: object) {
  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL ROLE ${role === 'authenticated' ? 'authenticated' : role === 'anon' ? 'anon' : 'gugu_push'}`)
    await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims ?? {})])
    const result = await client.query(sql, values)
    await client.query('COMMIT'); return result.rows
  } catch (error) { await client.query('ROLLBACK'); throw error }
}
async function register(f: Fixture, overrides: { owner?: string; session?: string; device?: string; token?: string; install?: string; chatSound?: boolean; taskSound?: boolean } = {}) {
  const owner = overrides.owner ?? f.owner; const install = overrides.install ?? f.install
  return (await rpc(db, 'authenticated', 'SELECT identity.mobile_push_register($1,$2,$3,$4,$5,true,true,$6,$7) AS value',
    [install, overrides.device ?? `phone-${install}-${owner}`, overrides.token ?? 'ab'.repeat(32), 'production', 'app.gugu.chat',
      overrides.chatSound ?? true, overrides.taskSound ?? true],
    { sub: owner, session_id: overrides.session ?? f.session, role: 'authenticated' }))[0].value as { registration_id: string; generation: string }
}
async function reserve(client = worker) {
  return (await rpc(client, 'gugu_push', "SELECT identity.mobile_push_reserve('production',20) AS id", [])).map(r => r.id as string)
}
async function prepare(id: string) {
  expect((await rpc(worker, 'gugu_push', 'SELECT identity.mobile_push_admit($1) AS yes', [id]))[0].yes).toBe(true)
  return (await rpc(worker, 'gugu_push', 'SELECT identity.mobile_push_prepare($1) AS value', [id]))[0].value
}
async function send(f: Fixture, options: { sender?: string; addressed?: string[]; whisper?: boolean; reply?: string } = {}) {
  const id = randomUUID()
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,to_user_ids,is_whisper,reply_to_message_id)
    VALUES($1,$2,$3,'PRIVATE_MESSAGE_CANARY',$4,$5,$6)`, [id, f.chat, options.sender ?? f.other,
    options.addressed ?? [f.owner], options.whisper ?? false, options.reply ?? null])
  return id
}
async function closeScope(f: Fixture, options: { caller?: string; ticketSession?: string; originalSession?: string; install?: string; device?: string } = {}) {
  const owner = options.caller ?? f.owner; const install = options.install ?? f.install
  return (await rpc(db, 'authenticated', 'SELECT identity.mobile_push_close_installation($1,$2,$3) AS value',
    [install, options.device ?? `phone-${install}-${owner}`, options.originalSession ?? f.session],
    { sub: owner, session_id: options.ticketSession ?? f.session, role: 'authenticated' }))[0].value
}
async function waitBlocked(observer: pg.Client, waiting: pg.Client, blocker: pg.Client) {
  const waitingPid = (await waiting.query('SELECT pg_backend_pid() AS id')).rows[0].id
  const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS id')).rows[0].id
  return { waitingPid, blockerPid, wait: async () => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if ((await observer.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS yes', [waitingPid, blockerPid])).rows[0].yes) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Push race did not reach the competing installation lock')
  } }
}

describe('mobile push binding and existing notification sources', () => {
  it('registers without an enabled phone host and returns no token; idempotent registration preserves generation', async () => fixture(async f => {
    const first = await register(f)
    expect(await register(f)).toEqual(first)
    expect(Object.keys(first).sort()).toEqual(['generation', 'registration_id'])
    expect((await db.query('SELECT count(*) FROM identity.gugu_devices WHERE device_id=$1', [`phone-${f.install}-${f.owner}`])).rows[0].count).toBe('0')
  }))
  it('refuses wrong owner/install phone IDs, another login session, and malformed tokens', async () => fixture(async f => {
    await expect(register(f, { device: `phone-${randomUUID()}-${f.owner}` })).rejects.toMatchObject({ code: '22023' })
    await expect(register(f, { device: `phone-${f.install}-${f.other}` })).rejects.toMatchObject({ code: '22023' })
    await expect(register(f, { session: f.otherSession })).rejects.toMatchObject({ code: '42501' })
    await expect(register(f, { token: 'PRIVATE_TOKEN_CANARY' })).rejects.toThrow('Invalid mobile push binding')
  }))
  it.each([{ chatSound: false, taskSound: true }, { chatSound: true, taskSound: false }])(
    'keeps chat sound $chatSound and task sound $taskSound independent at dispatch', async sounds => fixture(async f => {
      await register(f, sounds)
      await send(f)
      await db.query("UPDATE identity.agent_runtime_states SET agent_status='needs_user',agent_status_detail='question' WHERE agent_user_id=$1", [f.agent])
      const attempts = await reserve(); expect(attempts).toHaveLength(2)
      const selected: Record<string, boolean> = {}
      for (const id of attempts) { const value = await prepare(id); selected[value.gugu.kind] = value.sound }
      expect(selected).toEqual({ chat_message: sounds.chatSound, task_attention: sounds.taskSound })
    }))
  it('rotates generation for either sound preference and preserves an identical pair', async () => fixture(async f => {
    const first = await register(f, { chatSound: false, taskSound: true })
    expect(await register(f, { chatSound: false, taskSound: true })).toEqual(first)
    const chatChanged = await register(f, { chatSound: true, taskSound: true })
    expect(chatChanged.generation).not.toBe(first.generation)
    const taskChanged = await register(f, { chatSound: true, taskSound: false })
    expect(taskChanged.generation).not.toBe(chatChanged.generation)
    expect(taskChanged.registration_id).toBe(first.registration_id)
  }))
  it('requires both sound values instead of defaulting an unavailable preference', async () => fixture(async f => {
    for (const sounds of [[null, true], [true, null]]) {
      await expect(rpc(db, 'authenticated', 'SELECT identity.mobile_push_register($1,$2,$3,$4,$5,true,true,$6,$7)',
        [f.install, `phone-${f.install}-${f.owner}`, 'ab'.repeat(32), 'production', 'app.gugu.chat', ...sounds],
        { sub: f.owner, session_id: f.session, role: 'authenticated' })).rejects.toMatchObject({ code: '22023' })
    }
  }))
  it('keeps token tables and service functions closed to API roles', async () => fixture(async f => {
    await register(f)
    await expect(rpc(db, 'authenticated', 'SELECT token FROM identity.mobile_push_registrations', [],
      { sub: f.owner, role: 'authenticated' })).rejects.toMatchObject({ code: '42501' })
    await expect(rpc(db, 'authenticated', "SELECT identity.mobile_push_reserve('production',20)", [],
      { sub: f.owner, role: 'authenticated' })).rejects.toMatchObject({ code: '42501' })
    await expect(rpc(db, 'anon', 'SELECT identity.mobile_push_revoke($1,$2,$3)', [f.install, randomUUID(), randomUUID()])).rejects.toMatchObject({ code: '42501' })
    await expect(rpc(db, 'anon', 'SELECT identity.mobile_push_close_installation($1,$2,$3)',
      [f.install, `phone-${f.install}-${f.owner}`, f.session])).rejects.toMatchObject({ code: '42501' })
    await expect(rpc(worker, 'gugu_push', 'SELECT token FROM identity.mobile_push_registrations', [])).rejects.toMatchObject({ code: '42501' })
  }))
  it('revokes only the exact current owner/install/session/generation', async () => fixture(async f => {
    const binding = await register(f)
    const revoke = (owner: string, session: string, generation: string) => rpc(db, 'authenticated',
      'SELECT identity.mobile_push_revoke($1,$2,$3) AS value', [f.install, binding.registration_id, generation],
      { sub: owner, session_id: session, role: 'authenticated' })
    expect((await revoke(f.other, f.otherSession, binding.generation))[0].value).toBe(false)
    expect((await revoke(f.owner, f.session, randomUUID()))[0].value).toBe(false)
    expect((await revoke(f.owner, f.session, binding.generation))[0].value).toBe(true)
    await send(f); expect(await reserve()).toEqual([])
  }))
  it('session revocation cascades tokens and refuses stale JWT re-registration', async () => fixture(async f => {
    await register(f)
    await db.query('DELETE FROM auth.sessions WHERE id=$1', [f.session])
    expect((await db.query('SELECT count(*) FROM identity.mobile_push_registrations WHERE owner_user_id=$1', [f.owner])).rows[0].count).toBe('0')
    await expect(register(f)).rejects.toMatchObject({ code: '42501' })
  }))
  it('account switch needs the existing token and a delayed old logout cannot revoke the new binding', async () => fixture(async f => {
    const old = await register(f)
    await expect(register(f, { owner: f.other, session: f.otherSession, token: 'cd'.repeat(32) })).rejects.toMatchObject({ code: '42501' })
    const next = await register(f, { owner: f.other, session: f.otherSession })
    expect(next.registration_id).not.toBe(old.registration_id)
    expect((await rpc(db, 'authenticated', 'SELECT identity.mobile_push_revoke($1,$2,$3) AS value',
      [f.install, old.registration_id, old.generation], { sub: f.owner, session_id: f.session, role: 'authenticated' }))[0].value).toBe(false)
    expect((await db.query('SELECT owner_user_id FROM identity.mobile_push_registrations WHERE id=$1', [next.registration_id])).rows[0].owner_user_id).toBe(f.other)
  }))
  it('rotation suppresses an old reservation and late invalid-token responses preserve the new generation', async () => fixture(async f => {
    const old = await register(f); await send(f)
    const [attempt] = await reserve()
    const next = await register(f, { token: 'cd'.repeat(40) })
    expect(next.generation).not.toBe(old.generation)
    expect(await prepare(attempt)).toBeNull()
    await rpc(worker, 'gugu_push', "SELECT identity.mobile_push_finish($1,'rejected',now())", [attempt])
    expect((await db.query('SELECT generation FROM identity.mobile_push_registrations WHERE id=$1', [next.registration_id])).rows[0].generation).toBe(next.generation)
  }))
  it('a confirmed invalid current generation is removed; an older APNs timestamp is retained', async () => fixture(async f => {
    await register(f); await send(f)
    let [attempt] = await reserve(); await prepare(attempt)
    await rpc(worker, 'gugu_push', "SELECT identity.mobile_push_finish($1,'rejected',now()-interval '1 day')", [attempt])
    expect((await db.query('SELECT count(*) FROM identity.mobile_push_registrations WHERE owner_user_id=$1', [f.owner])).rows[0].count).toBe('1')
    await send(f); [attempt] = await reserve(); await prepare(attempt)
    await rpc(worker, 'gugu_push', "SELECT identity.mobile_push_finish($1,'rejected',now())", [attempt])
    expect((await db.query('SELECT count(*) FROM identity.mobile_push_registrations WHERE owner_user_id=$1', [f.owner])).rows[0].count).toBe('0')
  }))
  it('uses unread incoming DM events once and emits identifiers without private content', async () => fixture(async f => {
    const binding = await register(f); const message = await send(f)
    const attempts = await reserve(); expect(attempts).toHaveLength(1)
    const value = await prepare(attempts[0])
    expect(value.gugu).toMatchObject({ ownerId: f.owner, installationId: f.install,
      registrationId: binding.registration_id, generation: binding.generation, messageId: message, kind: 'chat_message' })
    expect(JSON.stringify(value)).not.toContain('PRIVATE_MESSAGE_CANARY')
    await db.query("SELECT chat.publish_user_revision($1,'message_created',jsonb_build_object('entity_id',$2::text,'chat_id',$3::text))", [f.owner, message, f.chat])
    expect(await reserve()).toEqual([])
    expect((await rpc(worker, 'gugu_push', 'SELECT identity.mobile_push_admit($1) AS yes', [attempts[0]]))[0].yes).toBe(false)
  }))
  it('rechecks reads, membership and mutes immediately before dispatch', async () => fixture(async f => {
    await register(f); const message = await send(f); const [attempt] = await reserve()
    await db.query('UPDATE chat.chat_members SET last_read_seq=(SELECT seq FROM chat.messages WHERE id=$1) WHERE chat_id=$2 AND user_id=$3', [message, f.chat, f.owner])
    expect(await prepare(attempt)).toBeNull()
    await send(f); await db.query("UPDATE chat.chat_members SET notification_level='none' WHERE chat_id=$1 AND user_id=$2", [f.chat, f.owner])
    expect(await reserve()).toEqual([])
    await db.query("UPDATE chat.chat_members SET notification_level='all' WHERE chat_id=$1 AND user_id=$2", [f.chat, f.owner])
    await send(f); const [removed] = await reserve()
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [f.chat, f.owner])
    expect(await prepare(removed)).toBeNull()
  }))
  it('groups require address/reply and never leak another recipient\'s whisper', async () => fixture(async f => {
    await register(f)
    await send(f, { addressed: [] }); expect(await reserve()).toEqual([])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [f.chat, f.agent])
    const own = await send(f, { sender: f.owner, addressed: [] }); expect(await reserve()).toEqual([])
    // A reply to the owner would qualify publicly, but this valid third-party
    // whisper remains invisible to the owner and must never produce an alert.
    await send(f, { addressed: [f.agent], whisper: true, reply: own }); expect(await reserve()).toEqual([])
    await send(f, { addressed: ['*'] }); expect(await reserve()).toHaveLength(1)
    await send(f, { addressed: [], reply: own }); expect(await reserve()).toHaveLength(1)
  }, 'group'))
  it('task attention follows needs_user edges and ignores repeated readings, completion and errors', async () => fixture(async f => {
    await register(f)
    await db.query("UPDATE identity.agent_runtime_states SET agent_status='needs_user',agent_status_detail='question' WHERE agent_user_id=$1", [f.agent])
    const [question] = await reserve(); expect(question).toBeDefined()
    expect((await prepare(question)).gugu).toMatchObject({ kind: 'task_attention', agentId: f.agent })
    await db.query("UPDATE identity.agent_runtime_states SET window_title='PRIVATE_TASK_CANARY' WHERE agent_user_id=$1", [f.agent])
    expect(await reserve()).toEqual([])
    await db.query("UPDATE identity.agent_runtime_states SET agent_status='idle',agent_status_detail='done' WHERE agent_user_id=$1", [f.agent])
    await db.query("UPDATE identity.agent_runtime_states SET agent_status='error',agent_status_detail=NULL WHERE agent_user_id=$1", [f.agent])
    expect(await reserve()).toEqual([])
  }))
  it('concurrent workers reserve one event and only one admission succeeds', async () => fixture(async f => {
    await register(f); await send(f)
    const other = new pg.Client({ connectionString: workerUrl }); await other.connect()
    try {
      const reservations = (await Promise.all([reserve(worker), reserve(other)])).flat()
      expect(reservations).toHaveLength(1)
      const admissions = await Promise.all([worker, other].map(client => rpc(client, 'gugu_push',
        'SELECT identity.mobile_push_admit($1) AS yes', [reservations[0]])))
      expect(admissions.flat().filter(x => x.yes)).toHaveLength(1)
    } finally { await other.end() }
  }))
  it('rotates registrations when an earlier endpoint continuously fills the batch', async () => fixture(async f => {
    await register(f)
    await register(f, { install: randomUUID(), token: 'cd'.repeat(32) })
    for (let i = 0; i < 25; i++) await send(f)
    const first = await reserve(); expect(first).toHaveLength(20)
    const registrationsFor = async (ids: string[]) => (await db.query(
      'SELECT DISTINCT registration_id FROM identity.mobile_push_attempts WHERE id=ANY($1::uuid[])', [ids])).rows.map(r => r.registration_id)
    const firstRegistration = await registrationsFor(first)
    expect(firstRegistration).toHaveLength(1)
    // Keep the first endpoint busy enough to consume another entire batch.
    for (let i = 0; i < 20; i++) await send(f)
    const second = await reserve(); expect(second).toHaveLength(20)
    const secondRegistration = await registrationsFor(second)
    expect(secondRegistration).toHaveLength(1)
    expect(secondRegistration[0]).not.toBe(firstRegistration[0])
  }))
  it('closes a cold-start installation without a retained token receipt and returns stable scoped evidence', async () => fixture(async f => {
    await register(f) // Simulate losing the RAM receipt before OS permission is denied.
    const proof = await closeScope(f)
    expect(proof).toMatchObject({ v: 1, closed: true, evidence: 'installation_fenced', owner_id: f.owner,
      session_id: f.session, installation_id: f.install, device_id: `phone-${f.install}-${f.owner}` })
    expect(proof.fence_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await closeScope(f)).toEqual(proof)
    expect((await db.query('SELECT count(*) FROM identity.mobile_push_registrations WHERE owner_user_id=$1', [f.owner])).rows[0].count).toBe('0')
    await expect(register(f)).rejects.toThrow('Push installation is closed for this login session')
  }))
  it('persists a fence even when register has not arrived yet', async () => fixture(async f => {
    expect((await closeScope(f)).evidence).toBe('installation_fenced')
    await expect(register(f)).rejects.toMatchObject({ code: '42501' })
    await expect(rpc(db, 'authenticated', 'SELECT * FROM identity.mobile_push_closures', [],
      { sub: f.owner, session_id: f.session, role: 'authenticated' })).rejects.toMatchObject({ code: '42501' })
  }))
  it('reports physical session absence, without inventing a never-registered claim or a fence ID', async () => fixture(async f => {
    await register(f); await db.query('DELETE FROM auth.sessions WHERE id=$1', [f.session])
    expect(await closeScope(f)).toMatchObject({ closed: true, evidence: 'session_absent', fence_id: null,
      owner_id: f.owner, session_id: f.session, installation_id: f.install })
    await expect(register(f)).rejects.toMatchObject({ code: '42501' })
  }))
  it('does not label a merely expired session as physically absent', async () => fixture(async f => {
    await register(f)
    await db.query("UPDATE auth.sessions SET not_after=now()-interval '1 second' WHERE id=$1", [f.session])
    expect((await closeScope(f)).evidence).toBe('installation_fenced')
    expect((await db.query('SELECT count(*) FROM auth.sessions WHERE id=$1', [f.session])).rows[0].count).toBe('1')
  }))
  it('closing one installation leaves another installation of the same owner/session usable', async () => fixture(async f => {
    await register(f)
    const install = randomUUID()
    const other = await register(f, { install, token: 'ef'.repeat(32) })
    await closeScope(f)
    expect(await register(f, { install, token: 'ef'.repeat(32) })).toEqual(other)
    expect((await db.query('SELECT count(*) FROM identity.mobile_push_registrations WHERE id=$1', [other.registration_id])).rows[0].count).toBe('1')
  }))
  it('an old close cannot delete a newer session registration or use the newer ticket to close the old session', async () => fixture(async f => {
    await register(f); await closeScope(f)
    const nextSession = randomUUID()
    await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [nextSession, f.owner])
    const next = await register(f, { session: nextSession })
    await closeScope(f)
    expect((await db.query('SELECT session_id FROM identity.mobile_push_registrations WHERE id=$1', [next.registration_id])).rows[0].session_id).toBe(nextSession)
    await expect(closeScope(f, { ticketSession: nextSession })).rejects.toMatchObject({ code: '42501' })
  }))
  it('an old owner close cannot delete a new owner registration on the same native installation', async () => fixture(async f => {
    await register(f); await closeScope(f)
    const next = await register(f, { owner: f.other, session: f.otherSession, token: 'ef'.repeat(32) })
    await closeScope(f)
    expect((await db.query('SELECT owner_user_id FROM identity.mobile_push_registrations WHERE id=$1', [next.registration_id])).rows[0].owner_user_id).toBe(f.other)
    await expect(closeScope(f, { caller: f.other, ticketSession: f.otherSession })).rejects.toMatchObject({ code: '42501' })
    await expect(closeScope(f, { device: `phone-${randomUUID()}-${f.owner}` })).rejects.toMatchObject({ code: '22023' })
  }))
  it('a committed close rejects a register already waiting on its installation lock', async () => fixture(async f => {
    const late = new pg.Client({ connectionString: url }); const observer = new pg.Client({ connectionString: url })
    await late.connect(); await observer.connect()
    try {
      const gate = await waitBlocked(observer, late, db)
      await db.query('BEGIN'); await db.query('SET LOCAL ROLE authenticated')
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.owner, session_id: f.session, role: 'authenticated' })])
      await db.query('SELECT identity.mobile_push_close_installation($1,$2,$3)', [f.install, `phone-${f.install}-${f.owner}`, f.session])
      const result = rpc(late, 'authenticated', 'SELECT identity.mobile_push_register($1,$2,$3,$4,$5,true,true,true,true)',
        [f.install, `phone-${f.install}-${f.owner}`, 'ab'.repeat(32), 'production', 'app.gugu.chat'],
        { sub: f.owner, session_id: f.session, role: 'authenticated' }).then(() => 'accepted', error => error.code)
      await gate.wait(); await db.query('COMMIT')
      expect(await result).toBe('42501')
    } finally { await db.query('ROLLBACK'); await late.end(); await observer.end() }
  }))
  it('a close waiting behind an admitted register removes that committed registration', async () => fixture(async f => {
    const late = new pg.Client({ connectionString: url }); const observer = new pg.Client({ connectionString: url })
    await late.connect(); await observer.connect()
    try {
      const gate = await waitBlocked(observer, late, db)
      await db.query('BEGIN'); await db.query('SET LOCAL ROLE authenticated')
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.owner, session_id: f.session, role: 'authenticated' })])
      await db.query('SELECT identity.mobile_push_register($1,$2,$3,$4,$5,true,true,true,true)',
        [f.install, `phone-${f.install}-${f.owner}`, 'ab'.repeat(32), 'production', 'app.gugu.chat'])
      const result = rpc(late, 'authenticated', 'SELECT identity.mobile_push_close_installation($1,$2,$3) AS value',
        [f.install, `phone-${f.install}-${f.owner}`, f.session], { sub: f.owner, session_id: f.session, role: 'authenticated' })
      await gate.wait(); await db.query('COMMIT')
      expect((await result)[0].value.evidence).toBe('installation_fenced')
      expect((await db.query('SELECT count(*) FROM identity.mobile_push_registrations WHERE owner_user_id=$1', [f.owner])).rows[0].count).toBe('0')
    } finally { await db.query('ROLLBACK'); await late.end(); await observer.end() }
  }))
})
