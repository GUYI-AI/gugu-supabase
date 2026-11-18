import {createHash,randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import pg from 'pg'
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest'

const url=process.env.GUGU_INTEGRATION_DATABASE_URL??''
const lower='ffffffff-ffff-ffff-fffe-ffffffffffff'
const row=(n:number)=>'ffffffff-ffff-ffff-ffff-'+String(n).padStart(12,'0')
let db:pg.Client,blocker:pg.Client,subject:string,other:string,job:string,token:string
let committedRows=false
const value=async(sql:string,args:unknown[]=[]) => (await db.query(sql,args)).rows[0].v
async function rejected(sql:string,args:unknown[]=[]){
 await db.query('SAVEPOINT rejected_call')
 try{await db.query(sql,args)}catch(error){await db.query('ROLLBACK TO SAVEPOINT rejected_call');return error as pg.DatabaseError}
 throw Error('Expected refusal')
}
async function activate(phase='auth',cursor:string|null=lower,no:number|null=null){
 token=randomUUID()
 await db.query("UPDATE identity.account_audit_redaction_jobs SET state='running',phase=$2,cursor_id=$3,cursor_no=$4,lease_token=$5,lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1",[job,phase,cursor,no,token])
 await db.query('DELETE FROM identity.account_audit_redaction_context WHERE transaction_id=pg_current_xact_id()')
 await db.query('INSERT INTO identity.account_audit_redaction_context(transaction_id,job_id,lease_token,backend_pid) VALUES(pg_current_xact_id(),$1,$2,pg_backend_pid())',[job,token])
}
async function seedAuth(n=3){
 for(let i=1;i<=n;i++)await db.query("INSERT INTO auth.audit_log_entries(id,payload,created_at) VALUES($1,$2,now())",[row(i),{actor_id:subject,actor_username:'erased@registered.invalid',actor_name:'Fixture',action:'login'}])
}
async function seedFiles(){
 await db.query("INSERT INTO file_private.storage_action_audit(id,actor_user_id,effective_actor_id,action,requested_ref_count,requested_item_ids,requested_message_ids) VALUES($1,$2,$2,'temporary',1,$3,$4)",[row(1),subject,[subject,other],['dm:'+subject,'unrelated']])
 for(let i=1;i<=3;i++)await db.query('INSERT INTO file_private.storage_action_audit_items(operation_id,change_no,storage_id,blob_id,chat_id,item_ids,versions) VALUES($1,$2,$3,$3,$4,$5,$6)',[row(1),i,subject,'dm:'+subject,[subject,other],[7,9]])
}
async function authBatch(limit=2){return(await db.query('SELECT * FROM identity.redact_registered_auth_audit_batch($1,$2)',[job,limit])).rows[0]}
async function fileBatch(limit=2){return(await db.query('SELECT * FROM file_private.redact_registered_storage_audit_batch($1,$2)',[job,limit])).rows[0]}
async function advance(result:{next_id:string|null,next_no:string|number|null}){
 await db.query('UPDATE identity.account_audit_redaction_jobs SET cursor_id=$2,cursor_no=$3 WHERE id=$1',[job,result.next_id,result.next_no])
}
beforeAll(async()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url))
 const fixture=JSON.parse(readFileSync(root+'.local/test-db/owner.json','utf8'))
 const target=new URL(url),project='gugucommunitytest'+createHash('sha256').update(root).digest('hex').slice(0,10)
 if(fixture.root!==root||fixture.project!==project||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||Number(target.port)!==fixture.port)throw Error('Owned loopback fixture required')
 if(execFileSync('docker',['port','supabase_db_'+project,'5432/tcp'],{encoding:'utf8'}).trim()!=='127.0.0.1:'+fixture.port)throw Error('Fixture binding differs')
 db=new pg.Client({connectionString:url});blocker=new pg.Client({connectionString:url});await db.connect();await blocker.connect()
 await db.query("SET statement_timeout='5s'");await blocker.query("SET statement_timeout='5s'")
})
afterAll(async()=>{await db?.end();await blocker?.end()})
beforeEach(async()=>{
 committedRows=false;subject=randomUUID();other=randomUUID()
 await db.query('BEGIN')
 await db.query("INSERT INTO identity.account_lifecycle_context(transaction_id,operation,subject_user_id,delete_user_ids) VALUES(pg_current_xact_id(),'privacy_erasure',$1,$2)",[subject,[subject,'agent-'+subject]])
 job=await value('SELECT identity.enqueue_account_audit_redaction($1,$2) v',[[subject,'agent-'+subject],'erased@registered.invalid'])
 await db.query('DELETE FROM identity.account_lifecycle_context WHERE transaction_id=pg_current_xact_id()')
 await activate()
})
afterEach(async()=>{
 await blocker.query('ROLLBACK');await db.query('ROLLBACK')
 if(committedRows){
  await db.query('DELETE FROM auth.audit_log_entries WHERE id=ANY($1::uuid[])',[[row(1),row(2),row(3)]])
  await db.query('DELETE FROM file_private.storage_action_audit WHERE id=$1',[row(1)])
  await db.query('DELETE FROM identity.account_audit_redaction_jobs WHERE id=$1',[job])
 }
})

describe('registered audit batches',()=>{
 it('keeps registry helpers and payload capability closed to every API role',async()=>{
  for(const signature of ['identity.registered_audit_redacted_payload(jsonb,text[],text)','identity.redact_registered_auth_audit_batch(uuid,integer)','file_private.redact_registered_storage_audit_batch(uuid,integer)','identity.registered_auth_audit_residual(uuid)','file_private.registered_storage_audit_residual(uuid)']){
   expect(await value("SELECT pg_get_userbyid(proowner)='postgres' AND proconfig @> ARRAY['search_path=\"\"'] v FROM pg_proc WHERE oid=$1::regprocedure",[signature])).toBe(true)
   for(const role of ['anon','authenticated','service_role'])expect(await value('SELECT has_function_privilege($1,$2,\'EXECUTE\') v',[role,signature])).toBe(false)
  }
 })
 it('requires the durable task, exact xid/PID/token and live lease',async()=>{
  for(const change of ["DELETE FROM identity.account_audit_redaction_context WHERE transaction_id=pg_current_xact_id()","UPDATE identity.account_audit_redaction_context SET backend_pid=0 WHERE job_id='"+job+"'","UPDATE identity.account_audit_redaction_context SET transaction_id='1'::xid8 WHERE job_id='"+job+"'","UPDATE identity.account_audit_redaction_context SET lease_token=gen_random_uuid() WHERE job_id='"+job+"'","UPDATE identity.account_audit_redaction_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id='"+job+"'"]){
   await db.query('SAVEPOINT invalid_context');await db.query(change)
   expect((await rejected('SELECT * FROM identity.redact_registered_auth_audit_batch($1,1)',[job])).code).toBe('42501')
   await db.query('ROLLBACK TO SAVEPOINT invalid_context')
  }
  expect((await rejected('SELECT * FROM identity.redact_registered_auth_audit_batch($1,1)',[randomUUID()])).code).toBe('42501')
 })
 it('rejects wrong phases and scan limits without modifying records',async()=>{
  await seedAuth()
  for(const limit of [0,-1,1001,null])expect((await rejected('SELECT * FROM identity.redact_registered_auth_audit_batch($1,$2)',[job,limit])).code).toBe('P0001')
  await activate('file_headers')
  expect((await rejected('SELECT * FROM identity.redact_registered_auth_audit_batch($1,1)',[job])).code).toBe('42501')
 })
 it('bounds scanned candidates, reports an end page, and never completes the task',async()=>{
  await seedAuth();const first=await authBatch()
  expect(first).toMatchObject({scanned:2,locked:2,changed:2,next_id:row(2),next_no:null,blocked:false,exhausted:false})
  await advance(first);const last=await authBatch()
  expect(last).toMatchObject({scanned:1,locked:1,changed:1,next_id:row(3),blocked:false,exhausted:true})
  expect(Number(await value('SELECT identity.registered_auth_audit_residual($1) v',[job]))).toBe(0)
  expect(await value('SELECT auth_email v FROM identity.account_audit_redaction_jobs WHERE id=$1',[job])).toBe('erased@registered.invalid')
 })
 it('limits scans rather than only matching writes',async()=>{
  await seedAuth();await db.query("UPDATE auth.audit_log_entries SET payload=json_build_object('actor_id',$1::text,'actor_username','other@registered.invalid') WHERE id=ANY($2::uuid[])",[other,[row(1),row(2)]])
  expect(await authBatch()).toMatchObject({scanned:2,locked:2,changed:0,next_id:row(2),exhausted:false})
  expect(Number(await value('SELECT identity.registered_auth_audit_residual($1) v',[job]))).toBe(1)
 })
 it('accepts the hard scan ceiling and leaves the next page for another transaction',async()=>{
  await db.query("INSERT INTO auth.audit_log_entries(id,payload,created_at) SELECT ('ffffffff-ffff-ffff-ffff-'||lpad(n::text,12,'0'))::uuid,json_build_object('actor_id',$1::text,'actor_username','erased@registered.invalid'),now() FROM generate_series(1,1050)n",[subject])
  const first=await authBatch(1000);expect(first).toMatchObject({scanned:1000,locked:1000,changed:1000,exhausted:false})
  expect(Number(await value('SELECT identity.registered_auth_audit_residual($1) v',[job]))).toBe(50)
  await advance(first);expect(await authBatch(1000)).toMatchObject({scanned:50,locked:50,changed:50,exhausted:true})
 })
 it('replays a batch idempotently and treats NULL/empty task email as ID-only',async()=>{
  await seedAuth();await db.query('UPDATE identity.account_audit_redaction_jobs SET auth_email=NULL WHERE id=$1',[job])
  expect((await authBatch()).changed).toBe(2);expect((await authBatch()).changed).toBe(0)
  await db.query("UPDATE identity.account_audit_redaction_jobs SET auth_email='' WHERE id=$1",[job])
  const last=await authBatch(3);expect(last.changed).toBe(1)
  expect(Number(await value('SELECT identity.registered_auth_audit_residual($1) v',[job]))).toBe(0)
 })
 it('does not skip over a locked candidate or call an empty write count completion',async()=>{
  await seedAuth();await db.query('DELETE FROM identity.account_audit_redaction_context WHERE transaction_id=pg_current_xact_id()');await db.query('COMMIT');committedRows=true
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM auth.audit_log_entries WHERE id=$1 FOR UPDATE',[row(1)])
  await db.query('BEGIN');await activate()
  expect(await authBatch()).toMatchObject({scanned:2,locked:1,changed:1,next_id:lower,exhausted:false,blocked:true})
  expect(Number(await value('SELECT identity.registered_auth_audit_residual($1) v',[job]))).toBe(2)
  await blocker.query('ROLLBACK')
  expect(await authBatch()).toMatchObject({scanned:2,locked:2,changed:1,next_id:row(2),blocked:false})
 })
 it('covers file header actors and typed references with paired item versions',async()=>{
  await seedFiles();await activate('file_headers')
  expect(await fileBatch(1)).toMatchObject({scanned:1,locked:1,changed:1,next_id:row(1),next_no:null})
  const header=(await db.query('SELECT * FROM file_private.storage_action_audit WHERE id=$1',[row(1)])).rows[0]
  expect(header.actor_user_id).toMatch(/^erased:/);expect(header.effective_actor_id).toBe(header.actor_user_id)
  expect(header.requested_item_ids).toEqual([other]);expect(header.requested_message_ids).toEqual(['unrelated'])
  await activate('file_items',lower,0)
  const first=await fileBatch(2);expect(first).toMatchObject({scanned:2,locked:2,changed:2,next_id:row(1),next_no:'2',exhausted:false})
  await advance(first);expect(await fileBatch(2)).toMatchObject({scanned:1,changed:1,next_no:'3',exhausted:true})
  const details=(await db.query('SELECT * FROM file_private.storage_action_audit_items WHERE operation_id=$1 ORDER BY change_no',[row(1)])).rows
  for(const detail of details)expect(detail).toMatchObject({storage_id:null,blob_id:null,chat_id:null,item_ids:[other],versions:[9]})
  expect(Number(await value('SELECT file_private.registered_storage_audit_residual($1) v',[job]))).toBe(0)
 })
 it('refuses to jump an incomplete composite cursor',async()=>{
  await activate('file_items',row(1),null)
  expect((await rejected('SELECT * FROM file_private.redact_registered_storage_audit_batch($1,1)',[job])).code).toBe('42501')
 })
 it('keeps a blocked composite page at its original boundary',async()=>{
  await seedFiles();await db.query('DELETE FROM identity.account_audit_redaction_context WHERE transaction_id=pg_current_xact_id()');await db.query('COMMIT');committedRows=true
  await blocker.query('BEGIN');await blocker.query('SELECT operation_id FROM file_private.storage_action_audit_items WHERE operation_id=$1 AND change_no=1 FOR UPDATE',[row(1)])
  await db.query('BEGIN');await activate('file_items',lower,0)
  expect(await fileBatch(2)).toMatchObject({scanned:2,locked:1,changed:1,next_id:lower,next_no:'0',blocked:true,exhausted:false})
  expect(Number(await value('SELECT file_private.registered_storage_audit_residual($1) v',[job]))).toBe(3)
  await blocker.query('ROLLBACK')
  expect(await fileBatch(2)).toMatchObject({scanned:2,locked:2,changed:1,next_id:row(1),next_no:'2',blocked:false})
 })
 it('reuses the registry seventh-day gate on both helper paths',async()=>{
  await seedAuth();await db.query("UPDATE identity.account_audit_redaction_jobs SET scan_round=2,first_scan_completed_at=clock_timestamp(),next_scan_at=deleted_at+interval '7 days' WHERE id=$1",[job])
  expect((await rejected('SELECT * FROM identity.redact_registered_auth_audit_batch($1,1)',[job])).code).toBe('42501')
  await db.query("UPDATE identity.account_audit_redaction_jobs SET deleted_at=deleted_at-interval '8 days',target_at=target_at-interval '8 days',hard_due_at=hard_due_at-interval '8 days',next_scan_at=next_scan_at-interval '8 days' WHERE id=$1",[job])
  expect((await authBatch(3)).changed).toBe(3)
 })
 it('rolls back a partially processed batch when its lease expires',async()=>{
  await seedFiles();await activate('file_headers')
  await db.query('CREATE TEMP TABLE registered_delay_fixture(n integer)')
  await db.query("CREATE FUNCTION pg_temp.registered_delay_fixture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(0.2);RETURN NEW;END$$")
  await db.query('CREATE TRIGGER registered_delay_fixture BEFORE UPDATE ON file_private.storage_action_audit FOR EACH ROW EXECUTE FUNCTION pg_temp.registered_delay_fixture()')
  await db.query("UPDATE identity.account_audit_redaction_jobs SET lease_until=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",[job])
  expect((await rejected('SELECT * FROM file_private.redact_registered_storage_audit_batch($1,1)',[job])).code).toBe('42501')
  expect(await value('SELECT actor_user_id v FROM file_private.storage_action_audit WHERE id=$1',[row(1)])).toBe(subject)
 })
 it('allows full residual checks during verification without trusting cursors',async()=>{
  await seedAuth();await seedFiles();await db.query("UPDATE identity.account_audit_redaction_jobs SET state='verifying',phase='verify',cursor_id='ffffffff-ffff-ffff-ffff-ffffffffffff' WHERE id=$1",[job])
  expect(Number(await value('SELECT identity.registered_auth_audit_residual($1) v',[job]))).toBe(3)
  expect(Number(await value('SELECT file_private.registered_storage_audit_residual($1) v',[job]))).toBe(4)
 })
 it('does not confuse an empty advanced page with no actual residuals',async()=>{
  await seedAuth();await db.query("UPDATE identity.account_audit_redaction_jobs SET cursor_id='ffffffff-ffff-ffff-ffff-ffffffffffff' WHERE id=$1",[job])
  expect(await authBatch()).toMatchObject({scanned:0,locked:0,changed:0,blocked:false,exhausted:true})
  expect(Number(await value('SELECT identity.registered_auth_audit_residual($1) v',[job]))).toBe(3)
  expect(await value('SELECT auth_email v FROM identity.account_audit_redaction_jobs WHERE id=$1',[job])).toBe('erased@registered.invalid')
 })
})

describe('email reuse and typed Auth field protection',()=>{
 const redact=(payload:unknown)=>value('SELECT identity.registered_audit_redacted_payload($1,$2,$3) v',[payload,[subject,'agent-'+subject],'erased@registered.invalid'])
 it('preserves a different explicit actor and target even when the address matches',async()=>{
  const payload={actor_id:other,actor_username:'erased@registered.invalid',actor_name:'New account',traits:{user_id:other,user_email:'erased@registered.invalid',provider:'email',provider_id:'erased@registered.invalid'}}
  expect(await redact(payload)).toEqual(payload)
 })
 it('cleans an erased target without erasing its administrator actor',async()=>{
  const payload={actor_id:other,actor_username:'erased@registered.invalid',actor_name:'New actor',traits:{user_id:subject,user_email:'erased@registered.invalid',user_phone:'synthetic',provider:'email',provider_id:'erased@registered.invalid'}}
  expect(await redact(payload)).toEqual({actor_id:other,actor_username:'erased@registered.invalid',actor_name:'New actor',traits:{user_id:subject,provider:'email'}})
 })
 it('cleans an erased actor without erasing a new target using the same email',async()=>{
  const payload={actor_id:subject,actor_username:'erased@registered.invalid',actor_name:'Old actor',traits:{user_id:other,user_email:'erased@registered.invalid',user_phone:'synthetic',provider:'email',provider_id:'erased@registered.invalid'}}
  expect(await redact(payload)).toEqual({actor_id:subject,traits:payload.traits})
 })
 it('keeps an opaque provider UUID and all security/action/time/IP fields',async()=>{
  expect(await redact({actor_id:subject,actor_username:'erased@registered.invalid',actor_name:'Erased',action:'login',ip_address:'192.0.2.1',traits:{provider:'email',provider_id:subject}})).toEqual({actor_id:subject,action:'login',ip_address:'192.0.2.1',traits:{provider:'email',provider_id:subject}})
 })
 it('cleans a registered unattributed email but preserves unregistered email',async()=>{
  expect(await redact({actor_id:'00000000-0000-0000-0000-000000000000',actor_username:' ERased@registered.invalid ',actor_name:'Fixture'})).toEqual({actor_id:'00000000-0000-0000-0000-000000000000'})
  const unrelated={actor_username:'other@registered.invalid',actor_name:'Other'};expect(await redact(unrelated)).toEqual(unrelated)
 })
})
