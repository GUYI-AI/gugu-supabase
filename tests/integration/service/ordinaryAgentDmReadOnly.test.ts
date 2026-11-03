import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let db: pg.Client
let owner: string, friend: string, agent: string, device: string, dm: string, humanDm: string, group: string, historical: string
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Requires a disposable loopback database')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, friend, agent, device, dm, humanDm, group, historical] = Array.from({ length: 8 }, randomUUID)
  for (const id of [owner, friend]) await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@legacy-dm.invalid`])
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Fixture','fixture','linux')", [device, owner])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Ordinary fixture',$2,$3)", [agent, owner, device])
  for (const [chat, kind] of [[dm, 'dm'], [humanDm, 'dm'], [group, 'group']]) {
    await db.query('INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,$2,$3,$4)', [chat, kind, 'Legacy fixture', owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [chat, owner])
  }
  // Existing history predates the complete owner/agent pair; no guard is disabled for this fixture.
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,created_at) VALUES($1,$2,$3,'Existing history','2026-10-01T01:02:03Z')", [historical, dm, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($3,$4,'member'),($5,$2,'member'),($5,$4,'member')", [dm, agent, humanDm, friend, group])
})
afterEach(async () => { await db.query('ROLLBACK') })

async function as<T>(user: string, action: () => Promise<T>) {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  await db.query('SET LOCAL ROLE authenticated')
  try { return await action() } finally { await db.query('RESET ROLE').catch(() => undefined) }
}
async function denied(action: () => Promise<unknown>) {
  await db.query('SAVEPOINT denied')
  try {
    await expect(action()).rejects.toMatchObject({ code: '42501', hint: 'ordinary_agent_dm_read_only' })
  } finally { await db.query('ROLLBACK TO SAVEPOINT denied') }
}
const insert = (chat: string, sender = owner) => db.query('INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,$4)', [randomUUID(), chat, sender, 'New notification'])
const send = (chat: string, sender = owner) => db.query(`SELECT id FROM chat.send_message_idempotent($1,$2,$3,NULL,'New notification','text',NULL,NULL,false,false)`, [randomUUID(), chat, sender])

it('blocks both senders, direct inserts, definer sends and service-role inserts', async () => {
  await denied(() => as(owner, () => insert(dm)))
  await denied(() => as(owner, () => insert(dm, agent)))
  await denied(() => as(owner, () => send(dm)))
  await denied(async () => { await db.query('SET LOCAL ROLE service_role'); return insert(dm, agent) })
  expect((await db.query('SELECT count(*)::int AS n FROM chat.messages WHERE chat_id=$1', [dm])).rows[0].n).toBe(1)
})

it('keeps human DMs and groups writable', async () => {
  await as(owner, () => send(humanDm))
  await as(owner, () => send(group, agent))
  expect((await db.query('SELECT count(*)::int AS n FROM chat.messages WHERE chat_id=ANY($1)', [[humanDm, group]])).rows[0].n).toBe(2)
})

it('uses the personal-assistant provision marker independently of its display name', async () => {
  const operation = randomUUID()
  await db.query("INSERT INTO identity.agent_provision_operations(id,owner_user_id,device_id,kind,payload_hash,blueprint,phase) VALUES($1,$2,$3,'single','fixture','{}','completed')", [operation, owner, device])
  await db.query(`INSERT INTO identity.agent_provisions(id,owner_user_id,operation_id,member_key,device_id,display_name,agent_type,inherit_memory,history_import_required,payload_hash,agent_user_id,provisioned_agent_user_id,dm_chat_id,phase)
    VALUES($1,$2,$3,'assistant',$4,'Renamable assistant','claude-code',false,false,'fixture',$5::text,$5::uuid,$6,'completed')`, [randomUUID(), owner, operation, device, agent, dm])
  await as(owner, () => send(dm))
  await as(owner, () => insert(dm, agent))
  await db.query("UPDATE identity.agent_provisions SET member_key='ordinary' WHERE operation_id=$1", [operation])
  await denied(() => as(owner, () => insert(dm, agent)))
})

it('retains the original message, membership and active chat for permission-checked historical reads', async () => {
  const result = await as(owner, () => db.query('SELECT id,content,created_at FROM chat.messages_view WHERE chat_id=$1', [dm]))
  expect(result.rows).toEqual([expect.objectContaining({ id: historical, content: 'Existing history', created_at: new Date('2026-10-01T01:02:03Z') })])
  expect((await db.query('SELECT status FROM chat.chats WHERE id=$1', [dm])).rows[0].status).toBe('active')
  expect((await db.query('SELECT count(*)::int AS n FROM chat.chat_members WHERE chat_id=$1', [dm])).rows[0].n).toBe(2)
  expect((await as(friend, () => db.query('SELECT id FROM chat.messages_view WHERE chat_id=$1', [dm]))).rows).toEqual([])
})

it('cannot bypass admission by moving a message from a writable group', async () => {
  const id = randomUUID()
  await db.query('INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,$4)', [id, group, owner, 'Group message'])
  await denied(() => db.query('UPDATE chat.messages SET chat_id=$1 WHERE id=$2', [dm, id]))
  expect((await db.query('SELECT chat_id FROM chat.messages WHERE id=$1', [id])).rows[0].chat_id).toBe(group)
})

it('does not grant API execution of the internal trigger function', async () => {
  const fn = 'chat.reject_ordinary_agent_dm_message()'
  for (const role of ['anon', 'authenticated', 'service_role']) {
    expect((await db.query('SELECT has_function_privilege($1,$2,$3) AS allowed', [role, fn, 'EXECUTE'])).rows[0].allowed).toBe(false)
  }
})
