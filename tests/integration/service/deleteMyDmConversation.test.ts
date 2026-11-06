import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll,afterEach,beforeAll,beforeEach,expect,it } from 'vitest'

let db:pg.Client,owner:string,peer:string,dm:string
beforeAll(async()=>{
  const url=new URL(process.env.GUGU_INTEGRATION_DATABASE_URL??'')
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw Error('Requires disposable loopback database')
  db=new pg.Client({connectionString:url.href});await db.connect()
})
afterAll(async()=>{await db?.end()})
beforeEach(async()=>{
  await db.query('BEGIN');[owner,peer,dm]=Array.from({length:3},randomUUID)
  for(const id of [owner,peer]) await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[id,id+'@legacy-hide.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,creator_user_id) VALUES($1,'dm',$2)",[dm,owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role,inbox_published_at) VALUES($1,$2,'owner',now()),($1,$3,'member',now())",[dm,owner,peer])
})
afterEach(async()=>{await db.query('ROLLBACK')})
async function remove(){
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[owner])
  try{return(await db.query('SELECT chat.delete_my_dm_conversation($1) receipt',[dm])).rows[0].receipt}
  finally{await db.query('RESET ROLE')}
}
it('keeps the legacy receipt shape while future calls use reversible list maintenance',async()=>{
  const receipt=await remove()
  expect(receipt).toMatchObject({chat_id:dm,deleted_at:expect.any(String),hidden_at:expect.any(String),already:false})
  expect(receipt.deleted_at).toBe(receipt.hidden_at)
  expect((await db.query('SELECT conversation_deleted_at FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2',[dm,owner])).rows[0].conversation_deleted_at).toBeNull()
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'returns')",[randomUUID(),dm,peer])
  expect((await db.query('SELECT state.conversation_hidden_at FROM chat.chat_members m LEFT JOIN chat.conversation_list_state state USING(chat_id,user_id) WHERE m.chat_id=$1 AND m.user_id=$2',[dm,owner])).rows[0].conversation_hidden_at).toBeNull()
})
it('replays historical permanent deletion without converting or restoring it',async()=>{
  await db.query('UPDATE chat.chat_members SET conversation_deleted_at=$1 WHERE chat_id=$2 AND user_id=$3',['2026-11-01T00:00:00Z',dm,owner])
  const receipt=await remove()
  expect(receipt).toMatchObject({chat_id:dm,already:true})
  expect(new Date(receipt.deleted_at).toISOString()).toBe('2026-11-01T00:00:00.000Z')
  expect((await db.query('SELECT state.conversation_hidden_at FROM chat.chat_members m LEFT JOIN chat.conversation_list_state state USING(chat_id,user_id) WHERE m.chat_id=$1 AND m.user_id=$2',[dm,owner])).rows[0].conversation_hidden_at).toBeNull()
})
it('keeps its anonymous and service-role execution ACL closed',async()=>{
  for(const role of ['anon','service_role'])expect((await db.query("SELECT has_function_privilege($1,'chat.delete_my_dm_conversation(text)','EXECUTE') allowed",[role])).rows[0].allowed).toBe(false)
})
