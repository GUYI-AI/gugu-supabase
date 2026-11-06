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

it.each(['group','dm','topic','agent'])('hides a %s only for its ordinary member without changing history or lifecycle',async kind=>{
  const chat={group,dm,topic,agent:agentDm}[kind]!
  const before=await state(chat)
  const identities=(await db.query('SELECT * FROM identity.users WHERE id=ANY($1)',[[owner,reader,agent]])).rows
  const receipt=await hide(chat)
  expect(receipt).toMatchObject({chat_id:chat,hidden_at:expect.any(String),account_revision:expect.stringMatching(/^\d+$/)})
  expect(await listed()).not.toContain(chat)
  expect((await state(chat)).conversation_deleted_at).toBeNull()
  expect((await state(chat)).last_read_seq).toEqual(before.last_read_seq)
  expect((await db.query('SELECT * FROM identity.users WHERE id=ANY($1)',[[owner,reader,agent]])).rows).toEqual(identities)
  expect((await db.query('SELECT count(*)::int n FROM chat.chat_members WHERE chat_id=$1',[chat])).rows[0].n).toBe(2)
  expect((await db.query('SELECT status FROM chat.chats WHERE id=$1',[chat])).rows[0].status).toBe('active')
  expect((await snapshot()).chats.map((row:{id:string})=>row.id)).toContain(chat)
})

it('replays the same hide operation without hiding a row restored by a newer message',async()=>{
  const operation=randomUUID(), receipt=await hide(group,operation)
  await send()
  expect((await state()).conversation_hidden_at).toBeNull()
  expect(await hide(group,operation)).toEqual(receipt)
  expect((await state()).conversation_hidden_at).toBeNull()
  await hide(group,randomUUID())
  expect((await state()).conversation_hidden_at).not.toBeNull()
  await denied(()=>hide(dm,operation),'23505')
})

it('retains searchable history, read cursors and mute, and projects restoration through account revisions',async()=>{
  await send()
  await db.query("UPDATE chat.chat_members SET notification_level='none' WHERE chat_id=$1 AND user_id=$2",[group,owner])
  const before=await snapshot(), read=(await state()).last_read_seq
  await hide()
  expect(await as(owner,'SELECT * FROM chat.list_unread_locators($1)',[group])).toEqual([])
  expect((await as(owner,'SELECT * FROM chat.messages_view WHERE chat_id=$1',[group])).length).toBeGreaterThan(0)
  const cold=await snapshot()
  expect(cold.memberships.find((row:{chat_id:string,user_id:string})=>row.chat_id===group&&row.user_id===owner).conversation_hidden_at).not.toBeNull()
  await send()
  expect((await state()).conversation_hidden_at).toBeNull()
  expect((await state()).last_read_seq).toBe(read)
  expect((await state()).notification_level).toBe('none')
  const delta=(await as(owner,'SELECT chat.sync_since($1,500) AS value',[before.revision]))[0].value
  expect(delta.operations.filter((op:{event:string,payload:{kind?:string,chat_id:string}})=>op.event==='chat_members_changed'&&op.payload.kind==='own'&&op.payload.chat_id===group)).toHaveLength(2)
  expect(await listed()).toContain(group)
})

it('restores self-sent and visible persisted system messages',async()=>{
  for(const sender of [owner,null]) {
    await hide(); await send(group,sender)
    expect((await state()).conversation_hidden_at).toBeNull()
  }
})

it('does not restore for invisible whispers, imports, edits, read changes or deduplicated inserts',async()=>{
  const third=randomUUID()
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[third,third+'@list-hiding.invalid'])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')",[group,third])
  const existing=await send()
  await hide()
  await send(group,reader,{whisper:true,to:[third]})
  await send(group,reader,{client:'session-import-turn:'+randomUUID()})
  await send(group,reader,{id:existing})
  await db.query("UPDATE chat.messages SET content='edited' WHERE id=$1",[existing])
  await db.query('UPDATE chat.chat_members SET last_read_seq=1 WHERE chat_id=$1 AND user_id=$2',[group,owner])
  expect((await state()).conversation_hidden_at).not.toBeNull()
  await send(group,reader,{whisper:true,to:[owner]})
  expect((await state()).conversation_hidden_at).toBeNull()
})

it('excludes hidden topic contributions and source descendants, then restores both on visible activity',async()=>{
  await send(topic)
  await hide(topic)
  expect(await as(owner,'SELECT * FROM chat.list_unread_locators($1)',[topic])).toEqual([])
  await send(topic)
  expect((await state(topic)).conversation_hidden_at).toBeNull()
  await hide(group)
  expect(await listed()).not.toContain(topic)
  expect(await as(owner,'SELECT * FROM chat.list_unread_locators($1)',[topic])).toEqual([])
  await send(topic)
  expect((await state(topic)).conversation_hidden_at).toBeNull()
  expect((await state(group)).conversation_hidden_at).toBeNull()
  expect(await listed()).toEqual(expect.arrayContaining([group,topic]))
})

it('does not restore for messages below the reader history floor',async()=>{
  await db.query("UPDATE chat.chat_members SET hide_history_before=clock_timestamp()+interval '1 day' WHERE chat_id=$1 AND user_id=$2",[group,owner])
  await hide();await send()
  expect((await state()).conversation_hidden_at).not.toBeNull()
})

it('restores the source for a source member who can read a topic without participating',async()=>{
  await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2',[topic,owner])
  await hide(group);await send(topic)
  expect((await state(group)).conversation_hidden_at).toBeNull()
  expect((await db.query('SELECT 1 FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2',[topic,owner])).rows).toEqual([])
})

it('projects a removed historical Agent peer without making it an active member',async()=>{
  await db.query('UPDATE identity.users SET removed_at=clock_timestamp() WHERE id=$1',[agent])
  expect((await snapshot()).memberships).toContainEqual(expect.objectContaining({chat_id:agentDm,user_id:agent,historical_only:true}))
  expect(await as(owner,'SELECT user_id FROM chat.active_members WHERE chat_id=$1',[agentDm])).toEqual([{user_id:owner}])
  expect(await as(owner,'SELECT user_id,historical_only FROM chat.list_conversation_memberships($1) WHERE user_id=$2',[[agentDm],agent])).toEqual([{user_id:agent,historical_only:true}])
  expect(await as(reader,'SELECT * FROM chat.list_conversation_memberships($1)',[[agentDm]])).toEqual([])
})

it('preserves old permanent tombstones and maps future legacy calls to temporary hiding',async()=>{
  await db.query('UPDATE chat.chat_members SET conversation_deleted_at=clock_timestamp() WHERE chat_id=$1 AND user_id=$2',[dm,owner])
  const permanent=(await state(dm)).conversation_deleted_at
  await send(dm)
  expect(await listed()).not.toContain(dm)
  expect((await state(dm)).conversation_deleted_at).toEqual(permanent)
  await denied(()=>hide(dm),'55000')
  const receipt=(await as(owner,'SELECT chat.delete_my_dm_conversation($1) receipt',[agentDm]))[0].receipt
  expect(receipt.deleted_at).toBe(receipt.hidden_at)
  expect((await state(agentDm)).conversation_deleted_at).toBeNull()
})

it('rejects other-person writes and leaves the new API field, internal tables and helper ACLs closed',async()=>{
  await denied(()=>hide(agentDm,randomUUID(),reader),'42501')
  for(const fn of ['chat.hide_my_conversation(text,uuid)','chat.publish_native_conversation_message(text,text,text,text,text,timestamptz)']) {
    for(const role of ['anon','service_role']) expect((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[role,fn])).rows[0].allowed).toBe(false)
  }
  for (const role of ['anon','authenticated','service_role']) {
    for (const table of ['conversation_list_state','conversation_hide_operations','native_conversation_publications']) {
      for (const privilege of ['SELECT','INSERT','UPDATE','DELETE']) {
        expect((await db.query('SELECT has_table_privilege($1,$2,$3) allowed',[role,'chat.'+table,privilege])).rows[0].allowed).toBe(false)
      }
      expect((await db.query('SELECT relrowsecurity enabled FROM pg_class WHERE oid=$1::regclass',['chat.'+table])).rows[0].enabled).toBe(true)
    }
  }
  await denied(()=>as(owner,'SELECT * FROM chat.conversation_list_state'),'42501')
  expect((await db.query("SELECT has_table_privilege('authenticated','chat.native_conversation_publications','SELECT') allowed")).rows[0].allowed).toBe(false)
  expect((await db.query("SELECT pg_get_userbyid(proowner) owner FROM pg_proc WHERE oid='chat.hide_my_conversation(text,uuid)'::regprocedure")).rows[0].owner).toBe('postgres')
})

it('deduplicates native publications and orders delayed first delivery after hiding without copying message bodies',async()=>{
  const session=randomUUID(),id=randomUUID(),at='2026-01-01T00:00:00Z'
  const publish=(message=id,user=owner,dev=device)=>as(user,'SELECT chat.publish_native_conversation_message($1,$2,$3,$4,$5,$6) receipt',[dev,agent,session,message,agentDm,at])
  await hide(agentDm)
  expect((await publish())[0].receipt.already).toBe(false)
  expect((await state(agentDm)).conversation_hidden_at).toBeNull()
  await hide(agentDm)
  expect((await publish())[0].receipt.already).toBe(true)
  expect((await state(agentDm)).conversation_hidden_at).not.toBeNull()
  await publish(randomUUID())
  expect((await state(agentDm)).conversation_hidden_at).toBeNull()
  await denied(()=>publish(randomUUID(),reader),'42501')
  await denied(()=>publish(randomUUID(),owner,randomUUID()),'42501')
  await denied(()=>as(owner,'SELECT chat.publish_native_conversation_message($1,$2,$3,$4,$5,$6)',[device,agent,session,id,agentDm,'2026-01-02T00:00:00Z']),'23505')
  expect((await db.query('SELECT count(*)::int n FROM chat.messages WHERE chat_id=$1',[agentDm])).rows[0].n).toBe(0)
})

it('does not block privacy erasure with private list-state or native publication foreign keys',async()=>{
  await hide(group)
  await as(owner,'SELECT chat.publish_native_conversation_message($1,$2,$3,$4,$5,$6)',[device,agent,randomUUID(),randomUUID(),agentDm,'2026-01-01T00:00:00Z'])
  await hide(agentDm)
  await db.query('DELETE FROM auth.users WHERE id=$1',[owner])
  expect((await db.query('SELECT count(*)::int n FROM chat.conversation_list_state WHERE user_id=$1',[owner])).rows[0].n).toBe(0)
  expect((await db.query('SELECT count(*)::int n FROM chat.conversation_hide_operations WHERE user_id=$1',[owner])).rows[0].n).toBe(0)
  expect((await db.query('SELECT count(*)::int n FROM chat.native_conversation_publications WHERE agent_user_id=$1',[agent])).rows[0].n).toBe(0)
})
