import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'

/** Transactional SQL protocol fixture. Actual native SQLite custody and the
 * private platform credential adapter have separate effect-store tests. */
export async function assertConnectionReconciliation(db,runTest) {
  const test=(name,action)=>runTest(name,async()=>{
    await db.query('SAVEPOINT reconciliation_case')
    try {await action();await db.query('RELEASE reconciliation_case')}
    catch(error) {await db.query('ROLLBACK TO reconciliation_case; RELEASE reconciliation_case');throw error}
  })
  const owner=randomUUID(),other=randomUUID(),device='reconcile-'+randomUUID(),runtime=randomUUID()
  for(const id of [owner,other]) {
    await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
      confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
      VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,
      '{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`,[id,`${id}@reconciliation.invalid`])
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Reconciliation fixture') ON CONFLICT DO NOTHING",[id])
  }
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')",[device,owner])
  await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[runtime,device,owner])
  await db.query("INSERT INTO identity.connection_heads(owner_user_id,native_initialized_at,authority_mode,authority_epoch,verification_protocol) VALUES($1,clock_timestamp(),'owner',1,2)",[owner])
  const claims=async user=>db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,role:'authenticated'})])
  await claims(owner)
  const rpc=async(name,args,values)=>(await db.query(`SELECT identity.${name}(${args}) AS v`,values)).rows[0].v
  async function reject(action,code) {
    await db.query('SAVEPOINT reconcile_refusal')
    let caught;try{await action()}catch(error){caught=error}
    await db.query('ROLLBACK TO reconcile_refusal; RELEASE reconcile_refusal')
    assert.equal(caught?.code,code,caught?.message??'expected refusal')
  }
  const scope='device:'+device,key=account=>JSON.stringify(['github',account])
  const save=account=>rpc('connection_commit',"$1,$2,$3,0,'save',$4,$5,$6,$7",[randomUUID(),scope,key(account),{providerId:'github',accountId:account,configured:true},JSON.stringify({version:1,providerId:'github',accountId:account}),device,runtime])
  async function unknown(account) {
    const saved=await save(account),operationId=randomUUID()
    const removed=await rpc('connection_commit',"$1,$2,$3,$4,'remove',$5,NULL,$6,NULL",[operationId,scope,key(account),saved.revision,{},device])
    const admission=await rpc('connection_admit','$1,$2,$3',[runtime,removed.revision,operationId])
    const attemptId=await rpc('connection_attempt_begin','$1,$2,1,$3',[owner,operationId,runtime])
    const attempt=(await db.query('SELECT * FROM identity.connection_attempts WHERE attempt_id=$1',[attemptId])).rows[0]
    await rpc('connection_ack',"$1,$2,$3,'CONNECTION_OUTCOME_UNKNOWN',true",[runtime,operationId,admission.admissionId])
    return {operationId,admission,attempt,revision:removed.revision}
  }
  const age=async id=>db.query("UPDATE identity.connection_attempts SET started_at=statement_timestamp()-interval '11 minutes',deadline_at=statement_timestamp()-interval '1 minute' WHERE operation_id=$1",[id])
  const resolve=id=>rpc('connection_resolve_attempt','$1,$2',[owner,id])

  await test('all reconciliation writers and evidence tables start closed, including service_role',async()=>{
    const functions=['connection_attempt_begin(text,uuid,bigint,text)','connection_attempt_write_fence(text,uuid,uuid,bigint)',
      'connection_record_effect(text,uuid,uuid,uuid,text,text,text,text,text,jsonb)',
      'connection_record_native_fence(text,uuid,uuid,text,uuid,text)','connection_resolve_attempt(text,uuid)','connection_operation_status(uuid)']
    for(const role of ['anon','authenticated','service_role']) {
      for(const fn of functions)assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",[role,'identity.'+fn])).rows[0].allowed,false)
      for(const table of ['connection_attempts','connection_effect_evidence','connection_resolutions'])assert.equal((await db.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') AS allowed",[role,'identity.'+table])).rows[0].allowed,false)
    }
  })
  await test('trusted original evidence resolves UNKNOWN without rewriting its ACK or executing the effect',async()=>{
    const {operationId,admission,attempt,revision}=await unknown('confirmed')
    const receipt=async()=>(await db.query('SELECT receipt::text AS v FROM identity.connection_admissions WHERE admission_id=$1',[admission.admissionId])).rows[0].v
    const original=await receipt()
    await rpc('connection_record_effect',"$1,$2,$3,$4,'github','confirmed','applied','native-transaction',$5",[owner,operationId,attempt.attempt_id,attempt.credential_generation,'a'.repeat(64)])
    const result=await resolve(operationId);assert.equal(result.outcome,'applied');assert.deepEqual(await resolve(operationId),result)
    assert.equal(await receipt(),original)
    assert.equal((await rpc('connection_operation_status','$1',[operationId])).effective.state,'succeeded')
    assert.equal((await rpc('connection_admit','$1,$2,NULL',[runtime,(await db.query('SELECT revision::text AS v FROM identity.connection_heads WHERE owner_user_id=$1',[owner])).rows[0].v])).admitted,true)
    await reject(()=>rpc('connection_record_effect',"$1,$2,$3,$4,'github','confirmed','applied','native-transaction',$5",[owner,operationId,attempt.attempt_id,randomUUID(),'a'.repeat(64)]),'42501')
    await reject(()=>rpc('connection_record_effect',"$1,$2,$3,$4,'github','other','applied','native-transaction',$5",[owner,operationId,attempt.attempt_id,attempt.credential_generation,'a'.repeat(64)]),'42501')
    await reject(()=>rpc('connection_attempt_write_fence','$1,$2,$3,1',[owner,operationId,attempt.attempt_id]),'PT409')
  })
  await test('missing platform evidence becomes failed only after the deadline and durable write fence',async()=>{
    const operationId=randomUUID(),head=(await db.query('SELECT revision::text AS v FROM identity.connection_heads WHERE owner_user_id=$1',[owner])).rows[0].v
    await rpc('connection_recreate_begin',"$1,'platform',NULL,NULL,NULL,'notion',$2",[operationId,head])
    const attemptId=await rpc('connection_attempt_begin','$1,$2,1,NULL',[owner,operationId])
    assert.equal(await resolve(operationId),null);await age(operationId)
    const result=await resolve(operationId);assert.equal(result.outcome,'failed');assert.deepEqual(await resolve(operationId),result)
    assert.equal((await rpc('connection_operation_status','$1',[operationId])).effective.blocksNewOperations,false)
    assert.equal((await db.query('SELECT fence_kind FROM identity.connection_attempts WHERE attempt_id=$1',[attemptId])).rows[0].fence_kind,'platform-transaction')
    assert.equal((await db.query('SELECT consumed_at IS NOT NULL AS closed FROM identity.connection_recreation_intents WHERE operation_id=$1',[operationId])).rows[0].closed,true)
    await reject(()=>rpc('connection_attempt_write_fence','$1,$2,$3,1',[owner,operationId,attemptId]),'PT409')
    await reject(()=>rpc('connection_commit',"$1,'platform',$2,0,'save',$3,$4,NULL,NULL",[randomUUID(),JSON.stringify(['notion','default']),{providerId:'notion',accountId:'default',configured:true},JSON.stringify({version:1,providerId:'notion',accountId:'default'})]),'PT409')
  })
  await test('an unfenceable native attempt never turns absence or timeout into a false failure',async()=>{
    const {operationId,attempt}=await unknown('unfenceable');await age(operationId)
    assert.equal(await resolve(operationId),null)
    assert.equal((await rpc('connection_operation_status','$1',[operationId])).effective.blocksNewOperations,true)
    await rpc('connection_record_native_fence','$1,$2,$3,$4,$5,$6',[owner,operationId,attempt.attempt_id,device,attempt.credential_generation,'f'.repeat(64)])
    const result=await resolve(operationId);assert.equal(result.outcome,'failed');assert.deepEqual(await resolve(operationId),result)
    await reject(()=>rpc('connection_record_effect',"$1,$2,$3,$4,'github','unfenceable','applied','native-transaction',$5",[owner,operationId,attempt.attempt_id,attempt.credential_generation,'b'.repeat(64)]),'PT409')
  })
  await test('a lost native authorization ticket response expires without any disclosed generation or device effect',async()=>{
    await db.query('SAVEPOINT unprepared_native');
    const operationId=randomUUID(),head=(await db.query('SELECT revision::text AS v FROM identity.connection_heads WHERE owner_user_id=$1',[owner])).rows[0].v;
    await rpc('connection_recreate_begin',"$1,$2,NULL,NULL,$3,'github',$4",[operationId,scope,device,head]);
    const row=(await db.query('SELECT * FROM identity.connection_attempts WHERE operation_id=$1',[operationId])).rows[0];
    assert.equal(row.prepared_at,null);assert.equal(row.runtime_instance_id,null);
    assert.equal(await rpc('connection_attempt_inspect','$1,$2',[operationId,runtime]),null);
    assert.equal(await resolve(operationId),null);await age(operationId);
    const decision=await resolve(operationId);assert.equal(decision.outcome,'failed');assert.deepEqual(await resolve(operationId),decision);
    assert.equal((await db.query('SELECT fence_kind FROM identity.connection_attempts WHERE operation_id=$1',[operationId])).rows[0].fence_kind,'unprepared-intent');
    await reject(()=>rpc('connection_attempt_prepare','$1,1,$2',[operationId,runtime]),'PT409');
    await db.query('ROLLBACK TO unprepared_native; RELEASE unprepared_native');
  })
  await test('the original native admission is a durable candidate before its response can be lost',async()=>{
    await db.query('SAVEPOINT lost_native_admit');
    const saved=await save('lost-admit'),operationId=randomUUID();
    const removed=await rpc('connection_commit',"$1,$2,$3,$4,'remove',$5,NULL,$6,NULL",[operationId,scope,key('lost-admit'),saved.revision,{},device]);
    const receipt=await rpc('connection_admit','$1,$2,$3',[runtime,removed.revision,operationId]);
    const row=(await db.query('SELECT * FROM identity.connection_attempts WHERE operation_id=$1',[operationId])).rows[0];
    assert.equal(row.admission_id,receipt.admissionId);assert.ok(row.prepared_at);
    await age(operationId);assert.equal(await resolve(operationId),null);
    await db.query('ROLLBACK TO lost_native_admit; RELEASE lost_native_admit');
  })
  await test('a newer provider intent fences an older effect and publication even at the identical head revision',async()=>{
    await db.query('SAVEPOINT provider_intent_order');
    const operationId=randomUUID(),head=(await db.query('SELECT revision::text AS v FROM identity.connection_heads WHERE owner_user_id=$1',[owner])).rows[0].v;
    const ticket=await rpc('connection_recreate_begin',"$1,$2,NULL,NULL,$3,'github',$4",[operationId,scope,device,head]);
    const context=await rpc('connection_attempt_prepare','$1,1,$2',[operationId,runtime]);
    const data={providerId:'github',accountId:'older-unpublished',configured:true};
    const document=JSON.stringify({version:1,providerId:'github',accountId:'older-unpublished'});
    const publication={operationId,scopeKey:scope,resourceKey:null,expectedRevision:null,operation:'save',data,document,deviceId:device,recreationId:ticket.recreationId};
    await rpc('connection_record_effect',"$1,$2,$3,$4,'github','older-unpublished','applied','native-transaction',$5,$6",[owner,operationId,context.attemptId,context.credentialGeneration,'e'.repeat(64),publication]);
    await rpc('connection_recreate_begin',"$1,$2,NULL,NULL,$3,'github',$4",[randomUUID(),scope,device,head]);
    await reject(()=>rpc('connection_attempt_write_fence','$1,$2,$3,1',[owner,operationId,context.attemptId]),'PT409');
    await reject(()=>rpc('connection_commit',"$1,$2,NULL,NULL,'save',$3,$4,$5,$6,$7",[operationId,scope,data,document,device,runtime,ticket.recreationId]),'PT409');
    assert.equal((await resolve(operationId)).outcome,'applied');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM identity.connection_items WHERE owner_user_id=$1 AND resource_key=$2',[owner,key('older-unpublished')])).rows[0].n,0);
    await db.query('ROLLBACK TO provider_intent_order; RELEASE provider_intent_order');
  })
  await test('native preparation rejects a stale authorization head before an attempt can start',async()=>{
    await db.query('SAVEPOINT stale_native_prepare');
    const operationId=randomUUID(),head=(await db.query('SELECT revision::text AS v FROM identity.connection_heads WHERE owner_user_id=$1',[owner])).rows[0].v;
    await rpc('connection_recreate_begin',"$1,$2,NULL,NULL,$3,'github',$4",[operationId,scope,device,head]);
    await db.query('UPDATE identity.connection_heads SET revision=revision+1 WHERE owner_user_id=$1',[owner]);
    await reject(()=>rpc('connection_attempt_prepare','$1,1,$2',[operationId,runtime]),'PT409');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM identity.connection_attempts WHERE operation_id=$1',[operationId])).rows[0].n,1);
    assert.equal((await db.query('SELECT prepared_at FROM identity.connection_attempts WHERE operation_id=$1',[operationId])).rows[0].prepared_at,null);
    await db.query('ROLLBACK TO stale_native_prepare; RELEASE stale_native_prepare');
  })
  await test('missing and foreign operation reads have identical public results',async()=>{
    const own=await unknown('private');await claims(other)
    assert.equal(await rpc('connection_operation_status','$1',[own.operationId]),null)
    assert.equal(await rpc('connection_operation_status','$1',[randomUUID()]),null)
    await claims(owner)
    const result=await rpc('connection_operation_status','$1',[own.operationId])
    assert.deepEqual(Object.keys(result).sort(),['version','operationId','scopeKey','resourceKey','deviceId','revision','operation','original','resolution','effective','confirmation'].sort())
    assert.doesNotMatch(JSON.stringify(result),/credentialGeneration|requestHash|admissionId|attemptId|evidenceDigest|receipt/)
  })
}
