import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let db:pg.Client, actor:string, member:string, team:string, session:string
let metadata:Record<string,string>
const scalar=async(sql:string,args:unknown[]=[]) => (await db.query(sql,args)).rows[0]?.v
const active=()=>scalar('SELECT identity.team_session_is_active() v')
async function claims(patch:Record<string,unknown>={}) {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub:actor,role:'authenticated',session_id:session,app_metadata:metadata,...patch})])
}
async function client(sql:string,args:unknown[]=[]) {
  await db.query('SET LOCAL ROLE authenticated')
  try{return await db.query(sql,args)}finally{await db.query('RESET ROLE')}
}
beforeAll(async()=>{
  const url=new URL(process.env.GUGU_INTEGRATION_DATABASE_URL??'')
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Owned loopback database required')
  db=new pg.Client({connectionString:url.href});await db.connect()
})
beforeEach(async()=>{
  await db.query('BEGIN')
  actor=randomUUID();member=randomUUID();team=randomUUID();session=randomUUID()
  metadata={gugu_account_kind:'team_member',gugu_team_id:team,gugu_member_id:member,gugu_team_region:'cn'}
  await db.query("UPDATE team_private.deployment SET region='cn' WHERE singleton")
  await db.query(`INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at,raw_app_meta_data)
    VALUES($1,'authenticated','authenticated',$2,now(),now(),$3)`,[actor,randomUUID()+'@gate-fixture.invalid',JSON.stringify(metadata)])
  await db.query("INSERT INTO team_private.teams(id,name,region,state)VALUES($1,'Gate fixture','cn','active')",[team])
  await db.query(`INSERT INTO team_private.members(id,team_id,principal_user_id,email_normalized,state)
    VALUES($1,$2,$3,$4,'active')`,[member,team,actor,randomUUID()+'@member-fixture.invalid'])
  await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at)VALUES($1,$2,now(),now())',[session,actor])
  await claims()
})
afterEach(async()=>{await db.query('ROLLBACK')})
afterAll(async()=>{await db?.end()})

it('checks the current session and live membership instead of trusting the old JWT',async()=>{
  expect(await active()).toBe(true)
  await db.query("UPDATE team_private.members SET state='disabled',revision=revision+1 WHERE id=$1",[member])
  expect(await active()).toBe(false)
  expect(await scalar('SELECT EXISTS(SELECT 1 FROM auth.sessions WHERE id=$1) v',[session])).toBe(true)
  await db.query("UPDATE team_private.members SET state='active',revision=revision+1 WHERE id=$1",[member])
  expect(await active()).toBe(true)
  await db.query('DELETE FROM auth.sessions WHERE id=$1',[session])
  expect(await active()).toBe(false)
})
it('fails closed for missing/malformed/another principal session and fixed metadata mismatch',async()=>{
  for(const patch of [{session_id:null},{session_id:'invalid'},{session_id:randomUUID()},
    {app_metadata:{...metadata,gugu_member_id:randomUUID()}},{app_metadata:{...metadata,gugu_team_region:'hk'}},
    {app_metadata:{gugu_account_kind:'personal'}}]){
    await claims(patch);expect(await active()).toBe(false)
  }
})
it('requires the local deployment region and rejects a copied team from another region',async()=>{
  await db.query('UPDATE team_private.deployment SET region=NULL WHERE singleton');expect(await active()).toBe(false)
  await db.query("UPDATE team_private.deployment SET region='hk' WHERE singleton");expect(await active()).toBe(false)
  await db.query('SAVEPOINT refused')
  await expect(db.query('SELECT identity.team_context_for($1)',[actor])).rejects.toMatchObject({message:'team_region_mismatch'})
  await db.query('ROLLBACK TO SAVEPOINT refused')
  await db.query("UPDATE team_private.deployment SET region='cn' WHERE singleton");expect(await active()).toBe(true)
})
it('fails closed while the later region helper has not been installed',async()=>{
  await db.query('ALTER FUNCTION identity.team_deployment_region() RENAME TO fixture_unavailable_region')
  expect(await active()).toBe(false)
})
it('rejects suspended organizations and banned principals',async()=>{
  await db.query("UPDATE team_private.teams SET state='suspended' WHERE id=$1",[team]);expect(await active()).toBe(false)
  await db.query("UPDATE team_private.teams SET state='active' WHERE id=$1",[team])
  await db.query("UPDATE auth.users SET banned_until=now()+interval '1 hour' WHERE id=$1",[actor]);expect(await active()).toBe(false)
})
it('preserves the ordinary personal path without region configuration or synthetic Auth sessions',async()=>{
  const personal=randomUUID()
  await db.query("INSERT INTO auth.users(id,email_confirmed_at,created_at)VALUES($1,now(),now())",[personal])
  await db.query('UPDATE team_private.deployment SET region=NULL WHERE singleton')
  await claims({sub:personal,session_id:null,app_metadata:{}})
  expect(await active()).toBe(true)
  expect((await client('SELECT id FROM identity.users WHERE id=$1',[personal])).rows).toHaveLength(1)
})
it('intersects existing row scopes and closes delegated agent/file authorization',async()=>{
  expect((await client('SELECT id FROM identity.users WHERE id=$1',[actor])).rows).toHaveLength(1)
  await db.query("UPDATE team_private.members SET state='disabled',revision=revision+1 WHERE id=$1",[member])
  expect((await client('SELECT id FROM identity.users WHERE id=$1',[actor])).rows).toHaveLength(0)
  expect(await scalar('SELECT identity.user_is_live($1) v',[actor])).toBe(false)
  expect(await scalar('SELECT chat.is_acting_as($1) v',[actor])).toBe(false)
})
it('preserves direct UUID group creation without recursive policy expansion',async()=>{
  const item=randomUUID(),publicId=(await db.query("SELECT nextval('chat.public_chat_id_seq') n")).rows[0].n
  await client("INSERT INTO chat.chats(id,public_id,kind,name,creator_user_id)VALUES($1,$2,'group','gate direct insert',$3)",[item,publicId,actor])
  expect(await scalar('SELECT EXISTS(SELECT 1 FROM chat.chats WHERE id=$1) v',[item])).toBe(true)
})
it('binds subscriptions and publishing to the current member revision and Auth session',async()=>{
  const namespace=await scalar('SELECT identity.team_realtime_namespace_for($1,$2) v',[actor,session])
  const topic='gugu:user:'+actor+':events'
  expect(namespace).toContain(':r:1:session:')
  expect(await scalar('SELECT identity.team_realtime_access($1,false) v',[namespace+topic])).toBe(true)
  expect(await scalar('SELECT identity.team_realtime_fence($1,true) v',[namespace+topic])).toBe(false)
  expect(await scalar('SELECT identity.team_realtime_fence($1,false) v',[topic])).toBe(false)
  expect((await db.query('SELECT team_private.event_topics($1) topic',[topic])).rows).toEqual([{topic:namespace+topic}])
  await db.query("UPDATE team_private.members SET state='disabled',revision=2 WHERE id=$1",[member])
  expect((await db.query('SELECT team_private.event_topics($1) topic',[topic])).rows).toHaveLength(0)
  await db.query("UPDATE team_private.members SET state='active',revision=3 WHERE id=$1",[member])
  expect(await scalar('SELECT identity.team_realtime_access($1,false) v',[namespace+topic])).toBe(false)
  const current=await scalar('SELECT identity.team_realtime_namespace_for($1,$2) v',[actor,session])
  expect(current).toContain(':r:3:session:')
  await db.query('DELETE FROM auth.sessions WHERE id=$1',[session])
  expect((await db.query('SELECT team_private.event_topics($1) topic',[topic])).rows).toHaveLength(0)
})
it('keeps arbitrary actor/session helpers, deployment writes and private tables closed to API clients',async()=>{
  expect(await scalar("SELECT has_function_privilege('authenticated','identity.team_session_is_active()','EXECUTE') v")).toBe(true)
  for(const role of ['anon','authenticated']){
    expect(await scalar('SELECT has_function_privilege($1,\'identity.team_realtime_namespace_for(uuid,uuid)\',\'EXECUTE\') v',[role])).toBe(false)
    expect(await scalar('SELECT has_function_privilege($1,\'identity.team_deployment_region()\',\'EXECUTE\') v',[role])).toBe(false)
    expect(await scalar('SELECT has_table_privilege($1,\'team_private.deployment\',\'UPDATE\') v',[role])).toBe(false)
    expect(await scalar('SELECT has_function_privilege($1,\'chat.files_authorize(uuid,text,text,text)\',\'EXECUTE\') v',[role])).toBe(false)
  }
  expect(await scalar("SELECT has_table_privilege('service_role','team_private.deployment','UPDATE') v")).toBe(false)
})
