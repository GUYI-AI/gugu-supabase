import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const settings = {
  inventory_ready:true,
  storage_global_bytes: 1000, storage_account_bytes: 800, storage_group_bytes: 700,
  download_global_bytes: 1000, download_account_bytes: 800, download_group_bytes: 700,
  upload_permit_seconds: 120,
  sign_window_seconds: 60, sign_account_count: 100, sign_group_count: 100,
  file_max_bytes: 600,
}
let db: pg.Client
let baselineGlobalStorage: number
let owner: string, member: string, outsider: string, group: string
async function user(id: string) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function service() { await db.query('RESET ROLE') }
async function reject(sql: string, args: unknown[] = []) {
  await db.query('SAVEPOINT denied')
  try { await db.query(sql, args) } catch (e) {
    await db.query('ROLLBACK TO SAVEPOINT denied')
    return e as pg.DatabaseError
  }
  throw new Error('Expected rejection: ' + sql)
}
async function reserve(bytes: number, kind = 'download', account = owner, chat = group, id = randomUUID(), subject = randomUUID()) {
  return (await db.query('SELECT * FROM chat.file_transfer_reserve($1,$2,$3,$4,$5,$6)',
    [id, kind, account, chat, bytes, subject])).rows[0]
}
async function object(bytes: number, _days=0) {
  const id = randomUUID()
  await db.query("INSERT INTO chat.file_transfer_storage(id,bucket_id,object_name,size_bytes) VALUES($1,'oss',$2,$3)", [id, randomUUID(), bytes])
  await db.query('INSERT INTO chat.file_transfer_storage_refs(storage_id,chat_id,account_id) VALUES($1,$2,$3)', [id, group, owner])
  return id
}
async function registeredUpload(sha = 'ab'.repeat(32), bytes = 60, actor = owner) {
  await user(actor)
  const permit=(await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,$4) AS r',[randomUUID(),group,actor,bytes])).rows[0].r
  await service()
  await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)',[actor,permit.staging_key,sha,bytes,'application/octet-stream'])
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)',[permit.staging_key,actor])
  return permit.staging_key
}
beforeAll(async () => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('File policy tests require a disposable loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); member = randomUUID(); outsider = randomUUID(); group = randomUUID()
  for (const id of [owner, member, outsider]) {
    await db.query('INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,\'authenticated\',\'authenticated\',$2,\'{"provider":"email"}\',\'{}\',now(),now())', [id, id + '@file-policy.invalid'])
  }
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','file policy',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [group, owner, member])
  // Preserve the exact tested headroom when other suites have committed legitimate objects.
  baselineGlobalStorage=Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings", [{...settings,storage_global_bytes:baselineGlobalStorage+settings.storage_global_bytes}])
})
afterEach(async () => { await db.query('ROLLBACK') })
describe('atomic transfer budgets', () => {
  it('limits closure to verified physical windows, keeps reports read-only and preserves the first receipt',async()=>{
    const namespace={provider:'oss',region:'example',bucket:'test',prefix:'one'}
    const proof={namespace,issued_from:'2000-01-01T00:00:00Z',issued_before:'infinity',upload_inflight_seconds:7200,evidence:'test-provider-bound',terminal_sha256:'a'.repeat(64),periodic:true}
    const select=async(report:boolean,limit=500)=>(await db.query('SELECT * FROM chat.file_managed_upload_closable($1,$2,$3)',[namespace,limit,report])).rows
    await db.query(`WITH ids AS (SELECT gen_random_uuid() AS id FROM generate_series(1,501)),
      reservations AS (INSERT INTO chat.file_transfer_reservations(id,kind,account_id,subject,bytes,state,created_at,expires_at)
        SELECT id,'upload',$1,'staging/'||$1||'/'||id,2,'issued',now()-interval '4 hours',now()-interval '3 hours' FROM ids
        RETURNING id,subject)
      INSERT INTO chat.file_transfer_uploads(staging_key,reservation_id,account_id,actor_id,max_bytes)
        SELECT subject,id,$1,$1,1 FROM reservations`,[owner])
    expect(await select(true)).toHaveLength(0)
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||$1 WHERE scope='global'",[{upload_closure:proof}])
    const batch=await select(true)
    expect(batch).toHaveLength(500)
    expect((await reject('SELECT * FROM chat.file_managed_upload_closable($1,501)',[namespace])).message).toContain('1 to 500')
    expect((await db.query('SELECT * FROM chat.file_managed_upload_closable($1,500)',[{...namespace,prefix:'two'}])).rows).toHaveLength(0)
    expect(await select(false)).toEqual(batch)
    const next=await select(false,1)
    expect(next).toEqual(batch.slice(0,1))
    const key=next[0].staging_key
    await db.query("SELECT chat.file_managed_upload_closed($1,'first')",[key])
    await db.query("SELECT chat.file_managed_upload_closed($1,'retry')",[key])
    expect((await db.query('SELECT close_evidence FROM chat.file_transfer_uploads WHERE staging_key=$1',[key])).rows[0].close_evidence).toBe('first')
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '30 minutes' WHERE account_id=$1",[owner])
    expect(await select(true)).toHaveLength(0)
  })
  it('keeps ledger usage equal to holds and UTC-month observations through reconciliation and deletion',async()=>{
    const id=randomUUID()
    await reserve(100,'download',owner,group,id,'ledger lifecycle')
    const usage=async()=>Promise.all(['global','account','group'].map(async(scope)=>Number((await db.query(
      'SELECT chat.file_transfer_usage($1,$2,$3) AS n',['download',scope,scope==='global'?'*':scope==='account'?owner:group])).rows[0].n)))
    const initial=await usage()
    const at=(await db.query('SELECT now() AS t')).rows[0].t
    await db.query('SELECT chat.file_transfer_observe($1,$2,40,$3)',['ledger-first',id,at])
    expect(await usage()).toEqual(initial)
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE id=$1",[id])
    await db.query('SELECT chat.file_transfer_settle($1)',[id])
    expect(await usage()).toEqual(initial.map(n=>n-60))
    await db.query('SELECT chat.file_transfer_observe($1,$2,80,$3)',['ledger-late',id,at])
    expect(await usage()).toEqual(initial.map(n=>n+20))
    expect((await db.query('SELECT chat.file_transfer_observe($1,$2,80,$3) AS changed',['ledger-late',id,at])).rows[0].changed).toBe(false)
    expect(await usage()).toEqual(initial.map(n=>n+20))
    await db.query("DELETE FROM chat.file_transfer_observations WHERE event_id='ledger-first'")
    expect(await usage()).toEqual(initial.map(n=>n-20))
    await db.query('DELETE FROM chat.file_transfer_observations WHERE reservation_id=$1',[id])
    await db.query('DELETE FROM chat.file_transfer_reservations WHERE id=$1',[id])
    expect(await usage()).toEqual(initial.map(n=>n-100))
  })
  it('releases settled holds into the observation month and releases cancelled pending holds',async()=>{
    const id=randomUUID(),cancelled=randomUUID()
    const baseline=Number((await db.query("SELECT chat.file_transfer_usage('download','account',$1) AS n",[owner])).rows[0].n)
    await reserve(100,'download',owner,group,id,'monthly ledger')
    await db.query("UPDATE chat.file_transfer_reservations SET created_at=now()-interval '40 days',expires_at=now()-interval '1 second' WHERE id=$1",[id])
    await db.query("SELECT chat.file_transfer_observe($1,$2,40,now()-interval '39 days')",['ledger-old-month',id])
    await db.query("SELECT chat.file_transfer_observe($1,$2,20,now())",['ledger-this-month',id])
    await db.query('SELECT chat.file_transfer_settle($1)',[id])
    expect(Number((await db.query("SELECT chat.file_transfer_usage('download','account',$1) AS n",[owner])).rows[0].n)).toBe(baseline+20)
    await reserve(100,'download',owner,group,cancelled,'cancelled ledger')
    await db.query("UPDATE chat.file_transfer_reservations SET state='cancelled' WHERE id=$1",[cancelled])
    expect(Number((await db.query("SELECT chat.file_transfer_usage('download','account',$1) AS n",[owner])).rows[0].n)).toBe(baseline+20)
  })
  it('does not admit an unmeasured historical object into another quota scope',async()=>{
    const stored=await object(100),target=randomUUID()
    await db.query('UPDATE chat.file_transfer_storage SET size_bytes=NULL WHERE id=$1',[stored])
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','unknown length target',$2)",[target,owner])
    expect((await reject('INSERT INTO chat.file_transfer_storage_refs(storage_id,chat_id,account_id) VALUES($1,$2,$3)',[stored,target,owner])).hint).toBe('file_transfer_unavailable')
    expect((await db.query('SELECT chat_id FROM chat.file_transfer_storage_refs WHERE storage_id=$1',[stored])).rows).toEqual([{chat_id:group}])
  })
  it('requires bootstrap inventory, counts orphan bytes and denies client inventory writes',async()=>{
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"inventory_ready\":false}'")
    expect((await reject('SELECT chat.file_transfer_reserve($1,$2,$3,$4,1,$5)',[randomUUID(),'upload',owner,group,'bootstrap'])).hint).toBe('file_transfer_inventory_required')
    const entry={bucket_id:'oss',object_name:'unreferenced-object',size_bytes:100}
    await user(owner)
    expect((await reject('SELECT chat.file_transfer_inventory($1)',[JSON.stringify([entry])])).code).toBe('42501')
    await service()
    expect((await db.query('SELECT chat.file_transfer_inventory($1) AS n',[JSON.stringify([entry])])).rows[0].n).toBe(1)
    expect((await db.query('SELECT chat.file_transfer_inventory($1) AS n',[JSON.stringify([entry])])).rows[0].n).toBe(1)
    expect(Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)-baselineGlobalStorage).toBe(100)
    expect((await db.query("SELECT settings->'inventory_ready' AS ready FROM chat.file_transfer_limits")).rows[0].ready).toBe(false)
  })
  it('keeps abandoned upload capacity until a trusted operator records terminal provider evidence',async()=>{
    await user(owner)
    const permit=(await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,60) AS r',[randomUUID(),group,owner])).rows[0].r
    expect((await reject('SELECT chat.file_managed_upload_closed($1,$2)',[permit.staging_key,'operator-proof'])).code).toBe('42501')
    await service()
    expect((await reject('SELECT chat.file_managed_upload_closed($1,$2)',[permit.staging_key,''])).message).toBe('Terminal provider evidence is required')
    await db.query('SELECT chat.file_managed_upload_closed($1,$2)',[permit.staging_key,'provider-terminal-and-absence:fixture'])
    expect((await db.query('SELECT staging_deleted,close_evidence FROM chat.file_transfer_uploads WHERE staging_key=$1',[permit.staging_key])).rows[0]).toEqual({staging_deleted:true,close_evidence:'provider-terminal-and-absence:fixture'})
    expect(Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)-baselineGlobalStorage).toBe(0)
  })
  it('closes only expired unobserved downloads whose signing paths the operator covered', async () => {
    // Keep every boundary relative to the transaction clock, including an expiry exactly at the cutoff.
    const cutoff = "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 day'"
    const close = `SELECT chat.file_transfer_downloads_closed((${cutoff}), $1, $2) AS n`
    async function fixture(bucket: string, state = 'issued', kind = 'download', age = 1) {
      const storage = await object(10)
      await db.query('UPDATE chat.file_transfer_storage SET bucket_id=$2 WHERE id=$1', [storage, bucket])
      const id = randomUUID()
      await db.query(`INSERT INTO chat.file_transfer_reservations
        (id,kind,account_id,chat_id,subject,bytes,state,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,10,$6,(${cutoff})-interval '2 days',(${cutoff})-make_interval(days=>$7))`,
      [id,kind,owner,group,'object:'+storage,state,age])
      return id
    }
    const permanent = await fixture('oss','reserved')
    const temporary = await fixture('temporary')
    const observed = await fixture('oss')
    const excluded = [await fixture('workspace'), await fixture('oss','issued','upload'),
      await fixture('oss','issued','download',0), await fixture('oss','issued','download',-90)]
    await db.query(`SELECT chat.file_transfer_observe('zero-event',$1,0,(${cutoff}))`,[observed])

    await user(owner)
    expect((await reject(close,[['cdn','oss'],'forged'])).code).toBe('42501')
    await db.query('SET LOCAL ROLE service_role')
    for (const sources of [[], ['cdn','cdn'], ['cdn',null], ['unknown'], ['storage']]) {
      expect((await reject(close,[sources,'logs:test'])).message).toMatch(/source|Storage/)
    }
    for (const evidence of [null, '', '  ', 'x'.repeat(161)]) {
      expect((await reject(close,[['oss'],evidence])).message).toMatch(/evidence/)
    }
    for (const until of [null, 'infinity', 'tomorrow']) {
      expect((await reject('SELECT chat.file_transfer_downloads_closed($1,$2,$3)',[until,['oss'],'logs:test'])).message).toMatch(/cutoff/)
    }
    const held = async () => Number((await db.query("SELECT chat.file_transfer_usage('download','account',$1) AS n",[owner])).rows[0].n)
    const initial = await held()
    expect((await db.query(close,[['cdn'],'logs:cdn'])).rows[0].n).toBe(0)
    expect((await db.query(close,[['oss'],'logs:direct'])).rows[0].n).toBe(1)
    expect(await held()).toBe(initial-10)
    expect((await db.query(close,[['cdn','oss'],'logs:both'])).rows[0].n).toBe(1)
    expect((await db.query(close,[['oss','cdn'],'logs:retry'])).rows[0].n).toBe(0)
    expect(await held()).toBe(initial-20)
    const state = async (id: string) => (await db.query('SELECT state,close_evidence FROM chat.file_transfer_reservations WHERE id=$1',[id])).rows[0]
    expect(await state(temporary)).toEqual({state:'settled',close_evidence:'logs:direct'})
    for (const id of [...excluded, observed]) expect(await state(id)).toEqual({state:'issued',close_evidence:null})

    await db.query('SELECT chat.file_transfer_settle($1)',[observed])
    expect(await held()).toBe(initial-30)
    await db.query(`SELECT chat.file_transfer_observe('prior-month',$1,12,(${cutoff}))`,[permanent])
    expect(await held()).toBe(initial-30)
    await db.query("SELECT chat.file_transfer_observe('current-month',$1,18,now())",[permanent])
    expect(await held()).toBe(initial-12)
    expect(await state(permanent)).toEqual({state:'settled',close_evidence:'logs:both'})
  })
  it('only trusted imports can reconcile a current download, without refunding its issued capability',async()=>{
    const stored=await object(100),download=randomUUID()
    await reserve(100,'download',owner,group,download,'object:'+stored)
    await db.query("UPDATE chat.file_transfer_reservations SET state='issued' WHERE id=$1",[download])
    const at=(await db.query('SELECT now() AS at')).rows[0].at.toISOString()
    const event={event_id:'cdn:provider-1',download_id:download,object_name:(await db.query('SELECT object_name FROM chat.file_transfer_storage WHERE id=$1',[stored])).rows[0].object_name,bytes:130,observed_at:at}
    await user(owner)
    expect((await reject('SELECT chat.file_transfer_import($1)',[JSON.stringify([event])])).code).toBe('42501')
    await service()
    expect((await db.query('SELECT chat.file_transfer_import($1) AS r',[JSON.stringify([event])])).rows[0].r).toEqual({imported:1,duplicates:0})
    expect((await db.query('SELECT chat.file_transfer_import($1) AS r',[JSON.stringify([event])])).rows[0].r).toEqual({imported:0,duplicates:1})
    expect((await db.query('SELECT state,actual_bytes FROM chat.file_transfer_reservations WHERE id=$1',[download])).rows[0]).toEqual({state:'issued',actual_bytes:'130'})
    const extra={...event,event_id:'cdn:provider-2',bytes:10}
    expect((await reject('SELECT chat.file_transfer_import($1)',[JSON.stringify([extra,{...event,bytes:131}])])).message).toBe('Observation identity is immutable')
    expect((await db.query('SELECT actual_bytes FROM chat.file_transfer_reservations WHERE id=$1',[download])).rows[0].actual_bytes).toBe('130')
    expect((await reject('SELECT chat.file_transfer_import($1)',[JSON.stringify([{...extra,object_name:'other-object'}])])).hint).toBe('file_transfer_unknown_observation')
  })
  it('a normal verified upload reserves its scope, retains staging capacity and forwards only into groups with room',async()=>{
    const key=await registeredUpload(),message=randomUUID(),target=randomUUID()
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','target',$2)",[target,owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')",[target,owner])
    await db.query("INSERT INTO chat.file_transfer_limits VALUES('group',$1,$2,now())",[target,{storage_group_bytes:59}])
    await user(owner)
    await db.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5)',[key,message,group,owner,'original.bin'])
    expect((await reject('SELECT * FROM chat.attachment_forward($1,$2,$3,$4)',[message,randomUUID(),target,owner])).hint).toBe('file_transfer_group_storage_full')
    await service()
    expect((await db.query('SELECT chat_id,max_bytes,staging_deleted FROM chat.file_transfer_uploads WHERE staging_key=$1',[key])).rows[0]).toMatchObject({chat_id:group,max_bytes:'60',staging_deleted:false})
    const download=randomUUID()
    await user(member)
    const row=(await db.query('SELECT chat.file_transfer_download_as($1,$2,$3) AS r',[{message_id:message},member,download])).rows[0].r
    expect(row).toMatchObject({status:'ready',sha256:'ab'.repeat(32),size_bytes:60,download_id:download})
    expect(Date.parse(row.expires_at)-Date.parse(row.signed_at)).toBe(60000)
    await user(outsider)
    expect((await db.query('SELECT chat.file_transfer_download_as($1,$2,$3) AS r',[{message_id:message},outsider,randomUUID()])).rows[0].r.status).toBe('gone')
  })
  it('fails closed without configuration and rejects direct client access to the ledger', async () => {
    await db.query('DELETE FROM chat.file_transfer_limits')
    expect((await reject('SELECT chat.file_transfer_reserve($1,$2,$3,$4,$5,$6)', [randomUUID(), 'download', owner, group, 1, 'a'])).hint).toBe('file_transfer_not_configured')
    await user(owner)
    expect((await reject('SELECT * FROM chat.file_transfer_limits')).code).toBe('42501')
    expect((await reject('SELECT chat.file_transfer_reserve($1,$2,$3,$4,$5,$6)', [randomUUID(), 'download', owner, group, 1, 'a'])).code).toBe('42501')
    expect((await reject('SELECT chat.file_transfer_observe($1,$2,1,now())', ['forged', randomUUID()])).code).toBe('42501')
  })
  it('reserves once, rejects identity changes and does not partly consume denied scopes', async () => {
    expect((await db.query('SELECT chat.file_transfer_settings() AS s')).rows[0].s).not.toHaveProperty('download_link_bits_per_second')
    const id = randomUUID()
    await reserve(600, 'download', owner, group, id, 'same')
    await reserve(600, 'download', owner, group, id, 'same')
    expect((await db.query('SELECT count(*)::integer AS n FROM chat.file_transfer_reservations WHERE id=$1', [id])).rows[0].n).toBe(1)
    expect((await reject('SELECT chat.file_transfer_reserve($1,$2,$3,$4,$5,$6)', [id, 'download', owner, group, 601, 'same'])).hint).toBe('file_transfer_conflict')
    expect((await reject('SELECT chat.file_transfer_reserve($1,$2,$3,$4,$5,$6)', [randomUUID(), 'download', member, group, 101, 'over-group'])).hint).toBe('file_transfer_group_download_full')
    expect((await db.query('SELECT count(*)::integer AS n FROM chat.file_transfer_reservations WHERE chat_id=$1', [group])).rows[0].n).toBe(1)
  })
  it('one exhausted account leaves another account usable with group/global headroom', async () => {
    await db.query("INSERT INTO chat.file_transfer_limits VALUES('account',$1,$2,now())", [owner, { download_account_bytes: 10 }])
    await reserve(10)
    expect((await reject('SELECT chat.file_transfer_reserve($1,$2,$3,$4,$5,$6)', [randomUUID(), 'download', owner, group, 1, 'owner-full'])).hint).toBe('file_transfer_account_download_full')
    await reserve(20, 'download', member)
  })
  it('global budget stops all accounts; pending upload and deletion retain storage capacity', async () => {
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||$1::jsonb WHERE scope='global'",[{download_global_bytes:20,storage_global_bytes:baselineGlobalStorage+80}])
    await reserve(20)
    expect((await reject('SELECT chat.file_transfer_reserve($1,$2,$3,$4,$5,$6)', [randomUUID(), 'download', member, group, 1, 'global-full'])).hint).toBe('file_transfer_global_download_full')
    const stored = await object(40, 0)
    await reserve(40, 'upload')
    await db.query("UPDATE chat.file_transfer_storage SET state='deleting' WHERE id=$1", [stored])
    expect((await reject('SELECT chat.file_transfer_reserve($1,$2,$3,$4,$5,$6)', [randomUUID(), 'upload', owner, group, 1, 'storage-full'])).hint).toBe('file_transfer_global_storage_full')
    await db.query("UPDATE chat.file_transfer_storage SET state='gone' WHERE id=$1", [stored])
    await reserve(1, 'upload')
  })
  it('trusted observations preserve actual bytes above reservation without inventing product download activity', async () => {
    const stored = await object(100, 1)
    const r = await reserve(100, 'download', owner, group, randomUUID(), 'object:' + stored)
    const at = (await db.query('SELECT now() AS at')).rows[0].at
    await db.query("SELECT chat.file_transfer_observe('get-1',$1,130,$2)", [r.id, at])
    expect((await db.query("SELECT chat.file_transfer_observe('get-1',$1,130,$2) AS changed", [r.id, at])).rows[0].changed).toBe(false)
    expect((await db.query('SELECT actual_bytes FROM chat.file_transfer_reservations WHERE id=$1', [r.id])).rows[0].actual_bytes).toBe('130')
    expect((await reject("SELECT chat.file_transfer_observe('get-1',$1,131,$2)", [r.id, at])).message).toMatch(/immutable/)
  })
  it('old issued capabilities remain reserved across a UTC month boundary', async () => {
    await reserve(600)
    await db.query("UPDATE chat.file_transfer_reservations SET period='2000-01-01',created_at=now()-interval '40 days',state='issued'")
    expect((await reject('SELECT chat.file_transfer_reserve($1,$2,$3,$4,$5,$6)', [randomUUID(), 'download', owner, group, 101, 'carry'])).hint).toBe('file_transfer_group_download_full')
  })
  it('rate limits new signatures but permits an identical retry without another charge', async () => {
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"sign_account_count\":1}' WHERE scope='global'")
    const id = randomUUID()
    await reserve(10, 'download', owner, group, id, 'same')
    await reserve(10, 'download', owner, group, id, 'same')
    expect((await reject('SELECT chat.file_transfer_reserve($1,$2,$3,$4,$5,$6)', [randomUUID(), 'download', owner, group, 1, 'again'])).hint).toBe('file_transfer_rate_limited')
    await reserve(10, 'download', member)
  })
})
