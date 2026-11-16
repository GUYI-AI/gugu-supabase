import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BEGIN_READING_REVISIONS } from '../../support/revisionTransaction'

// gugu (owner 11-15): a message is its text and its files' index. A declared commit sends the message before its bytes;
// readers see the attachment pending (never the message), the function's hash settles it or fails it, a restarted sender
// settles it under a new upload, whispers take the same path, and the upload-first commit of older clients is unchanged.
// A pending file reads, in the shape released clients know, as an object not found ('upload' carries its own state).
const PENDING = {status:'missing',code:'object_not_found',upload:'pending'}, FAILED = {status:'missing',code:'object_not_found',upload:'failed'}
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const settings = {
  inventory_ready:true, storage_global_bytes:100000, storage_account_bytes:100000, storage_group_bytes:100000,
  download_global_bytes:100000, download_account_bytes:100000, download_group_bytes:100000,
  upload_permit_seconds:120, sign_window_seconds:60, sign_account_count:100, sign_group_count:100, file_max_bytes:10000,
}
let db:pg.Client, sender:string, receiver:string, outsider:string, group:string
async function user(id=sender) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:id,role:'authenticated'})])
}
async function service() { await db.query('RESET ROLE') }
async function reject(sql:string,args:unknown[]=[]) {
  await db.query('SAVEPOINT denied')
  try { await db.query(sql,args) } catch(error) { await db.query('ROLLBACK TO SAVEPOINT denied'); return error as pg.DatabaseError }
  throw Error('Expected refusal: '+sql)
}
const sha = () => randomBytes(32).toString('hex')
async function permit(bytes=60) {
  await user()
  return (await db.query('SELECT chat.file_managed_upload_as($1,$2,$3,$4) AS r',[randomUUID(),group,sender,bytes])).rows[0].r.staging_key as string
}
/** The new client's send: an upload permit, its declaration and the message, before any byte. */
async function declaredSend(digest=sha(), bytes=60, whisper=false) {
  const key=await permit(bytes), message=randomUUID()
  await user()
  const blob=(await db.query('SELECT chat.attachment_declare($1,$2,$3,$4,$5,$6) AS id',[key,digest,bytes,'image/png',800,600])).rows[0].id as string
  const sent=(await db.query('SELECT * FROM chat.attachment_commit(p_staging_key=>$1,p_message_id=>$2,p_chat_id=>$3,p_sender_user_id=>$4,p_file_name=>$5,p_to_user_ids=>$6,p_is_whisper=>$7)',
    [key,message,group,sender,'photo.png',whisper?[receiver]:[],whisper])).rows[0]
  return {key,message,blob,digest,bytes,sent}
}
/** The attachments function after it hashed the bytes under `uploadKey` (as finish does). */
async function settle(pendingKey:string, digest:string, bytes=60, uploadKey=pendingKey) {
  await service()
  const r=(await db.query('SELECT chat.file_blob_settle($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r',[sender,pendingKey,uploadKey,digest,bytes,'image/png',4,3,null])).rows[0].r
  if (r.status==='ready') await db.query('SELECT chat.file_managed_upload_registered($1,$2)',[uploadKey,sender])
  return r
}
async function resolve(message:string, actor=receiver) {
  await user(actor)
  return (await db.query('SELECT chat.file_resolve_as($1,$2) AS r',[{message_id:message},actor])).rows[0].r
}
async function download(message:string, actor=receiver) {
  await user(actor)
  return (await db.query('SELECT chat.file_transfer_download_as($1,$2,$3) AS r',[{message_id:message},actor,randomUUID()])).rows[0].r
}
beforeAll(async()=>{
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw Error('Attachment contracts require an isolated loopback database')
  db=new pg.Client({connectionString:url});await db.connect()
})
afterAll(async()=>{await db?.end()})
beforeEach(async()=>{
  await db.query(BEGIN_READING_REVISIONS)
  sender=randomUUID();receiver=randomUUID();outsider=randomUUID();group=randomUUID()
  for (const id of [sender,receiver,outsider]) await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())",[id,id+'@pending.invalid'])
  for (const id of [sender,receiver,outsider]) await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human',$1) ON CONFLICT (id) DO NOTHING",[id])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','bytes after message',$2)",[group,sender])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[group,sender,receiver])
  const usage=async(kind:string)=>Number((await db.query("SELECT chat.file_transfer_usage($1,'global','*') AS n",[kind])).rows[0].n)
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings",
    [{...settings,storage_global_bytes:await usage('upload')+settings.storage_global_bytes,download_global_bytes:await usage('download')+settings.download_global_bytes}])
})
afterEach(async()=>{await db.query('ROLLBACK')})

describe('the message is there before its bytes', ()=>{
  it('the receiver has the message with its attachment pending (name, size, type); nothing signs it yet', async()=>{
    const send=await declaredSend()
    expect(send.sent).toMatchObject({id:send.message,chat_id:group,content_type:'attachment'})
    await user(receiver)
    const row=(await db.query('SELECT seq,file_metadata FROM chat.messages_view WHERE id=$1',[send.message])).rows[0]
    expect(Number(row.seq)).toBeGreaterThan(0)
    expect(row.file_metadata, 'its place is drawn at its size').toMatchObject({...PENDING,size_bytes:60,content_type:'image/png',width:800,height:600,file_name:'photo.png',message_id:send.message})
    expect(await resolve(send.message)).toMatchObject(PENDING)
    expect(await download(send.message)).toMatchObject(PENDING)
    await user(receiver)
    expect((await db.query('SELECT * FROM chat.file_urls_as($1,$2)',[JSON.stringify([{message_id:send.message}]),receiver])).rows).toEqual([])
    expect((await resolve(send.message,outsider)).status).toBe('gone')
    await service()
    expect((await db.query("SELECT count(*)::int AS n FROM chat.file_transfer_storage WHERE blob_id=$1",[send.blob])).rows[0].n, 'not in the storage ledger').toBe(0)
  })
  it('bytes that match settle it: every reader gets the file, the message points at the live blob, the pending row is gone', async()=>{
    const send=await declaredSend()
    const settled=await settle(send.key,send.digest)
    expect(settled).toMatchObject({status:'ready',created:true})
    expect(await resolve(send.message)).toMatchObject({status:'ready',sha256:send.digest,size_bytes:60})
    expect((await download(send.message)).status).toBe('ready')
    await service()
    expect((await db.query('SELECT file_blob_id FROM chat.messages WHERE id=$1',[send.message])).rows[0].file_blob_id ?? null).not.toBe(send.blob)
    expect((await db.query('SELECT count(*)::int AS n FROM chat.file_blobs WHERE id=$1',[send.blob])).rows[0].n).toBe(0)
    expect((await db.query("SELECT count(*)::int AS n FROM chat.file_transfer_storage WHERE blob_id=$1",[settled.blob_id])).rows[0].n, 'in the ledger once settled').toBe(1)
    expect(await settle(send.key,send.digest), 'finishing again answers the same').toMatchObject({status:'ready',blob_id:settled.blob_id})
  })
  it('a whisper takes the same path: pending for its recipient, settled the same way', async()=>{
    const send=await declaredSend(sha(),60,true)
    expect(send.sent).toMatchObject({is_whisper:true})
    expect(await resolve(send.message)).toMatchObject(PENDING)
    await settle(send.key,send.digest)
    expect(await resolve(send.message)).toMatchObject({status:'ready',sha256:send.digest})
  })
  it('bytes that are not the declared file fail the attachment, not the message', async()=>{
    const send=await declaredSend()
    expect(await settle(send.key,sha())).toMatchObject({status:'failed'})
    expect(await resolve(send.message)).toMatchObject(FAILED)
    await user(receiver)
    expect((await db.query('SELECT seq,retracted_at FROM chat.messages_view WHERE id=$1',[send.message])).rows[0]).toMatchObject({retracted_at:null})
  })
  it('a sender that went offline settles it later under a new upload; a pending row past its deadline reads failed until then', async()=>{
    const send=await declaredSend()
    await service()
    await db.query("UPDATE chat.file_blobs SET created_at=now()-interval '25 hours' WHERE id=$1",[send.blob])
    expect(await resolve(send.message), 'the receiver is not left waiting forever').toMatchObject(FAILED)
    const again=await permit()
    expect(await settle(send.key,send.digest,60,again)).toMatchObject({status:'ready'})
    expect(await resolve(send.message)).toMatchObject({status:'ready',sha256:send.digest})
  })
  it('a restarted sender finds its own declarations still waiting for bytes, and only those', async()=>{
    const send=await declaredSend(), refused=await declaredSend(), whisper=await declaredSend(sha(),60,true)
    expect(await settle(refused.key,sha())).toMatchObject({status:'failed'})
    await user()
    const mine=(await db.query('SELECT chat.attachment_pending_mine() AS r')).rows[0].r
    // Its name too: finish classifies the bytes by it (a text file is a document), and a restart has nothing else to go by.
    // A set, not a sequence: the function orders by blob creation time, which is the same instant for every blob made in
    // this test's one transaction.
    expect(mine).toHaveLength(2)
    expect(mine).toEqual(expect.arrayContaining([
      expect.objectContaining({staging_key:send.key,message_id:send.message,chat_id:group,as:sender,sha256:send.digest,size_bytes:60,file_name:'photo.png'}),
      expect.objectContaining({staging_key:whisper.key,message_id:whisper.message,file_name:'photo.png'})]))
    expect(await settle(whisper.key,whisper.digest)).toMatchObject({status:'ready'})
    await user(receiver)
    expect((await db.query('SELECT chat.attachment_pending_mine() AS r')).rows[0].r).toEqual([])
    expect(await settle(send.key,send.digest)).toMatchObject({status:'ready'})
    await user()
    expect((await db.query('SELECT chat.attachment_pending_mine() AS r')).rows[0].r).toEqual([])
  })
  it('content already stored is reused: the attachment joins the existing blob', async()=>{
    const first=await declaredSend(), second=await declaredSend(first.digest)
    const one=await settle(first.key,first.digest), two=await settle(second.key,second.digest)
    expect(two).toMatchObject({status:'ready',blob_id:one.blob_id,created:false})
    expect(await resolve(second.message)).toMatchObject({status:'ready',sha256:first.digest})
  })
  it('only the uploader declares its own upload, within its reservation; a different declaration for the same key is refused', async()=>{
    const key=await permit(60)
    await user(receiver)
    expect((await reject('SELECT chat.attachment_declare($1,$2,$3,$4)',[key,sha(),60,'image/png'])).hint).toBe('attachment_upload_not_found')
    await user()
    expect((await reject('SELECT chat.attachment_declare($1,$2,$3,$4)',[key,sha(),61,'image/png'])).hint).toBe('file_transfer_too_large')
    const digest=sha()
    const id=(await db.query('SELECT chat.attachment_declare($1,$2,$3,$4) AS id',[key,digest,60,'image/png'])).rows[0].id
    expect((await db.query('SELECT chat.attachment_declare($1,$2,$3,$4) AS id',[key,digest,60,'image/png'])).rows[0].id).toBe(id)
    expect((await reject('SELECT chat.attachment_declare($1,$2,$3,$4)',[key,sha(),60,'image/png'])).hint).toBe('file_transfer_conflict')
    expect((await reject('SELECT chat.file_blob_settle($1,$2,$3,$4,$5,$6,$7,$8,$9)',[sender,key,key,digest,60,'image/png',null,null,null])).code, 'settling is the function\'s alone').toBe('42501')
  })
  it('an older client\'s upload-first commit is unchanged', async()=>{
    const key=await permit(), digest=sha()
    await service()
    await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)',[sender,key,digest,60,'image/png'])
    await db.query('SELECT chat.file_managed_upload_registered($1,$2)',[key,sender])
    await user()
    const message=randomUUID()
    await db.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5)',[key,message,group,sender,'old.png'])
    expect(await resolve(message)).toMatchObject({status:'ready',sha256:digest})
  })
  it('every bucket in use stays allowed, with pending added', async()=>{
    await service()
    const def=(await db.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid='chat.file_blobs'::regclass AND conname='file_blobs_bucket_id_check'")).rows[0].d as string
    for (const bucket of ['oss','temporary','workspace','avatars','chat-media','attachments','feedback-screenshots','pending']) expect(def).toContain(`'${bucket}'`)
  })
  it('settling or failing tells every reader of the message, so nobody polls for the bytes', async()=>{
    const revisions=async(id:string,message:string)=>{ await service()
      return Number((await db.query("SELECT count(*) AS n FROM chat.account_revisions WHERE user_id=$1 AND event='message_file_changed' AND resource_key->>'entity_id'=$2",[id,message])).rows[0].n) }
    const ok=await declaredSend(), bad=await declaredSend()
    expect(await revisions(receiver,ok.message)).toBe(0)
    await settle(ok.key,ok.digest); await settle(bad.key,sha())
    for (const id of [sender,receiver]) {
      expect(await revisions(id,ok.message)).toBe(1)
      expect(await revisions(id,bad.message)).toBe(1)
    }
  })
  it('a whisper\'s file change is told only to those who can see the whisper', async()=>{
    await service()
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')",[group,outsider])
    const send=await declaredSend(sha(),60,true)
    await settle(send.key,send.digest)
    await service()
    const n=async(id:string)=>Number((await db.query("SELECT count(*) AS n FROM chat.account_revisions WHERE user_id=$1 AND event='message_file_changed'",[id])).rows[0].n)
    expect(await n(receiver)).toBe(1)
    expect(await n(outsider)).toBe(0)
  })
})
