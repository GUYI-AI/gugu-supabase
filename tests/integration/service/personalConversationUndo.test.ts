import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { BEGIN_READING_REVISIONS } from '../../support/revisionTransaction'

let db: pg.Client
let owner: string, peer: string, room: string, other: string
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Requires disposable loopback database')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query(BEGIN_READING_REVISIONS)
  ;[owner, peer, room, other] = Array.from({ length: 4 }, randomUUID)
  for (const id of [owner, peer]) await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, id + '@conversation-undo.invalid'])
  for (const id of [room, other]) {
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Undo fixture',$2)", [id, peer])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'owner')", [id, owner, peer])
  }
  await send()
})
afterEach(async () => { await db.query('ROLLBACK') })
async function as(user: string, sql: string, values: unknown[]) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [user])
  try { return (await db.query(sql, values)).rows } finally { await db.query('RESET ROLE').catch(() => undefined) }
}
const hide = async (chat = room, operation = randomUUID(), user = owner) => (await as(user, 'SELECT chat.hide_my_conversation($1,$2) receipt', [chat, operation]))[0].receipt
const undo = async (hidden: string, chat = room, operation = randomUUID(), user = owner) => (await as(user, 'SELECT chat.undo_my_conversation_hide($1,$2,$3) receipt', [chat, hidden, operation]))[0].receipt
const clear = async () => (await as(owner, 'SELECT chat.delete_my_conversation($1,$2) receipt', [room, randomUUID()]))[0].receipt
const state = async () => (await db.query('SELECT * FROM chat.conversation_list_state WHERE chat_id=$1 AND user_id=$2', [room, owner])).rows[0]
const head = async () => (await db.query('SELECT revision::text revision FROM chat.account_revision_heads WHERE user_id=$1', [owner])).rows[0].revision
async function send() { await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Retained content')", [randomUUID(), room, peer]) }
async function denied(action: () => Promise<unknown>, code: string) {
  await db.query('SAVEPOINT denied')
  try { await expect(action()).rejects.toMatchObject({ code }) } finally { await db.query('ROLLBACK TO SAVEPOINT denied') }
}

it('undoes its current hide durably without changing retained messages or member preferences', async () => {
  const before = (await db.query('SELECT * FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id', [room])).rows
  const hidden = await hide()
  const receipt = await undo(hidden.operation_id)
  expect(receipt).toMatchObject({ chat_id: room, hide_operation_id: hidden.operation_id, restored: true, hidden_at: null })
  expect(await head()).toBe(receipt.account_revision)
  expect(BigInt(receipt.account_revision)).toBeGreaterThan(BigInt(hidden.account_revision))
  expect((await state()).conversation_hidden_at).toBeNull()
  expect((await state()).hidden_by_operation_id).toBeNull()
  expect((await db.query('SELECT * FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id', [room])).rows).toEqual(before)
  expect((await as(owner, 'SELECT chat_id FROM chat.list_my_chats_as($1)', [owner])).map(row => row.chat_id)).toContain(room)
  expect((await as(owner, 'SELECT content FROM chat.messages_view WHERE chat_id=$1', [room]))).toHaveLength(1)
})
it('replays a lost undo receipt without overriding a later hide', async () => {
  const first = await hide(), operation = randomUUID()
  const receipt = await undo(first.operation_id, room, operation)
  const newer = await hide()
  expect(await undo(first.operation_id, room, operation)).toEqual(receipt)
  expect((await state()).hidden_by_operation_id).toBe(newer.operation_id)
  expect(await head()).toBe(newer.account_revision)
})
it('does not undo a newer deliberate hide, including an already-hidden row', async () => {
  const first = await hide(), newer = await hide()
  expect(newer.already).toBe(true)
  expect((await undo(first.operation_id)).restored).toBe(false)
  expect((await undo(newer.operation_id)).restored).toBe(false)
  expect((await state()).conversation_hidden_at).not.toBeNull()
})
it('does not undo a history clear or restore its old history', async () => {
  const first = await hide(), cleared = await clear()
  expect((await undo(first.operation_id)).restored).toBe(false)
  expect((await state()).conversation_hidden_at).not.toBeNull()
  expect(new Date((await state()).conversation_cleared_at).toISOString()).toBe(new Date(cleared.cleared_at).toISOString())
  expect(await as(owner, 'SELECT content FROM chat.messages_view WHERE chat_id=$1', [room])).toEqual([])
})
it('does not override a newer hide after a new message restored the original row', async () => {
  const first = await hide(); await send(); const newer = await hide()
  expect((await undo(first.operation_id)).restored).toBe(false)
  expect((await state()).hidden_by_operation_id).toBe(newer.operation_id)
})
it('does not publish again when a new message already restored the row', async () => {
  const first = await hide(); await send(); const before = await head()
  expect((await undo(first.operation_id)).restored).toBe(false)
  expect(await head()).toBe(before)
})
it('only changes the authenticated person and keeps the other member hidden', async () => {
  const own = await hide(); await hide(room, randomUUID(), peer)
  await undo(own.operation_id)
  expect((await db.query('SELECT conversation_hidden_at FROM chat.conversation_list_state WHERE chat_id=$1 AND user_id=$2', [room, peer])).rows[0].conversation_hidden_at).not.toBeNull()
  await denied(() => undo(own.operation_id, room, randomUUID(), peer), '42501')
})
it('rejects cross-chat or changed retry parameters', async () => {
  const first = await hide(), second = await hide(other), operation = randomUUID()
  await denied(() => undo(first.operation_id, other), '23505')
  await undo(first.operation_id, room, operation)
  await denied(() => undo(second.operation_id, other, operation), '23505')
})
it('does not restore a legacy permanent deletion', async () => {
  const dm = randomUUID()
  await db.query("INSERT INTO chat.chats(id,kind,creator_user_id) VALUES($1,'dm',$2)", [dm, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [dm, owner, peer])
  const first = await hide(dm)
  await db.query('UPDATE chat.chat_members SET conversation_deleted_at=clock_timestamp() WHERE chat_id=$1 AND user_id=$2', [dm, owner])
  await denied(() => undo(first.operation_id, dm), '55000')
})
it('closes table reads and anonymous/service-role execution while permitting only the checked RPC', async () => {
  for (const role of ['anon', 'service_role']) expect((await db.query("SELECT has_function_privilege($1,'chat.undo_my_conversation_hide(text,uuid,uuid)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false)
  for (const role of ['anon', 'authenticated', 'service_role']) expect((await db.query("SELECT has_table_privilege($1,'chat.conversation_unhide_operations','SELECT') allowed", [role])).rows[0].allowed).toBe(false)
})

it('rejects Undo after the caller loses its active membership', async () => {
  const first = await hide()
  await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [room, owner])
  await denied(() => undo(first.operation_id), '42501')
  expect((await state()).conversation_hidden_at).not.toBeNull()
})
