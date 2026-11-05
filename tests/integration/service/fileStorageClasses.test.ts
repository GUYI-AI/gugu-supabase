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
let db:pg.Client, host:string, member:string, project:string, plain:string, device:string
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
/** The account's one file storage setting, written the way the client writes it. */
async function storage(values:Record<string,unknown>,account=host) {
  await user(account)
  await db.query(`INSERT INTO identity.user_settings(user_id,scope,config) VALUES($1,'user',jsonb_build_object('file_storage',$2::jsonb))
    ON CONFLICT(user_id,scope) DO UPDATE SET config=identity.user_settings.config||jsonb_build_object('file_storage',
      COALESCE(identity.user_settings.config->'file_storage','{}'::jsonb)||(EXCLUDED.config->'file_storage'))`,[account,values])
  await service()
}
/** Someone sends a file as a chat attachment through the ordinary managed upload path. */
async function send(target:string,type='application/pdf',sha=randomUUID().replaceAll('-','').repeat(2),as=member) {
  await user(as)
  const permit=(await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,60,$4) AS r',[randomUUID(),target,as,type])).rows[0].r
  await service()
  const blob=(await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,60,$4)',[as,permit.staging_key,sha,type])).rows[0]
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)',[permit.staging_key,as])
  await user(as)
  const message=randomUUID()
  const sent=(await db.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5)',[permit.staging_key,message,target,as,'file.bin'])).rows[0]
  await service()
  const stored=(await db.query('SELECT id FROM chat.file_transfer_storage WHERE blob_id=$1',[blob.blob_id])).rows[0].id as string
  return {blob:blob.blob_id as string,stored,message,item:sent.file_item_id as string,sha}
}
async function seconds(stored:string,chat:string) {
  const row=(await db.query('SELECT expired_at,expires_at,extract(epoch FROM expires_at-now()) AS s FROM chat.file_transfer_storage_refs WHERE storage_id=$1 AND chat_id=$2',[stored,chat])).rows[0]
  return {...row,s:row.s===null?null:Number(row.s)}
}
async function mark(refs:unknown[],action:string,as=member,actor:string|null=null) {
  await user(as)
  const n=(await db.query('SELECT chat.file_storage_mark_as($1,$2,$3) AS n',[JSON.stringify(refs),action,actor])).rows[0].n as number
  await service(); return n
}
async function overview(as=member) {
  await user(as)
  const r=(await db.query('SELECT chat.file_storage_overview_as() AS r')).rows[0].r
  await service(); return r
}
const DAY=86400
beforeAll(async()=>{
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw Error('File storage contracts require an isolated loopback database')
  db=new pg.Client({connectionString:url});await db.connect()
})
afterAll(async()=>{await db?.end()})
beforeEach(async()=>{
  await db.query('BEGIN')
  ;[host,member,project,plain,device]=Array.from({length:5},randomUUID)
  for (const id of [host,member]) await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())",[id,id+'@file-classes.invalid'])
  for (const [id,name] of [[project,'project'],[plain,'plain']]) {
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group',$2,$3)",[id,name,host])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[id,host,member])
  }
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Studio Mac','fixture','linux')",[device,host])
  await db.query("INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id) VALUES($1,$2,'root','fixture','/fixture',now(),$3)",[device,host,project])
  const baseline=Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings",[{...settings,storage_global_bytes:baseline+settings.storage_global_bytes}])
})
afterEach(async()=>{await db.query('ROLLBACK')})

describe('temporary and kept copies on the reference ledger',()=>{
  it('keeps images and temporary files on separate retention keys, always the uploader\'s own',async()=>{
    // The project owner's setting does not apply to what a member uploads.
    await storage({image_retention:'30d',temporary_retention:'30d'})
    await storage({image_retention:'1d',temporary_retention:'1d'},member)
    const image=await send(project,'image/png')
    expect((await seconds(image.stored,project)).s).toBeLessThanOrEqual(DAY)
    const doc=await send(project)
    expect((await seconds(doc.stored,project)).expires_at).toBeNull()
    expect(await mark([{message_id:doc.message}],'temporary')).toBe(1)
    expect((await seconds(doc.stored,project)).s).toBeLessThanOrEqual(DAY)
    // An ordinary chat: the same key.
    const note=await send(plain)
    expect(await mark([{item_id:note.item}],'temporary')).toBe(1)
    expect((await seconds(note.stored,plain)).s).toBeLessThanOrEqual(DAY)
    expect(await mark([{message_id:note.message}],'permanent')).toBe(1)
    expect((await seconds(note.stored,plain)).expires_at).toBeNull()
    // An image a project chat would expire can be kept.
    expect(await mark([{message_id:image.message}],'permanent')).toBe(1)
    expect((await seconds(image.stored,project)).expires_at).toBeNull()
  })
  it('lets only the uploader mark a copy, through the readers of that message or file',async()=>{
    const note=await send(plain)
    await user(host)
    expect((await reject('SELECT chat.file_storage_mark_as($1,$2)',[JSON.stringify([{message_id:note.message}]),'release'])).hint).toBe('file_transfer_denied')
    const outsider=randomUUID()
    await service()
    await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())",[outsider,outsider+'@file-classes.invalid'])
    await user(outsider)
    expect((await reject('SELECT chat.file_storage_mark_as($1,$2)',[JSON.stringify([{message_id:note.message}]),'temporary'])).hint).toBe('file_transfer_denied')
    await user()
    for (const [refs,action] of [[[{message_id:note.message}],'forever'],[[],'release'],[[{message_id:note.message,item_id:note.item}],'release'],[[{class:'other'}],'release']] as const) {
      expect((await reject('SELECT chat.file_storage_mark_as($1,$2)',[JSON.stringify(refs),action])).hint).toBe('file_transfer_invalid')
    }
    await service()
    expect((await seconds(note.stored,plain)).expires_at).toBeNull()
  })
  it('releases a copy through the existing expiry and collector, keeping bytes another chat still references',async()=>{
    const solo=await send(plain)
    expect(await mark([{message_id:solo.message}],'release')).toBe(1)
    expect((await seconds(solo.stored,plain)).expired_at).not.toBeNull()
    expect((await db.query('SELECT blob_id FROM chat.file_blob_gc WHERE blob_id=$1',[solo.blob])).rows).toHaveLength(1)
    // The same bytes in another ordinary chat: releasing one chat's copy keeps the bytes for the other.
    const shared=await send(plain),other=randomUUID()
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','other',$2)",[other,host])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[other,host,member])
    await send(other,'application/pdf',shared.sha)
    expect(await mark([{message_id:shared.message}],'release')).toBe(1)
    expect((await seconds(shared.stored,plain)).expired_at).not.toBeNull()
    expect((await seconds(shared.stored,other)).expired_at).toBeNull()
    expect(await db.query('SELECT chat.file_blob_in_use($1) AS used',[shared.blob]).then(r=>r.rows[0].used)).toBe(true)
  })
  it('marks every own copy of a class at once, in one chat or all, and nobody else\'s',async()=>{
    const a=await send(plain),b=await send(plain),mine=await send(plain,'image/png')
    const theirs=await send(plain,'application/pdf',undefined,host)
    expect(await mark([{class:'kept',chat_id:plain}],'temporary')).toBe(2)
    expect(await mark([{class:'temporary'}],'release')).toBe(2)
    for (const f of [a,b]) expect((await seconds(f.stored,plain)).expired_at).not.toBeNull()
    expect((await seconds(mine.stored,plain)).expired_at).toBeNull()
    expect((await seconds(theirs.stored,plain)).expired_at).toBeNull()
  })
  it('summarizes only the caller\'s own copies: classes, groups, what expires soonest, and the machines\' project files',async()=>{
    await storage({image_retention:'1d'})
    const image=await send(project,'image/png'),kept=await send(plain),temp=await send(plain)
    await mark([{message_id:temp.message}],'temporary')
    await send(plain,'application/pdf',undefined,host)
    const r=await overview()
    expect(r).toMatchObject({total_bytes:180,count:3,expiring_7d_bytes:120,
      classes:{image:{bytes:60,count:1},temporary:{bytes:60,count:1},kept:{bytes:60,count:1}}})
    expect(r.groups).toEqual([expect.objectContaining({chat_id:plain,name:'plain',project:false,bytes:120,count:2}),
      expect.objectContaining({chat_id:project,project:true,bytes:60,count:1})])
    expect(r.expiring.map((e:{class:string})=>e.class)).toEqual(['image','temporary'])
    expect(r.expiring[0]).toMatchObject({chat_id:project,item_id:expect.any(String),file_name:expect.any(String)})
    expect(r.machines).toEqual([])
    // The idle-expiry policy the panel states: none set → null; set → exactly what chat.file_transfer_expire reads.
    expect(r.expiry).toBeNull()
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"large_file_bytes\":1048576,\"large_file_idle_seconds\":2592000}' WHERE scope='global' AND scope_id='*'")
    expect((await overview()).expiry).toEqual({large_file_bytes:1048576,idle_seconds:2592000})
    void image;void kept
    // The owner's machine keeps the local files it sent: counted, not in the cloud.
    await user(host)
    await db.query("SELECT chat.file_device_publish($1,$2,$3,'a.bin',$4,123,'a.bin','application/octet-stream',NULL,NULL)",[randomUUID(),project,device,'ab'.repeat(32)])
    await service()
    expect((await overview(host)).machines).toEqual([{device_id:device,label:'Studio Mac',files:1,bytes:123,temporary_copy_bytes:0}])
  })
  it('lists each file\'s expiry and whether the reader uploaded it, as the uploader\'s mark decides',async()=>{
    const note=await send(plain)
    await mark([{message_id:note.message}],'temporary')
    const list=async(as:string)=>{ await user(as); const r=(await db.query('SELECT id,expires_at,is_mine,filename FROM chat.workspace_list_as($1,$2)',[plain,as])).rows; await service(); return r }
    const mine=(await list(member)).find((row)=>row.id===note.item)
    expect(mine.is_mine).toBe(true)
    expect(Date.parse(mine.expires_at)-Date.now()).toBeGreaterThan(6*DAY*1000)
    const theirs=(await list(host)).find((row)=>row.id===note.item)
    expect(theirs).toMatchObject({is_mine:false})
    expect(theirs.expires_at).toEqual(mine.expires_at)
    // A file with no cloud copy has neither.
    await user(host)
    const local=(await db.query("SELECT chat.file_device_publish($1,$2,$3,'a.bin',$4,9,'a.bin','application/octet-stream',NULL,NULL) AS r",[randomUUID(),project,device,'ab'.repeat(32)])).rows[0].r
    const row=(await db.query('SELECT expires_at,is_mine FROM chat.workspace_list_as($1,$2) WHERE id=$3',[project,host,local.item_id])).rows[0]
    await service()
    expect(row).toEqual({expires_at:null,is_mine:null})
  })
  it('lists each file\'s storage class, reclaimed copy, uploader and the machine holding a project file',async()=>{
    const temporary=await send(plain), kept=await send(plain), image=await send(plain,'image/png'), gone=await send(plain)
    await mark([{message_id:temporary.message}],'temporary')
    await mark([{message_id:kept.message}],'permanent')
    await mark([{message_id:gone.message}],'release')
    const columns='storage_class,copy_expired_at,copy_account_id,host_device_id'
    await user(host)
    const rows=(await db.query(`SELECT id,${columns} FROM chat.workspace_list_as($1,$2)`,[plain,host])).rows
    await service()
    const of=(item:string)=>rows.find((row)=>row.id===item)
    expect(of(temporary.item)).toMatchObject({storage_class:'temporary',copy_expired_at:null,copy_account_id:member,host_device_id:null})
    expect(of(kept.item)).toMatchObject({storage_class:'kept',copy_expired_at:null,copy_account_id:member})
    expect(of(image.item)).toMatchObject({storage_class:'image',copy_account_id:member})
    // A reclaimed copy has no class; when it went and whose it was stay.
    expect(of(gone.item)).toMatchObject({storage_class:null,copy_account_id:member})
    expect(of(gone.item).copy_expired_at).not.toBeNull()
    // A project file kept on its machine: no cloud copy, only the machine.
    await user(host)
    const local=(await db.query("SELECT chat.file_device_publish($1,$2,$3,'b.bin',$4,9,'b.bin','application/octet-stream',NULL,NULL) AS r",[randomUUID(),project,device,'cd'.repeat(32)])).rows[0].r
    const row=(await db.query(`SELECT ${columns} FROM chat.workspace_list_as($1,$2) WHERE id=$3`,[project,host,local.item_id])).rows[0]
    await service()
    expect(row).toEqual({storage_class:null,copy_expired_at:null,copy_account_id:null,host_device_id:device})
  })
  it('accepts temporary_retention among the account\'s known values only',async()=>{
    await user(host)
    for (const value of [{temporary_retention:'read-once'},{temporary_retention:'2d'},{temporary_retention:7}]) {
      expect((await reject(`INSERT INTO identity.user_settings(user_id,scope,config) VALUES($1,'user',jsonb_build_object('file_storage',$2::jsonb))`,[host,value])).code).toBe('23514')
    }
    await service()
    expect((await db.query('SELECT chat.file_storage_of($1) AS p',[host])).rows[0].p).toMatchObject({image_retention:'7d',temporary_retention:'7d'})
  })
})
