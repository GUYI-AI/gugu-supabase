import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// A project chat has no host: each version is kept by the device that sent it, any member's device may send the next
// version, and a reader is told which device keeps a version and whether it is online.
const url=process.env.GUGU_INTEGRATION_DATABASE_URL??''
let db:pg.Client, owner:string, member:string, group:string, bound:string, unbound:string, theirs:string, item:string
const sha='ab'.repeat(32), next='cd'.repeat(32), type='application/octet-stream'
const PUBLISH='SELECT chat.file_device_publish(p_item=>$1,p_chat=>$2,p_device=>$3,p_path=>$4,p_sha=>$5,p_size=>$6,p_filename=>$7,p_type=>$8,p_expected=>$9,p_project=>$10) AS r'
async function user(id:string) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:id,role:'authenticated'})])
}
async function service() { await db.query('RESET ROLE') }
async function fails(sql:string,args:unknown[]=[]) {
  await db.query('SAVEPOINT refused')
  try { await db.query(sql,args) } catch(error) {
    await db.query('ROLLBACK TO SAVEPOINT refused');return error as pg.DatabaseError
  }
  throw Error('Expected refusal: '+sql)
}
async function publish(as:string,device:string,project:string,{id=item,hash=sha,expected=null as number|null,path='data/file.bin'}={}) {
  await user(as)
  return (await db.query(PUBLISH,[id,group,device,path,hash,123,'file.bin',type,expected,project])).rows[0].r
}
async function resolve(ref:unknown,as:string) {
  await user(as)
  return (await db.query('SELECT chat.file_resolve_as($1,$2) AS r',[ref,as])).rows[0].r
}
async function storage(account:string,values:Record<string,unknown>) {
  await service()
  await db.query(`INSERT INTO identity.user_settings(user_id,scope,config) VALUES($1,'user',jsonb_build_object('file_storage',$2::jsonb))
    ON CONFLICT(user_id,scope) DO UPDATE SET config=identity.user_settings.config||EXCLUDED.config`,[account,values])
}
beforeAll(async()=>{
  if(!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw Error('Peer file contracts require an isolated loopback database')
  db=new pg.Client({connectionString:url});await db.connect()
})
afterAll(async()=>{await db?.end()})
beforeEach(async()=>{
  await db.query('BEGIN')
  ;[owner,member,group,bound,unbound,theirs,item]=Array.from({length:7},randomUUID)
  for(const id of [owner,member]) await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`,[id,id+'@project-peers.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','project peers',$2)",[group,owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[group,owner,member])
  // The owner's two machines, one with the project bound to the chat and one without; the member's machine has none.
  for(const [id,account,label] of [[bound,owner,'Studio Mac'],[unbound,owner,'Laptop'],[theirs,member,'Linux 1']]) await db.query(
    `INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,$3,'fixture','linux')`,[id,account,label])
  await db.query(`INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id)
    VALUES($1,$2,'root','fixture','/private/root',now(),$3)`,[bound,owner,group])
})
afterEach(async()=>{await db.query('ROLLBACK')})

describe('project chat files kept by the device that sent each version',()=>{
  it('keeps each sent file on its sender\'s own device, under its bound project or its device store',async()=>{
    await publish(owner,bound,'root')
    const other=randomUUID()
    await publish(owner,unbound,'device-store',{id:other,path:other+'/notes.md'})
    expect(await resolve({item_id:item},member)).toMatchObject({status:'ready',source:'local',host_device_id:bound,host_project_id:'root',
      host_account_id:owner,host_label:'Studio Mac',host_online:true})
    expect(await resolve({item_id:other},member)).toMatchObject({status:'ready',host_device_id:unbound,host_project_id:'device-store',host_label:'Laptop'})
    // Only the caller's own device, and only a project that device has bound to this chat.
    for(const [as,device,project] of [[member,bound,'root'],[owner,unbound,'root'],[member,theirs,'root'],[owner,bound,'elsewhere']]) {
      await user(as)
      expect((await fails(PUBLISH,[randomUUID(),group,device,'x.bin',sha,1,'x.bin',type,null,project])).hint).toBe('file_transfer_denied')
    }
  })
  it('lets any member\'s device write the next version, which that device keeps; older versions stay where they are',async()=>{
    await publish(owner,bound,'root')
    expect(await publish(member,theirs,'device-store',{hash:next,expected:1,path:item+'/file.bin'})).toMatchObject({version:2})
    expect(await resolve({item_id:item},owner)).toMatchObject({version:2,current_version:2,sha256:next,host_device_id:theirs,host_account_id:member,host_label:'Linux 1'})
    expect(await resolve({item_id:item,version:1},owner)).toMatchObject({version:1,current_version:2,sha256:sha,host_device_id:bound})
    // The version chain is the only order: a copy of an older version conflicts.
    await user(owner)
    expect((await fails(PUBLISH,[item,group,bound,'data/file.bin','ef'.repeat(32),123,'file.bin',type,1,'root'])).hint).toBe('file_transfer_conflict')
    expect(await publish(owner,bound,'root',{hash:'ef'.repeat(32),expected:2})).toMatchObject({version:3})
  })
  it('tells a reader on another account which device keeps a version and that it is offline',async()=>{
    await publish(owner,bound,'root')
    await service();await db.query("UPDATE identity.gugu_devices SET status='offline' WHERE device_id=$1",[bound])
    expect(await resolve({item_id:item},member)).toMatchObject({status:'ready',host_device_id:bound,host_label:'Studio Mac',host_online:false})
    // A removed device takes its versions with it.
    await service();await db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1',[bound])
    expect(await resolve({item_id:item},member)).toEqual({status:'gone'})
  })
  it('asks an older version\'s own device for a temporary copy, kept as long as that device\'s account says',async()=>{
    await service()
    await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=chat.file_transfer_limits.settings||EXCLUDED.settings",
      [{inventory_ready:true,file_max_bytes:1000,upload_permit_seconds:120,sign_window_seconds:60,sign_account_count:100,temporary_group_bytes:10000}])
    await storage(owner,{retention:'1d'});await storage(member,{retention:'30d'})
    await publish(owner,bound,'root')
    await publish(member,theirs,'device-store',{hash:next,expected:1,path:item+'/file.bin'})
    await user(member)
    const asked=(await db.query('SELECT chat.file_temporary_request($1,$2,$3) AS r',[{item_id:item,version:1},member,randomUUID()])).rows[0].r
    expect(asked).toMatchObject({status:'ready',version:1,host_device_id:bound,transfer_status:'requested'})
    await service()
    expect((await db.query('SELECT host_device_id,retention FROM chat.file_temporary_transfers WHERE id=$1',[asked.transfer_id])).rows)
      .toEqual([{host_device_id:bound,retention:'1d'}])
    expect((await db.query("SELECT topic FROM realtime.messages WHERE event='files.transfer' AND payload->>'request_id'=$1",[asked.transfer_id])).rows)
      .toEqual([{topic:`gugu:${bound}:rpc`}])
    // The holder's own setting closes its copies; the reader's does not.
    await storage(member,{temporary_transfer:false})
    await user(owner)
    expect((await db.query('SELECT chat.file_temporary_request($1,$2,$3) AS r',[{item_id:item,version:1},owner,randomUUID()])).rows[0].r).toMatchObject({host_device_id:bound})
    await storage(owner,{temporary_transfer:false})
    await user(member)
    expect((await fails('SELECT chat.file_temporary_request($1,$2,$3)',[{item_id:item,version:1},member,randomUUID()])).hint).toBe('file_transfer_denied')
  })
  it('lets a released client publish from its own bound device without naming a project',async()=>{
    await user(owner)
    expect((await db.query("SELECT chat.file_project_policy_as($1,$2,'root',false,true,'7d') AS r",[group,bound])).rows[0].r)
      .toMatchObject({host_device_id:bound,host_project_id:'root',proactive_upload:false})
    expect((await db.query('SELECT chat.file_device_publish($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r',[item,group,bound,'data/file.bin',sha,123,'file.bin',type,null,null])).rows[0].r)
      .toMatchObject({version:1})
    expect(await resolve({item_id:item},member)).toMatchObject({host_device_id:bound,host_project_id:'root'})
    // A device with no project bound to the chat names its device store; without a name it is refused.
    expect((await fails('SELECT chat.file_device_publish($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),group,unbound,'x.bin',sha,1,'x.bin',type,null,null])).hint).toBe('file_transfer_denied')
  })
})
