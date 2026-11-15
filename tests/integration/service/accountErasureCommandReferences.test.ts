import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let db: pg.Client
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
beforeEach(async () => { await db.query('BEGIN') })
afterEach(async () => { await db.query('ROLLBACK') })
afterAll(async () => { await db?.end() })

it('indexes exactly the original JSON-reference predicate, including legacy recipient values', async () => {
  const targets = ['human', 'agent', '5', 'true', '{"legacy": "id"}']
  const payloads = [null, {}, [], 'scalar', { agent_user_id: 'agent' }, { sender_user_id: 'human' },
    { reply_to_sender_user_id: 'human' }, { reply_to_sender_name: 'human' }, { to_user_ids: ['human', 'peer', '*'] },
    { to_user_ids: [5, true, null, { legacy: 'id' }] }, { to_user_ids: { human: true } }, { to_user_ids: 'human' },
    { agent_user_id: 'peer', sender_user_id: 'human', reply_to_sender_user_id: 'peer', to_user_ids: [] }]
  const cases = ['agent.deliver', 'agent.wake', 'agent.create', 'agent.stop', 'agent.runtime-info', null]
    .flatMap(type => payloads.map(payload => ({ type, payload, targets })))
  const { rows } = await db.query(`WITH cases AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS c(type text,payload jsonb,targets text[])
  ) SELECT (identity.command_erasure_references_v1(type,payload) && targets) IS TRUE AS indexed,
    (payload->>'agent_user_id'=ANY(targets)
     OR (type IN ('agent.deliver','agent.wake') AND payload->>'sender_user_id'=ANY(targets))
     OR payload->>'reply_to_sender_user_id'=ANY(targets)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(payload->'to_user_ids')='array'
           THEN payload->'to_user_ids' ELSE '[]'::jsonb END) recipient(value) WHERE recipient.value=ANY(targets))) IS TRUE AS original
    FROM cases`, [JSON.stringify(cases)])
  expect(rows).toHaveLength(cases.length)
  for (const row of rows) expect(row.indexed).toBe(row.original)
  expect((await db.query(`SELECT identity.command_erasure_references_v1('agent.stop','{"to_user_ids":[5.0]}'::jsonb) refs`)).rows[0].refs).toContain('5.0')
})

it('has a ready expression index, pure helper permissions and closed erasure permissions', async () => {
  const index = (await db.query(`SELECT i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) definition
    FROM pg_index i WHERE i.indexrelid='identity.gugu_device_commands_erasure_refs_idx'::regclass`)).rows[0]
  expect(index.indisvalid && index.indisready).toBe(true)
  expect(index.definition).toContain('command_erasure_references_v1(type, payload)')
  const fn = (await db.query(`SELECT provolatile,proparallel,prosecdef FROM pg_proc
    WHERE oid='identity.command_erasure_references_v1(text,jsonb)'::regprocedure`)).rows[0]
  expect(fn).toMatchObject({ provolatile: 'i', proparallel: 's', prosecdef: false })
  for (const role of ['authenticated', 'service_role']) expect((await db.query(`SELECT has_function_privilege($1,
    'identity.command_erasure_references_v1(text,jsonb)','EXECUTE') allowed`, [role])).rows[0].allowed).toBe(true)
  const writers = (await db.query(`SELECT rolname,has_function_privilege(rolname,
    'identity.command_erasure_references_v1(text,jsonb)','EXECUTE') allowed FROM pg_roles
    WHERE has_table_privilege(rolname,'identity.gugu_device_commands','INSERT')
       OR has_table_privilege(rolname,'identity.gugu_device_commands','UPDATE')`)).rows
  expect(writers.length).toBeGreaterThan(0)
  for (const writer of writers) expect(writer.allowed, writer.rolname).toBe(true)
  for (const role of ['anon', 'authenticated', 'service_role']) expect((await db.query(`SELECT has_function_privilege($1,
    'identity.erase_human_account(text)','EXECUTE') allowed`, [role])).rows[0].allowed).toBe(false)
})

it('hard deletion removes owned and sender commands while preserving anonymous replies, recipients and unrelated commands', async () => {
  const owner = randomUUID(), peer = randomUUID(), ownAgent = randomUUID(), peerAgent = randomUUID()
  const ownDevice = 'erasure-' + randomUUID(), peerDevice = 'erasure-' + randomUUID()
  for (const id of [owner, peer]) await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at)
    VALUES($1,'authenticated','authenticated',$2,now())`, [id, `${id}@command-erasure.invalid`])
  for (const [id, user] of [[ownDevice, owner], [peerDevice, peer]]) await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,status)
    VALUES($1,$2,'Erasure fixture','erasure-fixture','linux','offline')`, [id, user])
  for (const [id, user, device] of [[ownAgent, owner, ownDevice], [peerAgent, peer, peerDevice]]) await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,desired_status)
    VALUES($1,'agent','Erasure fixture',$2,$3,'offline')`, [id, user, device])
  async function command(user: string, device: string, payload: unknown) {
    const id = randomUUID()
    await db.query(`INSERT INTO identity.gugu_device_commands(id,user_id,device_id,type,payload,status)
      VALUES($1,$2,$3,'agent.deliver',$4::jsonb,'done')`, [id, user, device, JSON.stringify(payload)])
    return id
  }
  const owned = await command(owner, ownDevice, { agent_user_id: ownAgent })
  const sender = await command(peer, peerDevice, { agent_user_id: peerAgent, sender_user_id: ownAgent })
  const reply = await command(peer, peerDevice, { agent_user_id: peerAgent, sender_user_id: peer, reply_to_sender_user_id: owner })
  const recipient = await command(peer, peerDevice, { agent_user_id: peerAgent, to_user_ids: ['*', owner, peer, 5, ownAgent] })
  const both = await command(peer, peerDevice, { agent_user_id: peerAgent, reply_to_sender_user_id: ownAgent, to_user_ids: [owner, peer] })
  const untouched = { agent_user_id: peerAgent, sender_user_id: peer, to_user_ids: [peer], other: { keep: true } }
  const other = await command(peer, peerDevice, untouched)
  await db.query('DELETE FROM auth.users WHERE id=$1', [owner])
  expect((await db.query('SELECT id FROM identity.gugu_device_commands WHERE id=ANY($1::uuid[])', [[owned, sender]])).rows).toHaveLength(0)
  const survivors = (await db.query('SELECT id,payload FROM identity.gugu_device_commands WHERE id=ANY($1::uuid[])', [[reply, recipient, both, other]])).rows
  const payload = (id: string) => survivors.find(row => row.id === id)?.payload
  expect(survivors).toHaveLength(4)
  expect(payload(reply)).not.toHaveProperty('reply_to_sender_user_id')
  expect(payload(reply).reply_to_sender_name).toBe('已注销用户')
  expect(payload(recipient).to_user_ids).toEqual(['*', peer, '5'])
  expect(payload(both).to_user_ids).toEqual([peer])
  expect(payload(both).reply_to_sender_name).toBe('已注销用户')
  expect(payload(other)).toEqual(untouched)
  expect((await db.query('SELECT 1 FROM auth.users WHERE id=$1', [peer])).rows).toHaveLength(1)
})
