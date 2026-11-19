import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {connectionLegacyResponseFixture} from './platform-connection-legacy-fixture.mjs'

export async function installConnectionEntryGateWithEvidence({db,query,sql,test}) {
  const fixture=await connectionLegacyResponseFixture(db)
  const {owner,assistant,device}=fixture.identities
  const state=async()=> (await db.query(`SELECT p.oid,p.proacl::text,p.proowner,p.prosecdef,p.provolatile,p.proconfig
    FROM pg_proc p WHERE p.oid IN (
      'identity.assistant_panel_commit(text,uuid,text,text,bigint,text,jsonb,uuid,text,text,text)'::regprocedure,
      'identity.connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid)'::regprocedure,
      'identity.connection_snapshot(text)'::regprocedure) ORDER BY oid`)).rows
  const before=await fixture.capture(),catalogBefore=await state()
  let result
  try {
    result=await query(sql)
    await test('entry guards preserve OIDs, owners, ACLs and non-integrations response bytes',async()=>{
      assert.deepEqual(await state(),catalogBefore)
      assert.deepEqual(await fixture.capture(),before)
    })
    await db.query('BEGIN')
    try {
      const rejected=async(action,code)=>{
        await db.query('SAVEPOINT entry_rejection')
        let error
        try{await action()}catch(e){error=e}
        await db.query('ROLLBACK TO entry_rejection; RELEASE entry_rejection')
        assert.equal(error?.code,code,error?.message ?? 'expected refusal')
        if(code==='PT426') {
          assert.equal(error.message,'请升级到 8.0.0 版本后再管理连接')
          assert.deepEqual(JSON.parse(error.detail),{errorCode:'CONNECTION_CLIENT_UPGRADE_REQUIRED',feature:'connection-management',minimumVersion:'8.0.0',clientPlatform:'desktop',policyRevision:'1'})
        }
      }
      const declarations=async(version)=>db.query("SELECT set_config('request.headers',$1,true)",[
        JSON.stringify({'x-gugu-connection-client-version':version,'x-gugu-connection-client-platform':'desktop'})])
      const legacy=(domain='integrations')=>db.query(`SELECT identity.assistant_panel_commit($1,$2,$3,$4,0,'save',$5,NULL,NULL,$6,NULL)`,
        [assistant,randomUUID(),domain,domain==='integrations'?'["github","fixture"]':'profile-2',
        domain==='integrations'?{providerId:'github',accountId:'fixture',configured:true}:{text:'unchanged'},device])
      await test('legacy integrations stop after owner switch, while unrelated tasks and receipts remain usable',async()=>{
        await declarations('8.0.0')
        await db.query('SAVEPOINT off_path')
        await legacy()
        await db.query('ROLLBACK TO off_path; RELEASE off_path')
        await db.query("INSERT INTO identity.connection_heads(owner_user_id,authority_mode,native_initialized_at) VALUES($1,'owner',clock_timestamp())",[owner])
        await rejected(()=>legacy(),'PT409')
        await legacy('personality')
        assert.equal((await db.query("SELECT identity.assistant_panel_resource($1,'personality','profile')::text bytes",[assistant])).rows[0].bytes,before.resource)
      })
      await test('old declarations refuse all new management APIs before UUID/head or credential mutation',async()=>{
        await db.query("SELECT identity.connection_management_set_policy(0,true,'{\"desktop\":\"8.0.0\"}')")
        await declarations('0.3.1')
        const existing=(await db.query("SELECT revision::text FROM identity.connection_heads WHERE owner_user_id=$1",[owner])).rows
        await rejected(()=>legacy(),'PT426')
        for(const [sql,args] of [
          ["SELECT identity.connection_snapshot(NULL)",[]],
          ["SELECT identity.connection_resource('platform','fixture')",[]],
          ["SELECT identity.connection_recreate_begin($1,'platform',NULL,NULL,NULL,'amap',0)",[randomUUID()]],
          ["SELECT identity.connection_commit($1,'platform','fixture',0,'save','{}')",[randomUUID()]],
          ["SELECT identity.connection_commit_batch($1,$2,'[]')",[randomUUID(),randomUUID()]],
          ["SELECT identity.connection_pending('absent-runtime')",[]],
          ["SELECT identity.connection_admit('absent-runtime',0,$1)",[randomUUID()]],
        ])await rejected(()=>db.query(sql,args),'PT426')
        assert.deepEqual((await db.query("SELECT revision::text FROM identity.connection_heads WHERE owner_user_id=$1",[owner])).rows,existing)
        assert.equal((await db.query("SELECT count(*)::int n FROM identity.connection_operations WHERE owner_user_id=$1",[owner])).rows[0].n,0)
        assert.equal((await db.query("SELECT identity.connection_authority() value")).rows[0].value.mode,'owner')
        await rejected(()=>db.query("SELECT identity.connection_admit('absent-runtime',0,NULL)"),'42501')
      })
      await test('upgrading reads the original owner state without reauthorization or clearing tombstones',async()=>{
        await db.query("UPDATE identity.connection_heads SET native_initialized_at=clock_timestamp(),revision=2 WHERE owner_user_id=$1",[owner])
        await db.query(`INSERT INTO identity.connection_items(owner_user_id,scope_key,resource_key,revision,data,public_metadata,deleted_at)
          VALUES($1,'platform','["amap","kept"]',1,'{"providerId":"amap","accountId":"kept","configured":true}','{"providerId":"amap","accountId":"kept"}',NULL),
          ($1,'platform','["amap","revoked"]',2,'{"providerId":"amap","accountId":"revoked"}',NULL,clock_timestamp())`,[owner])
        const original=(await db.query('SELECT to_jsonb(i) value FROM identity.connection_items i WHERE owner_user_id=$1 ORDER BY resource_key',[owner])).rows

        await declarations('8.0.0+fixture')
        const state=(await db.query('SELECT identity.connection_snapshot(NULL) value')).rows[0].value
        assert.equal(state.state,'ready')
        assert.equal(state.items.length,2)
        assert.ok(state.items.find(i=>i.resourceKey==='["amap","revoked"]').deletedAt)
        assert.deepEqual((await db.query('SELECT to_jsonb(i) value FROM identity.connection_items i WHERE owner_user_id=$1 ORDER BY resource_key',[owner])).rows,original)
        await rejected(()=>legacy(),'PT409')
        assert.equal((await db.query('SELECT identity.connection_management_access() value')).rows[0].value.allowed,true)
      })
    } finally {await db.query('ROLLBACK')}
  } catch(error) {await db.query('ROLLBACK');throw error} finally {await fixture.cleanup()}
  return result
}
