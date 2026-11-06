import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Read authorization outlives archive/list visibility. Only the last irreversible reader removal releases bytes;
// all reference families and the collector use the same conversation_gone -> reference_expired -> held_until chain.
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
async function send(chat: string, as: string, sha = randomUUID().replaceAll('-', '').repeat(2), whisper = false) {
  await user(as)
  const permit = (await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,60,$4) AS r', [randomUUID(), chat, as, 'application/pdf'])).rows[0].r
  await service()
  const blob = (await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,60,$4)', [as, permit.staging_key, sha, 'application/pdf'])).rows[0].blob_id as string
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)', [permit.staging_key, as])
  await user(as)
  const message = randomUUID()
  const sent = (await db.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,$7)', [permit.staging_key, message, chat, as, 'report.pdf', whisper ? [owner] : [], whisper])).rows[0]
  await service()
  // The upload registration lapses and is swept, as it is an hour later.
  await db.query("UPDATE chat.file_blob_uploads SET expires_at=now()-interval '1 second' WHERE blob_id=$1", [blob])
  await db.query('SELECT chat.file_blob_sweep()')
  return { blob, sha, message, item: sent.file_item_id as string }
}
async function gone(chat: string) { return (await db.query('SELECT chat.conversation_gone($1) AS gone', [chat])).rows[0].gone }
async function readable(ref: unknown, actor = member) {
  await user(actor)
  const result = (await db.query('SELECT chat.file_resolve_as($1,$2) AS r', [ref, actor])).rows[0].r
  const download = (await db.query('SELECT chat.file_transfer_download_as($1,$2,$3) AS r', [ref, actor, randomUUID()])).rows[0].r
  await service()
  expect(result.status).toBe('ready')
  expect(download.status).toBe('ready')
}
async function queue(blob: string) { await db.query('SELECT chat.file_blob_enqueue($1)', [blob]) }
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

describe('historical readers keep bytes through archive and the one collector', () => {
  it('an archived group retains message and folder downloads even after a mistaken job becomes due', async () => {
    const { blob, message, item } = await send(group, member)
    expect(await collected(blob)).toEqual([])
    await user(owner); await db.query('SELECT chat.archive_group_as($1,$2)', [group, owner]); await service()
    expect(await gone(group)).toBe(false)
    await queue(blob)
    expect(await collected(blob)).toEqual([])
    expect(await jobs(blob)).toEqual([])
    await readable({ message_id: message })
    await readable({ item_id: item, version: 1 })
    expect((await db.query('SELECT state FROM chat.file_blobs WHERE id=$1', [blob])).rows).toEqual([{ state: 'live' }])
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

  it('removing one reader preserves an archived group; removing its last reader queues and collects it', async () => {
    const { blob } = await send(group, member)
    await db.query("UPDATE chat.chats SET status='archived' WHERE id=$1", [group])
    await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1', [owner])
    expect(await gone(group)).toBe(false)
    expect(await collected(blob)).toEqual([])
    await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1', [member])
    expect(await gone(group)).toBe(true)
    expect(await jobs(blob)).toEqual([{ status: 'pending' }])
    const [claim] = await collected(blob)
    expect(claim).toMatchObject({ blob_id: blob })
    await db.query('SELECT chat.file_blob_gc_finish($1,$2)', [blob, claim.claim_token])
    expect((await db.query('SELECT state FROM chat.file_transfer_storage WHERE blob_id=$1', [blob])).rows).toEqual([{ state: 'gone' }])
  })

  it('an archived topic uses its readable source container', async () => {
    const topic = randomUUID()
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id) VALUES($1,'topic','topic',$2,$3)", [topic, owner, group])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [topic, owner, member])
    const file = await send(topic, member)
    await db.query("UPDATE chat.chats SET status='archived' WHERE id IN ($1,$2)", [topic, group])
    expect(await gone(topic)).toBe(false)
    await queue(file.blob)
    expect(await collected(file.blob)).toEqual([])
    await readable({ message_id: file.message })
  })
})

describe('all historical reference families retain the same collector protection', () => {
  it('keeps a replaced folder file through its exact historical version after group archival', async () => {
    const pointer = `${group}/${owner}/${randomUUID()}-old.pdf`
    const next = `${group}/${owner}/${randomUUID()}-new.pdf`
    for (const name of [pointer, next]) await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('workspace',$1)", [name])
    await user(owner)
    const item = (await db.query('SELECT * FROM chat.workspace_create_file_as($1,$2,$3,$4,60,$5)', [group, owner, 'old.pdf', 'application/pdf', pointer])).rows[0].id
    await db.query('SELECT * FROM chat.workspace_replace_file_as($1,$2,$3,60,NULL,NULL)', [item, owner, next])
    await service()
    const blob = (await db.query("SELECT id FROM chat.file_blobs WHERE bucket_id='workspace' AND object_name=$1", [pointer])).rows[0].id
    await db.query("UPDATE chat.chats SET status='archived' WHERE id=$1", [group])
    await queue(blob)
    expect(await collected(blob)).toEqual([])
    await readable({ item_id: item, version: 1 }) // gugu-file://<item>?v=1
    await readable({ item_id: item, version: 2 })
  })

  it.each(['message', 'avatar', 'output'])('keeps an archived group legacy %s object without a blob-id pointer', async kind => {
    const name = `${group}/${owner}/${randomUUID()}.pdf`
    const url = `http://127.0.0.1/storage/v1/object/public/chat-media/${name}`
    await db.query("INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('chat-media',$1,'{\"size\":60,\"mimetype\":\"application/pdf\"}')", [name])
    const message = randomUUID()
    if (kind === 'message') await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,storage_bucket_id,storage_object_name)
      VALUES($1,$2,$3,$4,'attachment','chat-media',$5)`, [message, group, owner, `[附件] old.pdf (application/pdf)\n[URL] ${url}`, name])
    if (kind === 'avatar') await db.query("UPDATE chat.chats SET avatar_url=$1,avatar_storage_bucket_id='chat-media',avatar_storage_object_name=$2 WHERE id=$3", [url, name, group])
    if (kind === 'output') await db.query("INSERT INTO chat.group_outputs(chat_id,name,url,storage_bucket_id,storage_object_name) VALUES($1,'output.pdf',$2,'chat-media',$3)", [group, url, name])
    const blob = (await db.query("SELECT chat.file_blob_for_object('chat-media',$1) AS id", [name])).rows[0].id
    await db.query("UPDATE chat.chats SET status='archived' WHERE id=$1", [group])
    await queue(blob)
    expect(await collected(blob)).toEqual([])
    expect((await db.query("SELECT chat.file_blob_held_until($1)='infinity'::timestamptz AS held", [blob])).rows[0].held).toBe(true)
    if (kind === 'message') await readable({ message_id: message })
  })

  it('keeps a direct message blob with no workspace item', async () => {
    const file = await send(group, member, undefined, true)
    expect(file.item).toBeNull() // A whispered attachment has only a message blob, and no folder entry.
    await db.query("UPDATE chat.chats SET status='archived' WHERE id=$1", [group])
    expect(await collected(file.blob)).toEqual([])
    await readable({ message_id: file.message }, owner)
  })

  it('keeps a private session attachment even when its group has no readers', async () => {
    const file = await send(group, member), device = randomUUID(), sender = randomUUID(), receiver = randomUUID(), attachment = randomUUID()
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", [device, owner])
    for (const agent of [sender, receiver]) await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','fixture',$2,$3)", [agent, owner, device])
    const key = `staging/${owner}/${randomUUID()}`
    await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,60,$4)', [owner, key, file.sha, 'application/pdf'])
    await user(owner)
    await db.query('SELECT * FROM chat.session_attachment_commit($1,$2,$3,$4,$5,$6)', [key, attachment, sender, 'fixture', [receiver], 'private.pdf'])
    await service()
    await db.query("UPDATE chat.file_blob_uploads SET expires_at=now()-interval '1 second' WHERE blob_id=$1", [file.blob])
    await db.query('UPDATE identity.users SET removed_at=now() WHERE id IN ($1,$2)', [owner, member])
    expect(await gone(group)).toBe(true)
    expect(await collected(file.blob)).toEqual([])
    await db.query('UPDATE chat.session_attachments SET revoked_at=now() WHERE id=$1', [attachment])
    await queue(file.blob)
    expect(await collected(file.blob)).toMatchObject([{ blob_id: file.blob }])
  })

  it('the forward repair removes readable queued stock while preserving independent idle expiry and in-flight work', async () => {
    const kept = await send(group, member), expired = await send(group, member), running = await send(group, member)
    await db.query("UPDATE chat.chats SET status='archived' WHERE id=$1", [group])
    for (const file of [kept, expired, running]) await queue(file.blob)
    await db.query('UPDATE chat.file_transfer_storage_refs SET expired_at=now() WHERE storage_id IN (SELECT id FROM chat.file_transfer_storage WHERE blob_id=$1)', [expired.blob])
    await db.query("UPDATE chat.file_blob_gc SET status='running',claim_token=$2,claimed_at=now() WHERE blob_id=$1", [running.blob, randomUUID()])
    const due = (await db.query('SELECT next_attempt_at FROM chat.file_blob_gc WHERE blob_id=$1', [expired.blob])).rows[0].next_attempt_at
    await db.query(readFileSync(new URL('../../../supabase/migrations/20261106143000_keep_readable_conversation_bytes.sql', import.meta.url), 'utf8'))
    expect(await jobs(kept.blob)).toEqual([])
    expect(await jobs(running.blob)).toEqual([{ status: 'running' }])
    expect((await db.query('SELECT next_attempt_at FROM chat.file_blob_gc WHERE blob_id=$1', [expired.blob])).rows[0].next_attempt_at).toEqual(due)
    expect(await collected(expired.blob)).toMatchObject([{ blob_id: expired.blob }])
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

  it('list deletion and later agent removal leave the hidden owner able to read', async () => {
    const { blob, message } = await send(dm, owner)
    await archiveAgent(); await deleteDm()
    expect(await collected(blob)).toEqual([])
    await removeAgent()
    expect(await gone(dm)).toBe(false)
    await queue(blob)
    expect(await collected(blob)).toEqual([])
    await readable({ message_id: message }, owner)
  })

  it('agent removal followed by owner list deletion retains the same read authorization', async () => {
    const { blob, message } = await send(dm, owner)
    await removeAgent()
    expect(await collected(blob)).toEqual([])
    await deleteDm()
    expect(await gone(dm)).toBe(false)
    await queue(blob)
    expect(await collected(blob)).toEqual([])
    await readable({ message_id: message }, owner)
    // Only irreversible identity removal ends the remaining read authorization.
    await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1', [owner])
    expect(await gone(dm)).toBe(true)
    expect(await collected(blob)).toEqual([]) // The already issued download must outlive its capability.
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE kind='download' AND chat_id=$1", [dm])
    expect(await collected(blob)).toMatchObject([{ blob_id: blob }])
  })

  it('an archived DM with live seats preserves both direct and exact-version reads', async () => {
    const file = await send(dm, owner)
    await db.query("UPDATE chat.chats SET status='archived' WHERE id=$1", [dm])
    expect(await gone(dm)).toBe(false)
    await queue(file.blob)
    expect(await collected(file.blob)).toEqual([])
    await readable({ message_id: file.message }, owner)
    await readable({ item_id: file.item, version: 1 }, owner)
  })
})
