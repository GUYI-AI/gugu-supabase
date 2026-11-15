import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: pg.Client
let owner: string, stranger: string, assistant: string, executor: string, home: string, device: string
let instance: string, workerInstance: string, coordinator: string, worker: string, chat: string
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
type Event = { message_id: string; kind: string; from_session_id: string; from_device_id: string; to_session_id: string; to_device_id: string; content?: string; [key: string]: unknown }
type Work = { work_id: string; outcome: string; terminal_version: string }
type Delivery = Event & { seq:string; lease_token: string; delivery_state: string; platform_received_at: string; assistant_admitted_at: string | null; owner_delivered_at: string | null; occurred_at?:string }

async function as<T>(user: string, action: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  await db.query('SET LOCAL ROLE authenticated')
  try { return await action() } finally { await db.query('RESET ROLE').catch(() => undefined) }
}
async function call<T = Record<string, unknown>>(name: string, args: unknown[]): Promise<T> {
  return (await db.query<{ result: T }>(`SELECT identity.${name}(${args.map((_,i) => `$${i+1}`).join(',')}) AS result`, args)).rows[0]!.result
}
async function failure(action: () => Promise<unknown>, pattern: RegExp) {
  await db.query('SAVEPOINT expected_failure')
  try { await expect(action()).rejects.toThrow(pattern) } finally { await db.query('ROLLBACK TO SAVEPOINT expected_failure') }
}
const task = (executors = [{ session_id: worker, device_id: device, agent_user_id: executor }]) => ({ title: 'Check a result', coordinator_session_id: coordinator, executors })
const dispatch = (extra: Partial<Event> = {}): Event => ({ message_id: randomUUID(), kind: 'dispatch', from_session_id: coordinator, from_device_id: home, to_session_id: worker, to_device_id: device, content: 'Please check this result', ...extra })
const report = (kind = 'completed', extra: Partial<Event> = {}): Event => ({ message_id: randomUUID(), kind, from_session_id: worker, from_device_id: device, to_session_id: coordinator, to_device_id: home, content: 'Verified the result', ...extra })
const commit = (id: string, events: Event[], initial: unknown = null, op = randomUUID(), runtime = instance) => as(owner, () => call<Work>('assistant_work_commit', [assistant,runtime,op,id,initial === null ? null : JSON.stringify(initial),JSON.stringify(events)]))
const list = (before: string | null = null, limit = 50) => as(owner, () => call<{ items: (Work & { created_seq: string; executors: unknown[] })[]; next_before: string | null }>('assistant_work_list', [assistant,before,limit]))
const history = (id: string, after = '0', limit = 100) => as(owner, () => call<{ work: Work & {coordinator_session_id:string;coordinator_device_id:string;executors:unknown[]}; events: Delivery[]; next_after: string | null }>('assistant_work_history', [assistant,id,after,limit]))
const claim = (runtime = instance, limit = 20) => as(owner, () => call<{ events: Delivery[] }>('assistant_work_outbox_claim', [runtime,limit,60]))
const settle = (event: Delivery, stage = 'executor_admitted', runtime = instance, receipt = {}) => as(owner, () => call('assistant_work_outbox_settle', [runtime,event.message_id,event.lease_token,stage,stage === 'retry' ? 'CHANNEL_UNAVAILABLE' : null,5,JSON.stringify(receipt)]))

beforeAll(async () => {
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw new Error('Work ledger tests require a disposable loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); stranger = randomUUID(); assistant = randomUUID(); executor = randomUUID()
  home = `ledger-${randomUUID()}`; device = `ledger-${randomUUID()}`
  instance = randomUUID(); workerInstance = randomUUID(); coordinator = randomUUID(); worker = randomUUID(); chat = randomUUID()
  for (const id of [owner,stranger]) {
    await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
      confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
      VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`,[id,`${id}@ledger.invalid`])
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Ledger test') ON CONFLICT DO NOTHING",[id])
  }
  for (const id of [home,device]) await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')",[id,owner])
  for (const [id,host] of [[assistant,home],[executor,device]]) await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Ledger agent',$2,$3)",[id,owner,host])
  await db.query("INSERT INTO chat.chats(id,kind,creator_user_id) VALUES($1,'dm',$2)",[chat,owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')",[chat,owner,assistant])
  const provision = randomUUID()
  await db.query("INSERT INTO identity.agent_provision_operations(id,owner_user_id,device_id,kind,payload_hash,blueprint,phase) VALUES($1,$2,$3,'single','fixture','{}','completed')",[provision,owner,home])
  await db.query(`INSERT INTO identity.agent_provisions(id,owner_user_id,operation_id,member_key,device_id,display_name,agent_type,inherit_memory,history_import_required,payload_hash,agent_user_id,provisioned_agent_user_id,dm_chat_id,phase)
    VALUES($1,$2,$3,'assistant',$4,'Ledger assistant','claude-code',false,false,'fixture',$5::text,$5::text::uuid,$6,'completed')`,[randomUUID(),owner,provision,home,assistant,chat])
  for (const [id,host] of [[instance,home],[workerInstance,device]]) await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[id,host,owner])
})
afterEach(async () => { await db.query('ROLLBACK') })

describe('account work ledger and its only delivery outbox', () => {
  it('leaves unbound reports unclaimed without spending attempts while dispatch remains available',async()=>{
    const id=randomUUID(),event=report('progress'),other=randomUUID(),first=dispatch()
    await commit(id,[dispatch()],task());await commit(id,[event],null,randomUUID(),workerInstance)
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='admitted',executor_admitted_at=now() WHERE work_id=$1 AND kind='dispatch'",[id])
    await commit(other,[first],task())
    await db.query("SELECT set_config('identity.agent_adopt_move_agent_id',$1,true)",[assistant])
    await db.query('UPDATE identity.users SET device_id=$1 WHERE id=$2',[device,assistant])
    expect((await claim(workerInstance)).events.map(row=>row.message_id)).toEqual([first.message_id])
    expect((await claim(workerInstance)).events).toHaveLength(0)
    expect((await db.query('SELECT delivery_state,attempts FROM identity.assistant_work_events WHERE message_id=$1',[event.message_id])).rows[0]).toEqual({delivery_state:'pending',attempts:0})
    await as(owner,()=>call('assistant_work_coordinator_bind',[assistant,workerInstance,randomUUID()]))
    const ready=(await claim(workerInstance)).events
    expect(ready.map(row=>row.message_id)).toEqual([event.message_id])
    await settle(ready[0]!,'assistant_admitted',workerInstance)
    expect((await history(id)).events.find(row=>row.message_id===event.message_id)?.delivery_state).toBe('admitted')
  })

  it('invalidates an in-flight report lease when its coordinator moves',async()=>{
    const id=randomUUID(),event=report('progress')
    await commit(id,[dispatch()],task());await commit(id,[event],null,randomUUID(),workerInstance)
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='admitted',executor_admitted_at=now() WHERE work_id=$1 AND kind='dispatch'",[id])
    const leased=(await claim()).events[0]!
    await db.query("SELECT set_config('identity.agent_adopt_move_agent_id',$1,true)",[assistant])
    await db.query('UPDATE identity.users SET device_id=$1 WHERE id=$2',[device,assistant])
    await failure(()=>settle(leased,'assistant_admitted'),/lease|token/i)
    expect((await claim()).events).toHaveLength(0)
    expect((await db.query('SELECT delivery_state,assistant_admitted_at FROM identity.assistant_work_events WHERE message_id=$1',[event.message_id])).rows[0]).toEqual({delivery_state:'pending',assistant_admitted_at:null})
    await as(owner,()=>call('assistant_work_coordinator_bind',[assistant,workerInstance,randomUUID()]))
    expect((await claim(workerInstance)).events[0]?.message_id).toBe(event.message_id)
  })

  it('requires a fresh binding when returning to a previously bound or original home',async()=>{
    const id=randomUUID(),nextSession=randomUUID(),third=`ledger-${randomUUID()}`
    await commit(id,[dispatch()],task())
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')",[third,owner])
    await db.query("SELECT set_config('identity.agent_adopt_move_agent_id',$1,true)",[assistant])
    await db.query('UPDATE identity.users SET device_id=$1 WHERE id=$2',[device,assistant])
    await as(owner,()=>call('assistant_work_coordinator_bind',[assistant,workerInstance,nextSession]))
    expect((await history(id)).work).toHaveProperty('coordinator_current',{session_id:nextSession,device_id:device})
    for(const target of [third,device,home]) {
      await db.query('UPDATE identity.users SET device_id=$1 WHERE id=$2',[target,assistant])
      expect((await history(id)).work).toHaveProperty('coordinator_current',null)
      expect((await db.query('SELECT current_coordinator_session_id,current_coordinator_device_id FROM identity.assistant_work WHERE work_id=$1',[id])).rows[0]).toEqual({current_coordinator_session_id:null,current_coordinator_device_id:null})
    }
    const fresh=randomUUID()
    await as(owner,()=>call('assistant_work_coordinator_bind',[assistant,instance,fresh]))
    expect((await history(id)).work).toHaveProperty('coordinator_current',{session_id:fresh,device_id:home})
  })

  it('binds the moved assistant coordinator without rewriting original report endpoints or hashes',async()=>{
    const id=randomUUID(),pending=randomUUID(),event=report(),nextSession=randomUUID()
    await commit(pending,[dispatch()],task())
    await commit(id,[dispatch()],task());await commit(id,[event],null,randomUUID(),workerInstance)
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='admitted',executor_admitted_at=now() WHERE work_id=$1 AND kind='dispatch'",[id])
    const original=(await db.query('SELECT event_hash,to_session_id,to_device_id FROM identity.assistant_work_events WHERE message_id=$1',[event.message_id])).rows[0]
    await db.query("SELECT set_config('identity.agent_adopt_move_agent_id',$1,true)",[assistant])
    await db.query('UPDATE identity.users SET device_id=$1 WHERE id=$2',[device,assistant])
    expect((await history(id)).work).toHaveProperty('coordinator_current',null)
    expect((await history(id)).events.find(row=>row.message_id===event.message_id)).toHaveProperty('delivery_target',null)
    await failure(()=>as(owner,()=>call('assistant_work_coordinator_bind',[assistant,instance,nextSession])),/home|runtime/i)
    await as(owner,()=>call('assistant_work_coordinator_bind',[assistant,workerInstance,nextSession]))
    expect(await as(owner,()=>call('assistant_work_coordinator_bind',[assistant,workerInstance,nextSession]))).toMatchObject({bound_count:0})
    expect((await history(id)).work).toHaveProperty('coordinator_current',{session_id:nextSession,device_id:device})
    expect((await history(id)).events.find(row=>row.message_id===event.message_id)).toHaveProperty('delivery_target',{session_id:nextSession,device_id:device})
    const relocatedClaim = (await claim(workerInstance)).events.find(row=>row.message_id===event.message_id)
    expect(relocatedClaim).toBeDefined()
    expect(relocatedClaim).toHaveProperty('coordinator_current',{session_id:nextSession,device_id:device})
    expect((await db.query('SELECT event_hash,to_session_id,to_device_id FROM identity.assistant_work_events WHERE message_id=$1',[event.message_id])).rows[0]).toEqual(original)
    const inference=report('failed',{from_session_id:nextSession,from_device_id:device,executor_session_id:worker,reason_code:'EXECUTOR_ENDED_WITHOUT_REPORT'})
    await commit(id,[inference],null,randomUUID(),workerInstance)
    expect((await history(id)).work.outcome).toBe('completed') // A relocated inference never replaces a real result.
    await failure(()=>commit(pending,[report('failed',{from_session_id:coordinator,from_device_id:home,executor_session_id:worker,reason_code:'RESULT_MISSING'})]),/sender|endpoint/i)
    await commit(pending,[{...inference,message_id:randomUUID(),to_session_id:nextSession,to_device_id:device}],null,randomUUID(),workerInstance)
    expect((await history(pending)).work.outcome).toBe('failed')
    await commit(pending,[report()],null,randomUUID(),workerInstance)
    expect((await history(pending)).work.outcome).toBe('completed')
  })

  it('reserves at most six notice wakes across runtime restarts, with server leases and grouped reasons',async()=>{
    const id=randomUUID(),one=dispatch(),two=dispatch()
    await commit(id,[one,two],task())
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='abandoned',abandoned_at=now(),abandoned_reason_code=CASE WHEN message_id=$1 THEN 'device_offline' ELSE 'SESSION_DEVICE_UNREACHABLE' END WHERE work_id=$2",[one.message_id,id])
    const wakes=(runtime=workerInstance)=>as(owner,()=>call<{items:Array<{anchor_message_id:string;reason_code:string;lease_token:string;lease_remaining_ms:number;wake_attempts:number}>}>('assistant_work_notice_wake_claim',[runtime,20,60]))
    expect((await wakes(instance)).items).toHaveLength(0) // Home reconciliation never spends a wake credit.
    for(let n=1;n<=6;n++) {
      const item=(await wakes()).items[0]!
      expect(item).toMatchObject({anchor_message_id:one.message_id,reason_code:'UNREACHABLE',wake_attempts:n})
      expect(item.lease_remaining_ms).toBeGreaterThan(59000)
      expect((await wakes()).items).toHaveLength(0)
      await failure(()=>as(owner,()=>call('assistant_work_notice_wake_release',[workerInstance,one.message_id,randomUUID()])),/lease|token/i)
      await as(owner,()=>call('assistant_work_notice_wake_release',[workerInstance,one.message_id,item.lease_token]))
      await as(owner,()=>call('assistant_work_notice_wake_release',[workerInstance,one.message_id,item.lease_token]))
      expect((await wakes()).items).toHaveLength(0) // Releasing does not reset server backoff.
      await db.query("UPDATE identity.assistant_work_notice_wakes SET available_at=now()-interval '1 second' WHERE anchor_message_id=$1",[one.message_id])
      const next=randomUUID()
      await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[next,device,owner]);workerInstance=next
    }
    expect((await wakes()).items).toHaveLength(0)
    expect((await history(id)).events).toHaveLength(2) // No second queue or synthetic payload.
  })

  it('keeps the same six-wake group and lease when an earlier event changes category',async()=>{
    const id=randomUUID(),earlier=dispatch(),later=dispatch()
    await commit(id,[earlier,later],task())
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='abandoned',abandoned_at=now(),abandoned_reason_code='DEVICE_OFFLINE' WHERE message_id=$1",[later.message_id])
    const take=()=>as(owner,()=>call<{items:Array<{anchor_message_id:string;lease_token:string;wake_attempts:number}>}>('assistant_work_notice_wake_claim',[workerInstance,20,60]))
    const first=(await take()).items[0]!
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='abandoned',abandoned_at=now(),abandoned_reason_code='DEVICE_UNREACHABLE' WHERE message_id=$1",[earlier.message_id])
    expect((await take()).items).toHaveLength(0)
    for(let n=1;n<=6;n++) {
      await db.query("UPDATE identity.assistant_work_notice_wakes SET lease_until=now()-interval '1 second',available_at=now()-interval '1 second' WHERE work_id=$1",[id])
      const rows=(await take()).items
      if(n===6) expect(rows).toHaveLength(0)
      else expect(rows[0]).toMatchObject({anchor_message_id:first.anchor_message_id,wake_attempts:n+1})
    }
  })

  it('separates completed delivery from an earlier question notice and hides all wake metadata',async()=>{
    const id=randomUUID(),question=report('question'),completed=report()
    await commit(id,[dispatch()],task());await commit(id,[question],null,randomUUID(),workerInstance)
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='abandoned',abandoned_at=now(),abandoned_reason_code='DEVICE_OFFLINE' WHERE message_id=$1",[question.message_id])
    const notice=randomUUID()
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,'Question not delivered','text')",[notice,chat,assistant])
    await as(owner,()=>call('assistant_work_owner_delivered',[assistant,instance,question.message_id,chat,notice,'abandonment_notice']))
    await commit(id,[completed],null,randomUUID(),workerInstance)
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='abandoned',abandoned_at=now(),abandoned_reason_code='DEVICE_OFFLINE' WHERE message_id=$1",[completed.message_id])
    const result=await as(owner,()=>call<{items:Array<{notice_kind:string}>}>('assistant_work_notice_wake_claim',[workerInstance,20,60]))
    expect(result.items).toHaveLength(1);expect(result.items[0]!.notice_kind).toBe('completed')
    for(const row of (await history(id)).events) expect(Object.keys(row).some(key=>key.startsWith('notice_wake_'))).toBe(false)
    for(const row of (await claim(workerInstance)).events) expect(Object.keys(row).some(key=>key.startsWith('notice_wake_'))).toBe(false)
    const abandoned=await as(owner,()=>call<{events:Delivery[]}>('assistant_work_abandoned',[instance,100]))
    expect(abandoned.events.map(row=>row.message_id)).toEqual([completed.message_id])
    await db.query('UPDATE identity.assistant_work_events SET owner_delivered_at=now() WHERE message_id=$1',[completed.message_id])
    expect((await as(owner,()=>call<{items:Work[]}>('assistant_work_list',[assistant,null,100,true]))).items).toHaveLength(0)
  })

  it('uses the same stable reason categories as notice consumers without exposing the internal classifier',async()=>{
    for(const [code,category] of [['LEGACY_REPORT_MISSING','REPORT_MISSING'],['EXECUTOR_FAILED','EXECUTION_FAILED'],['HOST_FAILURE','INTERRUPTED'],['SOURCE_UNAVAILABLE','SOURCE_UNAVAILABLE'],['unknown_method','INCOMPATIBLE'],['device_offline','UNREACHABLE'],['CONNECT_TIMEOUT','NO_RESPONSE'],['42501','PERMISSION'],['AUTH_FAILED','PERMISSION'],['OTHER','DELIVERY_FAILED']]) {
      expect(await call('assistant_work_notice_reason',[code])).toBe(category)
    }
    await failure(()=>as(owner,()=>call('assistant_work_notice_reason',['OTHER'])),/permission/i)
  })

  it('reclaims an expired notice lease, isolates accounts, and marks a whole reason group with one real owner post',async()=>{
    const id=randomUUID(),one=dispatch(),two=dispatch()
    await commit(id,[one,two],task())
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='abandoned',abandoned_at=now(),abandoned_reason_code='DEVICE_OFFLINE' WHERE work_id=$1",[id])
    const wake=()=>as(owner,()=>call<{items:Array<{anchor_message_id:string;lease_token:string}>}>('assistant_work_notice_wake_claim',[workerInstance,20,60]))
    const old=(await wake()).items[0]!
    await db.query("UPDATE identity.assistant_work_notice_wakes SET lease_until=now()-interval '1 second',available_at=now()-interval '1 second' WHERE anchor_message_id=$1",[one.message_id])
    await as(owner,()=>call('assistant_work_notice_wake_release',[workerInstance,one.message_id,old.lease_token]))
    await as(owner,()=>call('assistant_work_notice_wake_release',[workerInstance,one.message_id,old.lease_token]))
    const fresh=(await wake()).items[0]!
    expect(fresh.anchor_message_id).toBe(old.anchor_message_id);expect(fresh.lease_token).not.toBe(old.lease_token)
    await failure(()=>as(owner,()=>call('assistant_work_notice_wake_release',[workerInstance,one.message_id,old.lease_token])),/lease|token/i)
    await failure(()=>as(stranger,()=>call('assistant_work_notice_wake_claim',[workerInstance,20,60])),/lease|runtime/i)
    const notice=randomUUID()
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,'Could not reach the device','text')",[notice,chat,assistant])
    await as(owner,()=>call('assistant_work_owner_delivered',[assistant,instance,two.message_id,chat,notice,'abandonment_notice']))
    const rows=(await history(id)).events
    expect(rows.every(row=>row.abandonment_notified_at&&row.owner_delivered_at===null)).toBe(true)
    expect((await wake()).items).toHaveLength(0)
    const later=dispatch();await commit(id,[later])
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='abandoned',abandoned_at=now(),abandoned_reason_code='DEVICE_UNREACHABLE' WHERE message_id=$1",[later.message_id])
    expect((await wake()).items).toHaveLength(0) // A new member cannot reopen a notified group.
    const different=randomUUID()
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,'A different notice','text')",[different,chat,assistant])
    await failure(()=>as(owner,()=>call('assistant_work_owner_delivered',[assistant,instance,later.message_id,chat,different,'abandonment_notice'])),/receipt|different/i)
    await as(owner,()=>call('assistant_work_owner_delivered',[assistant,instance,later.message_id,chat,notice,'abandonment_notice']))
  })

  it('excludes ordinary progress and superseded failures, and retires HOST_FAILURE after its inferred result is delivered',async()=>{
    const id=randomUUID();await commit(id,[dispatch()],task())
    const hostFailure=report('progress',{reason_code:'HOST_FAILURE'})
    await commit(id,[hostFailure],null,randomUUID(),workerInstance)
    const inferred=report('failed',{from_session_id:coordinator,from_device_id:home,executor_session_id:worker,reason_code:'HOST_FAILURE'})
    await commit(id,[inferred])
    await db.query('UPDATE identity.assistant_work_events SET owner_delivered_at=now() WHERE message_id=$1',[inferred.message_id])
    const filtered=()=>as(owner,()=>call<{items:Work[]}>('assistant_work_list',[assistant,null,100,true]))
    expect((await filtered()).items).toHaveLength(0)
    await commit(id,[report('progress')],null,randomUUID(),workerInstance)
    expect((await as(owner,()=>call<{items:unknown[]}>('assistant_work_notice_wake_claim',[workerInstance,20,60]))).items).toHaveLength(0)
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='abandoned',abandoned_at=now(),abandoned_reason_code='HOST_FAILURE',owner_delivered_at=NULL WHERE message_id=$1",[inferred.message_id])
    await commit(id,[report()],null,randomUUID(),workerInstance)
    expect((await as(owner,()=>call<{items:unknown[]}>('assistant_work_notice_wake_claim',[workerInstance,20,60]))).items).toHaveLength(0)
  })

  it('reopens a finished executor when the coordinator dispatches to it again, then settles on its next result (#615)',async()=>{
    const id=randomUUID();await commit(id,[dispatch()],task())
    expect(await commit(id,[report('completed')],null,randomUUID(),workerInstance)).toMatchObject({outcome:'completed'})
    expect(await commit(id,[dispatch({content:'再列下载文件夹'})])).toMatchObject({outcome:'active'})
    const reopened=(await history(id)).work as Work & {executor_outcomes:Record<string,unknown>}
    expect(reopened.outcome).toBe('active')
    expect(reopened.executor_outcomes).not.toHaveProperty(worker)
    // A different result this time is its answer to the follow-up, not a contradiction of the first one.
    expect(await commit(id,[report('failed')],null,randomUUID(),workerInstance)).toMatchObject({outcome:'failed'})
    expect((await history(id)).events.filter(event=>event.kind==='dispatch')).toHaveLength(2)
  })

  it('closes stale imported work without a result and allows a late genuine result to prevail',async()=>{
    const id=randomUUID(),event=dispatch(),input={...task(),coordinator_device_id:home}
    await as(owner,()=>call('assistant_work_import',[assistant,workerInstance,id,JSON.stringify(input),JSON.stringify([{...event,occurred_at:'2026-10-20T08:00:00Z',receipt_kind:'received'}])]))
    expect((await list()).items.filter(row=>row.outcome==='active')).toHaveLength(0)
    const row=(await history(id)).work as Work & {executor_outcomes:Record<string,{origin:string;reason_code:string}>}
    expect(row.outcome).toBe('failed')
    expect(row.executor_outcomes[worker]).toMatchObject({origin:'coordinator',reason_code:'LEGACY_REPORT_MISSING'})
    await commit(id,[report()],null,randomUUID(),workerInstance)
    expect((await history(id)).work.outcome).toBe('completed')
  })
  it('accepts an original coordinator home after an evidenced assistant move',async()=>{
    const nextHome=`moved-${randomUUID()}`
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'next','next','linux')",[nextHome,owner])
    await db.query("SELECT set_config('identity.agent_adopt_move_agent_id',$1,true)",[assistant])
    await db.query('UPDATE identity.users SET device_id=$1 WHERE id=$2',[nextHome,assistant])
    const id=randomUUID(),event=dispatch(),input={...task(),coordinator_device_id:home}
    await as(owner,()=>call('assistant_work_import',[assistant,workerInstance,id,JSON.stringify(input),JSON.stringify([{...event,occurred_at:'2026-10-20T08:00:00Z',receipt_kind:'received'}])]))
    expect((await history(id)).work.work_id).toBe(id)
    const forged=randomUUID()
    await failure(()=>as(owner,()=>call('assistant_work_import',[assistant,workerInstance,forged,JSON.stringify({...input,coordinator_device_id:device}),JSON.stringify([{...event,from_device_id:device,occurred_at:'2026-10-20T08:00:00Z',receipt_kind:'received'}])])),/historical|coordinator|invalid/i)
  })
  it('imports a real legacy admission without rerunning the task or manufacturing owner delivery',async()=>{
    const id=randomUUID(),event=dispatch(),occurred='2026-10-20T08:00:00Z'
    const input={...task(),coordinator_device_id:home}
    const migrated={...event,occurred_at:occurred,receipt_kind:'received'}
    const request=()=>as(owner,()=>call('assistant_work_import',[assistant,workerInstance,id,JSON.stringify(input),JSON.stringify([migrated])]))
    await request();await request()
    expect((await claim()).events).toHaveLength(0)
    const page=await history(id)
    expect(page.events).toHaveLength(1)
    expect(page.events[0]).toMatchObject({content:event.content,delivery_state:'admitted',owner_delivered_at:null})
    expect(Date.parse(page.events[0]!.occurred_at!)).toBe(Date.parse(occurred))
    expect(Date.parse(page.events[0]!.platform_received_at)).toBeGreaterThan(Date.parse(occurred))
  })
  it('imports legacy executor results and preserves their terminal fact without another send',async()=>{
    const id=randomUUID(),input={...task(),coordinator_device_id:home},event=report()
    await as(owner,()=>call('assistant_work_import',[assistant,workerInstance,id,JSON.stringify(input),JSON.stringify([{...event,occurred_at:'2026-10-20T08:00:00Z',receipt_kind:'sent_admitted'}])]))
    expect((await history(id)).work).toMatchObject({work_id:id,outcome:'completed'})
    expect((await claim()).events).toHaveLength(0)
  })
  it('refuses a legacy admission attested by a device outside either receipt endpoint',async()=>{
    const id=randomUUID(),input={...task(),coordinator_device_id:home}
    await failure(()=>as(owner,()=>call('assistant_work_import',[assistant,instance,id,JSON.stringify(input),JSON.stringify([{...dispatch(),occurred_at:'2026-10-20T08:00:00Z',receipt_kind:'received'}])])),/receipt|runtime|recipient/i)
    expect((await list()).items).toHaveLength(0)
  })

  it('does not let a later imported progress change the real terminal version or a live queue receipt',async()=>{
    const id=randomUUID(),input={...task(),coordinator_device_id:home},final=report(),later=report('progress')
    await as(owner,()=>call('assistant_work_import',[assistant,workerInstance,id,JSON.stringify(input),JSON.stringify([
      {...final,occurred_at:'2026-10-20T08:00:00Z',receipt_kind:'sent_admitted'},
      {...later,occurred_at:'2026-10-20T08:01:00Z',receipt_kind:'sent_admitted'}])]))
    const page=await history(id)
    expect(page.work.terminal_version).toBe(page.events.find(e=>e.message_id===final.message_id)!.seq)
    const normal=randomUUID(),event=dispatch()
    await commit(normal,[event],task())
    await as(owner,()=>call('assistant_work_import',[assistant,workerInstance,normal,JSON.stringify(input),JSON.stringify([{...event,occurred_at:'2026-10-20T08:00:00Z',receipt_kind:'received'}])]))
    expect((await history(normal)).events[0]!.delivery_state).toBe('pending')
  })

  it('commits the task and delivery together; a failed second event leaves neither', async () => {
    const id = randomUUID()
    await failure(() => commit(id,[dispatch(),dispatch({ to_device_id: 'not-owned' })],task()), /endpoint|device|target/i)
    expect((await list()).items).toHaveLength(0)
    expect((await claim(workerInstance)).events).toHaveLength(0)
    await commit(id,[dispatch()],task())
    expect((await list()).items[0]).toMatchObject({ work_id: id,outcome: 'active' })
    expect((await claim(workerInstance)).events).toHaveLength(1)
  })

  it('returns the exact task endpoints with each history page without touching a sleeping device', async () => {
    const id=randomUUID()
    await commit(id,[dispatch()],task())
    await db.query("UPDATE identity.runtime_instances SET last_heartbeat_at = now() - interval '1 day'")
    const page=await history(id)
    expect(page.work).toMatchObject({work_id:id,coordinator_session_id:task().coordinator_session_id,executors:task().executors})
    expect(page.work.coordinator_device_id).toBe(home)
    expect(page.work).not.toHaveProperty('initial_task')
  })

  it('deduplicates lost responses by operation and stable message ID; different bodies are refused', async () => {
    const id = randomUUID(), op = randomUUID(), event = dispatch()
    const first = await commit(id,[event],task(),op)
    expect(await commit(id,[event],task(),op)).toEqual(first)
    await commit(id,[event],task())
    expect((await history(id)).events).toHaveLength(1)
    await failure(() => commit(id,[{ ...event,content: 'Changed body' }],null,op), /reuse|different|conflict/i)
    await failure(() => commit(id,[{ ...event,content: 'Changed body' }]), /reuse|different|conflict/i)
  })

  it('reads tasks and collaboration while all runtime leases and devices are offline', async () => {
    const id = randomUUID(), event = dispatch()
    await commit(id,[event],task())
    await db.query("UPDATE identity.runtime_instances SET last_heartbeat_at=now()-interval '1 day'")
    await db.query("UPDATE identity.gugu_devices SET status='offline' WHERE device_id=ANY($1)",[[home,device]])
    expect((await list()).items.map(row => row.work_id)).toEqual([id])
    expect((await history(id)).events[0]).toMatchObject({ message_id: event.message_id,content: event.content })
    await failure(() => claim(), /runtime|lease/i)
  })

  it('isolates accounts and disallows anonymous and direct-table writes', async () => {
    const id = randomUUID(); await commit(id,[dispatch()],task())
    await failure(() => as(stranger,() => call('assistant_work_list',[assistant,null,50])), /account|assistant|permission/i)
    await failure(() => as(stranger,() => call('assistant_work_history',[assistant,id,0,100])), /account|assistant|permission/i)
    await failure(() => as(owner,() => db.query('DELETE FROM identity.assistant_work')), /permission denied/i)
    await db.query('SET LOCAL ROLE anon')
    await failure(() => call('assistant_work_list',[assistant,null,50]), /permission denied/i)
    await db.query('RESET ROLE')
  })

  it('requires the dispatch home and exact stored executor endpoints for reports', async () => {
    const id = randomUUID()
    await failure(() => commit(id,[dispatch()],task(),randomUUID(),workerInstance), /coordinator|home|device|endpoint/i)
    await commit(id,[dispatch()],task())
    await failure(() => commit(id,[report()],null,randomUUID(),instance), /sender|runtime|endpoint/i)
    await failure(() => commit(id,[report('progress',{ from_session_id: randomUUID() })],null,randomUUID(),workerInstance), /sender|executor|endpoint/i)
    await commit(id,[report()],null,randomUUID(),workerInstance)
    expect((await list()).items[0].outcome).toBe('completed')
  })

  it('does not claim an unexpired lease twice; expiry fences the old token', async () => {
    const id = randomUUID(), contender = randomUUID(); await commit(id,[dispatch()],task())
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[contender,device,owner])
    const first = (await claim(workerInstance)).events[0]!
    expect((await claim(contender)).events).toHaveLength(0)
    await db.query("UPDATE identity.assistant_work_events SET lease_until=now()-interval '1 second' WHERE message_id=$1",[first.message_id])
    const second = (await claim(contender)).events[0]!
    expect(second.lease_token).not.toBe(first.lease_token)
    await failure(() => settle(first,'executor_admitted',workerInstance), /lease|token/i)
    await settle(second,'executor_admitted',contender)
    await settle(second,'executor_admitted',contender)
    expect((await claim(workerInstance)).events).toHaveLength(0)
  })

  it('releases failed deliveries with backoff and rejects an old acknowledgement', async () => {
    const id = randomUUID(); await commit(id,[dispatch()],task())
    const event = (await claim(workerInstance)).events[0]!
    expect(event.failed_attempts).toBe(0)
    await settle(event,'retry',workerInstance)
    expect((await claim(workerInstance)).events).toHaveLength(0)
    await failure(() => settle(event,'executor_admitted',workerInstance), /lease|token/i)
    await db.query("UPDATE identity.assistant_work_events SET available_at=now()-interval '1 second' WHERE message_id=$1",[event.message_id])
    expect((await claim(workerInstance)).events[0]).toMatchObject({ message_id: event.message_id,failed_attempts: 1 })
  })

  it('keeps platform acceptance, assistant admission and owner delivery as independent facts', async () => {
    const id = randomUUID(); await commit(id,[dispatch()],task())
    const incoming = report(); await commit(id,[incoming],null,randomUUID(),workerInstance)
    const result = (await history(id)).events.find(event => event.message_id === incoming.message_id)!
    expect(result.platform_received_at).toBeTruthy()
    expect(result.assistant_admitted_at).toBeNull(); expect(result.owner_delivered_at).toBeNull()
    const claimed = (await claim()).events.find(event => event.message_id === incoming.message_id)!
    await settle(claimed,'assistant_admitted')
    const ownerMessage = randomUUID()
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,'The result is ready','text')",[ownerMessage,chat,assistant])
    const args = [assistant,instance,incoming.message_id,chat,ownerMessage]
    await as(owner,() => call('assistant_work_owner_delivered',args))
    await as(owner,() => call('assistant_work_owner_delivered',args))
    const delivered = (await history(id)).events.find(event => event.message_id === incoming.message_id)!
    expect(delivered.assistant_admitted_at).toBeTruthy(); expect(delivered.owner_delivered_at).toBeTruthy()
    await failure(() => as(owner,() => call('assistant_work_owner_delivered',[assistant,instance,incoming.message_id,chat,randomUUID()])), /message|receipt|different/i)
  })

  it('keeps separate work IDs for the same executor and ignores late progress for completion', async () => {
    const first = randomUUID(), second = randomUUID()
    await commit(first,[dispatch()],task()); await commit(second,[dispatch()],task())
    await commit(first,[report()],null,randomUUID(),workerInstance)
    await commit(first,[report('progress')],null,randomUUID(),workerInstance)
    expect((await list()).items.map(row => [row.work_id,row.outcome])).toEqual([[second,'active'],[first,'completed']])
    expect((await history(second)).events).toHaveLength(1)
  })

  it('ends fan-out work only when all executors report terminal outcomes and pages without omission', async () => {
    const id = randomUUID(), other = randomUUID()
    await commit(id,[dispatch(),dispatch({ to_session_id: other })],task([{ session_id: worker,device_id: device,agent_user_id: executor },{ session_id: other,device_id: device,agent_user_id: executor }]))
    await commit(id,[report()],null,randomUUID(),workerInstance)
    expect((await list()).items[0].outcome).toBe('active')
    await commit(id,[report('failed',{ from_session_id: other,reason_code: 'MODEL_UNAVAILABLE' })],null,randomUUID(),workerInstance)
    expect((await list()).items[0].outcome).toBe('failed')
    const page = await history(id,'0',2)
    expect(page.events).toHaveLength(2); expect(page.next_after).toBeTruthy()
    const next = await history(id,page.next_after!,2)
    expect(new Set([...page.events,...next.events].map(event => event.message_id)).size).toBe(4)
    await failure(() => commit(id,[report('cancelled')],null,randomUUID(),workerInstance), /terminal|ended|conflict/i)
  })

  it('rechecks original cloud message visibility without losing the remaining direct history', async () => {
    const id = randomUUID(), source = randomUUID()
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,'Original cloud instruction','text')",[source,chat,assistant])
    const event = dispatch({ content: undefined,source_chat_id: chat,source_message_id: source })
    await commit(id,[event],task())
    await commit(id,[report('progress')],null,randomUUID(),workerInstance)
    expect((await history(id)).events[0]!.content).toBe('Original cloud instruction')
    await db.query('UPDATE chat.messages SET deleted_at=clock_timestamp() WHERE id=$1',[source])
    const rows = (await history(id)).events
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ content: null,source_available: false })
    expect(rows[1]!.content).toBe('Verified the result')
    await failure(() => commit(randomUUID(),[event],task()), /source|visible/i)
  })

  it('accepts authorized attachment references and rejects missing or unrelated files atomically', async () => {
    const blob = randomUUID(), item = randomUUID(), hash = randomUUID().replaceAll('-','').repeat(2)
    await db.query("INSERT INTO chat.file_blobs(id,bucket_id,object_name,sha256,size_bytes,content_type,created_by) VALUES($1,'workspace',$2,$3,10,'text/plain',$4)",[blob,`${chat}/${blob}`,hash,owner])
    await db.query("INSERT INTO chat.workspace_items(id,chat_id,kind,filename,blob_id,created_by) VALUES($1,$2,'file','result.txt',$3,$4)",[item,chat,blob,owner])
    const id = randomUUID()
    await commit(id,[dispatch({ attachment_refs: [{ item_id: item }] })],task())
    expect((await history(id)).events[0]!.attachment_refs).toEqual([{ item_id: item }])
    await failure(() => commit(randomUUID(),[dispatch({ attachment_refs: [{ item_id: randomUUID() }] })],task()), /attachment|visible/i)
    expect((await list()).items).toHaveLength(1)
  })

  it('queues native session-file receipts addressed to the coordinator, with verified metadata', async () => {
    const id = randomUUID(), attachment = randomUUID(), staging = `staging/${owner}/${randomUUID()}`
    await commit(id,[dispatch()],task())
    await db.query('SET LOCAL ROLE service_role')
    await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,4,$4)',[owner,staging,'ab'.repeat(32),'application/octet-stream'])
    await db.query('RESET ROLE')
    const ref = await as(owner, async () => (await db.query<{ attachment_id: string; file_name: string; sha256: string; size_bytes: string; content_type: string }>(
      'SELECT * FROM chat.session_attachment_commit($1,$2,$3,$4,$5,$6)',[staging,attachment,executor,worker,[assistant],'original.bin'])).rows[0]!)
    const native = { ...ref,size_bytes: Number(ref.size_bytes) }
    const completed = report('completed',{ attachment_refs: [native] })
    await failure(() => commit(id,[{ ...completed,attachment_refs: [{ ...native,sha256: 'cd'.repeat(32) }] }],null,randomUUID(),workerInstance), /attachment|metadata|visible/i)
    await commit(id,[completed],null,randomUUID(),workerInstance)
    expect((await claim()).events.find(row => row.message_id === completed.message_id)!.attachment_refs).toEqual([native])
  })

  it('does not expose queue tokens in history and performs no writes while reading', async () => {
    const id = randomUUID(); await commit(id,[dispatch()],task())
    await claim(workerInstance)
    const before = await db.query('SELECT to_jsonb(e) AS row FROM identity.assistant_work_events e WHERE work_id=$1',[id])
    const rows = (await history(id)).events
    expect(rows[0]).not.toHaveProperty('lease_token')
    await list(); await history(id)
    expect((await db.query('SELECT to_jsonb(e) AS row FROM identity.assistant_work_events e WHERE work_id=$1',[id])).rows).toEqual(before.rows)
  })

  it('invalidates account readers on business changes but not queue lease maintenance', async () => {
    const count = async () => Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM realtime.messages WHERE topic=$1 AND event='assistant_work_changed'",[`gugu:user:${owner}:events`])).rows[0]!.n)
    const before = await count(), id = randomUUID()
    await commit(id,[dispatch()],task())
    expect(await count()).toBe(before + 1)
    const event = (await claim(workerInstance)).events[0]!
    await list(); await history(id)
    expect(await count()).toBe(before + 1)
    await settle(event,'executor_admitted',workerInstance)
    expect(await count()).toBe(before + 2)
    await settle(event,'executor_admitted',workerInstance)
    expect(await count()).toBe(before + 2)
  })

  it('binds the executor identity on admission without changing the immutable dispatch retry', async () => {
    const id = randomUUID(), initial = task([{ session_id: worker,device_id: device } as { session_id: string; device_id: string; agent_user_id: string }]), event = dispatch()
    await commit(id,[event],initial)
    const claimed = (await claim(workerInstance)).events[0]!
    await settle(claimed,'executor_admitted',workerInstance,{ agent_user_id: executor })
    await commit(id,[event],initial)
    expect((await list()).items[0]!.executors).toEqual([{ session_id: worker,device_id: device,agent_user_id: executor }])
  })

  it('refuses owner delivery before admission and fabricated owner messages', async () => {
    const id = randomUUID(); await commit(id,[dispatch()],task())
    const event = report(); await commit(id,[event],null,randomUUID(),workerInstance)
    await failure(() => as(owner,() => call('assistant_work_owner_delivered',[assistant,instance,event.message_id,chat,randomUUID()])), /admission/i)
    const claimed = (await claim()).events.find(row => row.message_id === event.message_id)!
    await settle(claimed,'assistant_admitted')
    await failure(() => as(owner,() => call('assistant_work_owner_delivered',[assistant,instance,event.message_id,chat,randomUUID()])), /source|message|visible/i)
    expect((await history(id)).events.find(row => row.message_id === event.message_id)!.owner_delivered_at).toBeNull()
  })

  it('delivers a late executor completion with its file after an inferred coordinator failure', async () => {
    const id = randomUUID(), blob = randomUUID(), item = randomUUID(), hash = randomUUID().replaceAll('-','').repeat(2)
    await db.query("INSERT INTO chat.file_blobs(id,bucket_id,object_name,sha256,size_bytes,content_type,created_by) VALUES($1,'workspace',$2,$3,10,'text/plain',$4)",[blob,`${chat}/${blob}`,hash,owner])
    await db.query("INSERT INTO chat.workspace_items(id,chat_id,kind,filename,blob_id,created_by) VALUES($1,$2,'file','late-result.txt',$3,$4)",[item,chat,blob,owner])
    await commit(id,[dispatch()],task())
    await commit(id,[report('failed',{ from_session_id: coordinator,from_device_id: home,executor_session_id: worker,reason_code: 'RESULT_MISSING' })])
    expect((await list()).items[0]!.outcome).toBe('failed')
    const completed = report('completed',{ attachment_refs: [{ item_id: item }] })
    await commit(id,[completed],null,randomUUID(),workerInstance)
    expect((await list()).items[0]!.outcome).toBe('completed')
    const older=(await claim()).events.find(row=>row.kind==='failed')!
    expect(older.message_id).not.toBe(completed.message_id)
    await settle(older,'assistant_admitted')
    expect((await claim()).events.find(row => row.message_id === completed.message_id)).toMatchObject({ attachment_refs: [{ item_id: item }] })
    await failure(() => commit(id,[report('cancelled')],null,randomUUID(),workerInstance), /terminal|conflict/i)
  })

  it('keeps an executor terminal outcome authoritative over later coordinator inference', async () => {
    const id = randomUUID(); await commit(id,[dispatch()],task())
    await commit(id,[report()],null,randomUUID(),workerInstance)
    const before = (await list()).items[0]!
    await commit(id,[report('failed',{ from_session_id: coordinator,from_device_id: home,executor_session_id: worker,reason_code: 'RESULT_MISSING' })])
    expect((await list()).items[0]).toMatchObject({ outcome: 'completed',terminal_version: before.terminal_version })
  })

  it('abandons an undeliverable event once without claiming result delivery to the owner', async () => {
    const id = randomUUID(); await commit(id,[dispatch()],task())
    const event = (await claim(workerInstance)).events[0]!
    const args = [workerInstance,event.message_id,event.lease_token,'abandoned','CHANNEL_UNAVAILABLE',5,'{}']
    await as(owner,() => call('assistant_work_outbox_settle',args))
    await as(owner,() => call('assistant_work_outbox_settle',args))
    expect((await claim(workerInstance)).events).toHaveLength(0)
    expect((await as(owner,() => call<{ events: Delivery[] }>('assistant_work_abandoned',[instance,100]))).events).toHaveLength(1)
    const notice = randomUUID()
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,'This task could not be delivered: network unavailable','text')",[notice,chat,assistant])
    const receipt = [assistant,instance,event.message_id,chat,notice,'abandonment_notice']
    await as(owner,() => call('assistant_work_owner_delivered',receipt))
    await as(owner,() => call('assistant_work_owner_delivered',receipt))
    const abandoned = (await history(id)).events[0]!
    expect(abandoned).toMatchObject({ delivery_state: 'abandoned',abandoned_reason_code: 'CHANNEL_UNAVAILABLE',owner_delivered_at: null })
    expect(abandoned.abandonment_notified_at).toBeTruthy()
    expect(abandoned.executor_admitted_at).toBeNull()
    expect((await as(owner,() => call<{ events: Delivery[] }>('assistant_work_abandoned',[instance,100]))).events).toHaveLength(0)
  })

  it('does not advertise unused direct SELECT policies on the closed tables', async () => {
    expect((await db.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='identity' AND tablename IN ('assistant_work','assistant_work_events') AND permissive='PERMISSIVE'")).rows[0]!.n).toBe(0)
  })

  it('returns server-computed lease and age budgets independently of a device wall clock',async()=>{
    const id=randomUUID(),event=dispatch()
    await commit(id,[event],task())
    await db.query("UPDATE identity.assistant_work_events SET platform_received_at=clock_timestamp()-interval '23 hours' WHERE message_id=$1",[event.message_id])
    const lease=(await claim(workerInstance)).events[0]!
    expect(lease.lease_remaining_ms).toBeGreaterThan(59000)
    expect(lease.lease_remaining_ms).toBeLessThanOrEqual(60000)
    expect(lease.age_ms).toBeGreaterThanOrEqual(23*60*60*1000)
    expect(lease.age_ms).toBeLessThan(23*60*60*1000+5000)
  })
  it('filters reconciliation work before paging and excludes ordinary progress and acknowledged abandonment',async()=>{
    const active=randomUUID();await commit(active,[dispatch()],task())
    async function finished(){
      const id=randomUUID(),event=report()
      await commit(id,[dispatch()],task());await commit(id,[event],null,randomUUID(),workerInstance)
      return {id,event}
    }
    const done=await finished()
    await db.query('UPDATE identity.assistant_work_events SET owner_delivered_at=now() WHERE message_id=$1',[done.event.message_id])
    await commit(done.id,[report('progress')],null,randomUUID(),workerInstance)
    const terminal=await finished()
    const question=report('question');await commit(terminal.id,[question],null,randomUUID(),workerInstance)
    const abandoned=await finished()
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='abandoned',abandoned_at=now(),abandoned_reason_code='DELIVERY_EXPIRED' WHERE message_id=$1",[abandoned.event.message_id])
    const filtered=()=>as(owner,()=>call<{items:Work[];next_before:string|null}>('assistant_work_list',[assistant,null,100,true]))
    expect((await filtered()).items.map(row=>row.work_id).sort()).toEqual([active,terminal.id,abandoned.id].sort())
    await db.query("UPDATE identity.assistant_work_events SET owner_delivered_at=now() WHERE work_id=$1 AND kind<>'dispatch'",[terminal.id])
    await db.query('UPDATE identity.assistant_work_events SET abandonment_notified_at=now() WHERE message_id=$1',[abandoned.event.message_id])
    const page=await as(owner,()=>call<{items:Work[];next_before:string|null}>('assistant_work_list',[assistant,null,1,true]))
    expect(page.items.map(row=>row.work_id)).toEqual([active]);expect(page.next_before).toBeNull()
    expect((await list()).items).toHaveLength(4)
  })

  it('keeps later messages behind an older lease for the same work and seat, but not behind abandonment',async()=>{
    const id=randomUUID(),first=dispatch(),second=dispatch()
    await commit(id,[first,second],task())
    const claimed=(await claim(workerInstance)).events
    expect(claimed.map(row=>row.message_id)).toEqual([first.message_id])
    expect((await claim(workerInstance)).events).toHaveLength(0)
    await as(owner,()=>call('assistant_work_outbox_settle',[workerInstance,claimed[0]!.message_id,claimed[0]!.lease_token,'abandoned','NETWORK',5,JSON.stringify({failure_observed:true})]))
    expect((await claim(workerInstance)).events.map(row=>row.message_id)).toEqual([second.message_id])
  })

  it('allows concurrent runtimes to claim each durable message at most once', async () => {
    const events = Array.from({ length: 8 },() => dispatch()), contender = randomUUID()
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[contender,device,owner])
    for(const event of events) await commit(randomUUID(),[event],task())
    await db.query('COMMIT')
    const other = new pg.Client({ connectionString: url }); await other.connect()
    try {
      async function take(client: pg.Client, runtime: string) {
        await client.query('BEGIN')
        await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({ sub: owner,role: 'authenticated' })])
        await client.query('SET LOCAL ROLE authenticated')
        const result = await client.query<{ result: { events: Delivery[] } }>('SELECT identity.assistant_work_outbox_claim($1,8,60) AS result',[runtime])
        await client.query('COMMIT')
        return result.rows[0]!.result.events
      }
      const results = await Promise.all([take(db,workerInstance),take(other,contender)])
      const ids = results.flat().map(row => row.message_id)
      expect(ids).toHaveLength(8); expect(new Set(ids).size).toBe(8)
      await db.query("UPDATE identity.assistant_work_events SET delivery_state='abandoned',lease_until=NULL,abandoned_at=now(),abandoned_reason_code='DEVICE_OFFLINE' WHERE owner_user_id=$1",[owner])
      const another=randomUUID()
      await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[another,device,owner])
      async function takeNotices(client:pg.Client,runtime:string) {
        await client.query('BEGIN')
        await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,role:'authenticated'})])
        await client.query('SET LOCAL ROLE authenticated')
        const answer=await client.query<{result:{items:Array<{anchor_message_id:string}>}}>('SELECT identity.assistant_work_notice_wake_claim($1,8,60) AS result',[runtime])
        await client.query('COMMIT');return answer.rows[0]!.result.items
      }
      const notices=(await Promise.all([takeNotices(db,workerInstance),takeNotices(other,another)])).flat()
      expect(notices).toHaveLength(8);expect(new Set(notices.map(row=>row.anchor_message_id)).size).toBe(8)
    } finally {
      await other.end()
      await db.query('ROLLBACK')
      await db.query('DELETE FROM identity.assistant_work WHERE owner_user_id=$1',[owner])
      await db.query('DELETE FROM identity.agent_provision_operations WHERE owner_user_id=$1',[owner])
      await db.query('DELETE FROM chat.chats WHERE id=$1',[chat])
      await db.query('DELETE FROM identity.users WHERE id=ANY($1)',[[assistant,executor]])
      await db.query('DELETE FROM identity.gugu_devices WHERE device_id=ANY($1)',[[home,device]])
      await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[[owner,stranger]])
      await db.query('BEGIN')
    }
  })

  it('serializes a report claim snapshot with an uncommitted coordinator move',async()=>{
    const id=randomUUID(),event=report('progress')
    await commit(id,[dispatch()],task());await commit(id,[event],null,randomUUID(),workerInstance)
    await db.query("UPDATE identity.assistant_work_events SET delivery_state='admitted',executor_admitted_at=now() WHERE work_id=$1 AND kind='dispatch'",[id])
    await db.query('COMMIT')
    const moving=new pg.Client({connectionString:url}),taking=new pg.Client({connectionString:url})
    await moving.connect();await taking.connect()
    let flight:Promise<pg.QueryResult<{result:{events:Delivery[]}}>>|undefined
    try {
      await moving.query('BEGIN')
      await moving.query("SELECT set_config('identity.agent_adopt_move_agent_id',$1,true)",[assistant])
      await moving.query('UPDATE identity.users SET device_id=$1 WHERE id=$2',[device,assistant])
      await taking.query('BEGIN')
      await taking.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,role:'authenticated'})])
      await taking.query('SET LOCAL ROLE authenticated')
      const pid=(await taking.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      let finished=false,blocked=false
      flight=taking.query<{result:{events:Delivery[]}}>('SELECT identity.assistant_work_outbox_claim($1,20,60) AS result',[instance])
      void flight.then(()=>{finished=true},()=>{finished=true})
      const deadline=Date.now()+3000
      while(!finished&&Date.now()<deadline) {
        blocked=(await db.query<{blocked:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0]!.blocked
        if(blocked)break
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      await moving.query('COMMIT')
      const answer=(await flight).rows[0]!.result
      await taking.query('COMMIT')
      expect(blocked).toBe(true)
      expect(answer.events).toHaveLength(0)
      expect((await db.query('SELECT delivery_state,attempts,assistant_admitted_at FROM identity.assistant_work_events WHERE message_id=$1',[event.message_id])).rows[0]).toEqual({delivery_state:'pending',attempts:0,assistant_admitted_at:null})
    } finally {
      await moving.query('ROLLBACK');await flight?.catch(()=>undefined);await taking.query('ROLLBACK')
      await moving.end();await taking.end()
      await db.query('DELETE FROM identity.assistant_work WHERE owner_user_id=$1',[owner])
      await db.query('DELETE FROM identity.agent_provision_operations WHERE owner_user_id=$1',[owner])
      await db.query('DELETE FROM chat.chats WHERE id=$1',[chat])
      await db.query('DELETE FROM identity.users WHERE id=ANY($1)',[[assistant,executor]])
      await db.query('DELETE FROM identity.gugu_devices WHERE device_id=ANY($1)',[[home,device]])
      await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[[owner,stranger]])
      await db.query('BEGIN')
    }
  })

  it('exercises atomic enqueue, lease acknowledgement and offline reads through authenticated HTTP', async () => {
    await db.query('COMMIT')
    const endpoint = process.env.GUGU_INTEGRATION_SUPABASE_URL ?? ''
    if (!['127.0.0.1','localhost','[::1]'].includes(new URL(endpoint).hostname)) throw new Error('HTTP ledger tests require the fixture API')
    const options = { auth: { persistSession: false,autoRefreshToken: false,detectSessionInUrl: false },db: { schema: 'identity' } }
    const admin = createClient(endpoint,process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY!,options)
    const client = createClient(endpoint,process.env.VITE_SUPABASE_ANON_KEY!,options)
    try {
      const password = randomUUID()
      expect((await admin.auth.admin.updateUserById(owner,{ password,email_confirm: true })).error).toBeNull()
      expect((await client.auth.signInWithPassword({ email: `${owner}@ledger.invalid`,password })).error).toBeNull()
      const id = randomUUID(), event = dispatch()
      const saved = await client.rpc('assistant_work_commit',{ p_assistant: assistant,p_runtime_instance_id: instance,
        p_operation_id: randomUUID(),p_work_id: id,p_task: task(),p_events: [event] })
      expect(saved.error).toBeNull(); expect(saved.data).toMatchObject({ work_id: id,outcome: 'active' })
      const foreign = await client.rpc('assistant_work_outbox_claim',{ p_runtime_instance_id: instance,p_limit: 20,p_lease_seconds: 60 })
      expect(foreign.error).toBeNull(); expect(foreign.data.events).toHaveLength(0)
      const lease = await client.rpc('assistant_work_outbox_claim',{ p_runtime_instance_id: workerInstance,p_limit: 20,p_lease_seconds: 60 })
      expect(lease.error).toBeNull(); expect(lease.data.events).toHaveLength(1)
      const ack = await client.rpc('assistant_work_outbox_settle',{ p_runtime_instance_id: workerInstance,p_message_id: event.message_id,
        p_lease_token: lease.data.events[0].lease_token,p_stage: 'executor_admitted' })
      expect(ack.error).toBeNull()
      await db.query("UPDATE identity.assistant_work_events SET delivery_state='abandoned',abandoned_at=now(),abandoned_reason_code='DEVICE_OFFLINE' WHERE message_id=$1",[event.message_id])
      const notice=await client.rpc('assistant_work_notice_wake_claim',{p_runtime_instance_id:workerInstance})
      expect(notice.error).toBeNull();expect(notice.data.items).toHaveLength(1)
      expect((await client.rpc('assistant_work_notice_wake_release',{p_runtime_instance_id:workerInstance,p_anchor_message_id:event.message_id,p_lease_token:notice.data.items[0].lease_token})).error).toBeNull()
      await db.query("UPDATE identity.runtime_instances SET last_heartbeat_at=now()-interval '1 day' WHERE owner_user_id=$1",[owner])
      const read = await client.rpc('assistant_work_list',{ p_assistant: assistant })
      expect(read.error).toBeNull(); expect(read.data.items[0].work_id).toBe(id)
      const scoped = await client.rpc('assistant_work_list',{ p_assistant: assistant,p_reconcile_only: true })
      expect(scoped.error).toBeNull();expect(scoped.data.items[0].work_id).toBe(id)
      const record = await client.rpc('assistant_work_history',{ p_assistant: assistant,p_work_id: id })
      expect(record.error).toBeNull(); expect(record.data.events[0].content).toBe(event.content)
      expect((await client.from('assistant_work_events').update({ content: 'Forged' }).eq('message_id',event.message_id)).error?.code).toBe('42501')
      const anonymous = createClient(endpoint,process.env.VITE_SUPABASE_ANON_KEY!,options)
      expect((await anonymous.rpc('assistant_work_list',{ p_assistant: assistant })).error?.code).toBe('42501')
    } finally {
      await client.auth.signOut()
      await db.query('DELETE FROM chat.chats WHERE id=$1',[chat])
      await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[[owner,stranger]])
      await db.query('BEGIN')
    }
  })
})
