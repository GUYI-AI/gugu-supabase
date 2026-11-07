import assert from 'node:assert/strict'
import {generateKeyPairSync,randomUUID} from 'node:crypto'
/** Real SQL capability/challenge tests. Ed25519 authenticity is exercised by the
 * actual public requester/native signer and privileged service adapter suites. */
export async function assertConnectionEvidenceTrust(db,test){
 const owner=randomUUID(),other=randomUUID(),device=randomUUID(),runtime=randomUUID(),operationId=randomUUID(),keyId=randomUUID();
 for(const id of [owner,other]){
  await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
   VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`,[id,id+'@evidence-trust.invalid']);
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Evidence trust') ON CONFLICT DO NOTHING",[id]);
 }
 await db.query("INSERT INTO identity.connection_heads(owner_user_id,native_initialized_at,authority_mode,authority_epoch,verification_protocol) VALUES($1,clock_timestamp(),'owner',1,2)",[owner]);
 await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'trust','fixture','linux')",[device,owner]);
 await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[runtime,device,owner]);
 await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,role:'authenticated'})]);
 const rpc=async(name,args,values)=>(await db.query(`SELECT identity.${name}(${args}) AS v`,values)).rows[0].v;
 const reject=async(fn,code)=>{await db.query('SAVEPOINT trust_refusal');let e;try{await fn()}catch(error){e=error}await db.query('ROLLBACK TO trust_refusal; RELEASE trust_refusal');assert.equal(e?.code,code,e?.message??'expected refusal')};
 await rpc('connection_recreate_begin',"$1,$2,NULL,NULL,$3,'github',0",[operationId,'device:'+device,device]);
 const context=await rpc('connection_attempt_prepare','$1,1,$2',[operationId,runtime]);
 const issue=()=>rpc('connection_evidence_challenge_issue',"$1,$2,'read'",[owner,operationId]);
 await test('owner device membership cannot create a trusted key or use a closed verifier capability',async()=>{
  await reject(issue,'42501');
  for(const role of ['anon','authenticated','service_role']){
   await reject(async()=>{await db.query('SET LOCAL ROLE '+role);await issue()},'42501');
   await reject(async()=>{await db.query('SET LOCAL ROLE '+role);await db.query('SELECT * FROM identity.connection_device_evidence_keys')},'42501');
   await reject(async()=>{await db.query('SET LOCAL ROLE '+role);await db.query('INSERT INTO identity.connection_device_evidence_keys(key_id,owner_user_id,device_id,public_key,enrollment_reference) VALUES($1,$2,$3,$4,$5)',[keyId,owner,device,'MCowBQYDK2VwAyEA'+'A'.repeat(43),'untrusted-owner'])},'42501');
  }
 });
 const publicKey=generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).toString('base64url');
 await db.query('INSERT INTO identity.connection_device_evidence_keys(key_id,owner_user_id,device_id,public_key,enrollment_reference) VALUES($1,$2,$3,$4,$5)',[keyId,owner,device,publicKey,'isolated-operator-pairing']);
 await test('service challenges bind the independent active key and exact original context, with durable replay identity',async()=>{
  const trusted=await issue(),another=await issue();assert.equal(trusted.publicKey,publicKey);assert.notEqual(trusted.challenge.nonce,another.challenge.nonce);
  const read=()=>rpc('connection_evidence_challenge_read','$1',[trusted.challenge.challengeId]);assert.deepEqual(await read(),trusted);assert.deepEqual(await read(),trusted);
  const envelope={version:1,challenge:trusted.challenge,proof:{version:1,attempt:context,state:'prepared',fenced:false},signature:'A'.repeat(86)};
  // This internal predicate is deliberately invoked as the isolated installer,
  // not an API identity. The service must first cryptographically verify it.
  const consume=value=>rpc('connection_evidence_challenge_consume','$1,$2,$3',[owner,operationId,value]);
  await reject(()=>consume(envelope.proof),'42501');
  await reject(()=>rpc('connection_evidence_challenge_consume','$1,$2,$3',[other,operationId,envelope]),'42501');
  await reject(()=>consume({...envelope,challenge:{...envelope.challenge,nonce:'f'.repeat(64)}}),'42501');
  assert.deepEqual(await consume(envelope),envelope.proof);assert.deepEqual(await consume(envelope),envelope.proof);
  await reject(()=>consume({...envelope,proof:{...envelope.proof,state:'started'}}),'42501');
  await db.query('UPDATE identity.connection_device_evidence_keys SET revoked_at=clock_timestamp() WHERE key_id=$1',[keyId]);
  assert.equal(await read(),null);await reject(()=>consume(envelope),'42501');
 });
 await test('removing a device preserves enrollment audit and cannot leave a usable trust root',async()=>{
  await db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1',[device]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM identity.connection_device_evidence_keys WHERE key_id=$1',[keyId])).rows[0].n,1);
  await reject(issue,'42501');
 });

}
