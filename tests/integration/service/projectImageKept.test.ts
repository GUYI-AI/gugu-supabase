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
let db:pg.Client, host:string, member:string, project:string, plain:string, memberDevice:string, otherDevice:string, hostDevice:string
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
  ;[memberDevice,otherDevice,hostDevice]=Array.from({length:3},randomUUID)
  const device=hostDevice
  for (const id of [host,member]) await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())",[id,id+'@image-expiry.invalid'])
  for (const [id,name] of [[project,'project'],[plain,'plain']]) {
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group',$2,$3)",[id,name,host])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[id,host,member])
  }
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')",[device,host])
  for (const [id,account] of [[memberDevice,member],[otherDevice,member]]) await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,status) VALUES($1,$2,'keeper','fixture','linux','online')",[id,account])
  await db.query("INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id) VALUES($1,$2,'root','fixture','/fixture',now(),$3)",[device,host,project])
  const baseline=Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings",[{...settings,storage_global_bytes:baseline+settings.storage_global_bytes}])
})
afterEach(async()=>{await db.query('ROLLBACK')})

const sha64=()=>randomUUID().replaceAll('-','').repeat(2)
async function pending(device:string,as=member) {
  await user(as);const rows=(await db.query('SELECT * FROM chat.file_device_adopt_pending($1)',[device])).rows;await service();return rows
}
async function itemOf(message:string) {
  return (await db.query('SELECT file_item_id FROM chat.messages WHERE id=$1',[message])).rows[0].file_item_id as string
}
async function adopt(item:string,device:string,sha:string,as=member,size=60) {
  await user(as);const r=(await db.query("SELECT chat.file_device_adopt($1,$2,'device-store','.gugu/attachments/x/shot.png',$3,$4) AS r",[item,device,sha,size])).rows[0].r;await service();return r as boolean
}
async function resolve(item:string,as=host) {
  await user(as);const r=(await db.query('SELECT chat.file_resolve_as($1,$2) AS r',[{item_id:item},as])).rows[0].r;await service();return r
}
async function listed(item:string,as=host) {
  await user(as);const rows=(await db.query('SELECT * FROM chat.workspace_list_as($1,$2)',[project,as])).rows;await service()
  return rows.find(row=>row.id===item)
}
const topics=async(topic:string)=>(await db.query('SELECT event FROM realtime.messages WHERE topic=$1',[topic])).rows.map(row=>row.event)
async function adopted() {
  const image=await send(),item=await itemOf(image.message)
  expect(await adopt(item,memberDevice,image.sha)).toBe(true)
  return {...image,item}
}

describe('a project image also kept by the machine that sent it',()=>{
  it('keeps file_resolve_as stable',async()=>{
    expect((await db.query("SELECT provolatile FROM pg_proc WHERE oid='chat.file_resolve_as(jsonb,text)'::regprocedure")).rows[0].provolatile).toBe('s')
  })
  it('lists a sent image for its sender\'s device once, and first keeper wins',async()=>{
    const image=await send(),item=await itemOf(image.message)
    expect((await pending(memberDevice)).map(row=>row.item_id)).toEqual([item])
    expect(await adopt(item,memberDevice,image.sha)).toBe(true)
    expect(await pending(memberDevice)).toEqual([])
    expect(await adopt(item,memberDevice,image.sha)).toBe(false)
  })
  it('refuses other bytes, other accounts and other images',async()=>{
    const image=await send(),item=await itemOf(image.message)
    await user()
    const error=await reject("SELECT chat.file_device_adopt($1,$2,'device-store','.gugu/attachments/x/shot.png',$3,60)",[item,memberDevice,sha64()])
    expect(error.hint).toBe('file_transfer_invalid')
    await service()
    expect(await pending(hostDevice,host)).toEqual([])
    expect(await adopt(item,hostDevice,image.sha,host)).toBe(false)
    const pdf=await send(project,undefined,'application/pdf')
    expect(await adopt(await itemOf(pdf.message),memberDevice,pdf.sha)).toBe(false)
    const elsewhere=await send(plain)
    expect(await adopt(await itemOf(elsewhere.message),memberDevice,elsewhere.sha)).toBe(false)
    expect(await adopt(item,memberDevice,image.sha)).toBe(true)
    expect(await adopt(item,otherDevice,image.sha)).toBe(false)
    expect(await adopt(item,memberDevice,image.sha)).toBe(false)
    expect(await pending(otherDevice)).toEqual([])
  })
  it('keeps only the image it was handed',async()=>{
    const one=await send(),two=await send(),[first,second]=[await itemOf(one.message),await itemOf(two.message)]
    expect(await adopt(first,memberDevice,one.sha)).toBe(true)
    expect((await pending(memberDevice)).map(row=>row.item_id)).toEqual([second])
  })
  it('skips what the caller has already tried, so a failing image does not hide the next',async()=>{
    const one=await send(),two=await send(),[first,second]=[await itemOf(one.message),await itemOf(two.message)]
    await user();const rows=(await db.query('SELECT * FROM chat.file_device_adopt_pending($1,50,$2)',[memberDevice,[first]])).rows;await service()
    expect(rows.map(row=>row.item_id)).toEqual([second])
  })
  it('takes a path only under the kept images directory of its root',async()=>{
    const image=await send(),item=await itemOf(image.message)
    await user()
    for (const path of ['../shot.png','/etc/passwd','docs/shot.png','.gugu/attachments/../../shot.png','.gugu/attachments/x/../shot.png']) {
      await db.query('SAVEPOINT p')
      await expect(db.query("SELECT chat.file_device_adopt($1,$2,'device-store',$3,$4,60)",[item,memberDevice,path,image.sha]),path).rejects.toThrow()
      await db.query('ROLLBACK TO SAVEPOINT p')
    }
    await service()
    expect((await db.query('SELECT 1 FROM chat.file_device_revisions WHERE item_id=$1',[item])).rows).toEqual([])
  })
  it('keeps nothing of a retracted image',async()=>{
    const image=await send(),item=await itemOf(image.message)
    await db.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1',[image.message])
    expect(await pending(memberDevice)).toEqual([])
    expect(await adopt(item,memberDevice,image.sha)).toBe(false)
  })
  it('does not let another account wake a machine',async()=>{
    const image=await send(),item=await itemOf(image.message),topic=`gugu:${memberDevice}:rpc`
    const before=(await topics(topic)).length
    await user(host)
    await reject('SELECT file_private.ask_to_adopt($1,$2)',[item,member])
    await service()
    expect((await topics(topic)).length).toBe(before)
  })
  it('gives an agent\'s image to the device that agent runs on, not to its owner\'s other machine',async()=>{
    const agent=randomUUID()
    await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())",[agent,agent+'@image-expiry.invalid'])
    await db.query("UPDATE identity.users SET type='agent',owner_user_id=$2,device_id=$3 WHERE id=$1",[agent,member,otherDevice])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')",[project,agent])
    const image=await send(),item=await itemOf(image.message)
    await db.query('UPDATE chat.messages SET sender_user_id=$2 WHERE id=$1',[image.message,agent])
    expect(await pending(memberDevice)).toEqual([])
    expect(await adopt(item,memberDevice,image.sha)).toBe(false)
    expect((await pending(otherDevice)).map(row=>row.item_id)).toEqual([item])
    expect(await adopt(item,otherDevice,image.sha)).toBe(true)
  })
  it('reads the cloud copy while it lives, then the machine; the same in the folder list',async()=>{
    const image=await adopted()
    expect(await resolve(image.item)).toMatchObject({status:'ready',source:'managed-object'})
    expect((await listed(image.item)).host_device_id).toBeNull()
    await due(image.stored);expect(await expire()).toBe(1)
    expect(await resolve(image.item)).toMatchObject({status:'ready',source:'local',host_device_id:memberDevice,host_label:'keeper',host_online:true})
    expect((await listed(image.item)).host_device_id).toBe(memberDevice)
    expect(await status(image.message)).toBe('ready')
    await db.query("UPDATE identity.gugu_devices SET status='offline' WHERE device_id=$1",[memberDevice])
    expect(await resolve(image.item)).toMatchObject({status:'ready',source:'local',host_online:false})
  })
  it('still says expired when no machine kept it',async()=>{
    const image=await send(),item=await itemOf(image.message)
    await due(image.stored);expect(await expire()).toBe(1)
    expect(await status(image.message)).toBe('expired')
    expect(await resolve(item,member)).toMatchObject({status:'expired'})
    expect(await pending(memberDevice)).toEqual([])
  })
  it('does not make the local revision hold the cloud bytes, and reads from the machine after they are collected',async()=>{
    const image=await adopted()
    await due(image.stored);expect(await expire()).toBe(1)
    const claim=await collect(image.blob)
    expect(claim).toMatchObject({blob_id:image.blob})
    await db.query('SELECT chat.file_blob_gc_finish($1,$2)',[image.blob,claim.claim_token])
    expect((await db.query('SELECT state FROM chat.file_transfer_storage WHERE blob_id=$1',[image.blob])).rows).toEqual([{state:'gone'}])
    expect(await resolve(image.item)).toMatchObject({status:'ready',source:'local',host_device_id:memberDevice})
    expect(await status(image.message)).toBe('ready')
  })
  it('stays kept through a rename, while its cloud copy lives and after it expires',async()=>{
    const image=await adopted()
    await user()
    const [moved]=(await db.query("SELECT * FROM chat.workspace_move_as($1,$2,NULL,'renamed.png',1)",[image.item,member])).rows
    await service()
    expect(moved.version).toBe(2)
    expect(await pending(memberDevice)).toEqual([])
    expect(await resolve(image.item)).toMatchObject({status:'ready',source:'managed-object',version:2})
    await due(image.stored);expect(await expire()).toBe(1)
    expect(await resolve(image.item)).toMatchObject({status:'ready',source:'local',host_device_id:memberDevice})
    expect(await status(image.message)).toBe('ready')
  })
  it('asks the sender\'s online desktops to keep a sent image, only images of project chats',async()=>{
    await send(plain)
    await send(project,undefined,'application/pdf')
    expect(await topics(`gugu:${memberDevice}:rpc`)).toEqual([])
    await db.query("UPDATE identity.gugu_devices SET status='offline' WHERE device_id=$1",[otherDevice])
    await send()
    expect(await topics(`gugu:${memberDevice}:rpc`)).toEqual(['files.transfer'])
    expect(await topics(`gugu:${otherDevice}:rpc`)).toEqual([])
    expect(await topics(`gugu:${hostDevice}:rpc`)).toEqual([])
  })
  it('says a keeping machine is back once per return, and shows that topic only to who shares a file with it',async()=>{
    const topic=`gugu:holder:${memberDevice}`
    await db.query("UPDATE identity.gugu_devices SET status='offline' WHERE device_id=$1",[memberDevice])
    await db.query("UPDATE identity.gugu_devices SET status='online' WHERE device_id=$1",[memberDevice])
    expect(await topics(topic)).toEqual([])
    await adopted()
    await db.query("UPDATE identity.gugu_devices SET status='offline' WHERE device_id=$1",[memberDevice])
    await db.query("UPDATE identity.gugu_devices SET last_seen_at=now() WHERE device_id=$1",[memberDevice])
    expect(await topics(topic)).toEqual([])
    await db.query("UPDATE identity.gugu_devices SET status='online' WHERE device_id=$1",[memberDevice])
    await db.query("UPDATE identity.gugu_devices SET status='online',last_seen_at=now() WHERE device_id=$1",[memberDevice])
    expect(await topics(topic)).toEqual(['holder_online'])
    const visible=async(as:string)=>{await user(as);const r=(await db.query('SELECT chat.file_holder_visible($1) AS r',[memberDevice])).rows[0].r;await service();return r}
    expect(await visible(host)).toBe(true)
    const stranger=randomUUID()
    await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())",[stranger,stranger+'@image-expiry.invalid'])
    expect(await visible(stranger)).toBe(false)
  })
})
