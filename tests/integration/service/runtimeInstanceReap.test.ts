import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let owner: string, device: string, otherDevice: string

async function instance(host: string, age: string) {
  const id = randomUUID()
  await db.query(`INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id,last_heartbeat_at,created_at)
    VALUES($1,$2,$3,now()-$4::interval,now()-$4::interval)`, [id, host, owner, age])
  return id
}
async function remaining(ids: string[]) {
  return (await db.query('SELECT instance_id FROM identity.runtime_instances WHERE instance_id=ANY($1)', [ids]))
    .rows.map(row => row.instance_id).sort()
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Runtime instance reaping requires the disposable loopback database')
  }
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, device, otherDevice] = Array.from({ length: 3 }, randomUUID)
  await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,now(),now())`, [owner, `${owner}@runtime-reap.invalid`])
  for (const id of [device, otherDevice]) await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'Runtime reap fixture','fixture','linux')`, [id, owner])
})
afterEach(async () => { if (db) { await db.query('ROLLBACK'); await db.query('RESET ROLE') } })

describe('runtime instance rows end with their lifecycle', () => {
  it('the device-lease sweep deletes instances past the grace and keeps recent ones', async () => {
    const live = await instance(device, '10 seconds')
    const stale = await instance(device, '5 minutes')
    const crashed = await instance(device, '61 minutes')
    const ancient = await instance(otherDevice, '30 days')
    await db.query('SELECT identity.sweep_device_leases()')
    expect(await remaining([live, stale, crashed, ancient])).toEqual([live, stale].sort())
  })

  it('the sweep bounds its deletes per run and drains the rest on the next run', async () => {
    // Rolled back with the test: only this test's rows are past the grace.
    await db.query("DELETE FROM identity.runtime_instances WHERE last_heartbeat_at < now() - interval '1 hour'")
    const old = [await instance(device, '2 hours'), await instance(device, '3 hours'), await instance(device, '4 hours')]
    await db.query('SELECT identity.sweep_device_leases(2)')
    expect(await remaining(old)).toHaveLength(1)
    await db.query('SELECT identity.sweep_device_leases(2)')
    expect(await remaining(old)).toEqual([])
  })

  it('a reaped instance registers again on its next heartbeat', async () => {
    const id = await instance(device, '2 hours')
    await db.query('SELECT identity.sweep_device_leases()')
    expect(await remaining([id])).toEqual([])
    await db.query('SET LOCAL ROLE authenticated')
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
    await db.query('SELECT identity.runtime_instance_heartbeat($1,$2)', [id, device])
    await db.query('RESET ROLE')
    expect(await remaining([id])).toEqual([id])
  })

  it('removing a device deletes its instance rows and no other device\'s', async () => {
    const mine = [await instance(device, '10 seconds'), await instance(device, '3 days')]
    const other = await instance(otherDevice, '10 seconds')
    await db.query('SET LOCAL ROLE authenticated')
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
    await db.query('SELECT identity.remove_device($1,false)', [device])
    await db.query('RESET ROLE')
    expect(await remaining([...mine, other])).toEqual([other])
  })
})
