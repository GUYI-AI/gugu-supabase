// Multipart upload state (20261115190000): the store's upload id and the parts reported done, kept per staging key.
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
const PARTS='SELECT chat.file_managed_upload_parts($1,$2,$3,$4) AS r'
async function permit(actor=owner) {
  await user(actor)
  const p=(await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,$4) AS r',[randomUUID(),group,actor,60])).rows[0].r
  await service()
  return p.staging_key as string
}
const parts=async(key:string,id:string|null,done:number[]=[],account=owner)=>(await db.query(PARTS,[key,account,id,done])).rows[0].r
describe('multipart upload state',()=>{
  it('records the first upload id only, and merges reported parts in order without repeats',async()=>{
    const key=await permit()
    expect(await parts(key,null)).toEqual({upload_id:null,parts_done:[]})
    expect(await parts(key,null,[1])).toEqual({upload_id:null,parts_done:[]})
    expect(await parts(key,'U1')).toEqual({upload_id:'U1',parts_done:[]})
    expect(await parts(key,'U2',[3,1,1])).toEqual({upload_id:'U1',parts_done:[1,3]})
    expect(await parts(key,null,[2])).toEqual({upload_id:'U1',parts_done:[1,2,3]})
    expect((await reject(PARTS,[key,member,'U1',[]])).hint).toBe('file_transfer_denied')
  })
  it('clears only the recorded upload, so a late clear of an old one keeps the new one',async()=>{
    const key=await permit()
    await parts(key,'U1',[1,2])
    await db.query('SELECT chat.file_managed_upload_parts_clear($1,$2,$3)',[key,owner,'U0'])
    expect(await parts(key,null)).toEqual({upload_id:'U1',parts_done:[1,2]})
    await db.query('SELECT chat.file_managed_upload_parts_clear($1,$2,$3)',[key,owner,'U1'])
    expect(await parts(key,null)).toEqual({upload_id:null,parts_done:[]})
  })
  const expire=(keys:string[])=>db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE id IN (SELECT reservation_id FROM chat.file_transfer_uploads WHERE staging_key=ANY($1))",[keys])
  const claim=async(limit:number,among:string[])=>(await db.query('SELECT * FROM chat.file_managed_upload_parts_claim($1)',[limit])).rows
    .filter(r=>among.includes(r.staging_key))
  it('claims only expired uploads that have an upload id, and stamps them as tried',async()=>{
    const [old,live,none]=[await permit(),await permit(),await permit()]
    await parts(old,'U-old');await parts(live,'U-live')
    await expire([old,none])
    expect(await claim(50,[old,live,none])).toEqual([{staging_key:old,account_id:owner,upload_id:'U-old'}])
    expect((await db.query('SELECT abandon_tried_at IS NOT NULL AS tried FROM chat.file_transfer_uploads WHERE staging_key=$1',[old])).rows[0].tried).toBe(true)
  })
  it('when every claimed abandon fails, the next round takes the ones not tried yet',async()=>{
    const keys=[await permit(),await permit(),await permit()]
    for(const [i,key] of keys.entries()) await parts(key,'U'+i)
    await expire(keys)
    // Limit 2 stands for the gc's 50: the first round's two fail (nothing clears them), the third is next.
    const first=(await claim(2,keys)).map(r=>r.staging_key)
    expect(first).toHaveLength(2)
    expect((await claim(2,keys)).map(r=>r.staging_key)[0]).toBe(keys.find(k=>!first.includes(k)))
  })
  it('a row that keeps failing is tried again in turn, earliest tried first, after the rows never tried',async()=>{
    const [early,late,fresh]=[await permit(),await permit(),await permit()]
    for(const key of [early,late,fresh]) await parts(key,'U-'+key.slice(-4))
    await expire([early,late,fresh])
    await db.query("UPDATE chat.file_transfer_uploads SET abandon_tried_at=now()-interval '10 minutes' WHERE staging_key=$1",[early])
    await db.query("UPDATE chat.file_transfer_uploads SET abandon_tried_at=now()-interval '5 minutes' WHERE staging_key=$1",[late])
    expect((await claim(1,[early,late,fresh])).map(r=>r.staging_key)).toEqual([fresh])
    expect((await claim(1,[early,late,fresh])).map(r=>r.staging_key)).toEqual([early])
    expect((await claim(1,[early,late,fresh])).map(r=>r.staging_key)).toEqual([late])
  })
  const permitOf=async(key:string)=>(await db.query("SELECT r.created_at,r.expires_at,r.expires_at>now() AS live,extract(epoch FROM r.expires_at-now()) AS left FROM chat.file_transfer_reservations r JOIN chat.file_transfer_uploads u ON u.reservation_id=r.id WHERE u.staging_key=$1",[key])).rows[0]
  const age=(key:string,issued:string,expires:string)=>db.query(`UPDATE chat.file_transfer_reservations SET created_at=now()-interval '${issued}',expires_at=now()+interval '${expires}' WHERE id=(SELECT reservation_id FROM chat.file_transfer_uploads WHERE staging_key=$1)`,[key])
  it('an upload that keeps reporting keeps its permit past the permit length; one that stopped expires as before',async()=>{
    const [reporting,stopped]=[await permit(),await permit()]
    await parts(reporting,'U1');await parts(stopped,'U2')
    // Issued 400 s ago with a 120 s permit: still live only because it has been reporting.
    await age(reporting,'400 seconds','10 seconds')
    await parts(reporting,null,[1])
    expect(Number((await permitOf(reporting)).left)).toBe(120)
    expect((await db.query('SELECT chat.file_managed_upload_for($1,$2) AS r',[reporting,owner])).rows[0].r.blob_id).toBeNull()
    await age(stopped,'400 seconds','-1 seconds')
    await parts(stopped,null,[1])
    expect((await permitOf(stopped)).live).toBe(false)
    expect((await reject('SELECT chat.file_managed_upload_for($1,$2)',[stopped,owner])).hint).toBe('file_transfer_expired')
  })
  it('never extends a permit beyond a day after it was issued, nor one already used',async()=>{
    const [old,used]=[await permit(),await permit()]
    await parts(old,'U1');await parts(used,'U2')
    await age(old,'1 day - 30 seconds','5 seconds')
    await parts(old,null,[1])
    const p=await permitOf(old)
    expect(new Date(p.expires_at).getTime()-new Date(p.created_at).getTime()).toBe(24*3600*1000)
    await db.query("UPDATE chat.file_transfer_reservations SET state='settled',expires_at=now()+interval '5 seconds' WHERE id=(SELECT reservation_id FROM chat.file_transfer_uploads WHERE staging_key=$1)",[used])
    await parts(used,null,[1])
    expect(Number((await permitOf(used)).left)).toBe(5)
  })
  // upload-parts and upload-complete refuse through file_managed_upload_for: an expired permit, and an upload already sent.
  it('the permit check the routes rely on refuses an expired permit and reports a sent upload\'s blob',async()=>{
    const expired=await permit()
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE id=(SELECT reservation_id FROM chat.file_transfer_uploads WHERE staging_key=$1)",[expired])
    expect((await reject('SELECT chat.file_managed_upload_for($1,$2)',[expired,owner])).hint).toBe('file_transfer_expired')
    const sent=await permit()
    expect((await db.query('SELECT chat.file_managed_upload_for($1,$2) AS r',[sent,owner])).rows[0].r.blob_id).toBeNull()
    await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)',[owner,sent,'ab'.repeat(32),60,'application/octet-stream'])
    await db.query('SELECT chat.file_managed_upload_registered($1,$2)',[sent,owner])
    expect((await db.query('SELECT chat.file_managed_upload_for($1,$2) AS r',[sent,owner])).rows[0].r.blob_id).toEqual(expect.any(String))
  })
  it('is for the service only',async()=>{
    const key=await permit()
    await user(owner)
    for(const [sql,args] of [[PARTS,[key,owner,'U1',[]]],['SELECT chat.file_managed_upload_parts_clear($1,$2,$3)',[key,owner,'U1']],
      ['SELECT * FROM chat.file_managed_upload_parts_claim(1)',[]]] as const) {
      expect((await reject(sql,[...args])).code).toBe('42501')
    }
  })
})
