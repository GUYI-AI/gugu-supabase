
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'
import { expect,it } from 'vitest'

it('serves the explicit gate through real Auth/JWT/PostgREST and preserves saved state across upgrade',async()=>{
  const endpoint=process.env.GUGU_INTEGRATION_SUPABASE_URL!
  const database=process.env.GUGU_INTEGRATION_DATABASE_URL!
  for(const url of [endpoint,database])if(!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))
    throw new Error('Management gate acceptance requires its disposable loopback fixture')
  const service=process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY!,anon=process.env.VITE_SUPABASE_ANON_KEY!
  const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}
  const admin=createClient(endpoint,service,options),owner=createClient(endpoint,anon,options)
  const db=new pg.Client({connectionString:database});await db.connect()
  const email=randomUUID()+'@management-gate.invalid',password=randomUUID()
  let ownerId:string|undefined
  const name='identity.connection_snapshot(text)'
  try {
    const created=await admin.auth.admin.createUser({email,password,email_confirm:true})
    expect(created.error).toBeNull();ownerId=created.data.user!.id
    const signed=await owner.auth.signInWithPassword({email,password})
    expect(signed.error).toBeNull()
    const token=signed.data.session!.access_token
    const rpc=async(fn:string,args:unknown={},version?:string,bearer=token)=>fetch(endpoint+'/rest/v1/rpc/'+fn,{
      method:'POST',headers:{apikey:anon,authorization:'Bearer '+bearer,'content-type':'application/json','content-profile':'identity',
        ...(version?{'x-gugu-connection-client-version':version,'x-gugu-connection-client-platform':'desktop'}:{})},body:JSON.stringify(args)})
    const initialPolicy=(await db.query('SELECT revision::text,enforced,minimum_versions FROM identity.connection_management_client_policy WHERE id')).rows[0]
    const nextRevision=String(BigInt(initialPolicy.revision)+1n)
    const read=await rpc('connection_management_access')
    expect(read.status).toBe(200);expect(await read.json()).toMatchObject({enforced:false,allowed:true,policyRevision:initialPolicy.revision,message:null})
    expect((await db.query('SELECT count(*)::int n FROM identity.connection_heads WHERE owner_user_id=$1',[ownerId])).rows[0].n).toBe(0)
    await db.query("SELECT identity.connection_management_set_policy(revision,true,'{\"desktop\":\"8.0.0-beta.12\"}') FROM identity.connection_management_client_policy WHERE id")
    const denied=await rpc('connection_management_access',{},'8.0.0-beta.2+fixture')
    expect(denied.status).toBe(200)
    expect(await denied.json()).toMatchObject({allowed:false,enforced:true,errorCode:'CONNECTION_CLIENT_UPGRADE_REQUIRED',message:'请升级到 8.0.0-beta.12 版本后再管理连接'})
    expect((await rpc('connection_authority')).status).toBe(200)
    const anonymous=await rpc('connection_management_access',{},undefined,anon)
    expect(anonymous.status).toBe(401);expect((await anonymous.json()).code).toBe('42501')
    expect((await rpc('connection_management_access',{},undefined,service)).status).toBe(403)
    // Only the disposable fixture grants the dormant reader to test its body.
    expect((await db.query('SELECT has_function_privilege(\'authenticated\',$1,\'EXECUTE\') allowed',[name])).rows[0].allowed).toBe(false)
    await db.query('GRANT EXECUTE ON FUNCTION '+name+' TO authenticated')
    const refused=await rpc('connection_snapshot',{p_device_id:null},'0.3.1')
    expect(refused.status).toBe(426)
    const error=await refused.json()
    expect(error).toMatchObject({code:'PT426',message:'请升级到 8.0.0-beta.12 版本后再管理连接'})
    expect(JSON.parse(error.details)).toEqual({errorCode:'CONNECTION_CLIENT_UPGRADE_REQUIRED',feature:'connection-management',minimumVersion:'8.0.0-beta.12',clientPlatform:'desktop',policyRevision:nextRevision})
    await db.query("INSERT INTO identity.connection_heads(owner_user_id,native_initialized_at,authority_mode,revision) VALUES($1,clock_timestamp(),'owner',2)",[ownerId])
    await db.query(`INSERT INTO identity.connection_items(owner_user_id,scope_key,resource_key,revision,data,public_metadata,deleted_at)
      VALUES($1,'platform','["amap","saved"]',1,'{"providerId":"amap","accountId":"saved","configured":true}','{"providerId":"amap","accountId":"saved"}',NULL),
      ($1,'platform','["amap","revoked"]',2,'{"providerId":"amap","accountId":"revoked"}',NULL,clock_timestamp())`,[ownerId])
    const before=(await db.query('SELECT to_jsonb(i) value FROM identity.connection_items i WHERE owner_user_id=$1 ORDER BY resource_key',[ownerId])).rows
    const restored=await rpc('connection_snapshot',{p_device_id:null},'8.0.0-beta.12+fixture')
    expect(restored.status).toBe(200)
    const snapshot=await restored.json()
    expect(snapshot.state).toBe('ready');expect(snapshot.items).toHaveLength(2)
    expect(snapshot.items.find((x:{resourceKey:string})=>x.resourceKey==='["amap","revoked"]').deletedAt).toBeTruthy()
    expect((await db.query('SELECT to_jsonb(i) value FROM identity.connection_items i WHERE owner_user_id=$1 ORDER BY resource_key',[ownerId])).rows).toEqual(before)
  } finally {
    await db.query('REVOKE EXECUTE ON FUNCTION '+name+' FROM authenticated')
    await db.query("SELECT identity.connection_management_set_policy(revision,false,'{}') FROM identity.connection_management_client_policy WHERE id")
    if(ownerId)expect((await admin.auth.admin.deleteUser(ownerId)).error).toBeNull()
    await owner.removeAllChannels();await admin.removeAllChannels();await db.end()
  }
},60_000)
