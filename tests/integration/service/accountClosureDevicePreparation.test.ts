// Installed operation core + device preparation only. No shared DB or Auth HTTP.
import { randomUUID, createHash } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
let db: pg.Client
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw Error('Disposable loopback required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
beforeEach(async () => { await db.query('BEGIN') })
afterEach(async () => { await db.query('ROLLBACK') })
afterAll(async () => { await db?.end() })
async function rejected(run: () => Promise<unknown>) {
  await db.query('SAVEPOINT denied')
  try { await run() } catch (error) { await db.query('ROLLBACK TO SAVEPOINT denied'); return error as pg.DatabaseError }
  throw Error('Expected refusal')
}
async function fixture() {
  const user=randomUUID(), sid=randomUUID(), op=randomUUID(), native=randomUUID(), machine=randomUUID(), device='phone-'+machine+'-'+user
  await db.query("INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at) VALUES($1,'authenticated','authenticated',$2,now(),now())",[user,user+'@closure.invalid'])
  await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())',[sid,user])
  await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,session_id:sid,role:'authenticated'})])
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,machine_id,tier,label,hostname,platform,auth_session_id,capabilities) VALUES($1,$2,$3,'fixture','phone','phone','android',$4,'{\"host_kind\":\"phone\",\"runtimes\":[\"pi\"],\"actions\":{\"actions\":[]}}')",[device,user,machine,sid])
  await db.query("INSERT INTO account_deletion_private.operations(id,operation_digest,receipt_digest,user_id,session_id,email_digest,consent_version,state,revision,challenge_generation) VALUES($1,$2,$3,$4,$5,$6,'immediate-forfeit-v1','open',0,1)",[op,op.replaceAll('-','').repeat(2),'a'.repeat(64),user,sid,createHash('sha256').update(user+'@closure.invalid').digest('hex')])
  return { user,sid,op,native,machine,device }
}
const prepare=(f: Awaited<ReturnType<typeof fixture>>) => db.query('SELECT account_deletion_private.device_preparation_prepare($1,$2,$3) r',[f.op,f.device,f.native]).then(r=>r.rows[0].r)
const read=(f: Awaited<ReturnType<typeof fixture>>,server: string) => db.query('SELECT account_deletion_private.device_preparation_read($1,$2,$3) r',[f.op,f.native,server]).then(r=>r.rows[0].r)
const cancel=(f: Awaited<ReturnType<typeof fixture>>,server: string) => db.query('SELECT account_deletion_private.device_preparation_cancel($1,$2,$3) r',[f.op,f.native,server]).then(r=>r.rows[0].r)
const enable=()=>db.query('UPDATE account_deletion_private.device_preparation_access SET enabled=true')
describe('private reversible device preparation',()=>{
  it('starts closed and grants no API role any helper or private table',async()=>{
    const f=await fixture()
    expect((await rejected(()=>prepare(f))).message).toContain('UNAVAILABLE')
    for(const role of ['anon','authenticated','service_role']) {
      expect((await db.query("SELECT has_function_privilege($1,'account_deletion_private.device_preparation_prepare(uuid,text,uuid)','EXECUTE') allowed",[role])).rows[0].allowed).toBe(false)
      expect((await db.query("SELECT has_table_privilege($1,'account_deletion_private.device_preparations','UPDATE') allowed",[role])).rows[0].allowed).toBe(false)
    }
  })
  it('preserves the device and owned Agent, withdraws capabilities and only ephemeral presence',async()=>{
    const f=await fixture(), agent=randomUUID()
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Retained agent',$2,$3)",[agent,f.user,f.device])
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[randomUUID(),f.device,f.user])
    await enable(); const first=await prepare(f)
    expect(await prepare(f)).toEqual(first)
    expect(await read(f,first.server_generation)).toEqual(first)
    expect((await db.query('SELECT device_id,owner_user_id,removed_at FROM identity.users WHERE id=$1',[agent])).rows[0]).toEqual({device_id:f.device,owner_user_id:f.user,removed_at:null})
    expect((await db.query('SELECT status,capabilities,auth_session_id FROM identity.gugu_devices WHERE device_id=$1',[f.device])).rows[0]).toMatchObject({status:'offline',capabilities:{host_kind:'phone',runtimes:[],terminals:[]},auth_session_id:f.sid})
    expect((await db.query('SELECT count(*)::int n FROM identity.runtime_instances WHERE device_id=$1',[f.device])).rows[0].n).toBe(0)
    expect((await db.query('SELECT count(*)::int n FROM auth.sessions WHERE id=$1',[f.sid])).rows[0].n).toBe(1)
    expect((await rejected(()=>db.query('SELECT identity.remove_device($1,true)',[f.device]))).code).toBe('42501')
    expect((await db.query('SELECT removed_at FROM identity.users WHERE id=$1',[agent])).rows[0].removed_at).toBeNull()
  })
  it('refuses heartbeat updates, raw deletion and new runtime presence while sealed',async()=>{
    const f=await fixture(); await enable(); await prepare(f)
    for(const run of [
      ()=>db.query("UPDATE identity.gugu_devices SET status='online' WHERE device_id=$1",[f.device]),
      ()=>db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1',[f.device]),
      ()=>db.query('SELECT identity.runtime_instance_heartbeat($1,$2)',[randomUUID(),f.device]),
      ()=>db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[randomUUID(),f.device,f.user]),
    ]) expect((await rejected(run)).code).toBe('42501')
  })
  it('blocks reserve-only registration through the actual invoker RPC',async()=>{
    const f=await fixture(); await enable(); await prepare(f)
    await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:f.user,session_id:f.sid,role:'authenticated'})])
    await db.query('SET LOCAL ROLE authenticated')
    const device={device_id:f.device,machine_id:f.machine,tier:'fixture',label:'phone',hostname:'phone',platform:'android',reserve_only:true,capabilities:{host_kind:'phone'}}
    expect((await rejected(()=>db.query('SELECT identity.register_gugu_device($1)',[device]))).message).toContain('DEVICE_CLOSURE_PREPARING')
  })
  it.each(['open','confirming','processing'])('cannot cancel %s or a wrong generation',async state=>{
    const f=await fixture(); await enable(); const prepared=await prepare(f)
    await db.query('UPDATE account_deletion_private.operations SET state=$2 WHERE id=$1',[f.op,state])
    expect((await rejected(()=>cancel(f,prepared.server_generation))).message).toContain('CANNOT_CANCEL')
  })
  it('releases only an authoritatively closed operation and leaves the device offline',async()=>{
    const f=await fixture(); await enable(); const prepared=await prepare(f)
    await db.query("UPDATE account_deletion_private.operations SET state='closed_before_confirm' WHERE id=$1",[f.op])
    expect((await rejected(()=>cancel(f,randomUUID()))).message).toContain('SCOPE_CONFLICT')
    const done=await cancel(f,prepared.server_generation)
    expect(done.cancelled).toBe(true); expect(await cancel(f,prepared.server_generation)).toEqual(done)
    expect((await db.query('SELECT status,capabilities FROM identity.gugu_devices WHERE device_id=$1',[f.device])).rows[0]).toMatchObject({status:'offline',capabilities:{runtimes:[],terminals:[]}})
  })
  it('rejects expired original SID and does not treat a gate closure as an unseal',async()=>{
    const f=await fixture(); await enable(); const prepared=await prepare(f)
    await db.query("UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id=$1",[f.sid])
    expect((await rejected(()=>read(f,prepared.server_generation))).code).toBe('42501')
    await db.query('UPDATE auth.sessions SET not_after=NULL WHERE id=$1',[f.sid])
    await db.query('UPDATE account_deletion_private.device_preparation_access SET enabled=false')
    expect((await rejected(()=>read(f,prepared.server_generation))).message).toContain('UNAVAILABLE')
    expect((await rejected(()=>prepare(f))).message).toContain('UNAVAILABLE')
    expect((await rejected(()=>db.query("UPDATE identity.gugu_devices SET status='online' WHERE device_id=$1",[f.device]))).code).toBe('42501')
  })
})
