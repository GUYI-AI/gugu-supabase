import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const GiB = 1024 ** 3 // SERVER_DISK_LOW_BYTES in the shared client health predicate.
let db: Client
let owner: string, device: string
const capabilities = (free: number, total = 8 * GiB) => ({ host_kind: 'server', runtimes: ['codex'], server_disk: { free_bytes: free, total_bytes: total } })
const head = async () => (await db.query('SELECT revision::text FROM chat.account_revision_heads WHERE user_id=$1', [owner])).rows[0]?.revision ?? '0'
async function disk(free: number, total = 8 * GiB) {
  await db.query('UPDATE identity.gugu_devices SET capabilities=$2::jsonb WHERE device_id=$1', [device, JSON.stringify(capabilities(free, total))])
}
async function revisions(after: string) {
  return (await db.query('SELECT event,resource_key,tombstone FROM chat.account_revisions WHERE user_id=$1 AND revision>$2 ORDER BY revision', [owner, after])).rows
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Device disk revision tests require disposable loopback PostgreSQL')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); device = `disk-${randomUUID()}`
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [owner, `${owner}@disk.invalid`])
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Disk fixture') ON CONFLICT(id) DO NOTHING", [owner])
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,status,capabilities)
    VALUES($1,$2,'Disk fixture','fixture','linux','online',$3::jsonb)`, [device, owner, JSON.stringify(capabilities(2 * GiB))])
})
afterEach(async () => { await db?.query('ROLLBACK') })

describe('on-demand disk state and threshold revisions', () => {
  it.each([2 * GiB, GiB - 2])('persists exact bytes without revising within the same threshold state: %s', async free => {
    await disk(free)
    const before = await head()
    await disk(free + 1, 9 * GiB)
    expect(await revisions(before)).toEqual([])
    expect((await db.query('SELECT capabilities FROM identity.gugu_devices WHERE device_id=$1', [device])).rows[0].capabilities).toEqual(capabilities(free + 1, 9 * GiB))
  })

  it('revises on entering and leaving low disk, with exactly 1 GiB healthy', async () => {
    const before = await head()
    await disk(GiB - 1)
    await disk(GiB)
    expect(await revisions(before)).toEqual(Array.from({ length: 2 }, () => ({ event: 'device_changed', resource_key: { device_id: device, kind: 'row' }, tombstone: false })))
  })

  it.each([
    ['status', 'offline'], ['label', 'Renamed'], ['hostname', 'new-host'], ['platform', 'darwin'],
    ['tier', 'beta'], ['machine_id', 'new-machine'], ['session_digest', '[{"conversationId":"changed"}]'],
    ['capabilities', JSON.stringify({ ...capabilities(2 * GiB + 1), runtimes: ['codex', 'claude'] })],
  ])('retains device revisions for visible %s changes', async (column, value) => {
    const before = await head()
    // Column names are the fixed fixture list above.
    await db.query(`UPDATE identity.gugu_devices SET ${column}=$2${column === 'label' ? ',label_customized_at=clock_timestamp()' : ''} WHERE device_id=$1`, [device, value])
    expect(await revisions(before)).toEqual([{ event: 'device_changed', resource_key: { device_id: device, kind: 'row' }, tombstone: false }])
  })

  it.each([null, 'bad', [], { free_bytes: '1', total_bytes: 10 }, { free_bytes: -1, total_bytes: 10 }, { free_bytes: 20, total_bytes: 10 }])('does not treat malformed disk state as low: %j', async server_disk => {
    const before = await head()
    await db.query('UPDATE identity.gugu_devices SET capabilities=$2::jsonb WHERE device_id=$1', [device, JSON.stringify({ ...capabilities(2 * GiB), server_disk })])
    expect(await revisions(before)).toEqual([])
  })

  it('still publishes insertions and removals', async () => {
    const before = await head()
    await db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1', [device])
    expect(await revisions(before)).toEqual([{ event: 'device_changed', resource_key: { device_id: device, kind: 'row' }, tombstone: true }])
    await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
      VALUES($1,$2,'Disk fixture','fixture','linux')`, [device, owner])
    expect((await revisions(before)).map(row => row.tombstone)).toEqual([true, false])
  })
})
