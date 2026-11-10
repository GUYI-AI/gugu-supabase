import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// #2080 relies on this transport boundary, not on a user_id supplied in an RPC envelope.
// Write directly as authenticated so the installed realtime.messages INSERT policies decide.
let db: Client
let owner: string, peer: string, outsider: string, group: string
let device: string, peerDevice: string, outsiderDevice: string

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Device RPC authorization requires disposable loopback PostgreSQL')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  await db.query("SET LOCAL statement_timeout='15s'")
  owner = randomUUID(); peer = randomUUID(); outsider = randomUUID(); group = randomUUID()
  device = `rpc-owner-${randomUUID()}`
  peerDevice = `rpc-peer-${randomUUID()}`
  outsiderDevice = `rpc-outsider-${randomUUID()}`
  for (const [id, ownedDevice] of [[owner, device], [peer, peerDevice], [outsider, outsiderDevice]]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [id, `${id}@example.test`])
    await db.query(`INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','RPC fixture')
      ON CONFLICT (id) DO NOTHING`, [id])
    await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
      VALUES ($1,$2,'RPC fixture','isolated','linux')`, [ownedDevice, id])
  }
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id)
    VALUES ($1,'group','RPC permission fixture',$2)`, [group, owner])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role)
    VALUES ($1,$2,'owner'),($1,$3,'member')`, [group, owner, peer])
})
afterEach(async () => { await db?.query('ROLLBACK') })

async function asUser(id: string) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
  expect((await db.query('SELECT current_user AS role,auth.uid()::text AS uid')).rows)
    .toEqual([{ role: 'authenticated', uid: id }])
}
function topic(ownedDevice: string, form: 'device' | 'per-caller') {
  return `gugu:${ownedDevice}:rpc${form === 'per-caller' ? `:${peerDevice}` : ''}`
}
async function write(topic: string, probe: string, claimedUser: string) {
  return db.query(`INSERT INTO realtime.messages(topic,event,payload,extension,private)
    VALUES ($1,'rpc_permission_probe',$2::jsonb,'broadcast',true)`,
  [topic, JSON.stringify({ probe_id: probe, user_id: claimedUser })])
}
async function stored(probe: string) {
  await db.query('RESET ROLE')
  return (await db.query(`SELECT topic,payload,extension,private FROM realtime.messages
    WHERE event='rpc_permission_probe' AND payload->>'probe_id'=$1`, [probe])).rows
}
async function expectAllowed(actor: string, destination: string) {
  const probe = randomUUID()
  await asUser(actor)
  await write(destination, probe, actor)
  expect(await stored(probe)).toEqual([{
    topic: destination, payload: { probe_id: probe, user_id: actor }, extension: 'broadcast', private: true,
  }])
}
async function expectDenied(actor: string, destination: string) {
  const probe = randomUUID()
  await db.query('SAVEPOINT denied_rpc')
  await asUser(actor)
  let failure: unknown
  try {
    // Claiming the target owner's identity in the payload must not authorize the writer.
    await write(destination, probe, owner)
  } catch (error) { failure = error }
  await db.query('ROLLBACK TO SAVEPOINT denied_rpc')
  expect((failure as { code?: string } | undefined)?.code).toBe('42501')
  expect(await stored(probe)).toEqual([])
}
async function memberExists() {
  await db.query('RESET ROLE')
  return (await db.query('SELECT 1 FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [group, peer])).rows.length === 1
}

describe.each(['device', 'per-caller'] as const)('device RPC topic writes (%s)', (form) => {
  it('allows the device owner to publish', async () => {
    await expectAllowed(owner, topic(device, form))
    await expectAllowed(peer, topic(peerDevice, form))
  })

  it('rejects another account writing to the device, even with the owner in the envelope', async () => {
    await expectAllowed(outsider, topic(outsiderDevice, form))
    await expectDenied(outsider, topic(device, form))
  })

  it('does not give a conversation member the owner\'s device transport', async () => {
    expect(await memberExists()).toBe(true)
    await expectAllowed(peer, topic(peerDevice, form))
    await expectDenied(peer, topic(device, form))
  })

  it('rejects a former member after removal while their own device remains writable', async () => {
    expect(await memberExists()).toBe(true)
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [group, peer])
    expect(await memberExists()).toBe(false)
    await expectAllowed(peer, topic(peerDevice, form))
    await expectDenied(peer, topic(device, form))
  })
})
