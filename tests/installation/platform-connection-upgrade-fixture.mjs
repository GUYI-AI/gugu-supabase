import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'

export async function assertConnectionManagementGate(db,test) {
  const owner=randomUUID()
  await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
    confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
    VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,
    '{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`,[owner,`${owner}@connection-upgrade.invalid`])
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Upgrade fixture') ON CONFLICT DO NOTHING",[owner])
  await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,role:'authenticated'})])
  async function headers(version,platform='desktop') {
    await db.query("SELECT set_config('request.headers',$1,true)",[JSON.stringify({
      ...(version===undefined?{}:{'x-gugu-connection-client-version':version}),
      ...(platform===undefined?{}:{'x-gugu-connection-client-platform':platform})})])
  }
  async function read(role='authenticated') {
    await db.query(`SET LOCAL ROLE ${role}`)
    try{return (await db.query('SELECT identity.connection_management_access() AS access')).rows[0].access}
    finally{await db.query('RESET ROLE')}
  }
  async function refused(sql,code) {
    await db.query('SAVEPOINT upgrade_denied')
    let error
    try{await db.query(sql)}catch(e){error=e}
    await db.query('ROLLBACK TO upgrade_denied; RELEASE upgrade_denied')
    assert.equal(error?.code,code);return error
  }
  await test('management gate defaults off, is owner-authenticated and does not initialize assistant or head',async()=>{
    await db.query("SELECT set_config('request.headers','{}',true)")
    assert.deepEqual(await read(),{version:1,feature:'connection-management',policyRevision:'0',enforced:false,
      allowed:true,minimumVersion:null,clientPlatform:null,errorCode:null})
    assert.equal((await db.query('SELECT count(*)::int n FROM identity.connection_heads WHERE owner_user_id=$1',[owner])).rows[0].n,0)
    for(const role of ['anon','service_role']) {
      assert.equal((await db.query("SELECT has_function_privilege($1,'identity.connection_management_access()','EXECUTE') allowed",[role])).rows[0].allowed,false)
      await refused(`SET LOCAL ROLE ${role}; SELECT identity.connection_management_access()`,'42501')
    }
    for(const role of ['anon','authenticated','service_role']) {
      assert.equal((await db.query("SELECT has_table_privilege($1,'identity.connection_management_client_policy','SELECT') allowed",[role])).rows[0].allowed,false)
      for(const signature of ['identity.connection_management_require_access()','identity.connection_management_set_policy(bigint,boolean,jsonb)']) {
        assert.equal((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,signature])).rows[0].allowed,false)
      }
    }
  })
  await test('full release and prerelease comparison rejects missing/invalid declarations without touching identity or authority',async()=>{
    await db.query("SELECT identity.connection_management_set_policy(0,true,'{\"desktop\":\"1.2.3-beta.2\",\"phone\":\"2.0.0\"}'::jsonb)")
    for(const [version,allowed] of [[undefined,false],['0.3.1',false],['1.2.3-beta.1',false],['1.2.3-beta.2',true],
      ['1.2.3-beta.10',true],['1.2.3-beta.02',false],['1.2.3',true],['1.2.3+build.1',true],['1.3.0-alpha',true],['v9.0.0',false],['bad',false]]) {
      await headers(version)
      const result=await read();assert.equal(result.allowed,allowed,`${version}`)
      assert.equal(result.errorCode,allowed?null:'CONNECTION_CLIENT_UPGRADE_REQUIRED')
      assert.equal(result.minimumVersion,'1.2.3-beta.2');assert.equal(result.policyRevision,'1')
    }
    await headers('2.0.0-beta.1','phone');assert.equal((await read()).allowed,false)
    await headers('2.0.0','phone');assert.equal((await read()).allowed,true)
    await headers('9.0.0','unknown');const unknown=await read();assert.equal(unknown.allowed,false);assert.equal(unknown.clientPlatform,null)
    await headers('9.0.0','web');assert.equal((await read()).allowed,false)
    assert.equal((await db.query('SELECT identity.connection_authority() value')).rows[0].value.mode,'legacy')
    assert.equal((await db.query('SELECT count(*)::int n FROM identity.connection_heads WHERE owner_user_id=$1',[owner])).rows[0].n,0)
  })
  await test('blocked SQL has exact PT426 and public details; configuration changes are revision fenced and API closed',async()=>{
    await headers('0.3.1')
    const error=await refused('SELECT identity.connection_management_require_access()','PT426')
    assert.equal(error.message,'CONNECTION_CLIENT_UPGRADE_REQUIRED')
    assert.deepEqual(JSON.parse(error.detail),{feature:'connection-management',minimumVersion:'1.2.3-beta.2',clientPlatform:'desktop',policyRevision:'1'})
    await refused("SELECT identity.connection_management_set_policy(0,false,'{}')",'PT409')
    await refused("SELECT identity.connection_management_set_policy(1,true,'{}')",'22023')
    await refused("SELECT identity.connection_management_set_policy(1,true,'{\"desktop\":\"1.2.3-beta.01\"}')",'22023')
    await refused("SELECT identity.connection_management_set_policy(1,true,'{\"unexpected\":\"1.0.0\"}')",'22023')
    await db.query("SELECT identity.connection_management_set_policy(1,false,'{}')")
    assert.equal((await read()).allowed,true)
    await db.query('SELECT identity.connection_management_require_access()')
    assert.equal((await db.query('SELECT count(*)::int n FROM identity.connection_operations WHERE owner_user_id=$1',[owner])).rows[0].n,0)
  })
}
