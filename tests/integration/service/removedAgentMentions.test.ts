import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// GUYI-AI/gugu#2383: mentioning an agent whose social identity was removed must not reject
// the whole message. The message reaches the others; the removed former member gets a
// terminal refusal and is never woken. Ids that were never members here are still rejected.
let db: Client
let owner: string, peer: string, agent: string, stranger: string, device: string, group: string, other: string, topic: string
async function admin() { await db.query('RESET ROLE') }
async function user(id = owner) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function send(chat: string, to: string[] | null, extra: { whisper?: boolean, sender?: string } = {}) {
  const id = randomUUID()
  await user(extra.sender ?? owner)
  await db.query('INSERT INTO chat.messages(id,chat_id,sender_user_id,content,to_user_ids,is_whisper) VALUES($1,$2,$3,$4,$5,$6)',
    [id, chat, extra.sender ?? owner, 'hello @agent', to, extra.whisper ?? false])
  await admin()
  return id
}
async function refused(chat: string, to: string[], extra: { whisper?: boolean, sender?: string } = {}) {
  await db.query('SAVEPOINT refusal')
  try { await send(chat, to, extra) } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT refusal'); await admin()
    return error as Error & { code: string, hint?: string, detail?: string }
  }
  throw new Error('Expected the message to be rejected')
}
async function removeIdentity(id: string) {
  await user()
  await db.query('SELECT identity.archive_user($1,true)', [id])
  await admin()
}
async function outcome(message: string, recipient: string) {
  return (await db.query(`SELECT
      (SELECT array_agg(reason) FROM chat.message_agent_delivery_blocks WHERE message_id=$1 AND agent_user_id=$2) AS blocks,
      EXISTS(SELECT 1 FROM chat.message_agent_wakes WHERE message_id=$1 AND agent_user_id=$2) AS woken,
      EXISTS(SELECT 1 FROM identity.gugu_device_commands WHERE payload->>'message_id'=$1 AND payload->>'agent_user_id'=$2) AS delivered`,
  [message, recipient])).rows[0]
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Removed agent mention contracts require the disposable loopback database')
  }
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, peer, agent, stranger, device, group, other, topic] = Array.from({ length: 8 }, randomUUID)
  for (const id of [owner, peer]) await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,now(),now())`, [id, `${id}@removed-mention.invalid`])
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'removed mention fixture','fixture','linux')`, [device, owner])
  for (const id of [agent, stranger]) await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,desired_status)
    VALUES($1,'agent','Removed mention fixture',$2,$3,'online')`, [id, owner, device])
  for (const id of [group, other]) {
    await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Removed mention fixture',$2)`, [id, owner])
    await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`, [id, owner, peer])
  }
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')`, [group, agent])
  // The stranger agent only ever sat in the other group.
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')`, [other, stranger])
  const anchor = randomUUID()
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'anchor')`, [anchor, group, owner])
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id) VALUES($1,'topic','Removed mention topic',$2,$3,$4)`,
    [topic, owner, group, anchor])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')`, [topic, owner, peer])
  await db.query('SET CONSTRAINTS ALL IMMEDIATE')
})
afterEach(async () => { if (db) await db.query('ROLLBACK') })

describe('mentions of a removed former member (#2383)', () => {
  it('rejected the whole message before the fix; now the others receive it and the removed agent gets one refusal', async () => {
    await removeIdentity(agent)
    const message = await send(group, [agent, peer])
    await user(peer)
    expect((await db.query('SELECT id FROM chat.messages WHERE id=$1', [message])).rows).toEqual([{ id: message }])
    await admin()
    expect(await outcome(message, agent)).toEqual({ blocks: ['identity_removed'], woken: false, delivered: false })
    // Members learn the refusal the same way as agent_archived: a delivery revision, then they read the row.
    for (const member of [owner, peer]) {
      expect((await db.query("SELECT 1 FROM chat.account_revisions WHERE user_id=$1 AND event='delivery_changed' AND resource_key->>'entity_id'=$2",
        [member, message])).rowCount).toBeGreaterThan(0)
    }
    await user(peer)
    expect((await db.query('SELECT agent_user_id,reason FROM chat.message_agent_delivery_blocks WHERE message_id=$1', [message])).rows)
      .toEqual([{ agent_user_id: agent, reason: 'identity_removed' }])
    await admin()
    // Its old seat is untouched and it is still not a member.
    expect((await db.query('SELECT chat.is_chat_member($1,$2) AS live', [group, agent])).rows[0].live).toBe(false)
  })

  it('a topic of the group it sat in accepts the mention the same way and does not seat the removed agent', async () => {
    await removeIdentity(agent)
    const message = await send(topic, [agent])
    expect(await outcome(message, agent)).toEqual({ blocks: ['identity_removed'], woken: false, delivered: false })
    expect((await db.query('SELECT 1 FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [topic, agent])).rows).toEqual([])
  })

  it('ids that never sat in this chat are still rejected, live or removed, with a nameable error', async () => {
    const notMember = (ids: string[]) => ({ code: 'P0001', message: 'recipient_not_member', hint: 'recipient_not_member', detail: ids.join(',') })
    expect(await refused(group, [stranger])).toMatchObject(notMember([stranger]))
    await removeIdentity(stranger)
    const unknown = randomUUID()
    expect(await refused(group, [stranger])).toMatchObject(notMember([stranger]))
    // Only the offending ids, in the order given, once each; the removed former member is not one.
    expect(await refused(group, [unknown, peer, agent, stranger, unknown])).toMatchObject(notMember([unknown, stranger]))
    expect(await refused(topic, [stranger])).toMatchObject(notMember([stranger]))
    // A whisper keeps the whisper rule's own named refusal.
    expect(await refused(group, [stranger], { whisper: true })).toMatchObject({ code: '23514', message: expect.stringContaining('is not a member of') })
  })

  it('a sender without the right to speak here still gets the generic RLS refusal, never membership facts', async () => {
    const intruder = randomUUID()
    await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at)
      VALUES($1,'authenticated','authenticated',$2,now(),now())`, [intruder, `${intruder}@removed-mention.invalid`])
    for (const to of [[randomUUID()], [peer]]) {
      const error = await refused(group, to, { sender: intruder })
      expect(error.code).toBe('42501')
      expect(error.hint).toBeUndefined()
    }
  })

  it('a whisper to the removed agent is still rejected; @all records nothing for it', async () => {
    await removeIdentity(agent)
    expect((await refused(group, [agent], { whisper: true })).code).toBe('23514')
    const everyone = await send(group, ['*'])
    expect(await outcome(everyone, agent)).toEqual({ blocks: null, woken: false, delivered: false })
  })

  it('an archived agent that kept its identity still gets agent_archived, not identity_removed', async () => {
    await db.query('UPDATE identity.users SET session_archived_at=now() WHERE id=$1', [agent])
    const message = await send(group, [agent])
    expect((await outcome(message, agent)).blocks).toEqual(['agent_archived'])
  })

  it('new functions are closed: only the policy test is callable, and only by signed-in users', async () => {
    const rows = (await db.query(`SELECT r.rolname AS role,
        has_function_privilege(r.rolname,'chat_private.is_removed_agent_recipient(text,text)','EXECUTE') AS recipient,
        has_function_privilege(r.rolname,'chat_private.is_removed_agent_seat(text,text)','EXECUTE') AS seat,
        has_function_privilege(r.rolname,'chat.record_message_removed_agent_refusals()','EXECUTE') AS refusals,
        has_function_privilege(r.rolname,'chat.reject_non_member_recipients()','EXECUTE') AS rejecter
      FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role','gugu_files') ORDER BY 1`)).rows
    expect(rows).toEqual([
      { role: 'anon', recipient: false, seat: false, refusals: false, rejecter: false },
      { role: 'authenticated', recipient: true, seat: false, refusals: false, rejecter: false },
      { role: 'gugu_files', recipient: false, seat: false, refusals: false, rejecter: false },
      { role: 'service_role', recipient: false, seat: false, refusals: false, rejecter: false },
    ])
    await db.query('SAVEPOINT reason')
    await expect(db.query(`INSERT INTO chat.message_agent_delivery_blocks(message_id,agent_user_id,reason)
      SELECT id,$1,'something_else' FROM chat.messages LIMIT 1`, [agent])).rejects.toMatchObject({ code: '23514' })
    await db.query('ROLLBACK TO SAVEPOINT reason')
  })
})
