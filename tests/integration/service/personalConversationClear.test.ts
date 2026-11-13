import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let db: pg.Client
let owner: string, reader: string, device: string, agent: string, group: string, dm: string, agentDm: string, topic: string, anchor: string
beforeAll(async () => {
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw Error('Requires disposable loopback database')
  db = new pg.Client({ connectionString:url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner,reader,device,agent,group,dm,agentDm,topic,anchor] = Array.from({length:9},randomUUID)
  for (const id of [owner,reader]) await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[id,id+'@list-hiding.invalid'])
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Fixture','fixture','linux')",[device,owner])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Fixture',$2,$3)",[agent,owner,device])
  for (const [id,kind,peer] of [[group,'group',reader],[dm,'dm',reader],[agentDm,'dm',agent]]) {
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,$2,'Fixture',$3)",[id,kind,reader])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[id,peer,owner])
  }
  await db.query("UPDATE chat.chat_members SET inbox_published_at=clock_timestamp() WHERE chat_id=ANY($1)",[[dm,agentDm]])
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'anchor')",[anchor,group,reader])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id) VALUES($1,'topic','Topic',$2,$3,$4)",[topic,reader,group,anchor])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[topic,reader,owner])
})
afterEach(async () => { await db.query('ROLLBACK') })
async function as(user: string, sql: string, values: unknown[] = []) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',json_build_object('sub',$1::text,'role','authenticated')::text,true)",[user])
  try { return (await db.query(sql,values)).rows } finally { await db.query('RESET ROLE').catch(()=>undefined) }
}
const hide = async (chat=group, operation=randomUUID(), user=owner) => (await as(user,'SELECT chat.hide_my_conversation($1,$2) AS receipt',[chat,operation]))[0].receipt
const listed = async (user=owner) => (await as(user,'SELECT chat_id FROM chat.list_my_chats_as($1)',[user])).map(row=>row.chat_id)
const state = async (chat=group,user=owner) => (await db.query('SELECT state.conversation_hidden_at,m.conversation_deleted_at,m.last_read_seq,m.notification_level FROM chat.chat_members m LEFT JOIN chat.conversation_list_state state USING(chat_id,user_id) WHERE m.chat_id=$1 AND m.user_id=$2',[chat,user])).rows[0]
const snapshot = async () => (await as(owner,'SELECT chat.sync_snapshot() AS value'))[0].value
const send = async (chat=group,sender: string|null=reader, extra: { whisper?: boolean; to?: string[]; client?: string; id?: string }={}) => {
  const id=extra.id??randomUUID()
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,is_whisper,to_user_ids,client_message_id) VALUES($1,$2,$3,'new',$4,$5,$6) ON CONFLICT(id) DO NOTHING",[id,chat,sender,!!extra.whisper,extra.to??null,extra.client??null])
  return id
}
async function denied(action:()=>Promise<unknown>,code:string) {
  await db.query('SAVEPOINT denied')
  try { await expect(action()).rejects.toMatchObject({code}) } finally { await db.query('ROLLBACK TO SAVEPOINT denied') }
}

const clear = async (chat=group, operation=randomUUID(), user=owner) => (await as(user,'SELECT chat.delete_my_conversation($1,$2) AS receipt',[chat,operation]))[0].receipt
const messages = async (chat=group,user=owner) => (await as(user,'SELECT id FROM chat.messages_view WHERE chat_id=$1 ORDER BY seq',[chat])).map(row=>row.id)
const say = async (chat=group,sender=reader) => {
  const id=randomUUID()
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,created_at) VALUES($1,$2,$3,'visible record',clock_timestamp())",[id,chat,sender])
  return id
}
it('retains searchable hidden history but clears only the deleting account and keeps future messages',async()=>{
  const old=await say(dm)
  await hide(dm)
  expect(await messages(dm)).toEqual([old])
  const seats=(await db.query('SELECT * FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id',[dm])).rows
  const receipt=await clear(dm)
  expect(receipt).toMatchObject({chat_id:dm,cleared_at:expect.any(String),account_revision:expect.any(String)})
  expect(await messages(dm)).toEqual([])
  expect(await messages(dm,reader)).toEqual([old])
  expect((await db.query('SELECT * FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id',[dm])).rows).toEqual(seats)
  const newer=await say(dm)
  expect(await messages(dm)).toEqual([newer])
  expect(await messages(dm,reader)).toEqual([old,newer])
  expect(await listed()).toContain(dm)
  expect((await as(owner,'SELECT id FROM chat.message_history_as($1)',[dm])).map(row=>row.id)).toEqual([newer])
})
it('applies a group deletion to its topic history without changing another member',async()=>{
  const old=await say(topic)
  await clear(group)
  expect(await messages(group)).toEqual([])
  expect(await messages(topic)).toEqual([])
  expect(await messages(topic,reader)).toContain(old)
  const next=await say(topic)
  expect(await messages(topic)).toEqual([next])
})
it('clears a topic without clearing the source conversation',async()=>{
  await say(topic)
  await clear(topic)
  expect(await messages(topic)).toEqual([])
  expect(await messages(group)).toContain(anchor)
})
it('replays an old delete receipt without clearing new messages or undoing a newer hide',async()=>{
  await say(dm)
  const operation=randomUUID(),receipt=await clear(dm,operation)
  const next=await say(dm)
  await hide(dm)
  const hidden=await state(dm)
  expect(await clear(dm,operation)).toEqual(receipt)
  expect(await state(dm)).toEqual(hidden)
  expect(await messages(dm)).toEqual([next])
})
it('does not restore a deleted native conversation from late pre-delete publication or an acknowledged replay',async()=>{
  const old=new Date(Date.now()-60_000).toISOString()
  await clear(agentDm)
  const session=randomUUID(),message=randomUUID()
  const publish=async(id:string,at:string)=>(await as(owner,'SELECT chat.publish_native_conversation_message($1,$2,$3,$4,$5,$6) AS receipt',[device,agent,session,id,agentDm,at]))[0].receipt
  await publish(message,old)
  expect((await state(agentDm)).conversation_hidden_at).not.toBeNull()
  await publish(randomUUID(),new Date(Date.now()+1000).toISOString())
  expect((await state(agentDm)).conversation_hidden_at).toBeNull()
  await hide(agentDm)
  expect((await publish(message,old)).already).toBe(true)
  expect((await state(agentDm)).conversation_hidden_at).not.toBeNull()
})
it('exposes clear state only in the caller projection and keeps private tables closed',async()=>{
  await clear(dm)
  const own=(await as(owner,'SELECT * FROM chat.list_conversation_memberships($1)',[[dm]]))
  expect(own.find(row=>row.user_id===owner)?.conversation_cleared_at).toBeTruthy()
  expect(own.find(row=>row.user_id===reader)?.conversation_cleared_at).toBeNull()
  const peer=await as(reader,'SELECT * FROM chat.list_conversation_memberships($1)',[[dm]])
  expect(peer.every(row=>row.conversation_cleared_at===null)).toBe(true)
  expect((await snapshot()).memberships.find((row:{chat_id:string,user_id:string})=>row.chat_id===dm&&row.user_id===owner).conversation_cleared_at).toBeTruthy()
  for(const role of ['anon','authenticated','service_role']) {
    expect((await db.query("SELECT has_table_privilege($1,'chat.conversation_clear_operations','SELECT') AS allowed",[role])).rows[0].allowed).toBe(false)
    expect((await db.query("SELECT has_function_privilege($1,'chat.conversation_memberships_before_clear(text[])','EXECUTE') AS allowed",[role])).rows[0].allowed).toBe(false)
  }
})

it.each(['native-first','im-first'])('does not restore across a later hide when the same notification arrives %s',async order=>{
  const session=randomUUID(),message=randomUUID(),at=new Date().toISOString()
  const native=()=>as(owner,'SELECT chat.publish_native_conversation_message($1,$2,$3,$4,$5,$6)',[device,agent,session,message,agentDm,at])
  const im=()=>db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,created_at) VALUES($1,$2,$3,'owner notice',clock_timestamp())",[message,agentDm,agent])
  await (order==='native-first'?native():im())
  await hide(agentDm)
  const before=await state(agentDm)
  await (order==='native-first'?im():native())
  expect(await state(agentDm)).toEqual(before)
  const next=await say(agentDm,agent)
  expect(next).not.toBe(message)
  expect((await state(agentDm)).conversation_hidden_at).toBeNull()
})
