import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

// 20261110051000: a device row is deleted only by its owner's remove_device, and every API-registered device names its
// machine. Before, cleanup_legacy_gugu_devices (called by each client at startup) deleted a laptop unseen for 30 days
// together with its project folders, and deleted machine-less rows by hostname on every run.
let db: Client
let owner: string, laptop: string, here: string
// The release's one-time fill, run again on this fixture.
const fill = /^UPDATE identity\.gugu_devices\n[\s\S]*?;$/m.exec(readFileSync(new URL('../../../supabase/migrations/20261110051000_devices_removed_by_owner_only.sql', import.meta.url), 'utf8'))![0]

async function asOwner<Row = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<Row[]> {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
  await db.query('SET LOCAL ROLE authenticated')
  // A refused statement aborts the transaction: the caller rolls back to its savepoint, which also undoes the role.
  const rows = (await db.query(sql, values)).rows as Row[]
  await db.query('RESET ROLE')
  return rows
}
const device = async (id: string, machine: string | null, seen = 'now()') => db.query(`INSERT INTO identity.gugu_devices
  (device_id,user_id,label,hostname,platform,machine_id,last_seen_at,status) VALUES($1,$2,'fixture','same-host','linux',$3,${seen},'offline')`,
  [id, owner, machine])
const devices = async () => (await db.query('SELECT device_id FROM identity.gugu_devices WHERE user_id=$1 ORDER BY 1', [owner])).rows.map(r => r.device_id)

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Requires the disposable loopback database')
  }
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, laptop, here] = [randomUUID(), randomUUID(), randomUUID()]
  await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,now(),now())`,
    [owner, `${owner}@devices.invalid`])
  await device(here, `machine-${here}`)
})
afterEach(async () => { await db.query('ROLLBACK') })

it('no API call deletes a device unseen for 30 days or its project folders; only remove_device does', async () => {
  await device(laptop, `machine-${laptop}`, "now() - interval '31 days'")
  await db.query(`INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at)
    VALUES($1,$2,'p1','Holiday project','/home/me/p1',now())`, [laptop, owner])
  // The released clients' startup call: it still answers, and deletes nothing.
  expect(await asOwner<{ n: number }>('SELECT identity.cleanup_legacy_gugu_devices($1,$2) AS n', [here, 'same-host'])).toEqual([{ n: 0 }])
  expect(await devices()).toEqual([here, laptop].sort())
  expect((await db.query('SELECT local_project_id FROM identity.device_projects WHERE device_id=$1', [laptop])).rows).toHaveLength(1)
  await asOwner('SELECT identity.remove_device($1)', [laptop])
  expect(await devices()).toEqual([here])
})

it('an API write must name the machine', async () => {
  const id = randomUUID()
  const insert = (machine: string | null) => asOwner(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,machine_id)
    VALUES($1,$2,'fixture','h','linux',$3)`, [id, owner, machine])
  await db.query('SAVEPOINT s')
  await expect(insert(null)).rejects.toThrow(/DEVICE_MACHINE_REQUIRED/)
  await db.query('ROLLBACK TO SAVEPOINT s')
  await expect(insert('')).rejects.toThrow(/DEVICE_MACHINE_REQUIRED/)
  await db.query('ROLLBACK TO SAVEPOINT s')
  await insert(`machine-${id}`)
  await db.query('SAVEPOINT t')
  await expect(asOwner('UPDATE identity.gugu_devices SET machine_id=NULL WHERE device_id=$1', [id])).rejects.toThrow(/DEVICE_MACHINE_REQUIRED/)
  await db.query('ROLLBACK TO SAVEPOINT t')
})

it('the release gives a machine-less row a legacy machine id; its agent keeps the device and its client re-registers in place', async () => {
  const agent = randomUUID()
  await device(laptop, null)
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Fixture agent',$2,$3)`,
    [agent, owner, laptop])
  await db.query(fill)
  expect((await db.query('SELECT machine_id FROM identity.gugu_devices WHERE device_id=$1', [laptop])).rows[0].machine_id).toBe(`legacy:${laptop}`)
  expect((await db.query('SELECT device_id FROM identity.users WHERE id=$1', [agent])).rows[0].device_id).toBe(laptop)
  // A current client on that machine upserts its row by device_id with its real machine id.
  await asOwner(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,machine_id) VALUES($1,$2,'fixture','same-host','linux','hw-1')
    ON CONFLICT (device_id) DO UPDATE SET machine_id=EXCLUDED.machine_id`, [laptop, owner])
  expect((await db.query('SELECT machine_id FROM identity.gugu_devices WHERE device_id=$1', [laptop])).rows[0].machine_id).toBe('hw-1')
})
