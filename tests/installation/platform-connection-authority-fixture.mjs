import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export async function assertConnectionAuthorityReader(db, test) {
  const owner=randomUUID(), other=randomUUID()
  for(const id of [owner,other]) {
    await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
      confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
      VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,
      '{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`,[id,`${id}@authority-reader.invalid`])
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Authority fixture') ON CONFLICT DO NOTHING",[id])
  }
  async function read(id=owner) {
    await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:id,role:'authenticated'})])
    await db.query('SET LOCAL ROLE authenticated')
    const value=(await db.query('SELECT identity.connection_authority() AS result')).rows[0].result
    await db.query('RESET ROLE');return value
  }
  await test('authority read is explicit legacy without initializing an assistant or opening owner APIs',async()=>{
    assert.deepEqual(await read(),{version:1,mode:'legacy',epoch:'0',phase:'stable',acceptingNewOperations:true})
    assert.equal((await db.query('SELECT count(*)::int AS n FROM identity.connection_heads WHERE owner_user_id=$1',[owner])).rows[0].n,0)
    assert.equal((await db.query("SELECT count(*)::int AS n FROM identity.users WHERE owner_user_id=$1 AND type='agent'",[owner])).rows[0].n,0)
    assert.equal((await db.query("SELECT has_function_privilege('authenticated','identity.connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid)','EXECUTE') AS allowed")).rows[0].allowed,false)
  })
  await test('authority mode, epoch and intake phase are persisted, owner isolated and client read only',async()=>{
    await db.query("INSERT INTO identity.connection_heads(owner_user_id,authority_mode,authority_epoch,authority_phase) VALUES($1,'owner',4,'quiescing')",[owner])
    assert.deepEqual(await read(),{version:1,mode:'owner',epoch:'4',phase:'quiescing',acceptingNewOperations:false})
    assert.equal((await read(other)).mode,'legacy')
    await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,role:'authenticated'})])
    await db.query('SAVEPOINT authority_denied; SET LOCAL ROLE authenticated')
    let error;try{await db.query("UPDATE identity.connection_heads SET authority_mode='owner' WHERE owner_user_id=$1",[owner])}catch(caught){error=caught}
    await db.query('ROLLBACK TO authority_denied; RELEASE authority_denied')
    assert.equal(error?.code,'42501')
    assert.equal((await db.query("SELECT has_function_privilege('anon','identity.connection_authority()','EXECUTE') AS allowed")).rows[0].allowed,false)
  })
  await test('the internal authority fence rejects stale epochs and quiescence without granting an effect admission',async()=>{
    async function fence(mode,epoch,code) {
      await db.query('SAVEPOINT authority_fence')
      let error,result;try{result=(await db.query('SELECT identity.connection_authority_fence($1,$2) AS result',[mode,epoch])).rows[0].result}catch(caught){error=caught}
      await db.query('ROLLBACK TO authority_fence; RELEASE authority_fence')
      if(code)assert.equal(error?.code,code);else{assert.equal(error,undefined);assert.deepEqual(result,{mode,epoch:String(epoch)})}
    }
    await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,role:'authenticated'})])
    await fence('owner',4,'PT409')
    await db.query("UPDATE identity.connection_heads SET authority_phase='stable' WHERE owner_user_id=$1",[owner])
    await fence('owner',3,'PT409');await fence('legacy',4,'PT409');await fence('owner',4)
    assert.equal((await db.query("SELECT has_function_privilege('authenticated','identity.connection_authority_fence(text,bigint)','EXECUTE') AS allowed")).rows[0].allowed,false)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM identity.connection_admissions WHERE owner_user_id=$1',[owner])).rows[0].n,0)
  })
}
