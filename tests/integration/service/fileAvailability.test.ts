import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let db: pg.Client, owner: string, member: string, outsider: string, group: string, device: string
const value = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0].v
const admin = () => db.query('RESET ROLE')
async function user(id = owner) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function reject(sql: string, args: unknown[] = []) {
  await db.query('SAVEPOINT refused')
  try { await db.query(sql, args) } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT refused'); return error as pg.DatabaseError
  }
  throw Error('Expected authorization rejection')
}
async function cloud() {
  const id = randomUUID(), message = randomUUID()
  await user()
  const permit = await value('SELECT chat.file_managed_upload_as($1,$2,$3,60) AS v', [id, group, owner])
  await admin()
  const blob = (await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,60,$4)', [owner, permit.staging_key, randomBytes(32).toString('hex'), 'application/pdf'])).rows[0].blob_id
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)', [permit.staging_key, owner])
  await user()
  await db.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5)', [permit.staging_key, message, group, owner, 'availability.pdf'])
  await admin()
  const item = (await db.query('SELECT file_item_id AS id FROM chat.messages WHERE id=$1', [message])).rows[0]
  const stored = await value('SELECT id AS v FROM chat.file_transfer_storage WHERE blob_id=$1', [blob])
  return { ...item, blob, message, stored }
}
async function local(item = randomUUID(), expected: number | null = null) {
  await user()
  const r = await value('SELECT chat.file_device_publish(p_item=>$1,p_chat=>$2,p_device=>$3,p_path=>$4,p_sha=>$5,p_size=>60,p_filename=>$6,p_type=>$7,p_expected=>$8,p_project=>$9) AS v',
    [item, group, device, 'docs/availability.pdf', randomBytes(32).toString('hex'), 'availability.pdf', 'application/pdf', expected, 'root'])
  await admin()
  return { id: item, version: r.version }
}
async function readers(item: string) {
  await user()
  await db.query('SELECT chat.workspace_note_open($1)', [item])
  return {
    list: (await db.query('SELECT * FROM chat.workspace_list_as($1,$2) WHERE id=$3', [group, owner, item])).rows[0],
    detail: (await db.query('SELECT * FROM chat.workspace_get_as($1,$2)', [item, owner])).rows[0],
    search: (await db.query('SELECT * FROM chat.workspace_search(p_as_user_id=>$1) WHERE id=$2', [owner, item])).rows[0],
    recent: (await db.query('SELECT * FROM chat.workspace_recent(p_as_user_id=>$1) WHERE id=$2', [owner, item])).rows[0],
    resolve: await value('SELECT chat.file_resolve_as($1,$2) AS v', [{ item_id: item }, owner]),
  }
}
const state = (row: any) => ({ availability: row.availability, expired_at: row.expired_at === null ? null : new Date(row.expired_at).toISOString() })
beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw Error('File availability tests require an owned loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); member = randomUUID(); outsider = randomUUID(); group = randomUUID(); device = randomUUID()
  for (const id of [owner, member, outsider]) await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())", [id, id + '@availability.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','availability fixture',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [group, owner, member])
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'owned fixture','fixture','linux')", [device, owner])
  await db.query("INSERT INTO identity.chat_folders(device_id,user_id,folder_id,chat_id,path,position,created_at) VALUES($1,$2,'root',$3,'/fixture',1,now())", [device, owner, group])
  const baseline = Number(await value("SELECT chat.file_transfer_usage('upload','global','*') AS v"))
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings", [{
    inventory_ready: true, storage_global_bytes: baseline + 100000, storage_account_bytes: 100000, storage_group_bytes: 100000,
    download_global_bytes: 100000, download_account_bytes: 100000, download_group_bytes: 100000, upload_permit_seconds: 120, upload_edge_seconds:400, upload_sign_seconds:900, upload_inflight_seconds:600,
    sign_window_seconds: 60, sign_account_count: 1000, sign_group_count: 1000, file_max_bytes: 1000, temporary_group_bytes: 100000,
  }])
})
afterEach(async () => { await db.query('ROLLBACK') })

describe('overall readable file availability', () => {
  it('returns the same available state from lists, search, recent, detail, resolver and each version', async () => {
    const file = await cloud(), all = await readers(file.id)
    for (const row of Object.values(all)) expect(state(row)).toEqual({ availability: 'available', expired_at: null })
    expect(all.list).toMatchObject({ id: file.id, filename: 'availability.pdf', version: 1, child_count: null })
    const projected = await value('SELECT file_metadata AS v FROM chat.messages_view WHERE id=$1', [file.message])
    expect(state(projected)).toEqual(state(all.resolve))
    const history = (await db.query('SELECT * FROM chat.workspace_versions_as($1,$2)', [file.id, owner])).rows
    expect(history).toHaveLength(1); expect(state(history[0])).toEqual(state(all.list))
  })
  it('marks an expired cloud copy before opening it, including physically collected bytes', async () => {
    const file = await cloud()
    const expired = new Date('2026-11-01T00:00:00Z')
    await db.query("UPDATE chat.file_transfer_storage_refs SET expired_at=$2 WHERE storage_id=$1", [file.stored, expired])
    for (const physical of ['ready', 'gone']) {
      await admin(); await db.query('UPDATE chat.file_transfer_storage SET state=$2 WHERE id=$1', [file.stored, physical])
      for (const row of Object.values(await readers(file.id))) expect(state(row)).toEqual({ availability: 'expired', expired_at: expired.toISOString() })
    }
  })
  it('recognizes a past declared deadline without turning a future deadline into an already-expired file', async () => {
    const file = await cloud()
    await db.query("UPDATE chat.file_transfer_storage_refs SET expires_at=now()+interval '1 day' WHERE storage_id=$1", [file.stored])
    expect(state((await readers(file.id)).list)).toEqual({ availability: 'available', expired_at: null })
    await admin(); await db.query("UPDATE chat.file_transfer_storage_refs SET expires_at=now()-interval '1 second' WHERE storage_id=$1", [file.stored])
    for (const row of Object.values(await readers(file.id))) expect(state(row).availability).toBe('expired')
  })
  it('does not label physical absence or a broken device binding as expiry or deletion', async () => {
    const file = await cloud(); await db.query("UPDATE chat.file_transfer_storage SET state='gone' WHERE id=$1", [file.stored])
    for (const row of Object.values(await readers(file.id))) expect(state(row)).toEqual({ availability: 'unavailable', expired_at: null })
    await admin(); const held = await local()
    await db.query('DELETE FROM identity.chat_folders WHERE device_id=$1', [device])
    for (const row of Object.values(await readers(held.id))) expect(state(row)).toEqual({ availability: 'unavailable', expired_at: null })
  })
  it('keeps valid device-held bytes available while offline and computes older cloud versions independently', async () => {
    const file = await cloud()
    await db.query('UPDATE chat.file_transfer_storage_refs SET expired_at=now() WHERE storage_id=$1', [file.stored])
    await local(file.id, 1)
    await db.query("UPDATE identity.gugu_devices SET status='offline' WHERE device_id=$1", [device])
    for (const row of Object.values(await readers(file.id))) expect(state(row)).toEqual({ availability: 'available', expired_at: null })
    const history = (await db.query('SELECT * FROM chat.workspace_versions_as($1,$2)', [file.id, owner])).rows
    expect(history.map(row => [row.n, row.availability])).toEqual([[2, 'available'], [1, 'expired']])
    expect(await value('SELECT chat.file_resolve_as($1,$2) AS v', [{ item_id: file.id, version: 1 }, owner])).toMatchObject({ availability: 'expired' })
    expect((await readers(file.id)).resolve).toMatchObject({ availability: 'available', host_online: false })
  })
  it('keeps the same device version available after its temporary cloud generation expires and is collected', async () => {
    const held = await local()
    await user(member)
    const asked = await value('SELECT chat.file_temporary_request($1,$2,$3) AS v', [{ item_id: held.id }, member, randomUUID()])
    await user(); await db.query('SELECT chat.file_temporary_accept($1,128)', [asked.transfer_id])
    await admin()
    await db.query('SELECT chat.file_temporary_commit($1,$2,$3,128,$4)', [asked.transfer_id, owner, randomBytes(32).toString('hex'), Buffer.alloc(32, 7).toString('base64')])
    await db.query('UPDATE chat.file_transfer_storage_refs SET expired_at=now() WHERE storage_id IN (SELECT o.id FROM chat.file_transfer_storage o JOIN chat.file_temporary_transfers t ON t.blob_id=o.blob_id WHERE t.id=$1)', [asked.transfer_id])
    await db.query("UPDATE chat.file_transfer_storage SET state='gone' WHERE blob_id=(SELECT blob_id FROM chat.file_temporary_transfers WHERE id=$1)", [asked.transfer_id])
    await db.query("UPDATE identity.gugu_devices SET status='offline' WHERE device_id=$1", [device])
    for (const row of Object.values(await readers(held.id))) expect(state(row)).toEqual({ availability: 'available', expired_at: null })
  })
  it('keeps folders and database documents available without consulting cloud expiry', async () => {
    await user()
    const doc = (await db.query('SELECT id FROM chat.workspace_create_document_as($1,$2,$3,$4)', [group, owner, 'note.md', 'owned content'])).rows[0].id
    for (const row of Object.values(await readers(doc))) expect(state(row)).toEqual({ availability: 'available', expired_at: null })
    const folders = (await db.query("SELECT * FROM chat.workspace_list_as($1,$2) WHERE kind='folder'", [group, owner])).rows
    for (const folder of folders) expect(state(folder)).toEqual({ availability: 'available', expired_at: null })
  })
  it('does not reserve downloads, extend TTL or update file metadata while reading status', async () => {
    const file = await cloud()
    await user(); await db.query('SELECT chat.workspace_note_open($1)', [file.id]); await admin()
    const snapshot = async () => ({
      refs: (await db.query('SELECT to_jsonb(r) AS v FROM chat.file_transfer_storage_refs r WHERE storage_id=$1', [file.stored])).rows,
      reservations: (await db.query('SELECT to_jsonb(r) AS v FROM chat.file_transfer_reservations r WHERE account_id=$1 ORDER BY id', [owner])).rows,
      item: await value('SELECT to_jsonb(w) AS v FROM chat.workspace_items w WHERE id=$1', [file.id]),
    })
    const before = await snapshot()
    // Do not call readers(): note_open intentionally is an existing user action.
    await user()
    await db.query('SELECT * FROM chat.workspace_list_as($1,$2)', [group, owner])
    await db.query('SELECT * FROM chat.workspace_search(p_as_user_id=>$1)', [owner])
    await db.query('SELECT * FROM chat.workspace_recent(p_as_user_id=>$1)', [owner])
    await db.query('SELECT * FROM chat.workspace_get_as($1,$2)', [file.id, owner])
    await db.query('SELECT * FROM chat.workspace_versions_as($1,$2)', [file.id, owner])
    await value('SELECT chat.file_resolve_as($1,$2) AS v', [{ item_id: file.id }, owner])
    await admin(); expect(await snapshot()).toEqual(before)
  })
  it('keeps private predicates/bases closed and preserves unreadable-reference refusal', async () => {
    const file = await cloud()
    await user(outsider)
    expect(await value('SELECT chat.file_resolve_as($1,$2) AS v', [{ message_id: file.message }, outsider])).toEqual({ status: 'gone', availability: 'unavailable', expired_at: null })
    for (const sql of ['SELECT chat.file_blob_availability($1,$2)', 'SELECT chat.workspace_version_availability($1,1)',
      'SELECT * FROM chat.file_availability_batch(ARRAY[$1::uuid],ARRAY[1])']) {
      expect((await reject(sql, sql.includes('file_blob_') ? [file.blob, group] : [file.id])).code).toBe('42501')
    }
    expect((await reject('SELECT * FROM chat.workspace_list_as_availability_base($1,$2)', [group, outsider])).code).toBe('42501')
    expect((await reject('SELECT chat.file_resolve_availability_base($1,$2)', [{ message_id: file.message }, outsider])).code).toBe('42501')
    expect((await reject('SELECT * FROM chat.workspace_get_as($1,$2)', [file.id, outsider])).hint).toBe('workspace_item_not_found')
  })
})
