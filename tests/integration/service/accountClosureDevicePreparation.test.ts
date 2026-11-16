// Installed operation core + device preparation only. No shared DB or Auth HTTP.
import { randomUUID, createHash } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
let db: pg.Client
let database: string
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw Error('Disposable loopback required')
  database = url.href
  db = new pg.Client({ connectionString: database }); await db.connect()
})
beforeEach(async () => { await db.query('BEGIN') })
afterEach(async () => { await db.query('ROLLBACK') })
afterAll(async () => { await db?.end() })
async function rejected(run: () => Promise<unknown>) {
  await db.query('SAVEPOINT denied')
  try { await run() } catch (error) { await db.query('ROLLBACK TO SAVEPOINT denied'); return error as pg.DatabaseError }
  throw Error('Expected refusal')
}
async function fixture(client = db) {
  const user=randomUUID(), sid=randomUUID(), op=randomUUID(), native=randomUUID(), machine=randomUUID(), device='phone-'+machine+'-'+user
  await client.query("INSERT INTO auth.users(id,aud,role,email,email_confirmed_at,created_at) VALUES($1,'authenticated','authenticated',$2,now(),now())",[user,user+'@closure.invalid'])
  await client.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())',[sid,user])
  await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,session_id:sid,role:'authenticated'})])
  await client.query("INSERT INTO identity.gugu_devices(device_id,user_id,machine_id,tier,label,hostname,platform,auth_session_id,capabilities) VALUES($1,$2,$3,'fixture','phone','phone','android',$4,'{\"host_kind\":\"phone\",\"runtimes\":[\"pi\"],\"actions\":{\"actions\":[]}}')",[device,user,machine,sid])
  await client.query("INSERT INTO account_deletion_private.operations(id,operation_digest,receipt_digest,user_id,session_id,email_digest,consent_version,state,revision,challenge_generation) VALUES($1,$2,$3,$4,$5,$6,'immediate-forfeit-v1','open',0,1)",[op,op.replaceAll('-','').repeat(2),'a'.repeat(64),user,sid,createHash('sha256').update(user+'@closure.invalid').digest('hex')])
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

// Two real contenders and the existing read-only observer. Every account and
// switch mutation is fixture-owned and cleaned in finally; no fake schema.
async function committedFixture(a: pg.Client) {
  await a.query('BEGIN')
  const previous=(await a.query('SELECT enabled FROM account_deletion_private.device_preparation_access')).rows[0].enabled as boolean
  const f=await fixture(a)
  await a.query('UPDATE account_deletion_private.device_preparation_access SET enabled=true')
  await a.query('COMMIT')
  return {...f,previous}
}
async function disposeCommitted(a: pg.Client,f: Awaited<ReturnType<typeof committedFixture>>) {
  await a.query('BEGIN')
  await a.query('DELETE FROM auth.users WHERE id=$1',[f.user])
  await a.query('DELETE FROM account_deletion_private.operations WHERE id=$1',[f.op])
  await a.query('UPDATE account_deletion_private.device_preparation_access SET enabled=$1',[f.previous])
  await a.query('COMMIT')
}
async function finishConnections(a: pg.Client,b: pg.Client,f: Awaited<ReturnType<typeof committedFixture>> | undefined) {
  await Promise.allSettled([a.query('ROLLBACK'),b.query('ROLLBACK')])
  try { if(f) await disposeCommitted(a,f) }
  finally { await Promise.allSettled([a.end(),b.end()]) }
}
async function claims(client: pg.Client,f: Awaited<ReturnType<typeof fixture>>) {
  await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:f.user,session_id:f.sid,role:'authenticated'})])
}
const prepareOn=(client: pg.Client,f: Awaited<ReturnType<typeof fixture>>) => client.query('SELECT account_deletion_private.device_preparation_prepare($1,$2,$3) r',[f.op,f.device,f.native])
describe('device preparation independent-connection fences',()=>{
  it('waits for an admitted heartbeat then removes its ephemeral presence before preparing',async()=>{
    const a=new pg.Client({connectionString:database}),b=new pg.Client({connectionString:database})
    await a.connect(); await b.connect()
    let f: Awaited<ReturnType<typeof committedFixture>> | undefined
    let pending: Promise<{value?: pg.QueryResult;error?: unknown}> | undefined
    try {
      f=await committedFixture(a)
      await a.query('BEGIN'); await claims(a,f)
      await a.query('SELECT 1 FROM identity.gugu_devices WHERE device_id=$1 FOR SHARE',[f.device])
      await a.query('SELECT identity.runtime_instance_heartbeat($1,$2)',[randomUUID(),f.device])
      const apid=(await a.query('SELECT pg_backend_pid() pid')).rows[0].pid
      await b.query('BEGIN'); await b.query("SET LOCAL statement_timeout='5s'")
      const bpid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid
      pending=prepareOn(b,f).then(value=>({value}),error=>({error}))
      let blocked=false
      for(let n=0;n<100&&!blocked;n++) {
        blocked=(await db.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) blocked',[apid,bpid])).rows[0].blocked
        if(!blocked) await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect(blocked).toBe(true)
      await a.query('COMMIT')
      const completed=await pending; if(completed.error) throw completed.error
      expect(completed.value?.rows[0].r.prepared).toBe(true)
      await b.query('COMMIT')
      expect((await db.query('SELECT count(*)::int n FROM identity.runtime_instances WHERE device_id=$1',[f.device])).rows[0].n).toBe(0)
      expect((await db.query('SELECT status FROM identity.gugu_devices WHERE device_id=$1',[f.device])).rows[0].status).toBe('offline')
    } finally {
      await finishConnections(a,b,f); await pending
    }
  })
  it.each(['device','runtime'])('rejects an old RR snapshot attempting a late %s publication',async target=>{
    const a=new pg.Client({connectionString:database}),b=new pg.Client({connectionString:database})
    await a.connect(); await b.connect()
    let f: Awaited<ReturnType<typeof committedFixture>> | undefined
    try {
      f=await committedFixture(a)
      await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await claims(a,f)
      await a.query('SELECT status FROM identity.gugu_devices WHERE device_id=$1',[f.device])
      await b.query('BEGIN'); expect((await prepareOn(b,f)).rows[0].r.prepared).toBe(true); await b.query('COMMIT')
      const late=target==='device'
        ? a.query("UPDATE identity.gugu_devices SET status='online' WHERE device_id=$1",[f.device])
        : a.query('SELECT identity.runtime_instance_heartbeat($1,$2)',[randomUUID(),f.device])
      await expect(late).rejects.toMatchObject({code:'40001'})
      await a.query('ROLLBACK')
      expect((await db.query('SELECT status FROM identity.gugu_devices WHERE device_id=$1',[f.device])).rows[0].status).toBe('offline')
      expect((await db.query('SELECT count(*)::int n FROM identity.runtime_instances WHERE device_id=$1',[f.device])).rows[0].n).toBe(0)
    } finally {
      await finishConnections(a,b,f)
    }
  })
  it('refuses runtime admission without waiting while preparation holds the device',async()=>{
    const a=new pg.Client({connectionString:database}),b=new pg.Client({connectionString:database})
    await a.connect(); await b.connect()
    let f: Awaited<ReturnType<typeof committedFixture>> | undefined
    try {
      f=await committedFixture(a)
      await b.query('BEGIN'); await prepareOn(b,f)
      await a.query('BEGIN'); await claims(a,f)
      await a.query("SET LOCAL statement_timeout='2s'")
      await expect(a.query('SELECT identity.runtime_instance_heartbeat($1,$2)',[randomUUID(),f.device])).rejects.toMatchObject({code:'55P03'})
      await a.query('ROLLBACK'); await b.query('COMMIT')
      expect((await db.query('SELECT count(*)::int n FROM identity.runtime_instances WHERE device_id=$1',[f.device])).rows[0].n).toBe(0)
    } finally {
      await finishConnections(a,b,f)
    }
  })
})
