import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const settings = {
  inventory_ready:true, storage_global_bytes:100000, storage_account_bytes:100000, storage_group_bytes:100000,
  download_global_bytes:100000, download_account_bytes:100000, download_group_bytes:100000,
  upload_permit_seconds:120, upload_edge_seconds:400, upload_sign_seconds:900, upload_inflight_seconds:600, sign_window_seconds:60, sign_account_count:100, sign_group_count:100,
  file_max_bytes:10000, storage_warning_percent:80,
}
let db:pg.Client, host:string, member:string, project:string, plain:string, device:string, outsider:string
async function user(id=member) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:id,role:'authenticated'})])
}
async function service() { await db.query('RESET ROLE') }
async function reject(sql:string,args:unknown[]=[]) {
  await db.query('SAVEPOINT denied')
  try { await db.query(sql,args) } catch(error) {
    await db.query('ROLLBACK TO SAVEPOINT denied'); return error as pg.DatabaseError
  }
  throw Error('Expected refusal: '+sql)
}
/** The account's one global file storage setting, written the way the client writes it. The sender's by default. */
async function storage(values:Record<string,unknown>,account=member) {
  await user(account)
  await db.query(`INSERT INTO identity.user_settings(user_id,scope,config) VALUES($1,'user',jsonb_build_object('file_storage',$2::jsonb))
    ON CONFLICT(user_id,scope) DO UPDATE SET config=identity.user_settings.config||EXCLUDED.config`,[account,values])
  await service()
}
/** A member sends an image (or another file) as a chat attachment, through the ordinary managed upload path. */
async function send(target=project,sha=randomUUID().replaceAll('-','').repeat(2),type='image/png') {
  await user()
  const permit=(await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,60,$4) AS r',[randomUUID(),target,member,type])).rows[0].r
  await service()
  const blob=(await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,60,$4)',[member,permit.staging_key,sha,type])).rows[0]
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)',[permit.staging_key,member])
  await user()
  const message=randomUUID()
  await db.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5)',[permit.staging_key,message,target,member,'shot.png'])
  await service()
  const stored=(await db.query('SELECT id FROM chat.file_transfer_storage WHERE blob_id=$1',[blob.blob_id])).rows[0].id as string
  return {blob:blob.blob_id as string,stored,message,sha}
}
async function ref(stored:string,chat=project) {
  return (await db.query(`SELECT expired_at,expires_at,extract(epoch FROM expires_at-now()) AS seconds
    FROM chat.file_transfer_storage_refs WHERE storage_id=$1 AND chat_id=$2`,[stored,chat])).rows[0]
}
async function due(stored:string) {
  await db.query("UPDATE chat.file_transfer_storage_refs SET expires_at=now()-interval '1 second' WHERE storage_id=$1 AND chat_id=$2",[stored,project])
}
async function expire() { return (await db.query('SELECT chat.file_transfer_expire(500) AS n')).rows[0].n as number }
async function status(message:string) {
  await user()
  const r=(await db.query('SELECT chat.file_resolve_as($1,$2) AS r',[{message_id:message},member])).rows[0].r
  const row=(await db.query('SELECT file_metadata FROM chat.messages_view WHERE id=$1',[message])).rows[0]
  expect(row.file_metadata.status).toBe(r.status)
  await service();return r.status as string
}
const sha=()=>randomUUID().replaceAll('-','').repeat(2)
/** The sender uploads a preview with no chat and offers it for the bytes `original` (attachments `file-preview`). */
async function offer(account:string,original:string,type='image/webp',bytes=40) {
  await user(account)
  const permit=(await db.query('SELECT chat.file_managed_upload_as($1,NULL,$2,$3,$4) AS r',[randomUUID(),account,bytes,type])).rows[0].r
  await service()
  const blob=(await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)',[account,permit.staging_key,sha(),bytes,type])).rows[0].blob_id as string
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)',[permit.staging_key,account])
  return {blob,key:permit.staging_key as string,
    offered:async()=>(await db.query('SELECT chat.file_preview_offer($1,$2,$3) AS r',[account,permit.staging_key,original])).rows[0].r}
}
async function resolved(ref:Record<string,unknown>,as=member) {
  await user(as);const r=(await db.query('SELECT chat.file_resolve_as($1,$2) AS r',[ref,as])).rows[0].r;await service();return r
}
async function previewDownload(ref:Record<string,unknown>,as=member) {
  await user(as);const r=(await db.query('SELECT chat.file_preview_download_as($1,$2,$3) AS r',[ref,as,randomUUID()])).rows[0].r;await service();return r
}
async function claimable(blob:string) {
  await db.query("UPDATE chat.file_blob_uploads SET expires_at=now()-interval '1 second' WHERE blob_id=$1",[blob])
  // A signed download holds its bytes until it lapses: lapse it the way time would.
  await db.query(`UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE kind='download'
    AND subject IN (SELECT 'object:'||id::text FROM chat.file_transfer_storage WHERE blob_id=$1)`,[blob])
  await db.query('SELECT chat.file_blob_enqueue($1)',[blob])
  await db.query('UPDATE chat.file_blob_gc SET next_attempt_at=now() WHERE blob_id=$1',[blob])
  return (await db.query('SELECT * FROM chat.file_blob_gc_claim(50,600)')).rows.some(row=>row.blob_id===blob)
}
async function collect(blob:string) {
  await db.query("UPDATE chat.file_blob_uploads SET expires_at=now()-interval '1 second' WHERE blob_id=$1",[blob])
  // A signed download holds its bytes until it lapses: lapse it the way time would.
  await db.query(`UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE kind='download'
    AND subject IN (SELECT 'object:'||id::text FROM chat.file_transfer_storage WHERE blob_id=$1)`,[blob])
  return (await db.query('SELECT * FROM chat.file_blob_gc_claim(50,600)')).rows.find(row=>row.blob_id===blob)
}
beforeAll(async()=>{
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw Error('Image contracts require an isolated loopback database')
  db=new pg.Client({connectionString:url});await db.connect()
})
afterAll(async()=>{await db?.end()})
beforeEach(async()=>{
  await db.query('BEGIN')
  ;[host,member,project,plain,device,outsider]=Array.from({length:6},randomUUID)
  for (const id of [host,member,outsider]) await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())",[id,id+'@image-expiry.invalid'])
  for (const [id,name] of [[project,'project'],[plain,'plain']]) {
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group',$2,$3)",[id,name,host])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[id,host,member])
  }
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')",[device,host])
  await db.query("INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id) VALUES($1,$2,'root','fixture','/fixture',now(),$3)",[device,host,project])
  // What publish_device_projects records for a bound project (20261109210000_project_groups).
  await db.query('INSERT INTO chat.project_groups(chat_id) VALUES($1) ON CONFLICT DO NOTHING',[project])
  const baseline=Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings",[{...settings,storage_global_bytes:baseline+settings.storage_global_bytes}])
})
afterEach(async()=>{await db.query('ROLLBACK')})
describe('an image in a project chat is a file',()=>{
  it('is stored like any file: no expiry of its own, whatever image_retention says',async()=>{
    await storage({image_retention:'1d'})
    expect((await ref((await send()).stored)).expires_at).toBeNull()
    expect((await ref((await send(plain)).stored,plain)).expires_at).toBeNull()
    expect(await expire()).toBe(0)
  })
  it('expires a due copy through the expiry entry point without any deployment idle policy',async()=>{
    const image=await send();await due(image.stored)
    await db.query("DELETE FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*'")
    expect(await expire()).toBe(1)
    expect((await ref(image.stored)).expired_at).not.toBeNull()
    expect(await status(image.message)).toBe('expired')
    expect(await collect(image.blob)).toMatchObject({blob_id:image.blob})
    expect(await expire()).toBe(0)
  })
  it('keeps the bytes while the same image is referenced by an ordinary chat',async()=>{
    const image=await send(),copy=await send(plain,image.sha)
    expect(copy.stored).toBe(image.stored)
    await due(image.stored);expect(await expire()).toBe(1)
    expect(await status(image.message)).toBe('expired')
    expect(await status(copy.message)).toBe('ready')
    expect(await collect(image.blob)).toBeUndefined()
  })
  it('does not expire a copy with a live download capability until that capability ends',async()=>{
    const image=await send(),id=randomUUID()
    await user();expect((await db.query('SELECT chat.file_transfer_download_as($1,$2,$3) AS r',[{message_id:image.message},member,id])).rows[0].r.status).toBe('ready')
    await service();await due(image.stored)
    expect(await expire()).toBe(0)
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE id=$1",[id])
    expect(await expire()).toBe(1)
  })
  it('brings an expired copy back, kept, when the same bytes are sent again',async()=>{
    const image=await send();await due(image.stored);expect(await expire()).toBe(1)
    const again=await send(project,image.sha)
    expect(again.stored).toBe(image.stored)
    expect(await ref(image.stored)).toMatchObject({expired_at:null,expires_at:null})
    await user();expect((await db.query('SELECT chat.file_transfer_download_as($1,$2,$3) AS r',[{message_id:again.message},member,randomUUID()])).rows[0].r.status).toBe('ready')
    await service();expect(await expire()).toBe(0)
  })
  it('accepts only known file storage values in the account setting',async()=>{
    for (const value of [{image_retention:'read-once'},{image_retention:'2d'},{retention:'forever'},{proactive_upload:'yes'},{image_retention:['7d']},{unknown:true}]) {
      await user(host)
      expect((await reject(`INSERT INTO identity.user_settings(user_id,scope,config) VALUES($1,'user',jsonb_build_object('file_storage',$2::jsonb))`,[host,value])).code).toBe('23514')
    }
    await service()
    await storage({proactive_upload:false,temporary_transfer:false,retention:'read-once',image_retention:'30d'})
    expect((await db.query('SELECT chat.file_storage_of($1) AS p',[member])).rows[0].p)
      .toEqual({proactive_upload:false,temporary_transfer:false,retention:'read-once',image_retention:'30d',temporary_retention:'7d'})
  })
})

describe('an image\'s preview goes up with it and stays',()=>{
  it('is taken by the version its sender sends, and read through the same door as the file',async()=>{
    const original=sha(),preview=await offer(member,original)
    expect(await preview.offered()).toMatchObject({status:'ready',blob_id:preview.blob})
    const image=await send(project,original)
    const r=await resolved({message_id:image.message})
    expect(r.status).toBe('ready')
    expect(r.preview).toEqual({sha256:expect.stringMatching(/^[0-9a-f]{64}$/),size_bytes:40,content_type:'image/webp'})
    const signed=await previewDownload({message_id:image.message},host)
    expect(signed).toMatchObject({status:'ready',bucket_id:'oss',content_type:'image/webp',size_bytes:40,sha256:r.preview.sha256})
    expect(signed.object_name).toBe((await db.query('SELECT object_name FROM chat.file_blobs WHERE id=$1',[preview.blob])).rows[0].object_name)
    // Not for someone outside the chat.
    expect((await resolved({message_id:image.message},outsider)).preview).toBeUndefined()
    expect(await previewDownload({message_id:image.message},outsider)).toEqual({status:'gone'})
    // The preview is not one of the sender's cloud files: no reference, no usage row.
    expect((await db.query('SELECT count(*)::int AS n FROM chat.file_transfer_storage_refs r JOIN chat.file_transfer_storage o ON o.id=r.storage_id WHERE o.blob_id=$1',[preview.blob])).rows[0].n).toBe(0)
  })
  it('outlives the original\'s cloud copy, and is collected only when no version names it',async()=>{
    const original=sha(),preview=await offer(member,original)
    await preview.offered()
    const image=await send(project,original)
    await due(image.stored);expect(await expire()).toBe(1)
    const r=await resolved({message_id:image.message})
    expect(r.status).toBe('expired')
    expect(r.preview).toMatchObject({content_type:'image/webp'})
    expect((await previewDownload({message_id:image.message})).status).toBe('ready')
    expect(await collect(image.blob)).toMatchObject({blob_id:image.blob})
    expect(await claimable(preview.blob)).toBe(false)
    // The file goes: its versions go, and the preview with them.
    const item=(await db.query('SELECT file_item_id FROM chat.messages WHERE id=$1',[image.message])).rows[0].file_item_id
    await db.query('DELETE FROM chat.messages WHERE id=$1',[image.message])
    await db.query('DELETE FROM chat.workspace_items WHERE id=$1',[item])
    expect((await db.query('SELECT blob_id FROM chat.file_blob_gc WHERE blob_id=$1',[preview.blob])).rows).toHaveLength(1)
    expect(await claimable(preview.blob)).toBe(true)
  })
  it('follows the same bytes into other chats, and reaches versions sent before it was offered',async()=>{
    const original=sha(),image=await send(project,original)
    expect((await resolved({message_id:image.message})).preview).toBeUndefined()
    const preview=await offer(member,original);await preview.offered()
    expect((await resolved({message_id:image.message})).preview).toMatchObject({content_type:'image/webp'})
    const copy=await send(plain,original)
    expect((await resolved({message_id:copy.message})).preview).toMatchObject({content_type:'image/webp'})
  })
  it('is taken by a version its device keeps, for the device\'s own account only',async()=>{
    const original=sha(),preview=await offer(host,original);await preview.offered()
    await user(host)
    const local=(await db.query("SELECT chat.file_device_publish($1,$2,$3,'shot.png',$4,60,'shot.png','image/png',NULL,NULL) AS r",[randomUUID(),project,device,original])).rows[0].r
    await service()
    expect((await resolved({item_id:local.item_id})).preview).toMatchObject({content_type:'image/webp'})
    // The same sha offered by someone else names nothing of theirs.
    const other=sha(),theirs=await offer(member,other);await theirs.offered()
    await user(host)
    const unrelated=(await db.query("SELECT chat.file_device_publish($1,$2,$3,'b.png',$4,60,'b.png','image/png',NULL,NULL) AS r",[randomUUID(),project,device,other])).rows[0].r
    await service()
    expect((await resolved({item_id:unrelated.item_id})).preview).toBeUndefined()
  })
  it('is an upload of the caller\'s own',async()=>{
    const mine=await offer(member,sha())
    expect((await reject('SELECT chat.file_preview_offer($1,$2,$3)',[host,mine.key,sha()])).hint).toBe('file_transfer_conflict')
  })
})
