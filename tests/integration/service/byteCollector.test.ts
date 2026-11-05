import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// One collector for stored bytes (20261105080000): every way a blob loses its last holder — a folder delete, a temporary
// copy retired while its signed upload is still open, an account erasure — puts it into chat.file_blob_gc once, and the
// claim hands it to the attachments gc function once, after the last holder is gone.
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const settings = {
  inventory_ready: true, storage_global_bytes: 100000, storage_account_bytes: 100000, storage_group_bytes: 100000,
  download_global_bytes: 100000, download_account_bytes: 100000, download_group_bytes: 100000,
  upload_permit_seconds: 300, sign_window_seconds: 60, sign_account_count: 100, sign_group_count: 100,
  file_max_bytes: 10000, storage_warning_percent: 80, temporary_group_bytes: 10000,
}
const PUBLISH = 'SELECT chat.file_device_publish(p_item=>$1,p_chat=>$2,p_device=>$3,p_path=>$4,p_sha=>$5,p_size=>$6,p_filename=>$7,p_type=>$8,p_expected=>$9,p_project=>$10) AS r'
let db: pg.Client, owner: string, member: string, group: string, device: string, theirs: string
async function user(id: string) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function service() { await db.query('RESET ROLE') }
const jobs = async (blob: string) => (await db.query('SELECT status FROM chat.file_blob_gc WHERE blob_id=$1', [blob])).rows
/** Time passes for this blob's job: it is due now. */
async function due(blob: string) { await db.query("UPDATE chat.file_blob_gc SET next_attempt_at=now()-interval '1 second' WHERE blob_id=$1", [blob]) }
async function claimed(blob: string) {
  // The claim only tries the inventory lock, which the scheduled kick takes every ten minutes: wait for it here instead.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota', 0))")
  return (await db.query('SELECT * FROM chat.file_blob_gc_claim(500,600)')).rows.filter((row) => row.blob_id === blob)
}
/** A file put into the group folder through the ordinary managed upload path. */
async function placed(as: string) {
  await user(as)
  const permit = (await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,60,$4) AS r', [randomUUID(), group, as, 'application/pdf'])).rows[0].r
  await service()
  const blob = (await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,60,$4)', [as, permit.staging_key, randomUUID().replaceAll('-', '').repeat(2), 'application/pdf'])).rows[0].blob_id as string
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)', [permit.staging_key, as])
  await user(as)
  const item = (await db.query('SELECT id FROM chat.file_place_as($1,$2,$3,$4)', [permit.staging_key, group, as, 'report.pdf'])).rows[0].id as string
  await service()
  return { blob, item }
}

beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw Error('Collector contracts require an isolated loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  // The collection queue is shared by the whole database: hold the same lock as every other test that claims.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('tests:file_blob_gc', 0))")
  ;[owner, member, group, device, theirs] = Array.from({ length: 5 }, randomUUID)
  for (const id of [owner, member]) await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`, [id, id + '@collector.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','collector',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [group, owner, member])
  for (const [id, account] of [[device, owner], [theirs, member]]) await db.query(
    "INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", [id, account])
  await db.query("INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id) VALUES($1,$2,'root','fixture','/fixture',now(),$3)", [device, owner, group])
  const baseline = Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings",
    [{ ...settings, storage_global_bytes: baseline + settings.storage_global_bytes }])
})
afterEach(async () => { await db.query('ROLLBACK') })

describe('every lost holder reaches the one collector, once', () => {
  it('a folder delete queues the bytes once; they are collected once, after the upload registration lapses', async () => {
    const { blob, item } = await placed(member)
    expect(await jobs(blob)).toEqual([])
    await user(member); await db.query('SELECT * FROM chat.workspace_delete_as($1,$2)', [item, member]); await service()
    expect(await jobs(blob)).toEqual([{ status: 'pending' }])
    await due(blob)
    // The upload registration ends by a row delete (its sweep), which queues again: the job may go.
    expect(await claimed(blob)).toEqual([])
    expect(await jobs(blob)).toEqual([])
    await db.query("UPDATE chat.file_blob_uploads SET expires_at=now()-interval '1 second' WHERE blob_id=$1", [blob])
    await db.query('SELECT chat.file_blob_sweep()')
    expect(await jobs(blob)).toEqual([{ status: 'pending' }])
    await due(blob)
    expect(await claimed(blob)).toHaveLength(1)
    expect(await claimed(blob)).toEqual([])
    expect(await jobs(blob)).toEqual([{ status: 'running' }])
  })

  it('a temporary copy retired inside its upload window keeps its job until the signed upload lapses, then is collected once', async () => {
    const item = randomUUID()
    await user(owner); await db.query(PUBLISH, [item, group, device, 'data/file.bin', 'ab'.repeat(32), 123, 'file.bin', 'application/octet-stream', null, 'root'])
    await user(member); await db.query(PUBLISH, [item, group, theirs, item + '/file.bin', 'cd'.repeat(32), 123, 'file.bin', 'application/octet-stream', 1, 'device-store'])
    const asked = (await db.query('SELECT chat.file_temporary_request($1,$2,$3) AS r', [{ item_id: item, version: 1 }, member, randomUUID()])).rows[0].r
    await user(owner)
    await db.query('SELECT chat.file_temporary_accept($1,$2)', [asked.transfer_id, 64])
    await service()
    await db.query('SELECT chat.file_temporary_commit($1,$2,$3,$4,$5)', [asked.transfer_id, owner, 'ef'.repeat(32), 64, 'A'.repeat(42) + 'A='])
    const blob = (await db.query('SELECT blob_id FROM chat.file_temporary_transfers WHERE id=$1', [asked.transfer_id])).rows[0].blob_id as string
    const window = (await db.query("SELECT expires_at FROM chat.file_transfer_reservations WHERE id=$1 AND kind='upload' AND state='issued' AND expires_at>now()", [asked.transfer_id])).rows
    expect(window).toHaveLength(1)
    // Read once: its serving time ends while the signed upload is still open.
    await db.query("UPDATE chat.file_temporary_transfers SET serve_until=now()-interval '1 second' WHERE id=$1", [asked.transfer_id])
    expect((await db.query('SELECT chat.file_temporary_expire(500) AS n')).rows[0].n).toBeGreaterThanOrEqual(1)
    expect(await jobs(blob)).toEqual([{ status: 'pending' }])
    expect(await claimed(blob)).toEqual([])
    // Nothing fires when the upload capability lapses, so the job waits for exactly that moment instead of going away.
    expect((await db.query('SELECT next_attempt_at FROM chat.file_blob_gc WHERE blob_id=$1', [blob])).rows).toEqual([{ next_attempt_at: window[0].expires_at }])
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE id=$1", [asked.transfer_id])
    await due(blob)
    expect(await claimed(blob)).toMatchObject([{ blob_id: blob, bucket_id: 'temporary' }])
    expect(await claimed(blob)).toEqual([])
  })

  it('an account erasure queues the erased owner\'s unreferenced objects in the same queue, once; referenced ones stay', async () => {
    const stray = `${group}/${member}/${randomUUID()}.bin`, avatar = `${member}/group-avatar/${randomUUID()}.png`
    await db.query("INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES('workspace',$1,$2,'{\"size\":5,\"mimetype\":\"application/zip\"}'),('chat-media',$3,$2,NULL)", [stray, member, avatar])
    await db.query("UPDATE chat.chats SET avatar_url=$1,avatar_storage_bucket_id='chat-media',avatar_storage_object_name=$2 WHERE id=$3",
      [`http://127.0.0.1:54321/storage/v1/object/public/chat-media/${avatar}`, avatar, group])
    expect((await db.query("SELECT to_regclass('identity.storage_object_deletion_outbox') AS t")).rows[0].t).toBeNull()

    await db.query('DELETE FROM auth.users WHERE id=$1::uuid', [member])
    const queued = (await db.query(`SELECT b.bucket_id,b.object_name,b.size_bytes,b.content_type,g.status FROM chat.file_blob_gc g
      JOIN chat.file_blobs b ON b.id=g.blob_id WHERE b.object_name=ANY($1)`, [[stray, avatar]])).rows
    expect(queued).toEqual([{ bucket_id: 'workspace', object_name: stray, size_bytes: '5', content_type: 'application/zip', status: 'pending' }])
    const blob = (await db.query("SELECT id FROM chat.file_blobs WHERE bucket_id='workspace' AND object_name=$1", [stray])).rows[0].id as string
    await due(blob)
    expect(await claimed(blob)).toMatchObject([{ bucket_id: 'workspace', object_name: stray }])
    expect(await claimed(blob)).toEqual([])
  })
})
