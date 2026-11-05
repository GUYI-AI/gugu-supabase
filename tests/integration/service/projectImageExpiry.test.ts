import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const settings = {
  inventory_ready:true, storage_global_bytes:100000, storage_account_bytes:100000, storage_group_bytes:100000,
  download_global_bytes:100000, download_account_bytes:100000, download_group_bytes:100000,
  upload_permit_seconds:120, sign_window_seconds:60, sign_account_count:100, sign_group_count:100,
  file_max_bytes:10000, storage_warning_percent:80,
}
let db:pg.Client, host:string, member:string, project:string, plain:string
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
async function collect(blob:string) {
  await db.query("UPDATE chat.file_blob_uploads SET expires_at=now()-interval '1 second' WHERE blob_id=$1",[blob])
  return (await db.query('SELECT * FROM chat.file_blob_gc_claim(50,600)')).rows.find(row=>row.blob_id===blob)
}
beforeAll(async()=>{
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw Error('Image expiry contracts require an isolated loopback database')
  db=new pg.Client({connectionString:url});await db.connect()
})
afterAll(async()=>{await db?.end()})
beforeEach(async()=>{
  await db.query('BEGIN')
  ;[host,member,project,plain]=Array.from({length:4},randomUUID)
  const device=randomUUID()
  for (const id of [host,member]) await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())",[id,id+'@image-expiry.invalid'])
  for (const [id,name] of [[project,'project'],[plain,'plain']]) {
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group',$2,$3)",[id,name,host])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[id,host,member])
  }
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')",[device,host])
  await db.query("INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id) VALUES($1,$2,'root','fixture','/fixture',now(),$3)",[device,host,project])
  const baseline=Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings",[{...settings,storage_global_bytes:baseline+settings.storage_global_bytes}])
})
afterEach(async()=>{await db.query('ROLLBACK')})
describe('project chat images expire on their sender\'s global setting',()=>{
  it('fixes the expiry when an image is stored, from its sender\'s setting, only for project chats',async()=>{
    // Another account's setting, the project owner's included, does not apply to what this member sends.
    await storage({image_retention:'30d'},host)
    const week=await send()
    expect(Number((await ref(week.stored)).seconds)).toBeGreaterThan(7*86400-60)
    expect(Number((await ref(week.stored)).seconds)).toBeLessThanOrEqual(7*86400)
    await storage({image_retention:'1d'})
    const day=await send()
    expect(Number((await ref(day.stored)).seconds)).toBeLessThanOrEqual(86400)
    // A changed setting applies to new images only; existing expiries are not rewritten.
    expect(Number((await ref(week.stored)).seconds)).toBeGreaterThan(7*86400-60)
    expect((await ref((await send(plain)).stored,plain)).expires_at).toBeNull()
    // Any other file is uploaded as in an ordinary chat.
    expect((await ref((await send(project,undefined,'application/pdf')).stored)).expires_at).toBeNull()
    await storage({proactive_upload:true})
    expect((await ref((await send()).stored)).expires_at).toBeNull()
    expect(await expire()).toBe(0)
  })
  it('expires a due image through the idle entry point without any deployment idle policy',async()=>{
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
    expect((await ref(image.stored,plain)).expired_at).toBeNull()
    expect(await collect(image.blob)).toBeUndefined()
  })
  it('does not expire an image with a live download capability until that capability ends',async()=>{
    const image=await send(),id=randomUUID()
    await user();expect((await db.query('SELECT chat.file_transfer_download_as($1,$2,$3) AS r',[{message_id:image.message},member,id])).rows[0].r.status).toBe('ready')
    await service();await due(image.stored)
    expect(await expire()).toBe(0)
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE id=$1",[id])
    expect(await expire()).toBe(1)
  })
  it('restores an expired image sent again with a new interval',async()=>{
    const image=await send();await due(image.stored);expect(await expire()).toBe(1)
    await storage({image_retention:'30d'})
    const again=await send(project,image.sha)
    expect(again.stored).toBe(image.stored)
    const restored=await ref(image.stored)
    expect(restored.expired_at).toBeNull()
    expect(Number(restored.seconds)).toBeGreaterThan(30*86400-60)
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
