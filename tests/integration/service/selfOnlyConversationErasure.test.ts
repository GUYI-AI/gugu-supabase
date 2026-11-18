import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import pg from 'pg'
import { afterAll,afterEach,beforeAll,expect,it } from 'vitest'

const database=process.env.GUGU_INTEGRATION_DATABASE_URL??'',api=process.env.GUGU_INTEGRATION_SUPABASE_URL??''
const service=process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY??''
let db:pg.Client,definition:string
const ownedUsers:string[]=[],ownedRooms:string[]=[],ownedObjects:string[]=[]
let schedules:{jobname:string,schedule:string,command:string}[]=[]
const call='    PERFORM identity.erase_self_only_conversations(delete_user_ids);'
const row=async(sql:string,args:unknown[]=[]) => (await db.query(sql,args)).rows[0]
async function rollback(run:()=>Promise<void>){await db.query('BEGIN');try{await run()}finally{await db.query('ROLLBACK')}}
async function human(real=false){
  const id=randomUUID()
  if(real){
    const response=await auth('admin/users','POST',{email:id+'@self-only.invalid',password:randomUUID(),email_confirm:true})
    expect(response.status).toBe(200)
    const user=await response.json();ownedUsers.push(user.id);return user.id as string
  }
  await db.query("INSERT INTO auth.users(id,email,created_at)VALUES($1,$2,now())",[id,id+'@self-only.invalid'])
  ownedUsers.push(id);return id
}
async function agent(owner:string){
  const id=randomUUID(),device=randomUUID()
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)VALUES($1,$2,'fixture','fixture','linux')",[device,owner])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,desired_status)VALUES($1,'agent','Erasure fixture',$2,$3,'offline')",[id,owner,device])
  return id
}
async function room(kind:string,owner:string,members:string[],source?:string){
  const id=randomUUID();ownedRooms.push(id)
  const sourceMessage=source?(await row('SELECT id FROM chat.messages WHERE chat_id=$1 ORDER BY seq LIMIT 1',[source])).id:null
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id)
    VALUES($1,$2,'Erasure fixture',$3,$4,$5)`,[id,kind,owner,source??null,sourceMessage])
  for(const member of members)await db.query('INSERT INTO chat.chat_members(chat_id,user_id,role)VALUES($1,$2,$3)',
    [id,member,kind==='topic'?'member':member===owner?'owner':'member'])
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content)VALUES($1,$2,$3,'Retained fixture content')",[randomUUID(),id,owner])
  return id
}
async function binary(chat:string,owner:string,name?:string){
  const pointer=name??chat+'/'+owner+'/'+randomUUID()+'.bin'
  if(!name){await db.query("INSERT INTO storage.objects(bucket_id,name)VALUES('workspace',$1)",[pointer]);ownedObjects.push(pointer)}
  const item=await row(`INSERT INTO chat.workspace_items(chat_id,kind,filename,content_type,size_bytes,blob_id,created_by)
    VALUES($1,'file',$4,'application/octet-stream',8,chat.file_blob_for_pointer($2,8,'application/octet-stream',$3),$3)
    RETURNING id,blob_id`,[chat,pointer,owner,randomUUID()+'.bin'])
  return {...item,pointer}
}
async function auth(path:string,method='GET',body?:unknown){
  return fetch(api+'/auth/v1/'+path,{method,signal:AbortSignal.timeout(15000),
    headers:{apikey:service,authorization:'Bearer '+service,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)})})
}
async function waitingFor(blocked:number,blocker:number){
  const until=Date.now()+4000
  while(Date.now()<until){
    if((await row('SELECT $2=ANY(pg_blocking_pids($1)) blocked',[blocked,blocker])).blocked)return
    await new Promise(resolve=>setTimeout(resolve,20))
  }
  throw Error('Expected the owned membership/delete lock conflict')
}
beforeAll(async()=>{
  const d=new URL(database),a=new URL(api)
  if(d.hostname!=='127.0.0.1'||a.hostname!=='127.0.0.1'||Number(a.port)!==Number(d.port)-1)throw Error('Matching owned loopback services required')
  db=new pg.Client({connectionString:database});await db.connect()
  definition=(await row("SELECT pg_get_functiondef('identity.erase_human_account(text,text)'::regprocedure) body")).body
  expect(definition.split(call)).toHaveLength(2)
  schedules=(await db.query("SELECT jobname,schedule,command FROM cron.job WHERE jobname LIKE 'account-audit-redaction-%'")).rows
  for(const schedule of schedules)await db.query('SELECT cron.unschedule($1)',[schedule.jobname])
})
afterEach(async()=>{
  // Restore only this fixture's DDL and rows; normal erasure still cleans Auth.
  await db.query(definition)
  await db.query('DELETE FROM chat.chats WHERE id=ANY($1::text[])',[ownedRooms])
  await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[ownedUsers])
  await db.query('DELETE FROM identity.account_audit_redaction_jobs WHERE source_subject_id=ANY($1::text[])',[ownedUsers])
  await db.query("DELETE FROM chat.file_blobs WHERE bucket_id='workspace' AND object_name=ANY($1::text[])",[ownedObjects])
  if(ownedObjects.length&&(await row("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='workspace' AND name=ANY($1::text[])",[ownedObjects])).n){
    const removed=await fetch(api+'/storage/v1/object/workspace',{method:'DELETE',
      headers:{apikey:service,authorization:'Bearer '+service,'content-type':'application/json'},
      body:JSON.stringify({prefixes:ownedObjects}),signal:AbortSignal.timeout(15000)})
    expect(removed.ok).toBe(true);await removed.body?.cancel()
  }
  ownedUsers.length=ownedRooms.length=ownedObjects.length=0
})
afterAll(async()=>{
  for(const schedule of schedules)await db.query('SELECT cron.schedule($1,$2,$3)',[schedule.jobname,schedule.schedule,schedule.command])
  await db?.end()
})

it.each(['dm','ai','group','topic','removed_owned_agent','other_human','other_agent','other_archived_agent'])('erases only the complete own member set: %s',async kind=>rollback(async()=>{
  const owner=await human(),mine=await agent(owner),peer=await human(),theirs=await agent(peer)
  const source=kind==='topic'?await room('group',owner,[owner,mine,peer]):undefined
  const members=[owner,mine,...(kind==='other_human'?[peer]:['other_agent','other_archived_agent'].includes(kind)?[theirs]:[])]
  const target=await room(['removed_owned_agent','other_human','other_agent','other_archived_agent'].includes(kind)?'group':kind,owner,members,source)
  if(kind==='removed_owned_agent')await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1',[mine])
  if(kind==='other_archived_agent')await db.query('UPDATE identity.users SET session_archived_at=now() WHERE id=$1',[theirs])
  await db.query('DELETE FROM auth.users WHERE id=$1',[owner])
  const retained=['other_human','other_agent','other_archived_agent'].includes(kind)
  expect((await row('SELECT count(*)::int n FROM chat.chats WHERE id=$1',[target])).n).toBe(retained?1:0)
  expect((await row('SELECT count(*)::int n FROM chat.messages WHERE chat_id=$1',[target])).n).toBe(retained?1:0)
  if(retained)expect((await row('SELECT sender_user_id FROM chat.messages WHERE chat_id=$1',[target])).sender_user_id).toBeNull()
  if(source)expect((await row('SELECT count(*)::int n FROM chat.chats WHERE id=$1',[source])).n).toBe(1)
}))

it('cascades source topics and file items, queues exclusive blobs and preserves a shared copy',async()=>rollback(async()=>{
  const owner=await human(),mine=await agent(owner),peer=await human(),otherPeer=await human()
  const root=await room('group',owner,[owner,mine]),topic=await room('topic',owner,[owner,mine],root)
  // Two surviving humans keep the positive-control group active; archived
  // historical-reader protection remains covered by its own suite.
  const shared=await room('group',peer,[peer,otherPeer,owner])
  // Topics use their source's file container; do not create an invalid private
  // topic container just to exercise the cascade.
  const exclusive=await binary(root,owner),copy=await binary(root,owner),kept=await binary(shared,peer,copy.pointer)
  // Opaque legacy names and NULL ownership cannot be rediscovered from the
  // erased user prefix after deleting their last conversation reference.
  const legacy='opaque-'+randomUUID()+'.png'
  await db.query("INSERT INTO storage.objects(bucket_id,name,metadata)VALUES('avatars',$1,'{\"size\":8,\"mimetype\":\"image/png\"}')",[legacy])
  await db.query("UPDATE chat.chats SET avatar_url='https://fixture.invalid/storage/v1/object/public/avatars/'||$2,avatar_storage_bucket_id='avatars',avatar_storage_object_name=$2 WHERE id=$1",[root,legacy])
  expect((await row("SELECT count(*)::int n FROM chat.file_blobs WHERE bucket_id='avatars' AND object_name=$1",[legacy])).n).toBe(0)
  const folder=(await row("INSERT INTO chat.workspace_items(chat_id,kind,filename,created_by)VALUES($1,'folder','Nested',$2)RETURNING id",[root,owner])).id
  const text=(await row(`INSERT INTO chat.workspace_items(chat_id,kind,filename,content_type,inline_text,size_bytes,created_by,parent_id)
    VALUES($1,'document','note.md','text/markdown','fixture',7,$2,$3)RETURNING id`,[root,owner,folder])).id
  await db.query('SAVEPOINT guarded_folder')
  await expect(db.query('DELETE FROM chat.workspace_items WHERE id=$1',[folder])).rejects.toMatchObject({code:'23503',hint:'workspace_folder_not_empty'})
  await db.query('ROLLBACK TO guarded_folder')
  await db.query('DELETE FROM auth.users WHERE id=$1',[owner])
  expect((await row('SELECT count(*)::int n FROM chat.chats WHERE id=ANY($1)',[[root,topic]])).n).toBe(0)
  expect((await row('SELECT count(*)::int n FROM chat.workspace_items WHERE id=ANY($1::uuid[])',[[exclusive.id,copy.id,text,folder]])).n).toBe(0)
  expect((await row('SELECT count(*)::int n FROM chat.workspace_items WHERE id=$1',[kept.id])).n).toBe(1)
  expect((await row('SELECT chat.file_blob_in_use($1) used',[exclusive.blob_id])).used).toBe(false)
  expect((await row('SELECT count(*)::int n FROM chat.file_blob_gc WHERE blob_id=$1',[exclusive.blob_id])).n).toBe(1)
  expect((await row('SELECT chat.file_blob_in_use($1) used',[copy.blob_id])).used).toBe(true)
  expect((await row("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='workspace' AND name=$1",[copy.pointer])).n).toBe(1)
  expect((await row(`SELECT count(*)::int n FROM chat.file_blob_gc g JOIN chat.file_blobs b ON b.id=g.blob_id
    WHERE b.bucket_id='avatars' AND b.object_name=$1`,[legacy])).n).toBe(1)
}))

it('rolls back Auth, conversations, files and registration when a cascade cannot enqueue its blob',async()=>rollback(async()=>{
  const owner=await human(),mine=await agent(owner),target=await room('group',owner,[owner,mine]),file=await binary(target,owner)
  // This is serial owned-fixture DDL, not a weakened application guard.
  await db.query(`ALTER TABLE chat.file_blob_gc ADD CONSTRAINT self_only_queue_failure CHECK(blob_id<>'${file.blob_id}'::uuid) NOT VALID`)
  await db.query('SAVEPOINT rejected_delete')
  await expect(db.query('DELETE FROM auth.users WHERE id=$1',[owner])).rejects.toMatchObject({code:'23514',constraint:'self_only_queue_failure'})
  await db.query('ROLLBACK TO rejected_delete')
  expect((await row('SELECT count(*)::int n FROM auth.users WHERE id=$1',[owner])).n).toBe(1)
  expect((await row('SELECT count(*)::int n FROM chat.chats WHERE id=$1',[target])).n).toBe(1)
  expect((await row('SELECT count(*)::int n FROM chat.workspace_items WHERE id=$1',[file.id])).n).toBe(1)
  expect((await row('SELECT count(*)::int n FROM identity.account_audit_redaction_jobs WHERE source_subject_id=$1',[owner])).n).toBe(0)
}))

it('keeps the helper closed and rejects a forged context without deleting anything',async()=>rollback(async()=>{
  const owner=await human(),mine=await agent(owner),target=await room('group',owner,[owner,mine])
  for(const role of ['anon','authenticated','service_role'])expect((await row(
    "SELECT has_function_privilege($1,'identity.erase_self_only_conversations(text[])','EXECUTE') ok",[role])).ok).toBe(false)
  await db.query("SELECT set_config('gugu.privacy_erasure','true',true)")
  await db.query('SAVEPOINT refused')
  await expect(db.query('SELECT identity.erase_self_only_conversations($1)',[[owner,mine]])).rejects.toMatchObject({code:'42501'})
  await db.query('ROLLBACK TO refused')
  expect((await row('SELECT count(*)::int n FROM chat.chats WHERE id=$1',[target])).n).toBe(1)
}))

it('refuses an unsupported nested-topic cascade before changing any conversations',async()=>rollback(async()=>{
  const owner=await human(),mine=await agent(owner)
  const root=await room('group',owner,[owner,mine]),child=await room('topic',owner,[owner,mine],root)
  // Product create_topic rejects this shape; seed a legacy inconsistency via
  // the owned database without weakening any trigger or membership policy.
  const nested=await room('topic',owner,[owner,mine],child)
  await db.query('SAVEPOINT nested_refused')
  await expect(db.query('DELETE FROM auth.users WHERE id=$1',[owner])).rejects.toMatchObject({code:'55000',message:'Nested source topics require explicit repair before erasure'})
  await db.query('ROLLBACK TO nested_refused')
  expect((await row('SELECT count(*)::int n FROM chat.chats WHERE id=ANY($1)',[[root,child,nested]])).n).toBe(3)
  expect((await row('SELECT count(*)::int n FROM auth.users WHERE id=$1',[owner])).n).toBe(1)
}))

it('preserves a member who commits a join before erasure obtains the chat lock',async()=>{
  const owner=await human(),mine=await agent(owner),peer=await human(),target=await room('group',owner,[owner,mine])
  const join=new pg.Client({connectionString:database}),erase=new pg.Client({connectionString:database})
  await join.connect();await erase.connect()
  try{
    const jp=(await join.query('SELECT pg_backend_pid() pid')).rows[0].pid,ep=(await erase.query('SELECT pg_backend_pid() pid')).rows[0].pid
    await join.query('BEGIN');await join.query("SET LOCAL lock_timeout='5s'")
    await join.query("INSERT INTO chat.chat_members(chat_id,user_id,role)VALUES($1,$2,'member')",[target,peer])
    const pending=erase.query('DELETE FROM auth.users WHERE id=$1',[owner]).then(()=>null,error=>error)
    await waitingFor(ep,jp);await join.query('COMMIT');expect(await pending).toBeNull()
    expect((await row('SELECT count(*)::int n FROM chat.chats WHERE id=$1',[target])).n).toBe(1)
    expect((await row('SELECT count(*)::int n FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2',[target,peer])).n).toBe(1)
  }finally{await join.query('ROLLBACK');await join.end();await erase.end()}
})

it('does not let a concurrent join resurrect a conversation already being deleted',async()=>{
  const owner=await human(),mine=await agent(owner),peer=await human(),target=await room('group',owner,[owner,mine])
  const erase=new pg.Client({connectionString:database}),join=new pg.Client({connectionString:database})
  await erase.connect();await join.connect()
  try{
    const ep=(await erase.query('SELECT pg_backend_pid() pid')).rows[0].pid,jp=(await join.query('SELECT pg_backend_pid() pid')).rows[0].pid
    await erase.query('BEGIN');await erase.query('DELETE FROM auth.users WHERE id=$1',[owner])
    await join.query('BEGIN');await join.query("SET LOCAL lock_timeout='5s'")
    const pending=join.query("INSERT INTO chat.chat_members(chat_id,user_id,role)VALUES($1,$2,'member')",[target,peer]).then(()=>null,error=>error)
    await waitingFor(jp,ep);await erase.query('COMMIT')
    expect(await pending).toMatchObject({code:'P0001',message:'cannot add membership for absent chat '+target})
    await join.query('ROLLBACK')
    expect((await row('SELECT count(*)::int n FROM chat.chats WHERE id=$1',[target])).n).toBe(0)
  }finally{await erase.query('ROLLBACK');await join.query('ROLLBACK');await erase.end();await join.end()}
})

it('measures real Auth deletion before and after with identical own-conversation fixtures',async()=>{
  const timings:Record<string,number>[]=[]
  try{
    for(const variant of ['before','after']){
      await db.query(variant==='before'?definition.replace(call,''):definition)
      const owner=await human(true),mine=await agent(owner),target=await room('group',owner,[owner,mine])
      await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content)
        SELECT gen_random_uuid()::text,$1,$2,'Synthetic message '||n FROM generate_series(1,1000)n`,[target,owner])
      const started=performance.now(),deleted=await auth('admin/users/'+owner,'DELETE'),elapsed=performance.now()-started
      expect(deleted.status).toBe(200);await deleted.body?.cancel()
      const absent=await auth('admin/users/'+owner);expect(absent.status).toBe(404);await absent.body?.cancel()
      const remaining=(await row('SELECT count(*)::int n FROM chat.messages WHERE chat_id=$1',[target])).n
      expect(remaining).toBe(variant==='before'?1001:0)
      timings.push({variant:variant==='before'?0:1,messages:1001,delete_http_ms:elapsed})
    }
    console.info('self-only-auth-delete-timing',JSON.stringify({scope:'owned loopback; one agent, one group, 1001 messages; audit unchanged',timings}))
  }finally{await db.query(definition)}
},60000)
