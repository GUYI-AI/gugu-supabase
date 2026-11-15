import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { afterAll,afterEach,beforeAll,beforeEach,expect,it } from 'vitest'

const source=readFileSync(new URL('../../../ops/rollback-team-live-session-gate.sql',import.meta.url),'utf8')
const body=source.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'')
let db:pg.Client
const producers=()=>db.query(`SELECT p.oid,p.oid::regprocedure::text AS signature,p.prosrc,p.proowner,p.proacl,
  p.prosecdef,p.proconfig,p.provolatile,p.proparallel,p.proleakproof FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN ('chat','identity','moments','public') AND p.prosrc LIKE '%identity.send_team_realtime(%'
    AND p.oid<>'public.team_publish_realtime(text,jsonb,text)'::regprocedure ORDER BY p.oid`)
const policies=()=>db.query(`SELECT polrelid,polname,polcmd,polpermissive,polroles,polqual::text,polwithcheck::text
  FROM pg_policy WHERE polname NOT IN ('team_live_session_gate','team_realtime_fence','team_realtime_read')
  ORDER BY polrelid,polname`)
const hook=()=>db.query(`SELECT setdatabase,setconfig FROM pg_db_role_setting WHERE setrole='authenticator'::regrole ORDER BY setdatabase`)
async function run(){
  const results=[await db.query(body) as unknown as {rows:Record<string,unknown>[]}].flat()
  return results.at(-1)!.rows[0]
}
async function refused(message:string){
  const before=await hook(),beforeProducers=await producers()
  await db.query('SAVEPOINT refused')
  await expect(run()).rejects.toMatchObject({code:'55000',message})
  await db.query('ROLLBACK TO SAVEPOINT refused')
  expect((await hook()).rows).toEqual(before.rows)
  expect((await producers()).rows).toEqual(beforeProducers.rows)
}
beforeAll(async()=>{
  const url=new URL(process.env.GUGU_INTEGRATION_DATABASE_URL??'')
  if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Owned loopback database required')
  db=new pg.Client({connectionString:url.href});await db.connect()
})
beforeEach(async()=>{await db.query('BEGIN');await db.query('UPDATE team_private.deployment SET region=NULL WHERE singleton')})
afterEach(async()=>{await db.query('ROLLBACK')})
afterAll(async()=>{await db?.end()})

it('restores producers, only gate policies and the own hook while preserving security and retained data',async()=>{
  const old=(await producers()).rows,otherPolicies=(await policies()).rows
  expect(old.length).toBeGreaterThan(0)
  const users=(await db.query('SELECT count(*)::int n FROM auth.users')).rows
  const releases=(await db.query('SELECT * FROM gugu_install.releases ORDER BY version')).rows
  const r=await run()
  expect(r.producers_restored).toBe(old.length);expect(Number(r.policies_removed)).toBeGreaterThan(2)
  expect(Number(r.hook_settings_reset)).toBeGreaterThan(0);expect(r.team_principals).toBe(0)
  for(const original of old){
    const now=(await db.query(`SELECT p.oid,p.oid::regprocedure::text AS signature,p.prosrc,p.proowner,p.proacl,
      p.prosecdef,p.proconfig,p.provolatile,p.proparallel,p.proleakproof FROM pg_proc p WHERE p.oid=$1`,[original.oid])).rows[0]
    expect(now).toEqual({...original,prosrc:original.prosrc.replaceAll('identity.send_team_realtime(','realtime.send(')})
  }
  expect((await producers()).rows).toHaveLength(0)
  expect((await policies()).rows).toEqual(otherPolicies)
  expect((await hook()).rows.flatMap(r=>r.setconfig??[])).not.toContain('pgrst.db_pre_request=identity.team_request_gate')
  expect((await db.query('SELECT count(*)::int n FROM auth.users')).rows).toEqual(users)
  expect((await db.query('SELECT * FROM gugu_install.releases ORDER BY version')).rows).toEqual(releases)
  expect((await db.query('SELECT region FROM team_private.deployment WHERE singleton')).rows[0].region).toBeNull()
  expect((await db.query("SELECT has_function_privilege('gugu_files','chat.files_authorize(uuid,text,text,text)','EXECUTE') v")).rows[0].v).toBe(true)
  expect(await run()).toEqual({hook_settings_reset:0,policies_removed:0,producers_restored:0,team_principals:0})
})
it('refuses an open region before changing any policy or producer',async()=>{
  await db.query("UPDATE team_private.deployment SET region='cn' WHERE singleton")
  await refused('Close the deployment region before restoring the personal path')
})
it('refuses claimed and bound team principals even when disabled instead of erasing them',async()=>{
  const actor=randomUUID(),team=randomUUID(),member=randomUUID()
  await db.query(`INSERT INTO auth.users(id,email_confirmed_at,created_at,raw_app_meta_data)
    VALUES($1,now(),now(),'{"gugu_account_kind":"team_member"}')`,[actor])
  await refused('Full gate rollback requires zero team principals; preserve the deny-team fence')
  await db.query("UPDATE auth.users SET raw_app_meta_data='{}' WHERE id=$1",[actor])
  await db.query("INSERT INTO team_private.teams(id,name,region,state)VALUES($1,'Rollback fixture','cn','active')",[team])
  await db.query(`INSERT INTO team_private.members(id,team_id,principal_user_id,email_normalized,state)
    VALUES($1,$2,$3,$4,'disabled')`,[member,team,actor,randomUUID()+'@rollback-fixture.invalid'])
  await refused('Full gate rollback requires zero team principals; preserve the deny-team fence')
  expect((await db.query('SELECT principal_user_id,state FROM team_private.members WHERE id=$1',[member])).rows).toEqual([{principal_user_id:actor,state:'disabled'}])
})
it('refuses independent hooks and modified gate policy expressions atomically',async()=>{
  await db.query("ALTER ROLE authenticator SET pgrst.db_pre_request='public.independent_fixture_hook'")
  await refused('An independent Data API hook must not be overwritten')
  await db.query("ALTER ROLE authenticator SET pgrst.db_pre_request='identity.team_request_gate'")
  await db.query('ALTER POLICY team_live_session_gate ON identity.users USING(identity.team_session_is_active() OR true)')
  await refused('An unexpected gate policy must not be removed')
})
it('a rehearsal can restore catalog entries then roll the entire operation back',async()=>{
  const before=(await producers()).rows,settings=(await hook()).rows
  await db.query('SAVEPOINT rehearsal');await run();expect((await producers()).rows).toHaveLength(0)
  await db.query('ROLLBACK TO SAVEPOINT rehearsal')
  expect((await producers()).rows).toEqual(before);expect((await hook()).rows).toEqual(settings)
})
