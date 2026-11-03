import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let db: pg.Client
let owner: string, stranger: string, agent: string, device: string, dm: string, group: string, message: string, file: string
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Requires a disposable loopback database')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner,stranger,agent,device,dm,group,message,file] = Array.from({ length: 8 }, randomUUID)
  for (const id of [owner,stranger]) await db.query(`INSERT INTO auth.users(id,email) VALUES($1,$2)`, [id, `${id}@personal-dm.invalid`])
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Fixture','fixture','linux')", [device,owner])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,session_archived_at) VALUES($1,'agent','Archived fixture',$2,$3,'2026-11-02T08:41:00Z')", [agent,owner,device])
  for (const [id,kind] of [[dm,'dm'],[group,'group']]) {
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,$2,'Personal deletion fixture',$3)", [id,kind,owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [id,owner,agent])
  }
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,created_at) VALUES($1,$2,$3,'Retained historical sender','2026-11-01T03:48:01.246266Z')", [message,dm,agent])
  await db.query(`INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,inline_text,size_bytes,created_by)
    VALUES($1,$2,'document','retained.html','text/html','<h1>Retained version 1</h1>',27,$3)`, [file,dm,owner])
})
afterEach(async () => { await db.query('ROLLBACK') })

async function as<T>(user: string, action: () => Promise<T>) {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub:user,role:'authenticated' })])
  await db.query('SET LOCAL ROLE authenticated')
  try { return await action() } finally { await db.query('RESET ROLE').catch(() => undefined) }
}
async function reject(code: string, action: () => Promise<unknown>) {
  await db.query('SAVEPOINT denial')
  try { await expect(action()).rejects.toMatchObject({ message:code }) }
  finally { await db.query('ROLLBACK TO SAVEPOINT denial') }
}
const remove = (user = owner, chat = dm) => as(user, async () => (await db.query('SELECT chat.delete_my_dm_conversation($1) AS receipt',[chat])).rows[0].receipt)
const listed = (user = owner) => as(owner, async () => (await db.query('SELECT chat_id FROM chat.list_my_chats_as($1)',[user])).rows.map(row => row.chat_id))

it('durably deletes only the owner list record and preserves membership, identity, messages and file versions', async () => {
  const seats = (await db.query('SELECT * FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id',[dm])).rows
  const history = (await as(owner, () => db.query('SELECT * FROM chat.messages_view WHERE chat_id=$1',[dm]))).rows
  const identities = (await db.query('SELECT * FROM identity.users WHERE id=ANY($1)',[[owner,agent]])).rows
  const files = (await as(owner, () => db.query('SELECT * FROM chat.workspace_items WHERE id=$1',[file]))).rows
  const versions = (await as(owner, () => db.query('SELECT * FROM chat.workspace_item_versions WHERE item_id=$1',[file]))).rows
  expect(await listed()).toContain(dm)
  const receipt = await remove()
  expect(receipt).toMatchObject({ chat_id:dm,already:false,deleted_at:expect.any(String) })
  expect(await listed()).not.toContain(dm)
  expect(await listed()).toContain(group)
  const after = (await db.query('SELECT * FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id',[dm])).rows
  expect(after.map(row => ({...row,conversation_deleted_at:null}))).toEqual(seats)
  expect(after.find(row => row.user_id === agent).conversation_deleted_at).toBeNull()
  expect((await as(owner, () => db.query('SELECT * FROM chat.messages_view WHERE chat_id=$1',[dm]))).rows).toEqual(history)
  expect((await db.query('SELECT * FROM identity.users WHERE id=ANY($1)',[[owner,agent]])).rows).toEqual(identities)
  expect((await as(owner, () => db.query('SELECT * FROM chat.workspace_items WHERE id=$1',[file]))).rows).toEqual(files)
  expect((await as(owner, () => db.query('SELECT * FROM chat.workspace_item_versions WHERE item_id=$1',[file]))).rows).toEqual(versions)
  expect((await db.query('SELECT status FROM chat.chats WHERE id=$1',[dm])).rows[0].status).toBe('active')
})

it('replays the original deletion receipt without publishing a second revision', async () => {
  const first = await remove()
  await db.query('UPDATE identity.users SET session_archived_at=NULL WHERE id=$1',[agent])
  const revision = (await db.query('SELECT revision FROM chat.account_revision_heads WHERE user_id=$1',[owner])).rows
  expect(await remove()).toEqual({...first,already:true})
  expect((await db.query('SELECT revision FROM chat.account_revision_heads WHERE user_id=$1',[owner])).rows).toEqual(revision)
})

it('rejects an active agent with a specific reason and keeps the conversation listed', async () => {
  await db.query('UPDATE identity.users SET session_archived_at=NULL WHERE id=$1',[agent])
  await reject('conversation_agent_in_use', () => remove())
  expect(await listed()).toContain(dm)
})

it('rejects assistants independently of their name or archival state', async () => {
  const operation = randomUUID()
  await db.query("INSERT INTO identity.agent_provision_operations(id,owner_user_id,device_id,kind,payload_hash,blueprint,phase) VALUES($1,$2,$3,'single','fixture','{}','completed')",[operation,owner,device])
  await db.query(`INSERT INTO identity.agent_provisions(id,owner_user_id,operation_id,member_key,device_id,display_name,agent_type,inherit_memory,history_import_required,payload_hash,agent_user_id,provisioned_agent_user_id,dm_chat_id,phase)
    VALUES($1,$2,$3,'assistant',$4,'Renamed','codex',false,false,'fixture',$5::text,$5::uuid,$6,'completed')`,[randomUUID(),owner,operation,device,agent,dm])
  await reject('conversation_assistant_in_use', () => remove())
})

it('rejects another owner, agent callers, groups, human DMs and incomplete identities', async () => {
  await reject('conversation_dm_identity_unverified', () => remove(stranger))
  await reject('conversation_delete_owner_required', () => remove(agent))
  await reject('conversation_dm_identity_unverified', () => remove(owner,group))
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')",[dm,stranger])
  await reject('conversation_dm_identity_unverified', () => remove())
  expect((await db.query('SELECT conversation_deleted_at FROM chat.chat_members WHERE chat_id=$1',[dm])).rows.every(row => row.conversation_deleted_at === null)).toBe(true)
  await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2',[dm,agent])
  await reject('conversation_dm_identity_unverified', () => remove())
})

it('retains deletion access to an already removed historical agent identity', async () => {
  await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1',[agent])
  expect(await remove()).toMatchObject({ chat_id:dm,already:false })
  expect((await as(owner, () => db.query('SELECT sender_user_id FROM chat.messages_view WHERE id=$1',[message]))).rows).toEqual([{sender_user_id:agent}])
})

it.each(['restore','remove-owner'])('serializes deletion against a competing %s without a deadlock', async (operation) => {
  await db.query('COMMIT')
  const restoring = new pg.Client({connectionString:process.env.GUGU_INTEGRATION_DATABASE_URL})
  await restoring.connect()
  await restoring.query("SET statement_timeout='5s'")
  let outcome: Promise<unknown> | undefined
  try {
    await restoring.query('BEGIN')
    // Match lifecycle's complete globally ordered head set; locking only owner could manufacture an inverse order.
    await restoring.query('SELECT chat.lock_chat_revision_recipients($1,$2)',[dm,owner])
    await db.query('BEGIN')
    const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const blocker = (await restoring.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    outcome = remove().then(() => 'deleted', (error: Error) => error.message)
    const deadline = Date.now()+5000
    for (;;) {
      if ((await restoring.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS waiting',[pid,blocker])).rows[0].waiting) break
      if (Date.now()>deadline) throw new Error('Deletion did not reach the competing revision head')
      await new Promise(resolve => setTimeout(resolve,10))
    }
    await restoring.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,role:'authenticated'})])
    await restoring.query('SET LOCAL ROLE authenticated')
    if (operation === 'restore') await restoring.query('SELECT identity.set_agent_session_archival($1,$2,$3,1,NULL,$4)',
      [agent,device,randomUUID(),JSON.stringify([{id:randomUUID(),archived_at:'2026-11-02T08:41:00Z',restored_at:'2026-11-03T03:48:01Z'}])])
    else await restoring.query('SELECT identity.archive_user($1,true)',[owner])
    await restoring.query('COMMIT')
    expect(await outcome).toBe(operation === 'restore' ? 'conversation_agent_in_use' : 'conversation_delete_owner_required')
    await db.query('ROLLBACK')
    expect((await db.query('SELECT conversation_deleted_at FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2',[dm,owner])).rows[0].conversation_deleted_at).toBeNull()
  } finally {
    await restoring.query('ROLLBACK'); await outcome; await restoring.end(); await db.query('ROLLBACK')
    await db.query('DELETE FROM chat.chats WHERE id=ANY($1)',[[dm,group]])
    await db.query('DELETE FROM identity.users WHERE id=$1',[agent])
    await db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1',[device])
    await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[[owner,stranger]])
  }
})

it('keeps API roles from updating the personal deletion field or invoking the RPC anonymously', async () => {
  expect((await db.query("SELECT has_column_privilege('authenticated','chat.chat_members','conversation_deleted_at','UPDATE') AS allowed")).rows[0].allowed).toBe(false)
  for (const role of ['anon','service_role']) expect((await db.query('SELECT has_function_privilege($1,$2,$3) AS allowed',[role,'chat.delete_my_dm_conversation(text)','EXECUTE'])).rows[0].allowed).toBe(false)
})

// Execute the operational SQL inside the test transaction so the shared disposable fixture is restored afterwards.
it('rolls back list behavior with the original API grants and retains deletion state for forward recovery', async () => {
  await remove()
  await db.query('SAVEPOINT operational_rollback')
  const rollback = readFileSync(new URL('../../../ops/rollback-delete-my-archived-agent-dm.sql',import.meta.url),'utf8')
    .replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'')
  await db.query(rollback)
  expect(await listed()).toContain(dm)
  expect((await db.query("SELECT has_function_privilege('authenticated','chat.delete_my_dm_conversation(text)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false)
  for (const role of ['anon','service_role']) expect((await db.query('SELECT has_function_privilege($1,$2,$3) AS allowed',[role,'chat.list_my_chats_as(text)','EXECUTE'])).rows[0].allowed).toBe(false)
  expect((await db.query('SELECT conversation_deleted_at FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2',[dm,owner])).rows[0].conversation_deleted_at).not.toBeNull()
  await db.query('ROLLBACK TO SAVEPOINT operational_rollback')
  expect(await listed()).not.toContain(dm)
  expect(await remove()).toMatchObject({already:true})
})
