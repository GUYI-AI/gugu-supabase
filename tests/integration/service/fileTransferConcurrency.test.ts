import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { beforeAll,afterAll,beforeEach,afterEach,describe,it,expect } from 'vitest'
const url=process.env.GUGU_INTEGRATION_DATABASE_URL??''
let db:pg.Client,owner:string,group:string,prior:unknown,ids:string[],globalStorage:number
const items:string[]=[],blobs:string[]=[]
const settings={inventory_ready:true,storage_global_bytes:100,storage_account_bytes:100,storage_group_bytes:100,
  download_global_bytes:100,download_account_bytes:100,download_group_bytes:100,
  upload_permit_seconds:120, upload_edge_seconds:400, upload_sign_seconds:900, upload_inflight_seconds:600,sign_window_seconds:60,sign_account_count:100,sign_group_count:100}
beforeAll(async()=>{
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw new Error('Concurrency contracts require an isolated loopback database')
  db=new pg.Client({connectionString:url});await db.connect()
  owner=randomUUID();group=randomUUID()
  await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())",[owner,owner+'@quota.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','concurrency fixture',$2)",[group,owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')",[group,owner])
  for(let i=0;i<2;i++) {
    const blob=randomUUID(),item=randomUUID(),sha=randomUUID().replaceAll('-','').repeat(2)
    await db.query("INSERT INTO chat.file_blobs(id,bucket_id,object_name,sha256,size_bytes,content_type,created_by) VALUES($1,'oss',$2,$3,1,'application/octet-stream',$4)",[blob,'u/'+owner+'/'+sha,sha,owner])
    await db.query("INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,size_bytes,blob_id,created_by) VALUES($1,$2,'file',$3,'application/octet-stream',1,$4,$5)",[item,group,'concurrency-'+i+'.bin',blob,owner])
    items.push(item);blobs.push(blob)
  }
})
afterAll(async()=>{
  if (!db) return
  await db.query('DELETE FROM chat.workspace_items WHERE id=ANY($1::uuid[])',[items])
  await db.query('DELETE FROM chat.file_transfer_storage WHERE blob_id=ANY($1::uuid[])',[blobs])
  await db.query('DELETE FROM chat.file_blobs WHERE id=ANY($1::uuid[])',[blobs])
  await db.query('DELETE FROM chat.chats WHERE id=$1',[group]);await db.query('DELETE FROM auth.users WHERE id=$1',[owner]);await db.end()
})
beforeEach(async()=>{
  ids=[]
  prior=(await db.query("SELECT settings FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*'")).rows[0]?.settings
  globalStorage=Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings",[{...settings,storage_global_bytes:globalStorage+100}])
})
afterEach(async()=>{
  await db.query('DELETE FROM chat.file_transfer_reservations WHERE id=ANY($1::uuid[])',[ids])
  if (prior) await db.query("UPDATE chat.file_transfer_limits SET settings=$1 WHERE scope='global' AND scope_id='*'",[prior])
  else await db.query("DELETE FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*'")
})

async function race(kind='download',sameId=false,chat:string|null=null,distinctAccounts=false) {
  const clients=await Promise.all(Array.from({length:8},async()=>{
    const c=new pg.Client({connectionString:url,application_name:'file-quota-contender'});await c.connect();return c
  }))
  const shared=randomUUID()
  if(kind==='download') {
    await db.query('BEGIN')
    await db.query("SELECT 1 FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*' FOR UPDATE")
  } else await db.query("SELECT pg_advisory_lock(hashtextextended('gugu:file-transfer:quota',0))")
  const tasks=clients.map(async(c)=>{
    const id=sameId?shared:randomUUID();ids.push(id)
    try { return {row:(await c.query('SELECT * FROM chat.file_transfer_reserve($1,$2,$3,$4,1,$5)',[id,kind,distinctAccounts?randomUUID():owner,chat,'contract'])).rows[0]} }
    catch(e) { return {error:e as pg.DatabaseError} }
  })
  let setupFailure:unknown
  try {
    let waiting:unknown[]=[]
    const deadline=Date.now()+10000
    while(Date.now()<deadline) {
      await db.query('SELECT pg_stat_clear_snapshot()')
      waiting=(await db.query("SELECT pid,wait_event FROM pg_stat_activity WHERE application_name='file-quota-contender' AND state='active' AND wait_event_type='Lock'")).rows
      if(waiting.length===clients.length) break
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    console.info('contending database sessions',waiting)
    expect(waiting).toHaveLength(8)
  } catch(error) { setupFailure=error } finally {
    if(kind==='download') await db.query('COMMIT')
    else await db.query("SELECT pg_advisory_unlock(hashtextextended('gugu:file-transfer:quota',0))")
  }
  try { const results=await Promise.all(tasks); if(setupFailure) throw setupFailure; return results }
  finally { await Promise.all(clients.map(c=>c.end())) }
}
describe('real concurrent quota admission',()=>{
  it('downloads do not queue behind the installation-wide storage and GC lock',async()=>{
    const control=new pg.Client({connectionString:url,application_name:'file-quota-lock-control'})
    const reader=new pg.Client({connectionString:url,application_name:'file-quota-download'})
    await control.connect();await reader.connect()
    await reader.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,role:'authenticated'})])
    await db.query("SELECT pg_advisory_lock(hashtextextended('gugu:file-transfer:quota',0))")
    const waiting=control.query("SELECT pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0))")
    let downloading:Promise<pg.QueryResult>|undefined
    let finished=false
    try {
      const deadline=Date.now()+10000
      while(Date.now()<deadline) {
        const rows=(await db.query("SELECT pid FROM pg_stat_activity WHERE application_name='file-quota-lock-control' AND wait_event='advisory'")).rows
        if(rows.length===1) break
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect((await db.query("SELECT pid FROM pg_stat_activity WHERE application_name='file-quota-lock-control' AND wait_event='advisory'")).rows).toHaveLength(1)
      const id=randomUUID();ids.push(id)
      downloading=reader.query('SELECT chat.file_transfer_download_as($1,$2,$3) AS r',[{item_id:items[0]},owner,id])
      void downloading.then(()=>{finished=true},()=>{finished=true})
      while(!finished && Date.now()<deadline) {
        const locks=(await db.query("SELECT blocked.pid FROM pg_stat_activity blocked JOIN pg_locks b ON b.pid=blocked.pid AND NOT b.granted JOIN pg_locks holder ON holder.locktype=b.locktype AND holder.classid=b.classid AND holder.objid=b.objid AND holder.objsubid=b.objsubid AND holder.granted AND holder.pid=pg_backend_pid() WHERE blocked.application_name='file-quota-download'")).rows
        if(locks.length) break
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect(finished,'download completed while the confirmed global lock remained held').toBe(true)
      expect((await downloading).rows[0].r.status).toBe('ready')
    } finally {
      await db.query("SELECT pg_advisory_unlock(hashtextextended('gugu:file-transfer:quota',0))")
      await Promise.allSettled([waiting,downloading])
      await control.end();await reader.end()
    }
  })
  it.each(['global','account','group'] as const)('only three contenders win the final %s download bytes',async(scope)=>{
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||$1::jsonb WHERE scope='global'",[{['download_'+scope+'_bytes']:3}])
    const outcomes=await race('download',false,scope==='group'?group:null)
    expect(outcomes.filter(o=>'row'in o)).toHaveLength(3)
    expect(outcomes.filter(o=>'error'in o).map(o=>o.error?.hint)).toEqual(Array(5).fill('file_transfer_'+scope+'_download_full'))
    expect(Number((await db.query('SELECT sum(bytes) AS n FROM chat.file_transfer_reservations WHERE id=ANY($1::uuid[])',[ids])).rows[0].n)).toBe(3)
    // A rejected contender did not consume another scope. An unrelated account/group can still use its headroom.
    if(scope!=='global') {
      const id=randomUUID();ids.push(id)
      expect((await db.query('SELECT * FROM chat.file_transfer_reserve($1,$2,$3,NULL,1,$4)',[id,'download',randomUUID(),'other-scope'])).rows).toHaveLength(1)
    }
  })
  it('pending uploads cannot overbook the final physical-storage headroom',async()=>{
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||$1::jsonb WHERE scope='global'",[{storage_global_bytes:globalStorage+3}])
    const outcomes=await race('upload')
    expect(outcomes.filter(o=>'row'in o)).toHaveLength(3)
    expect(outcomes.filter(o=>'error'in o).map(o=>o.error?.hint)).toEqual(Array(5).fill('file_transfer_global_storage_full'))
    expect(Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)-globalStorage).toBe(3)
  })
  it.each(['global','group'] as const)('different accounts cannot overbook shared %s download headroom',async(scope)=>{
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||$1::jsonb WHERE scope='global'",[{['download_'+scope+'_bytes']:3}])
    const outcomes=await race('download',false,scope==='group'?group:null,true)
    expect(outcomes.filter(o=>'row'in o)).toHaveLength(3)
    expect(outcomes.filter(o=>'error'in o).map(o=>o.error?.hint)).toEqual(Array(5).fill('file_transfer_'+scope+'_download_full'))
  })
  it('eight simultaneous retries of one identity reserve exactly one byte',async()=>{
    const outcomes=await race('download',true)
    expect(outcomes.filter(o=>'row'in o)).toHaveLength(8)
    const rows=(await db.query('SELECT id,bytes FROM chat.file_transfer_reservations WHERE id=ANY($1::uuid[])',[ids])).rows
    expect(rows).toEqual([{id:ids[0],bytes:'1'}])
  })
  it.each(['account','group'] as const)('concurrent signatures preserve the rolling %s rate limit',async(scope)=>{
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||$1::jsonb WHERE scope='global'",[{['sign_'+scope+'_count']:3}])
    const outcomes=await race('download',false,scope==='group'?group:null)
    expect(outcomes.filter(o=>'row'in o)).toHaveLength(3)
    expect(outcomes.filter(o=>'error'in o).map(o=>o.error?.hint)).toEqual(Array(5).fill('file_transfer_rate_limited'))
  })
})
