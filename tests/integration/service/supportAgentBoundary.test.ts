import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const { Client } = createRequire(import.meta.url)('pg')
let db: InstanceType<typeof Client>
let owner: string, peer: string, agent: string, group: string, other: string
let configuration: string, runtime: string, publicMessage: string
let grant: { token: string; grant_id: string; status: number }
let initialRoleMemberships: unknown[]

async function fixtureRoleMemberships() {
  return (await db.query(`SELECT r.rolname,m.admin_option,m.inherit_option,m.set_option,m.grantor
    FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid
    WHERE m.member='postgres'::regrole AND r.rolname IN ('gugu_support_data','gugu_support_control')
    ORDER BY r.rolname,m.grantor`)).rows
}

async function call(role: string, sql: string, parameters: unknown[] = []) {
  await db.query('SAVEPOINT scoped_call')
  try {
    // Test-only role names, never derived from customer input.
    await db.query(`SET LOCAL ROLE ${role}`)
    const result = await db.query(sql, parameters)
    await db.query('RESET ROLE')
    await db.query('RELEASE SAVEPOINT scoped_call')
    return result.rows
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT scoped_call')
    throw error
  }
}
async function data(action = 'history', body: object = { chat_id: group }, token = grant.token) {
  return (await call('gugu_support_data', 'SELECT support_agent.request($1,$2,$3::jsonb) AS result',
    [token, action, JSON.stringify(body)]))[0].result
}
async function issue(caller = owner) {
  const version = (await db.query('SELECT version FROM support_help.configuration WHERE id=$1', [configuration])).rows[0].version
  return (await call('gugu_support_control', 'SELECT support_agent.manage($1,$2,$3::jsonb) AS result',
    [caller, 'issue', JSON.stringify({ configuration_id: configuration, agent_id: agent, runtime_id: runtime, config_version: version })]))[0].result
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Support boundary tests require a disposable loopback PostgreSQL database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
  expect((await db.query('SELECT current_user AS role')).rows[0].role).toBe('postgres')
  initialRoleMemberships = await fixtureRoleMemberships()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  // Supabase's postgres fixture is not a superuser. Its role-creator ADMIN
  // membership does not permit SET ROLE on PG17. These test-only SET grants
  // are rolled back with the synthetic records; production roles stay closed.
  await db.query('GRANT gugu_support_data,gugu_support_control TO postgres WITH INHERIT FALSE')
  await db.query('GRANT gugu_support_data,gugu_support_control TO postgres WITH SET TRUE')
  owner = randomUUID(); peer = randomUUID(); agent = randomUUID(); group = randomUUID(); other = randomUUID(); runtime = randomUUID()
  for (const id of [owner, peer]) {
    await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@support-fixture.invalid`])
    await db.query(`INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','Support fixture') ON CONFLICT(id) DO NOTHING`, [id])
  }
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'Support fixture isolated device','fixture','linux')`, [runtime, owner])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id)
    VALUES ($1,'agent','Support fixture Agent',$2,$3)`, [agent, owner, runtime])
  for (const id of [group, other]) {
    await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','Support fixture',$2)`, [id, owner])
    for (const [index, user] of [owner, peer, agent].entries()) {
      await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,$3)`, [id, user, index ? 'member' : 'owner'])
    }
  }
  configuration = (await db.query(`INSERT INTO support_help.configuration(id,singleton,help_group_id,duty_human_user_id,assistant_agent_ids,version)
    VALUES ($1,true,$2,$3,$4,1) ON CONFLICT(singleton) DO UPDATE SET help_group_id=$2,duty_human_user_id=$3,
      assistant_agent_ids=$4,version=support_help.configuration.version+1 RETURNING id`, [randomUUID(), group, owner, [agent]])).rows[0].id
  await db.query(`INSERT INTO support_agent.controllers(user_id,configuration_id) VALUES ($1,$2)`, [owner, configuration])
  await db.query(`INSERT INTO support_agent.agents(agent_id,configuration_id,runtime_id,device_id,approved_until,attestation_reference)
    VALUES ($1,$2,$3,$4,now()+interval '1 hour','synthetic-fixture-only')`, [agent, configuration, runtime, runtime])
  publicMessage = randomUUID()
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'PUBLIC FIXTURE')`, [publicMessage, group, peer])
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,is_whisper,to_user_ids)
    VALUES ($1,$2,$3,'PRIVATE WHISPER FIXTURE',true,$4)`, [randomUUID(), group, peer, [owner]])
  grant = await issue()
  expect(grant.status).toBe(200)
})
afterEach(async () => {
  if (!db) return
  try { await db.query('RESET ROLE'); await db.query('SET CONSTRAINTS ALL IMMEDIATE') }
  finally {
    await db.query('ROLLBACK')
    expect(await fixtureRoleMemberships()).toEqual(initialRoleMemberships)
  }
})

describe('live support SQL boundary', () => {
  it('returns only whitelisted public text and sends a marked Agent reply', async () => {
    const page = await data()
    expect(page.status).toBe(200)
    expect(page.data.map((row: { id: string }) => row.id)).toContain(publicMessage)
    expect(JSON.stringify(page.data)).not.toContain('PRIVATE WHISPER FIXTURE')
    expect(Object.keys(page.data[0]).sort()).toEqual(['content','created_at','id','sender_user_id','seq'])
    const id = randomUUID()
    expect((await data('reply', { chat_id: group, message_id: id, reply_to_message_id: publicMessage, content: 'Approved help' })).status).toBe(200)
    const sent = (await db.query('SELECT sender_user_id,content,is_whisper FROM chat.messages WHERE id=$1', [id])).rows[0]
    expect(sent).toEqual({ sender_user_id: agent, content: '[Support Agent] Approved help', is_whisper: false })
  })
  it('denies another group even though the same Agent is a member', async () => {
    expect((await data('history', { chat_id: other })).status).toBe(403)
    expect((await data('reply', { chat_id: other, message_id: randomUUID(), reply_to_message_id: publicMessage, content: 'denied' })).status).toBe(403)
  })
  it('denies a guessed token, owner token, expired grant and explicit revocation', async () => {
    expect((await data('history', { chat_id: group }, 'owner.jwt.token')).status).toBe(401)
    expect((await data('history', { chat_id: group }, grant.token.slice(0, -1) + (grant.token.endsWith('0') ? '1' : '0'))).status).toBe(401)
    await db.query(`UPDATE support_agent.grants SET expires_at=now()-interval '1 second' WHERE id=$1`, [grant.grant_id])
    expect((await data()).status).toBe(401)
    grant = await issue()
    expect((await call('gugu_support_control', 'SELECT support_agent.manage($1,$2,$3::jsonb) AS result',
      [owner, 'revoke', JSON.stringify({ configuration_id: configuration, grant_id: grant.grant_id })]))[0].result.status).toBe(200)
    expect((await data('events')).status).toBe(401)
    expect((await data('reply', { chat_id: group, message_id: randomUUID(), reply_to_message_id: publicMessage, content: 'stale' })).status).toBe(401)
  })
  it('invalidates a credential after membership removal even if the member rejoins', async () => {
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [group, agent])
    await db.query(`INSERT INTO chat.chat_members(chat_id,user_id) VALUES ($1,$2)`, [group, agent])
    expect((await data()).status).toBe(401)
  })
  it('revokes existing grants when an independent controller is soft-deleted', async () => {
    const controller = randomUUID()
    await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [controller, `${controller}@support-fixture.invalid`])
    await db.query(`INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','Independent controller') ON CONFLICT(id) DO NOTHING`, [controller])
    await db.query('INSERT INTO support_agent.controllers(user_id,configuration_id) VALUES ($1,$2)', [controller, configuration])
    grant = await issue(controller)
    expect(grant.status).toBe(200)
    expect((await data()).status).toBe(200)
    await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1', [controller])
    expect((await data()).status).toBe(401)
    expect((await issue(controller)).status).toBe(403)
  })
  it('denies an archived Agent in reads, replies, qualification and issuance', async () => {
    await db.query('UPDATE identity.users SET session_archived_at=now() WHERE id=$1', [agent])
    expect((await data()).status).toBe(401)
    expect((await data('reply', { chat_id: group, message_id: randomUUID(), reply_to_message_id: publicMessage, content: 'stale' })).status).toBe(401)
    const version = (await db.query('SELECT version FROM support_help.configuration WHERE id=$1', [configuration])).rows[0].version
    expect((await db.query('SELECT support_help.agent_isolation_verified($1,$2,$3) AS allowed', [agent, configuration, version])).rows[0].allowed).toBe(false)
    expect((await issue()).status).toBe(403)
  })
  it.each(['archived', 'removed', 'banned', 'auth_deleted'])(
    'uses the same active-human rule for the duty identity and controller: %s', async state => {
      if (state === 'archived') await db.query('UPDATE identity.users SET session_archived_at=now() WHERE id=$1', [owner])
      if (state === 'removed') await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1', [owner])
      if (state === 'banned') await db.query("UPDATE auth.users SET banned_until=now()+interval '1 hour' WHERE id=$1", [owner])
      if (state === 'auth_deleted') await db.query('UPDATE auth.users SET deleted_at=now() WHERE id=$1', [owner])
      expect((await data()).status).toBe(401)
      expect((await issue()).status).toBe(403)
    },
  )
  it('keeps host qualification across version increments but retires old grants', async () => {
    const old = (await db.query('SELECT version FROM support_help.configuration WHERE id=$1', [configuration])).rows[0].version
    expect((await db.query('SELECT support_help.agent_isolation_verified($1,$2,$3) AS yes', [agent, configuration, BigInt(old) + 1n])).rows[0].yes).toBe(true)
    await db.query('UPDATE support_help.configuration SET version=version+1 WHERE id=$1', [configuration])
    await db.query('SELECT support_help.configuration_version_changed($1,$2,$3)', [configuration, old, BigInt(old) + 1n])
    expect((await data()).status).toBe(401)
    grant = await issue()
    expect(grant.status).toBe(200)
  })
  it('exposes no tables, owner files, arbitrary RPC or management to the data role', async () => {
    for (const sql of ['SELECT * FROM support_agent.grants', 'SELECT * FROM chat.messages', 'SELECT * FROM identity.users',
      "SELECT pg_read_file('/owner/private')", "SELECT support_agent.manage('forged','issue','{}')"]) {
      await expect(call('gugu_support_data', sql)).rejects.toMatchObject({ code: '42501' })
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await expect(call(role, 'SELECT support_agent.request($1,$2,$3)', [grant.token, 'history', '{}'])).rejects.toMatchObject({ code: '42501' })
    }
    const functions = (await db.query(`SELECT p.proname,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='support_agent' AND p.proname IN ('request','manage')`)).rows
    expect(functions).toHaveLength(2)
    expect(functions.every((row: { prosecdef: boolean; proconfig: string[] }) => row.prosecdef && row.proconfig.includes('search_path=""'))).toBe(true)
  })
  it('stores hashes and content-free audit only', async () => {
    await data()
    const stored = (await db.query('SELECT encode(token_hash,\'hex\') AS hash FROM support_agent.grants WHERE id=$1', [grant.grant_id])).rows[0]
    expect(stored.hash).toHaveLength(64)
    expect(stored.hash).not.toBe(grant.token)
    const audit = JSON.stringify((await db.query('SELECT grant_id,agent_id,action,result,occurred_at FROM support_agent.audit WHERE grant_id=$1', [grant.grant_id])).rows)
    expect(audit).not.toContain(grant.token)
    expect(audit).not.toContain('PUBLIC FIXTURE')
    expect(audit).not.toContain('PRIVATE WHISPER FIXTURE')
  })
})
