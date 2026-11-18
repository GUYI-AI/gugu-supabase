import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Fixture,filesConfig,startFiles,machine,openPage,getFile,type Running,type Machine,type Page } from '../files/support.ts'

let db:pg.Client, admin:SupabaseClient, previousRegion:string|null
const url=process.env.GUGU_INTEGRATION_SUPABASE_URL??'', anon=process.env.VITE_SUPABASE_ANON_KEY??''
const team=randomUUID(), probe='team_gate_probe_fixture_'+randomUUID().replaceAll('-','')
const chat=randomUUID();let objectKey:string|null=null
const seats:{id:string,member:string,token:string,session:string}[]=[], clients:SupabaseClient[]=[]
let otherLogin:typeof seats[number]
const targetDevice='gate-device-'+randomUUID()
const transportReady=new Set<string>()
let fileFixture:Fixture|null=null,fileService:Running|null=null
let fileLoginRole:string|null=null
const fileMachines:Machine[]=[],filePages:Page[]=[]
const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check:()=>boolean|Promise<boolean>,timeout=5000){
  const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await pause(50)}throw Error('Owned fixture observation timed out')
}
function rpc(token:string){return fetch(url+'/rest/v1/rpc/'+probe,{method:'POST',headers:{apikey:anon,authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'})}
async function subscribe(token:string,topic:string,received:string[]){
  const c=createClient(url,anon,options);clients.push(c);await c.realtime.setAuth(token)
  const channel=c.channel(topic,{config:{private:true,broadcast:{ack:true}}})
    .on('broadcast',{event:'gate_probe'},e=>received.push(e.payload.tag))
    .on('broadcast',{event:'transport_probe'},e=>transportReady.add(e.payload.tag))
  await new Promise<void>((resolve,reject)=>{channel.subscribe((status)=>{
    if(status==='SUBSCRIBED')resolve();if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')reject(Error('Owned private channel did not authorize'))
  })})
  return channel
}
beforeAll(async()=>{
  const dbUrl=new URL(process.env.GUGU_INTEGRATION_DATABASE_URL??''), api=new URL(url)
  if(dbUrl.hostname!=='127.0.0.1'||api.hostname!=='127.0.0.1'||Number(api.port)!==Number(dbUrl.port)-1)throw Error('Matching owned loopback services required')
  db=new pg.Client({connectionString:dbUrl.href});await db.connect()
  previousRegion=(await db.query('SELECT region FROM team_private.deployment WHERE singleton')).rows[0].region
  await db.query("UPDATE team_private.deployment SET region='cn' WHERE singleton")
  admin=createClient(url,process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY??'',options)
  await db.query("INSERT INTO team_private.teams(id,name,region,state)VALUES($1,'HTTP gate fixture','cn','active')",[team])
  for(let i=0;i<2;i++){
    const member=randomUUID(),email=randomUUID()+'@live-gate.invalid',password=randomUUID()+randomUUID()
    const created=await admin.auth.admin.createUser({email,password,email_confirm:true,app_metadata:{gugu_account_kind:'team_member',gugu_team_id:team,gugu_member_id:member,gugu_team_region:'cn'}})
    if(created.error||!created.data.user)throw Error('Owned synthetic principal could not be created')
    const id=created.data.user.id
    seats.push({id,member,token:'',session:''})
    await db.query(`INSERT INTO team_private.members(id,team_id,principal_user_id,email_normalized,state)
      VALUES($1,$2,$3,$4,'active')`,[member,team,id,randomUUID()+'@live-member.invalid'])
    const auth=createClient(url,anon,options)
    const signed=await auth.auth.signInWithPassword({email,password})
    if(signed.error||!signed.data.session)throw Error('Owned principal could not sign in')
    const token=signed.data.session.access_token
    const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString())
    seats[i].token=token;seats[i].session=claims.session_id
    if(i===0){
      const secondAuth=createClient(url,anon,options), signedAgain=await secondAuth.auth.signInWithPassword({email,password})
      if(signedAgain.error||!signedAgain.data.session)throw Error('Owned second login failed')
      const otherToken=signedAgain.data.session.access_token
      otherLogin={id,member,token:otherToken,session:JSON.parse(Buffer.from(otherToken.split('.')[1],'base64url').toString()).session_id}
    }
  }
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)VALUES($1,$2,'gate fixture','fixture','linux')",[targetDevice,seats[0].id])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id)VALUES($1,'group','Storage gate fixture',$2)",[chat,seats[0].id])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role)VALUES($1,$2,'owner')",[chat,seats[0].id])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role)VALUES($1,$2,'member')",[chat,seats[1].id])
  objectKey=seats[0].id+'/'+randomUUID()+'.png'
  const uploaded=await admin.storage.from('feedback-screenshots').upload(objectKey,new Uint8Array([1,2,3]),{contentType:'image/png'})
  if(uploaded.error)throw Error('Owned private Storage fixture upload failed')
  await db.query(`CREATE FUNCTION public.${probe}() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT 7'; GRANT EXECUTE ON FUNCTION public.${probe}() TO authenticated; NOTIFY pgrst,'reload schema'`)
  await until(async()=>{const r=await rpc(seats[0].token);await r.body?.cancel();return r.status===200},10000)
})
afterAll(async()=>{
  for(const p of filePages)p.close()
  for(const m of fileMachines)m.socket.destroy()
  await fileService?.close()
  // pg.end() resolves at local socket shutdown; the server can still be
  // retiring that backend. Do not race Fixture.cleanup's forced termination
  // against a closing pool connection and turn its 57P01 into an uncaught event.
  // A genuine leaked connection fails this bounded readback instead of being
  // hidden by cleanup or by ignoring the error.
  if(fileLoginRole)await until(async()=>(await db.query(
    'SELECT count(*)::int n FROM pg_stat_activity WHERE usename=$1',[fileLoginRole])).rows[0].n===0,5000)
  await fileFixture?.cleanup()
  for(const c of clients)await c.removeAllChannels()
  if(db){
    if(objectKey){const removed=await admin.storage.from('feedback-screenshots').remove([objectKey]);expect(removed.error).toBeNull()}
    await db.query('DELETE FROM chat.chats WHERE id=$1',[chat])
    await db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1',[targetDevice])
    await db.query(`DROP FUNCTION IF EXISTS public.${probe}(); NOTIFY pgrst,'reload schema'`)
    await db.query('DELETE FROM team_private.members WHERE team_id=$1',[team])
    await db.query('DELETE FROM team_private.teams WHERE id=$1',[team])
    for(const s of seats){const deleted=await admin.auth.admin.deleteUser(s.id);expect(deleted.error).toBeNull();s.token=''}
    await db.query('UPDATE team_private.deployment SET region=$1 WHERE singleton',[previousRegion])
    await db.end()
  }
})

it('denies old HTTP JWTs and stops content on old live private subscriptions after disable, revision change and sign-out',async()=>{
  const first=seats[0],second=seats[1], original=(s:typeof first)=>'gugu:user:'+s.id+':events'
  const namespace=async(s:typeof first)=>(await db.query('SELECT identity.team_realtime_namespace_for($1,$2) ns',[s.id,s.session])).rows[0].ns
  const oldEvents:string[]=[],otherEvents:string[]=[],newEvents:string[]=[]
  const oldNs=await namespace(first), old=await subscribe(first.token,oldNs+original(first),oldEvents)
  await subscribe(second.token,await namespace(second)+original(second),otherEvents)
  const send=async(s:typeof first,tag:string)=>{await db.query("SELECT chat.send_user_event($1::jsonb,'gate_probe',$2,true)",[JSON.stringify({tag}),original(s)])}
  // SUBSCRIBED attests channel authorization, not the lazy database-broadcast
  // replication startup. Exercise both actual transports before the assertions.
  await until(async()=>{
    for(const s of seats)await db.query("SELECT chat.send_user_event($1::jsonb,'transport_probe',$2,true)",[JSON.stringify({tag:s.member}),original(s)])
    if(transportReady.has(first.member)&&transportReady.has(second.member))return true
    await pause(150);return false
  },15000)
  expect((await rpc(first.token)).status).toBe(200)
  const stored=()=>fetch(url+'/storage/v1/object/authenticated/feedback-screenshots/'+objectKey,{headers:{apikey:anon,authorization:'Bearer '+first.token}})
  const readable=await stored()
  const detail=readable.ok?null:await readable.clone().json().catch(()=>null)
  expect(readable.status,JSON.stringify(detail)).toBe(200);await readable.body?.cancel()
  await send(first,'before');await send(second,'before');await until(()=>oldEvents.length===1&&otherEvents.length===1)
  const rpcEvents:string[]=[],rpcTopic='gugu:'+targetDevice+':rpc:asker-fixture'
  const rpcChannel=await subscribe(otherLogin.token,await namespace(otherLogin)+rpcTopic,rpcEvents)
  const publish=(token:string)=>fetch(url+'/rest/v1/rpc/team_publish_realtime',{method:'POST',headers:{apikey:anon,authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({p_topic:rpcTopic,p_payload:{tag:'cross-session-rpc'},p_event:'gate_probe'})})
  expect((await publish(first.token)).ok).toBe(true);await until(()=>rpcEvents.length===1)
  expect(await rpcChannel.send({type:'broadcast',event:'gate_probe',payload:{tag:'raw-denied'}},{timeout:1000})).not.toBe('ok')
  await pause(100);expect(rpcEvents).toEqual(['cross-session-rpc'])
  expect((await publish(second.token)).status).toBe(403)
  await db.query("UPDATE team_private.members SET state='disabled',revision=2 WHERE id=$1",[first.member])
  const denied=await rpc(first.token);expect(denied.status).toBe(403);expect(await denied.text()).toContain('team_access_denied')
  expect((await publish(first.token)).status).toBe(403)
  const hidden=await stored();expect([400,403,404]).toContain(hidden.status);await hidden.body?.cancel()
  await send(first,'disabled');await send(second,'after-disable');await until(()=>otherEvents.length===2)
  await pause(300);expect(oldEvents).toEqual(['before']);expect(old.state).toBe('joined')
  await db.query("UPDATE team_private.members SET state='active',revision=3 WHERE id=$1",[first.member])
  const current=await namespace(first);expect(current).not.toBe(oldNs)
  const fresh=await subscribe(first.token,current+original(first),newEvents)
  await send(first,'restored');await until(()=>newEvents.length===1);expect(oldEvents).toEqual(['before'])
  const survivingEvents:string[]=[]
  await subscribe(otherLogin.token,await namespace(otherLogin)+original(first),survivingEvents)
  const out=await fetch(url+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:anon,authorization:'Bearer '+first.token}})
  expect(out.ok).toBe(true)
  expect((await rpc(first.token)).status).toBe(403)
  const authLookup=await fetch(url+'/auth/v1/user',{headers:{apikey:anon,authorization:'Bearer '+first.token}})
  expect(authLookup.status).toBe(403);await authLookup.body?.cancel()
  const revokedRead=await stored();expect([400,403,404]).toContain(revokedRead.status);await revokedRead.body?.cancel()
  expect((await rpc(otherLogin.token)).status).toBe(200)
  await send(first,'signed-out');await send(second,'after-sign-out');await until(()=>otherEvents.length===3)
  await until(()=>survivingEvents.includes('signed-out'))
  await pause(300);expect(newEvents).toEqual(['restored']);expect(fresh.state).toBe('joined')
},45000)

it('checks the same real Auth session on file HTTP reads and live document messages',async()=>{
  fileFixture=new Fixture();await fileFixture.connect()
  const status=JSON.parse(execFileSync(resolve('node_modules/.bin/supabase'),['status','--workdir',resolve('.local/test-db'),'--output','json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))
  const filesDbUrl=await fileFixture.filesLogin();fileLoginRole=new URL(filesDbUrl).username
  fileService=await startFiles(filesConfig(filesDbUrl,url+'/auth/v1/.well-known/jwks.json',{
    jwtSecret:status.JWT_SECRET?new TextEncoder().encode(status.JWT_SECRET):null,
  }))
  const item=await fileFixture.file(chat,seats[0].id,'live-gate.md','text/markdown','seed\n')
  expect((await getFile(fileService.url,seats[0].token,item)).status).toBe(404)
  expect((await getFile(fileService.url,otherLogin.token,item)).status).toBe(200)
  const open=(token:string)=>{const m=machine(fileService!.url,token);fileMachines.push(m);const p=openPage(m,item,0);filePages.push(p);return p}
  const revoked=open(otherLogin.token),kept=open(seats[1].token)
  await Promise.all([revoked.synced,kept.synced])
  kept.doc.getText('content').insert(0,'before:')
  await until(async()=>(await fileFixture!.row(item)).inline_text?.startsWith('before:')===true,10000)
  const out=await fetch(url+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:anon,authorization:'Bearer '+otherLogin.token}})
  expect(out.ok).toBe(true)
  await until(()=>revoked.events.closed!==null)
  expect((await getFile(fileService.url,otherLogin.token,item)).status).toBe(404)
  expect((await getFile(fileService.url,seats[1].token,item)).status).toBe(200)
  kept.doc.getText('content').insert(0,'kept:')
  await until(async()=>(await fileFixture!.row(item)).inline_text?.startsWith('kept:')===true)
  expect(revoked.text()).not.toContain('kept:')
  await db.query("UPDATE team_private.members SET state='disabled',revision=revision+1 WHERE id=$1",[seats[1].member])
  await until(()=>kept.events.closed!==null)
  expect((await getFile(fileService.url,seats[1].token,item)).status).toBe(404)
  kept.doc.getText('content').insert(0,'denied:')
  await pause(100)
  expect((await fileFixture.row(item)).inline_text).toMatch(/^kept:before:/)
},45000)
