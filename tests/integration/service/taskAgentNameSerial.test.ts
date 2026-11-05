import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let owner: string
let device: string
const provision = `SELECT * FROM identity.provision_taskpage_agent($1::uuid,$2,$3,'codex',$4,NULL,NULL,NULL,NULL,$5)`

async function authenticated(id = owner) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function serial(id: string) {
  return (await db.query<{ name_serial: number | null }>('SELECT name_serial FROM identity.users WHERE id=$1', [id])).rows[0]?.name_serial
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Task name serial tests require a disposable loopback database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); device = randomUUID()
  await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [owner, `${owner}@task-name.invalid`])
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'Task name fixture','fixture','linux')`, [device, owner])
  await authenticated()
})
afterEach(async () => { await db.query('ROLLBACK') })

describe('stable task agent name serial metadata', () => {
  it('retains the original serial through rename and idempotent provisioning', async () => {
    const id = randomUUID()
    const first = (await db.query(provision, [id, 'Codex 1', 'serial', device, 'Codex'])).rows[0]
    expect(first.display_name).toBe('Codex 1')
    expect(await serial(id)).toBe(1)
    await db.query('UPDATE identity.users SET display_name=$2 WHERE id=$1', [id, 'Fix login'])
    const retry = (await db.query(provision, [id, 'Codex 1', 'serial', device, 'Codex'])).rows[0]
    expect(retry.display_name).toBe('Fix login')
    expect(await serial(id)).toBe(1)
    const next = randomUUID()
    await db.query(provision, [next, 'Codex 1', 'serial', device, 'Codex'])
    expect(await serial(next)).toBe(2)
  })

  it('preserves duplicate explicit names while allocating separate stable serials', async () => {
    const a = randomUUID(), b = randomUUID()
    for (const id of [a, b]) {
      const row = (await db.query(provision, [id, 'Fix login', 'explicit', device, 'Codex'])).rows[0]
      expect(row.display_name).toBe('Fix login')
    }
    expect([await serial(a), await serial(b)]).toEqual([1, 2])
  })

  it('does not read digits in an explicit name as its task serial', async () => {
    const id = randomUUID()
    await db.query(provision, [id, 'Fix issue 999', 'explicit', device, 'Codex'])
    expect(await serial(id)).toBe(1)
    const looksLikePlaceholder = randomUUID()
    const row = (await db.query(provision, [looksLikePlaceholder, 'Codex 999', 'explicit', device, 'Codex'])).rows[0]
    expect(row.display_name).toBe('Codex 999')
    expect(await serial(looksLikePlaceholder)).toBe(2)
  })

  it('attests an existing task placeholder but does not guess a renamed legacy number', async () => {
    const placeholder = randomUUID(), renamed = randomUUID()
    await db.query(`SELECT * FROM identity.create_owned_agent('Codex 27',NULL,'codex',$1,NULL,NULL,true,NULL,$2::uuid)`, [device, placeholder])
    await db.query(`SELECT * FROM identity.create_owned_agent('Fix issue 99',NULL,'codex',$1,NULL,NULL,true,NULL,$2::uuid)`, [device, renamed])
    expect(await serial(placeholder)).toBeNull()
    await db.query(provision, [placeholder, 'Codex 27', 'serial', device, 'Codex'])
    await db.query(provision, [renamed, 'Fix issue 99', 'serial', device, 'Codex'])
    expect(await serial(placeholder)).toBe(27)
    expect(await serial(renamed)).toBeNull()
  })

  it('leaves persistent identities unchanged and keeps old provision callers compatible', async () => {
    const persistent = randomUUID(), legacy = randomUUID()
    await db.query(`SELECT * FROM identity.create_owned_agent('Assistant',NULL,'codex',$1,NULL,NULL,true,NULL,$2::uuid)`, [device, persistent])
    await db.query(`SELECT * FROM identity.provision_taskpage_agent($1::uuid,'Codex 1','serial','codex',$2)`, [legacy, device])
    expect(await serial(persistent)).toBeNull()
    expect(await serial(legacy)).toBe(1)
  })

  it('does not grant clients permission to alter the assigned serial', async () => {
    const id = randomUUID()
    await db.query(provision, [id, 'Codex 1', 'serial', device, 'Codex'])
    await db.query('SAVEPOINT rejected_write')
    await expect(db.query('UPDATE identity.users SET name_serial=500 WHERE id=$1', [id])).rejects.toThrow(/permission denied/i)
    await db.query('ROLLBACK TO SAVEPOINT rejected_write')
    expect(await serial(id)).toBe(1)
  })
})
