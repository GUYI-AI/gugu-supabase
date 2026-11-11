import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

// 20261111130000: end-to-end encrypted password vault sync (GUYI-AI/gugu#2481). The database never sees plaintext; it
// enforces who may join, who may write what, versioned saves and all-or-nothing re-keying.
let db: Client
let owner: string, mac: string, laptop: string, server: string
const key = () => randomBytes(32).toString('base64')
const commit = () => randomBytes(32).toString('hex')
const blob = (label: string) => Buffer.from(`ciphertext:${label}:${randomUUID()}`).toString('base64')

async function as<Row = Record<string, unknown>>(user: string, sql: string, values: unknown[] = []): Promise<Row[]> {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  await db.query('SET LOCAL ROLE authenticated')
  const rows = (await db.query(sql, values)).rows as Row[]
  await db.query('RESET ROLE')
  return rows
}
const call = async (sql: string, values: unknown[] = [], user = owner) => (await as<{ r: any }>(user, `SELECT ${sql} AS r`, values))[0].r
async function refused(pattern: RegExp, sql: string, values: unknown[] = [], user = owner) {
  await db.query('SAVEPOINT refused')
  await expect(call(sql, values, user)).rejects.toThrow(pattern)
  await db.query('ROLLBACK TO SAVEPOINT refused')
}
const person = async (id: string) => db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at)
  VALUES($1,'authenticated','authenticated',$2,now(),now())`, [id, `${id}@vault.invalid`])
const device = async (id: string, user = owner, kind = 'desktop') => db.query(`INSERT INTO identity.gugu_devices
  (device_id,user_id,label,hostname,platform,machine_id,capabilities) VALUES($1,$2,'fixture','h','darwin',$3,$4)`,
  [id, user, `machine-${id}`, JSON.stringify({ host_kind: kind })])
const state = (id: string, since = 0, user = owner) => call('identity.password_vault_state($1,$2)', [id, since], user)
// The four joining steps, as the two clients run them.
async function join(id: string, scope: 'full' | 'granted', shares: object[], publicKey = key()) {
  await call('identity.password_vault_request($1,$2,$3)', [id, publicKey, commit()])
  await call('identity.password_vault_challenge($1,$2,$3)', [mac, id, key()])
  await call('identity.password_vault_reveal($1,$2)', [id, key()])
  const epoch = (await state(mac)).epoch
  await call('identity.password_vault_approve($1,$2,$3,$4,$5,$6)', [mac, id, publicKey, scope, epoch, JSON.stringify(shares)])
  return publicKey
}
const save = (id: string, item: string, expected: number, epoch: number, wrapped = blob('wrapped'), shares: object[] = []) =>
  call('identity.password_vault_save($1,$2,$3,$4,$5,$6,$7)', [id, item, expected, epoch, wrapped, blob('item'), JSON.stringify(shares)])

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
  ;[owner, mac, laptop, server] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  await person(owner)
  await device(mac); await device(laptop); await device(server, owner, 'server')
  await call('identity.password_vault_initialize($1,$2,$3)', [mac, key(), blob('vk-mac')])
})
afterEach(async () => { await db.query('ROLLBACK') })

it('the tables are closed; only the owner of the device reaches the vault', async () => {
  for (const table of ['heads', 'devices', 'items', 'shares']) {
    await db.query('SAVEPOINT t')
    await expect(as(owner, `SELECT 1 FROM identity.password_vault_${table}`)).rejects.toThrow(/permission denied/)
    await db.query('ROLLBACK TO SAVEPOINT t')
  }
  const stranger = randomUUID(); await person(stranger); await device(randomUUID(), stranger)
  await refused(/PASSWORD_VAULT_DEVICE/, 'identity.password_vault_state($1,0)', [mac], stranger)
  await refused(/PASSWORD_VAULT_DEVICE/, 'identity.password_vault_request($1,$2,$3)', [laptop, key(), commit()], stranger)
  await refused(/PASSWORD_VAULT_STATE: vault already exists/, 'identity.password_vault_initialize($1,$2,$3)', [laptop, key(), blob('vk')])
})

it('a new device joins only through challenge, reveal and approval by a full device; pending sees no ciphertext', async () => {
  const item = randomUUID()
  await save(mac, item, 0, 1)
  const publicKey = key()
  expect(await call('identity.password_vault_request($1,$2,$3)', [laptop, publicKey, commit()])).toEqual({ status: 'pending' })
  expect((await state(laptop)).items).toEqual([])
  // The pending device cannot approve itself, nor skip a step.
  await refused(/not an approved member/, 'identity.password_vault_challenge($1,$2,$3)', [laptop, laptop, key()])
  await refused(/not waiting for a reveal/, 'identity.password_vault_reveal($1,$2)', [laptop, key()])
  await call('identity.password_vault_challenge($1,$2,$3)', [mac, laptop, key()])
  await refused(/not waiting for a challenge/, 'identity.password_vault_challenge($1,$2,$3)', [mac, laptop, key()])
  await refused(/not ready for approval/, 'identity.password_vault_approve($1,$2,$3,$4,$5,$6)', [mac, laptop, publicKey, 'full', 1, JSON.stringify([{ deviceId: laptop, sealed: blob('vk') }])])
  const pending = (await state(mac)).devices.find((d: any) => d.deviceId === laptop)
  expect(pending).toMatchObject({ status: 'pending', approverDeviceId: mac, deviceNonce: null })
  await call('identity.password_vault_reveal($1,$2)', [laptop, key()])
  // Approval seals to exactly the key the approver compared.
  await refused(/not ready for approval/, 'identity.password_vault_approve($1,$2,$3,$4,$5,$6)', [mac, laptop, key(), 'full', 1, JSON.stringify([{ deviceId: laptop, sealed: blob('vk') }])])
  await refused(/receives the vault key/, 'identity.password_vault_approve($1,$2,$3,$4,$5,$6)', [mac, laptop, publicKey, 'full', 1, '[]'])
  await call('identity.password_vault_approve($1,$2,$3,$4,$5,$6)', [mac, laptop, publicKey, 'full', 1, JSON.stringify([{ deviceId: laptop, sealed: blob('vk') }])])
  const joined = await state(laptop)
  expect(joined.shares).toHaveLength(1)
  expect(joined.items.map((i: any) => i.itemId)).toEqual([item])
  // Asking again with the same key is a no-op; an approved device is never replaced by a new key from the account.
  expect(await call('identity.password_vault_request($1,$2,$3)', [laptop, publicKey, commit()])).toEqual({ status: 'approved' })
  await refused(/approved with another key/, 'identity.password_vault_request($1,$2,$3)', [laptop, key(), commit()])
})

it('saves are versioned; a stale write is refused and nothing changes', async () => {
  const item = randomUUID()
  expect(await save(mac, item, 0, 1)).toMatchObject({ version: '1' })
  await refused(/PASSWORD_VAULT_STALE: item changed/, 'identity.password_vault_save($1,$2,$3,$4,$5,$6,$7)', [mac, item, 0, 1, blob('w'), blob('i'), '[]'])
  await refused(/PASSWORD_VAULT_STALE: key epoch changed/, 'identity.password_vault_save($1,$2,$3,$4,$5,$6,$7)', [mac, item, 1, 2, blob('w'), blob('i'), '[]'])
  const before = (await state(mac)).revision
  expect(await save(mac, item, 1, 1)).toMatchObject({ version: '2' })
  const changed = await state(mac, Number(before))
  expect(changed.items.map((i: any) => [i.itemId, i.version])).toEqual([[item, '2']])
  await refused(/PASSWORD_VAULT_STALE/, 'identity.password_vault_delete($1,$2,$3)', [mac, item, 1])
  await call('identity.password_vault_delete($1,$2,$3)', [mac, item, 2])
  expect((await state(mac)).items).toEqual([expect.objectContaining({ itemId: item, deleted: true, ciphertext: null, version: '3' })])
  expect(Number(await call('identity.password_vault_revision($1)', [mac]))).toBeGreaterThan(Number(before))
})

it('a limited device sees only items it holds a key for, edits them under the same key, and manages nothing', async () => {
  const granted = randomUUID(), other = randomUUID(), wrapped = blob('wrapped')
  await join(server, 'granted', [])
  await save(mac, granted, 0, 1, wrapped, [{ deviceId: server, sealed: blob('ik') }])
  await save(mac, other, 0, 1)
  const seen = await state(server)
  expect(seen.items.map((i: any) => i.itemId)).toEqual([granted])
  expect(seen.shares).toEqual([expect.objectContaining({ itemId: granted })])
  expect(await save(server, granted, 1, 1, wrapped)).toMatchObject({ version: '2' })
  // Its save left the share in place.
  expect((await state(server)).shares).toHaveLength(1)
  await refused(/may only edit items it holds/, 'identity.password_vault_save($1,$2,$3,$4,$5,$6,$7)', [server, granted, 2, 1, blob('other-key'), blob('i'), '[]'])
  await refused(/may only edit items it holds/, 'identity.password_vault_save($1,$2,$3,$4,$5,$6,$7)', [server, other, 1, 1, blob('w'), blob('i'), '[]'])
  await refused(/may only edit items it holds/, 'identity.password_vault_save($1,$2,$3,$4,$5,$6,$7)', [server, randomUUID(), 0, 1, blob('w'), blob('i'), '[]'])
  await refused(/not an approved member/, 'identity.password_vault_delete($1,$2,$3)', [server, granted, 2])
  await call('identity.password_vault_request($1,$2,$3)', [laptop, key(), commit()])
  await refused(/not an approved member/, 'identity.password_vault_challenge($1,$2,$3)', [server, laptop, key()])
})

it('removing a device asks for a re-key; the re-key covers every item and every remaining full device, all or nothing', async () => {
  const a = randomUUID(), b = randomUUID()
  await join(laptop, 'full', [{ deviceId: laptop, sealed: blob('vk-laptop') }])
  await join(server, 'granted', [])
  await save(mac, a, 0, 1, blob('w'), [{ deviceId: server, sealed: blob('ik') }])
  await save(mac, b, 0, 1)
  await as(owner, 'SELECT identity.remove_device($1)', [server])
  expect((await state(mac)).rotationRequired).toBe(true)
  const items = (version: number, ids = [a, b]) => JSON.stringify(ids.map(itemId => ({ itemId, expectedVersion: version, wrappedKey: blob('w2'), ciphertext: blob('i2') })))
  const keys = (...ids: string[]) => JSON.stringify(ids.map(deviceId => ({ deviceId, sealed: blob('vk2') })))
  await refused(/items changed/, 'identity.password_vault_rotate($1,$2,$3,$4,$5)', [mac, 1, [], items(1, [a]), keys(mac, laptop)])
  await refused(/item changed/, 'identity.password_vault_rotate($1,$2,$3,$4,$5)', [mac, 1, [], items(7), keys(mac, laptop)])
  await refused(/every remaining full device/, 'identity.password_vault_rotate($1,$2,$3,$4,$5)', [mac, 1, [], items(1), keys(mac)])
  // The removed device is no longer the owner's at all.
  await refused(/device is not owned/, 'identity.password_vault_rotate($1,$2,$3,$4,$5)', [server, 1, [], items(1), keys(mac, laptop)])
  expect((await state(mac)).epoch).toBe(1)
  expect(await call('identity.password_vault_rotate($1,$2,$3,$4,$5)', [mac, 1, [], items(1), keys(mac, laptop)])).toMatchObject({ epoch: 2 })
  const after = await state(laptop)
  expect(after).toMatchObject({ epoch: 2, rotationRequired: false })
  expect(after.shares).toEqual([expect.objectContaining({ epoch: 2, itemId: null })])
  expect(after.items.map((i: any) => [i.itemId, i.epoch, i.version]).sort()).toEqual([[a, 2, '2'], [b, 2, '2']].sort())
  // Removing laptop in the same call takes it out and leaves only mac's key.
  await call('identity.password_vault_rotate($1,$2,$3,$4,$5)', [mac, 2, [laptop], items(2), keys(mac)])
  await refused(/not an approved member/, 'identity.password_vault_save($1,$2,$3,$4,$5,$6,$7)', [laptop, a, 3, 3, blob('w'), blob('i'), '[]'])
  expect((await state(laptop)).items).toEqual([])
})

it('an empty vault can be started again only when no approved device can open the old one', async () => {
  await refused(/an approved device or the recovery code can still open/, 'identity.password_vault_reset($1)', [laptop])
  await as(owner, 'SELECT identity.remove_device($1)', [mac])
  await call('identity.password_vault_reset($1)', [laptop])
  expect(await state(laptop)).toEqual({ initialized: false })
  expect(await call('identity.password_vault_initialize($1,$2,$3)', [laptop, key(), blob('vk')])).toMatchObject({ epoch: 1 })
})

it('a recovery code lets a device join without another device; the account alone is not enough; a use consumes it', async () => {
  const proof = randomBytes(32).toString('base64'), verifier = createHash('sha256').update(Buffer.from(proof, 'base64')).digest('hex')
  const recoveryKey = key(), sealed = blob('vk-recovery')
  await refused(/not an approved member/, 'identity.password_vault_set_recovery($1,$2,$3,$4,$5)', [laptop, 1, recoveryKey, verifier, sealed])
  await call('identity.password_vault_set_recovery($1,$2,$3,$4,$5)', [mac, 1, recoveryKey, verifier, sealed])
  await refused(/a recovery code exists/, 'identity.password_vault_set_recovery($1,$2,$3,$4,$5)', [mac, 1, key(), verifier, blob('other')])
  expect(await state(mac)).toMatchObject({ recovery: true, recoveryPublicKey: recoveryKey })
  // Only full members see the code's public key (they re-seal to it); the cloud keeps only the verifier of the proof.
  expect(await state(laptop)).toMatchObject({ recovery: true, recoveryPublicKey: null })
  await refused(/recovery code does not match/, 'identity.password_vault_recovery_begin($1,$2)', [laptop, randomBytes(32).toString('base64')])
  await refused(/recovery code does not match/, 'identity.password_vault_recover($1,$2,$3,$4,$5)', [laptop, randomBytes(32).toString('base64'), key(), 1, blob('vk')])
  await refused(/the recovery code can still open/, 'identity.password_vault_reset($1)', [laptop])
  expect(await call('identity.password_vault_recovery_begin($1,$2)', [laptop, proof])).toEqual({ epoch: 1, sealed })
  const laptopKey = key()
  await call('identity.password_vault_recover($1,$2,$3,$4,$5)', [laptop, proof, laptopKey, 1, blob('vk-laptop')])
  const after = await state(laptop)
  expect(after).toMatchObject({ recovery: false, recoveryPublicKey: null })
  expect(after.devices.find((d: any) => d.deviceId === laptop)).toMatchObject({ status: 'approved', scope: 'full', publicKey: laptopKey })
  expect(after.shares).toEqual([expect.objectContaining({ itemId: null, epoch: 1 })])
  await refused(/recovery code does not match/, 'identity.password_vault_recovery_begin($1,$2)', [server, proof])
})

it('re-keying keeps the recovery code (re-sealed), replaces it, or drops it', async () => {
  const proof = randomBytes(32).toString('base64'), verifier = createHash('sha256').update(Buffer.from(proof, 'base64')).digest('hex')
  await call('identity.password_vault_set_recovery($1,$2,$3,$4,$5)', [mac, 1, key(), verifier, blob('vk1')])
  const rotate = (epoch: number, recovery: object | null) => call('identity.password_vault_rotate($1,$2,$3,$4,$5,$6)',
    [mac, epoch, [], '[]', JSON.stringify([{ deviceId: mac, sealed: blob('vk') }]), recovery === null ? null : JSON.stringify(recovery)])
  const resealed = blob('vk2-recovery')
  await rotate(1, { sealed: resealed })
  expect(await call('identity.password_vault_recovery_begin($1,$2)', [laptop, proof])).toEqual({ epoch: 2, sealed: resealed })
  const next = randomBytes(32).toString('base64')
  await rotate(2, { publicKey: key(), verifier: createHash('sha256').update(Buffer.from(next, 'base64')).digest('hex'), sealed: blob('vk3') })
  await refused(/recovery code does not match/, 'identity.password_vault_recovery_begin($1,$2)', [laptop, proof])
  expect(await call('identity.password_vault_recovery_begin($1,$2)', [laptop, next])).toMatchObject({ epoch: 3 })
  await rotate(3, null)
  expect(await state(mac)).toMatchObject({ epoch: 4, recovery: false })
  await refused(/recovery code does not match/, 'identity.password_vault_recovery_begin($1,$2)', [laptop, next])
})
