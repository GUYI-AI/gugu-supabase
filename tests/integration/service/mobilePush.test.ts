import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let db: pg.Client
type Fixture = { owner: string; other: string; session: string; otherSession: string; install: string; chat: string; agent: string }
beforeAll(async () => {
  const target = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
    throw new Error('Mobile push contracts require an installed disposable loopback backend')
  }
  db = new pg.Client({ connectionString: url }); await db.connect()
  await db.query("SET statement_timeout='10s'")
})
afterAll(async () => { await db?.end() })

async function fixture(body: (f: Fixture) => Promise<void>, kind = 'dm') {
  const f: Fixture = { owner: randomUUID(), other: randomUUID(), session: randomUUID(),
    otherSession: randomUUID(), install: randomUUID(), chat: randomUUID(), agent: randomUUID() }
  try {
    for (const [owner, session] of [[f.owner, f.session], [f.other, f.otherSession]]) {
      await db.query(`INSERT INTO auth.users(id,email) VALUES($1,$2)`, [owner, owner + '@push.invalid'])
      await db.query(`INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Push fixture') ON CONFLICT DO NOTHING`, [owner])
      await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())', [session, owner])
    }
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id) VALUES($1,'agent','Push fixture agent',$2)", [f.agent, f.owner])
    await db.query("INSERT INTO identity.agent_runtime_states(agent_user_id,owner_user_id,agent_status,agent_status_detail,runtime_status,last_seen_at) VALUES($1,$2,'idle','plain','online',now())", [f.agent, f.owner])
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,$2,'Push fixture',$3)", [f.chat, kind, f.owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [f.chat, f.owner, f.other])
    await body(f)
  } finally {
    await db.query('ROLLBACK'); await db.query('RESET ROLE')
    await db.query('DELETE FROM chat.chats WHERE id=$1', [f.chat])
    await db.query('DELETE FROM identity.agent_runtime_states WHERE agent_user_id=$1', [f.agent])
    await db.query('DELETE FROM identity.users WHERE id=$1', [f.agent])
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
async function register(f: Fixture, overrides: { owner?: string; session?: string; device?: string; token?: string; install?: string } = {}) {
  const owner = overrides.owner ?? f.owner; const install = overrides.install ?? f.install
  return (await rpc(db, 'authenticated', 'SELECT identity.mobile_push_register($1,$2,$3,$4,$5,true,true,true) AS value',
    [install, overrides.device ?? `phone-${install}-${owner}`, overrides.token ?? 'ab'.repeat(32), 'production', 'app.gugu.chat'],
    { sub: owner, session_id: overrides.session ?? f.session, role: 'authenticated' }))[0].value as { registration_id: string; generation: string }
}
async function reserve(client = db) {
  return (await rpc(client, 'gugu_push', "SELECT identity.mobile_push_reserve('production',20) AS id", [])).map(r => r.id as string)
}
async function prepare(id: string) {
  expect((await rpc(db, 'gugu_push', 'SELECT identity.mobile_push_admit($1) AS yes', [id]))[0].yes).toBe(true)
  return (await rpc(db, 'gugu_push', 'SELECT identity.mobile_push_prepare($1) AS value', [id]))[0].value
}
async function send(f: Fixture, options: { sender?: string; addressed?: string[]; whisper?: boolean; reply?: string } = {}) {
  const id = randomUUID()
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,to_user_ids,is_whisper,reply_to_message_id)
    VALUES($1,$2,$3,'PRIVATE_MESSAGE_CANARY',$4,$5,$6)`, [id, f.chat, options.sender ?? f.other,
    options.addressed ?? [f.owner], options.whisper ?? false, options.reply ?? null])
  return id
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
  it('keeps token tables and service functions closed to API roles', async () => fixture(async f => {
    await register(f)
    await expect(rpc(db, 'authenticated', 'SELECT token FROM identity.mobile_push_registrations', [],
      { sub: f.owner, role: 'authenticated' })).rejects.toMatchObject({ code: '42501' })
    await expect(rpc(db, 'authenticated', "SELECT identity.mobile_push_reserve('production',20)", [],
      { sub: f.owner, role: 'authenticated' })).rejects.toMatchObject({ code: '42501' })
    await expect(rpc(db, 'anon', 'SELECT identity.mobile_push_revoke($1,$2,$3)', [f.install, randomUUID(), randomUUID()])).rejects.toMatchObject({ code: '42501' })
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
    await rpc(db, 'gugu_push', "SELECT identity.mobile_push_finish($1,'rejected',now())", [attempt])
    expect((await db.query('SELECT generation FROM identity.mobile_push_registrations WHERE id=$1', [next.registration_id])).rows[0].generation).toBe(next.generation)
  }))
  it('a confirmed invalid current generation is removed; an older APNs timestamp is retained', async () => fixture(async f => {
    await register(f); await send(f)
    let [attempt] = await reserve(); await prepare(attempt)
    await rpc(db, 'gugu_push', "SELECT identity.mobile_push_finish($1,'rejected',now()-interval '1 day')", [attempt])
    expect((await db.query('SELECT count(*) FROM identity.mobile_push_registrations WHERE owner_user_id=$1', [f.owner])).rows[0].count).toBe('1')
    await send(f); [attempt] = await reserve(); await prepare(attempt)
    await rpc(db, 'gugu_push', "SELECT identity.mobile_push_finish($1,'rejected',now())", [attempt])
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
    expect((await rpc(db, 'gugu_push', 'SELECT identity.mobile_push_admit($1) AS yes', [attempts[0]]))[0].yes).toBe(false)
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
    await send(f, { addressed: [f.other], whisper: true }); expect(await reserve()).toEqual([])
    await send(f, { addressed: ['*'] }); expect(await reserve()).toHaveLength(1)
    const own = await send(f, { sender: f.owner, addressed: [] }); expect(await reserve()).toEqual([])
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
    const other = new pg.Client({ connectionString: url }); await other.connect()
    try {
      const reservations = (await Promise.all([reserve(db), reserve(other)])).flat()
      expect(reservations).toHaveLength(1)
      const admissions = await Promise.all([db, other].map(client => rpc(client, 'gugu_push',
        'SELECT identity.mobile_push_admit($1) AS yes', [reservations[0]])))
      expect(admissions.flat().filter(x => x.yes)).toHaveLength(1)
    } finally { await other.end() }
  }))
})
