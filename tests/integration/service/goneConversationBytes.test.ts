import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// A conversation nobody can reach again stops holding bytes (20261105100000): a dissolved group, a group archived by
// its owner's erasure, and a DM once no live member still has it. Its references are marked lost and its blobs go to the
// one collection queue; the claim collects them unless another live conversation still holds the same bytes.
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const settings = {
  inventory_ready: true, storage_global_bytes: 100000, storage_account_bytes: 100000, storage_group_bytes: 100000,
  download_global_bytes: 100000, download_account_bytes: 100000, download_group_bytes: 100000,
  upload_permit_seconds: 300, sign_window_seconds: 60, sign_account_count: 100, sign_group_count: 100,
  file_max_bytes: 10000, storage_warning_percent: 80,
}
let db: pg.Client, owner: string, member: string, group: string, other: string
async function user(id: string) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function service() { await db.query('RESET ROLE') }
/** A member sends a file as a chat attachment through the ordinary managed upload path. */
async function send(chat: string, as: string, sha = randomUUID().replaceAll('-', '').repeat(2)) {
  await user(as)
  const permit = (await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,60,$4) AS r', [randomUUID(), chat, as, 'application/pdf'])).rows[0].r
  await service()
  const blob = (await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,60,$4)', [as, permit.staging_key, sha, 'application/pdf'])).rows[0].blob_id as string
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)', [permit.staging_key, as])
  await user(as)
  await db.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5)', [permit.staging_key, randomUUID(), chat, as, 'report.pdf'])
  await service()
  // The upload registration lapses and is swept, as it is an hour later.
  await db.query("UPDATE chat.file_blob_uploads SET expires_at=now()-interval '1 second' WHERE blob_id=$1", [blob])
  await db.query('SELECT chat.file_blob_sweep()')
  return { blob, sha }
}
const jobs = async (blob: string) => (await db.query('SELECT status FROM chat.file_blob_gc WHERE blob_id=$1', [blob])).rows
/** Time passes until whatever is queued for this blob is due, then the collector claims. */
async function collected(blob: string) {
  await db.query("UPDATE chat.file_blob_gc SET next_attempt_at=now()-interval '1 second' WHERE blob_id=$1", [blob])
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota', 0))")
  return (await db.query('SELECT * FROM chat.file_blob_gc_claim(500,600)')).rows.filter((row) => row.blob_id === blob)
}

beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw Error('Conversation byte contracts require an isolated loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('tests:file_blob_gc', 0))")
  ;[owner, member, group, other] = Array.from({ length: 4 }, randomUUID)
  for (const id of [owner, member]) await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`, [id, id + '@gone-conversation.invalid'])
  for (const id of [group, other]) {
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','gone conversation',$2)", [id, owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [id, owner, member])
  }
  const baseline = Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings",
    [{ ...settings, storage_global_bytes: baseline + settings.storage_global_bytes }])
})
afterEach(async () => { await db.query('ROLLBACK') })

describe('a conversation that cannot come back releases its bytes through the one collector', () => {
  it('a dissolved group: its files are queued, collected, and the archived rows keep a blob identity with no bytes', async () => {
    const { blob } = await send(group, member)
    expect(await collected(blob)).toEqual([])
    await user(owner); await db.query('SELECT chat.archive_group_as($1,$2)', [group, owner]); await service()
    expect(await jobs(blob)).toEqual([{ status: 'pending' }])
    const [claim] = await collected(blob)
    expect(claim).toMatchObject({ blob_id: blob, bucket_id: 'oss' })
    await db.query('SELECT chat.file_blob_gc_finish($1,$2)', [blob, claim.claim_token])
    expect((await db.query('SELECT b.state, o.state AS bytes FROM chat.file_blobs b JOIN chat.file_transfer_storage o ON o.blob_id=b.id WHERE b.id=$1', [blob])).rows)
      .toEqual([{ state: 'live', bytes: 'gone' }])
    expect(await jobs(blob)).toEqual([])
  })

  it('a dissolved group does not take bytes another live group still holds', async () => {
    const { blob, sha } = await send(group, member)
    await send(other, member, sha)
    await user(owner); await db.query('SELECT chat.archive_group_as($1,$2)', [group, owner]); await service()
    expect(await collected(blob)).toEqual([])
  })

  it('a group archived by its owner\'s account erasure releases its files the same way', async () => {
    const solo = randomUUID()
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','solo',$2)", [solo, owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [solo, owner])
    const { blob } = await send(solo, owner)
    await db.query('DELETE FROM auth.users WHERE id=$1::uuid', [owner])
    expect((await db.query('SELECT status FROM chat.chats WHERE id=$1', [solo])).rows).toEqual([{ status: 'archived' }])
    expect(await collected(blob)).toMatchObject([{ blob_id: blob }])
  })
})

describe('a deleted DM keeps its bytes while the other side can still see it', () => {
  let agent: string, device: string, dm: string
  beforeEach(async () => {
    ;[agent, device, dm] = Array.from({ length: 3 }, randomUUID)
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Fixture','fixture','linux')", [device, owner])
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','DM agent',$2,$3)", [agent, owner, device])
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'dm','dm',$2)", [dm, owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [dm, owner, agent])
    await db.query('UPDATE chat.chat_members SET inbox_published_at=clock_timestamp() WHERE chat_id=$1', [dm])
  })
  const archiveAgent = () => db.query("UPDATE identity.users SET session_archived_at=now() WHERE id=$1", [agent])
  const deleteDm = async () => { await user(owner); await db.query('SELECT chat.delete_my_dm_conversation($1)', [dm]); await service() }
  const removeAgent = async () => { await user(owner); await db.query('SELECT identity.archive_user($1,true)', [agent]); await service() }

  it('deleted by its owner while the archived agent can still be restored: kept; once the agent is removed: collected', async () => {
    const { blob } = await send(dm, owner)
    await archiveAgent(); await deleteDm()
    expect(await collected(blob)).toEqual([])
    await removeAgent()
    expect(await jobs(blob)).toEqual([{ status: 'pending' }])
    expect(await collected(blob)).toMatchObject([{ blob_id: blob }])
  })

  it('the agent removed first, the owner deleting later: collected when the second side goes', async () => {
    const { blob } = await send(dm, owner)
    await removeAgent()
    expect(await collected(blob)).toEqual([])
    await deleteDm()
    expect(await collected(blob)).toMatchObject([{ blob_id: blob }])
  })
})
