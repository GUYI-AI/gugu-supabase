import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const settings = {
  inventory_ready:true, storage_global_bytes:100000, storage_account_bytes:100000, storage_group_bytes:100000,
  download_global_bytes:100000, download_account_bytes:100000, download_group_bytes:100000,
  upload_permit_seconds:120, sign_window_seconds:60, sign_account_count:100, sign_group_count:100,
  file_max_bytes:10000,
  large_file_bytes:50, large_file_idle_seconds:30*86400, storage_warning_percent:80,
}
let db:pg.Client, owner:string, member:string, outsider:string, group:string
async function user(id=owner) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:id,role:'authenticated'})])
}
async function service() { await db.query('RESET ROLE') }
async function reject(sql:string,args:unknown[]=[]) {
  await db.query('SAVEPOINT denied')
  try { await db.query(sql,args) } catch(error) {
    await db.query('ROLLBACK TO SAVEPOINT denied'); return error as pg.DatabaseError
  }
  throw Error('Expected refusal: '+sql)
}
async function upload(bytes=60,sha=randomUUID().replaceAll('-','').repeat(2),target=group) {
  await user()
  const permit=(await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,$4) AS r',[randomUUID(),target,owner,bytes])).rows[0].r
  await service()
  const blob=(await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)',[owner,permit.staging_key,sha,bytes,'application/octet-stream'])).rows[0]
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)',[permit.staging_key,owner])
  await user()
  const message=randomUUID()
  const sent=(await db.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5)',[permit.staging_key,message,target,owner,'fixture.bin'])).rows[0]
  await service()
  const stored=(await db.query('SELECT id FROM chat.file_transfer_storage WHERE blob_id=$1',[blob.blob_id])).rows[0].id
  return {item:sent.file_item_id as string,key:permit.staging_key,blob:blob.blob_id as string,stored:stored as string,message,sha,created:blob.created as boolean}
}
async function age(stored:string,days=31,last:number|null=null,target=group) {
  await service()
  await db.query('UPDATE chat.file_transfer_storage_refs SET retention_started_at=now()-make_interval(days=>$3),last_download_at=CASE WHEN $4::integer IS NULL THEN NULL ELSE now()-make_interval(days=>$4) END WHERE storage_id=$1 AND chat_id=$2',[stored,target,days,last])
}
async function expire(limit=500) { return (await db.query('SELECT chat.file_transfer_expire($1) AS n',[limit])).rows[0].n as number }
async function state(stored:string) {
  return (await db.query('SELECT o.state,ref.expired_at,ref.last_download_at,ref.retention_started_at FROM chat.file_transfer_storage o JOIN chat.file_transfer_storage_refs ref ON ref.storage_id=o.id WHERE o.id=$1 AND ref.chat_id=$2',[stored,group])).rows[0]
}
async function download(message:string,actor=member,id=randomUUID()) {
  await user(actor)
  return (await db.query('SELECT chat.file_transfer_download_as($1,$2,$3) AS r',[{message_id:message},actor,id])).rows[0].r
}
async function collect(blob:string) {
  await service()
  await db.query("UPDATE chat.file_blob_uploads SET expires_at=now()-interval '1 second' WHERE blob_id=$1",[blob])
  return (await db.query('SELECT * FROM chat.file_blob_gc_claim(50,600)')).rows.find(row=>row.blob_id===blob)
}
beforeAll(async()=>{
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw Error('Idle expiry contracts require an isolated loopback database')
  db=new pg.Client({connectionString:url});await db.connect()
})
afterAll(async()=>{await db?.end()})
beforeEach(async()=>{
  await db.query('BEGIN')
  owner=randomUUID();member=randomUUID();outsider=randomUUID();group=randomUUID()
  for (const id of [owner,member,outsider]) await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())",[id,id+'@expiry.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','idle expiry',$2)",[group,owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[group,owner,member])
  const baseline=Number((await db.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings",[{...settings,storage_global_bytes:baseline+settings.storage_global_bytes}])
})
afterEach(async()=>{await db.query('ROLLBACK')})
describe('non-project idle expiry, not quota eviction',()=>{
  it('discovers idle files on the original scheduler tick even with no due GC entries',async()=>{
    const file=await upload();await age(file.stored)
    await db.query("UPDATE chat.file_blob_gc SET status='pending',next_attempt_at=now()+interval '1 day'")
    // Missing secrets prove the real tick queued work without scheduling a network call.
    await db.query("DELETE FROM vault.secrets WHERE name IN ('attachments_gc_url','attachments_gc_key')")
    expect((await reject('SELECT chat.file_blob_gc_kick()')).message).toMatch(/blobs are due.*Vault has no attachments_gc_url/)
    expect((await state(file.stored)).expired_at).toBeNull() // A refused statement rolls back atomically.
    expect(await expire()).toBe(1)
  })
  it('displaying metadata never reserves a download or renews activity, while a real download still does',async()=>{
    const file=await upload();await age(file.stored)
    for(const actor of [owner,member]) {
      await user(actor)
      const r=(await db.query('SELECT chat.file_resolve_as($1,$2) AS r',[{message_id:file.message},actor])).rows[0].r
      expect(r).toMatchObject({status:'ready',source:'managed-object',sha256:file.sha})
      for(const field of ['url','download_id','signed_at','expires_at']) expect(r[field]).toBeUndefined()
    }
    await service()
    expect((await state(file.stored)).last_download_at).toBeNull()
    expect((await db.query("SELECT id FROM chat.file_transfer_reservations WHERE kind='download' AND chat_id=$1",[group])).rows).toEqual([])
    expect(await expire()).toBe(1)
    await user(member)
    expect((await db.query('SELECT chat.file_resolve_as($1,$2) AS r',[{message_id:file.message},member])).rows[0].r.status).toBe('expired')
    await user(outsider)
    expect((await db.query('SELECT chat.file_resolve_as($1,$2) AS r',[{message_id:file.message},outsider])).rows[0].r).toEqual({status:'gone'})
    await service();const readable=await upload()
    expect((await download(readable.message)).status).toBe('ready')
    await service();expect((await state(readable.stored)).last_download_at).not.toBeNull()
  })
  it('uses strict configured size and inclusive idle boundary, preserving small and recently read files',async()=>{
    const large=await upload(51),small=await upload(50),recent=await upload(100),young=await upload(100)
    await age(large.stored,30);await age(small.stored);await age(recent.stored,40,1);await age(young.stored,29)
    expect(await expire()).toBe(1)
    expect((await state(large.stored)).expired_at).not.toBeNull()
    for (const file of [small,recent,young]) expect((await state(file.stored)).expired_at).toBeNull()
    expect(await expire()).toBe(0)
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"large_file_bytes\":49,\"large_file_idle_seconds\":86400}'")
    expect(await expire()).toBe(3)
  })
  it('keeps old metadata dates while giving untracked references a full first retention interval',async()=>{
    const file=await upload()
    await db.query("UPDATE chat.file_transfer_storage_refs SET created_at=now()-interval '2 years' WHERE storage_id=$1",[file.stored])
    expect((await state(file.stored)).last_download_at).toBeNull()
    expect(await expire()).toBe(0)
  })
  it('retains files without an explicit expiry policy and rejects invalid destructive settings or batch sizes',async()=>{
    const file=await upload();await age(file.stored)
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings-'large_file_idle_seconds'")
    expect(await expire()).toBe(0)
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"large_file_idle_seconds\":0}'")
    expect((await reject('SELECT chat.file_transfer_expire()')).message).toBe('Invalid large file idle interval')
    for(const n of [null,0,501]) expect((await reject('SELECT chat.file_transfer_expire($1)',[n])).message).toBe('Invalid expiry batch size')
  })
  it('batches expiration without skipping survivors and never evicts permanent files under quota pressure',async()=>{
    const files=[await upload(),await upload(),await upload()]
    for(const file of files) await age(file.stored)
    expect(await expire(1)).toBe(1);expect(await expire(1)).toBe(1);expect(await expire(1)).toBe(1);expect(await expire(1)).toBe(0)
    const permanent=await upload(100);await age(permanent.stored,29)
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"storage_group_bytes\":1}'")
    await user()
    expect((await reject('SELECT chat.file_managed_upload_as($1,$2,$3,1)',[randomUUID(),group,owner])).hint).toBe('file_transfer_group_storage_full')
    await service();expect(await expire()).toBe(0)
    expect((await state(permanent.stored)).expired_at).toBeNull()
    expect((await state(permanent.stored)).state).toBe('ready')
  })
  it('excludes project-bound groups using the authoritative project registry',async()=>{
    const file=await upload();await age(file.stored)
    const device=randomUUID()
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,$3,'fixture','linux')",[device,owner,'fixture'])
    await db.query("INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id) VALUES($1,$2,'root','fixture','/fixture',now(),$3)",[device,owner,group])
    // What publish_device_projects records for a bound project (20261109210000_project_groups).
    await db.query('INSERT INTO chat.project_groups(chat_id) VALUES($1) ON CONFLICT DO NOTHING',[group])
    expect(await expire()).toBe(0)
    expect((await state(file.stored)).expired_at).toBeNull()
  })
  it('stamps only a fresh authorized download; retries, outsider attempts and provider observations do not renew it',async()=>{
    const file=await upload(),id=randomUUID();await age(file.stored)
    expect((await download(file.message,outsider)).status).toBe('gone')
    await service();expect((await state(file.stored)).last_download_at).toBeNull()
    const issued=await download(file.message,member,id)
    expect(issued.status).toBe('ready')
    await service()
    await age(file.stored,40,1)
    const before=(await state(file.stored)).last_download_at
    expect(await download(file.message,member,id)).toEqual(issued)
    await service();expect((await state(file.stored)).last_download_at).toEqual(before)
    await db.query('SELECT chat.file_transfer_observe($1,$2,1,now())',['provider:fixture',id])
    expect((await state(file.stored)).last_download_at).toEqual(before)
    expect(await expire()).toBe(0)
  })
  it('never expires a currently issued capability, then permits expiry after its validity window',async()=>{
    const file=await upload(),id=randomUUID()
    expect((await download(file.message,member,id)).status).toBe('ready')
    await age(file.stored)
    expect(await expire()).toBe(0)
    await db.query("UPDATE chat.file_transfer_reservations SET expires_at=now()-interval '1 second' WHERE id=$1",[id])
    expect(await expire()).toBe(1)
  })
  it('retains an active private task handoff when a group reference to the same SHA expires',async()=>{
    const file=await upload(),sender=randomUUID(),receiver=randomUUID(),device=randomUUID()
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')",[device,owner])
    for(const agent of [sender,receiver]) await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','fixture',$2,$3)",[agent,owner,device])
    const key='staging/'+owner+'/'+randomUUID(),attachment=randomUUID()
    await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,60,$4)',[owner,key,file.sha,'application/octet-stream'])
    await user();await db.query('SELECT * FROM chat.session_attachment_commit($1,$2,$3,$4,$5,$6)',[key,attachment,sender,'fixture',[receiver],'private.bin'])
    await age(file.stored);expect(await expire()).toBe(1)
    expect(await collect(file.blob)).toBeUndefined()
    await user();expect((await db.query('SELECT * FROM chat.session_attachment_urls_as($1,$2)',[[attachment],receiver])).rows).toHaveLength(1)
    await db.query('SELECT chat.session_attachment_revoke($1,$2)',[attachment,sender])
    await service();await db.query('SELECT chat.file_blob_enqueue($1)',[file.blob]);await db.query('UPDATE chat.file_blob_gc SET next_attempt_at=now() WHERE blob_id=$1',[file.blob])
    expect(await collect(file.blob)).toMatchObject({blob_id:file.blob})
  })
  it('refuses expired sources before signing or forwarding, without charging a download',async()=>{
    const file=await upload();await age(file.stored);expect(await expire()).toBe(1)
    const r=await download(file.message)
    expect(r.status).toBe('expired');expect(r.url).toBeUndefined();expect(r.download_id).toBeUndefined()
    await user()
    expect((await reject('SELECT * FROM chat.attachment_forward($1,$2,$3,$4)',[file.message,randomUUID(),group,owner])).hint).toBe('file_transfer_expired')
    expect((await reject('SELECT * FROM chat.attachment_share($1,$2,$3,$4,$5)',[file.item,1,randomUUID(),group,owner])).hint).toBe('file_transfer_expired')
    await service()
    expect((await db.query("SELECT id FROM chat.file_transfer_reservations WHERE kind='download' AND chat_id=$1",[group])).rows).toEqual([])
  })
  it('does not stamp downloads rejected by an exhausted budget',async()=>{
    const file=await upload();await age(file.stored)
    await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"download_group_bytes\":0}'")
    await user(member)
    expect((await reject('SELECT chat.file_transfer_download_as($1,$2,$3)',[{message_id:file.message},member,randomUUID()])).hint).toBe('file_transfer_group_download_full')
    await service();expect((await state(file.stored)).last_download_at).toBeNull()
  })
  it('holds physical bytes for an active shared reference in another group',async()=>{
    const file=await upload(),target=randomUUID()
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','shared bytes',$2)",[target,owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')",[target,owner])
    await user();await db.query('SELECT * FROM chat.attachment_forward($1,$2,$3,$4)',[file.message,randomUUID(),target,owner])
    await age(file.stored);expect(await expire()).toBe(1)
    expect(await collect(file.blob)).toBeUndefined()
    expect((await state(file.stored)).state).toBe('ready')
    expect((await db.query('SELECT expired_at FROM chat.file_transfer_storage_refs WHERE storage_id=$1 AND chat_id=$2',[file.stored,target])).rows[0].expired_at).toBeNull()
  })
  it('reuses GC claim tokens, failure backoff and confirmed deletion; metadata and quota remain until success',async()=>{
    const file=await upload();await age(file.stored);await expire()
    const before=Number((await db.query("SELECT chat.file_transfer_usage('upload','group',$1) AS n",[group])).rows[0].n)
    const first=await collect(file.blob)
    expect(first).toMatchObject({blob_id:file.blob,attempt_count:1})
    expect((await state(file.stored)).state).toBe('deleting')
    expect((await reject('SELECT chat.file_blob_gc_finish($1,$2)',[file.blob,randomUUID()])).message).toMatch(/lease .* is stale/)
    await db.query('SELECT chat.file_blob_gc_fail($1,$2,$3)',[file.blob,first.claim_token,'provider unavailable'])
    expect(Number((await db.query("SELECT chat.file_transfer_usage('upload','group',$1) AS n",[group])).rows[0].n)).toBe(before)
    expect(await collect(file.blob)).toBeUndefined()
    await db.query('UPDATE chat.file_blob_gc SET next_attempt_at=now() WHERE blob_id=$1',[file.blob])
    const second=await collect(file.blob);expect(second.attempt_count).toBe(2);expect(second.claim_token).not.toBe(first.claim_token)
    await db.query('SELECT chat.file_blob_gc_finish($1,$2)',[file.blob,second.claim_token])
    expect((await state(file.stored)).state).toBe('gone')
    expect((await db.query('SELECT id FROM chat.file_blobs WHERE id=$1',[file.blob])).rows).toEqual([{id:file.blob}])
    expect(Number((await db.query("SELECT chat.file_transfer_usage('upload','group',$1) AS n",[group])).rows[0].n)).toBe(before-60)
    expect((await download(file.message)).status).toBe('expired')
  })
  it.each([false,true])('ordinary fresh upload restores expired cards before/after physical deletion (%s), never an old receipt',async(remove)=>{
    const file=await upload();await age(file.stored);await expire()
    if(remove) {
      const claim=await collect(file.blob)
      await db.query('SELECT chat.file_blob_gc_finish($1,$2)',[file.blob,claim.claim_token])
    }
    await db.query('SELECT chat.file_managed_upload_registered($1,$2)',[file.key,owner])
    expect((await download(file.message)).status).toBe('expired')
    await service();expect((await state(file.stored)).state).toBe(remove?'gone':'ready')
    const replacement=await upload(60,file.sha)
    expect(replacement.blob).toBe(file.blob)
    expect(replacement.created).toBe(remove) // Collected identity invokes the existing post-copy race check.
    expect((await download(file.message)).status).toBe('ready')
    expect((await download(replacement.message)).status).toBe('ready')
    await service();expect((await state(file.stored)).expired_at).toBeNull()
  })
  it('a fresh same-SHA upload restores only its own group, not another expired group',async()=>{
    const file=await upload(),target=randomUUID()
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','other expired scope',$2)",[target,owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')",[target,owner])
    await user();const second=randomUUID()
    await db.query('SELECT * FROM chat.attachment_forward($1,$2,$3,$4)',[file.message,second,target,owner])
    await age(file.stored);await age(file.stored,31,null,target)
    expect(await expire()).toBe(2)
    await upload(60,file.sha)
    expect((await download(file.message)).status).toBe('ready')
    expect((await download(second,owner)).status).toBe('expired')
  })
  it('does not restore an old SHA when different bytes are reuploaded',async()=>{
    const file=await upload();await age(file.stored);await expire()
    const replacement=await upload()
    expect(replacement.blob).not.toBe(file.blob)
    expect((await download(file.message)).status).toBe('expired')
    expect((await download(replacement.message)).status).toBe('ready')
  })
  it('preserves the intended grants after replacing functions under the installation DDL guard',async()=>{
    const rules=[
      ['chat.file_transfer_download_as(jsonb,text,uuid)',true],
      ['chat.attachment_place_forward(text,text,text,text,boolean)',true],
      ['chat.file_managed_upload_registered(text,text,jsonb)',false],
      ['chat.file_blob_register(text,text,text,bigint,text,integer,integer)',false],
      ['chat.file_blob_gc_claim(integer,integer)',false],
      ['chat.file_blob_gc_finish(uuid,uuid)',false],
      ['chat.file_blob_in_use(uuid)',false],
      ['chat.file_blob_take(uuid)',false],
      ['chat.file_transfer_expire(integer)',false],
    ] as const
    expect((await db.query("SELECT to_regprocedure('chat.file_transfer_object_gone(text,text)') AS obsolete")).rows[0].obsolete).toBeNull()
    for(const [fn,allowed] of rules) {
      const r=(await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS anon,has_function_privilege('authenticated',$1,'EXECUTE') AS client",[fn])).rows[0]
      expect(r,fn).toEqual({anon:false,client:allowed})
    }
  })
  it('restricts expiry and private timestamps to service and administrator usage to the actual group admin',async()=>{
    const file=await upload();await user(member)
    expect((await reject('SELECT chat.file_transfer_expire()')).code).toBe('42501')
    expect((await reject('SELECT * FROM chat.file_transfer_storage_refs')).code).toBe('42501')
    expect((await reject('SELECT chat.file_transfer_group_usage($1,$2)',[group,member])).hint).toBe('file_transfer_denied')
    await user()
    expect((await db.query('SELECT chat.file_transfer_group_usage($1,$2) AS r',[group,owner])).rows[0].r).toEqual({used_and_reserved_bytes:120,limit_bytes:100000,warning:false,full:false})
    await service();await db.query("UPDATE chat.file_transfer_limits SET settings=settings||'{\"storage_group_bytes\":120}'")
    await user();expect((await db.query('SELECT chat.file_transfer_group_usage($1,$2) AS r',[group,owner])).rows[0].r).toMatchObject({warning:true,full:true})
  })
})
