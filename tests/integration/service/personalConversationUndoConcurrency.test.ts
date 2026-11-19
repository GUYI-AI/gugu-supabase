import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let a: pg.Client, b: pg.Client
let owner: string, peer: string, room: string, original: string, aPid: number, bPid: number
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Requires disposable loopback database')
  a = new pg.Client({ connectionString: url.href }); b = new pg.Client({ connectionString: url.href })
  await a.connect(); await b.connect()
  for (const c of [a, b]) await c.query("SET statement_timeout='8s'")
  aPid = (await a.query('SELECT pg_backend_pid() pid')).rows[0].pid
  bPid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid
})
afterAll(async () => { await a?.end(); await b?.end() })
beforeEach(async () => {
  ;[owner, peer, room, original] = Array.from({ length: 4 }, randomUUID)
  for (const id of [owner, peer]) await a.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, id + '@undo-race.invalid'])
  await a.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Undo race',$2)", [room, peer])
  await a.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'owner')", [room, owner, peer])
  await a.query('BEGIN'); await auth(a); await hide(a, original); await a.query('COMMIT')
})
afterEach(async () => {
  await a.query('ROLLBACK'); await b.query('ROLLBACK')
  await a.query('DELETE FROM chat.chats WHERE id=$1', [room])
  await a.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[owner, peer]])
})
const auth = (c: pg.Client) => c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner])
const hide = (c: pg.Client, operation = randomUUID()) => c.query('SELECT chat.hide_my_conversation($1,$2) receipt', [room, operation])
const undo = (c: pg.Client) => c.query('SELECT chat.undo_my_conversation_hide($1,$2,$3) receipt', [room, original, randomUUID()])
const state = async () => (await a.query('SELECT * FROM chat.conversation_list_state WHERE chat_id=$1 AND user_id=$2', [room, owner])).rows[0]
async function blocked() {
  const until = Date.now() + 4000
  while (Date.now() < until) {
    if ((await a.query('SELECT pg_blocking_pids($1) blockers', [bPid])).rows[0].blockers.includes(aPid)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw Error('Undo did not reach the intended transaction barrier')
}
it('rechecks active membership after waiting for concurrent revocation', async () => {
  await a.query('BEGIN'); await a.query('SELECT chat.lock_lines($1)', [[room]])
  await a.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [room, owner])
  await b.query('BEGIN'); await auth(b)
  const result = undo(b).then(() => null, (error: { code: string }) => error.code)
  await blocked(); await a.query('COMMIT')
  expect(await result).toBe('42501'); await b.query('ROLLBACK')
  expect((await state()).hidden_by_operation_id).toBe(original)
})
it('keeps a newer deliberate hide which commits before the older Undo', async () => {
  const newer = randomUUID()
  await a.query('BEGIN'); await auth(a); await hide(a, newer)
  await b.query('BEGIN'); await auth(b); const result = undo(b)
  await blocked(); await a.query('COMMIT')
  expect((await result).rows[0].receipt.restored).toBe(false); await b.query('COMMIT')
  expect((await state()).hidden_by_operation_id).toBe(newer)
})
it('keeps a later hide which waits for an earlier Undo to commit', async () => {
  await a.query('BEGIN'); await auth(a); expect((await undo(a)).rows[0].receipt.restored).toBe(true)
  const newer = randomUUID()
  await b.query('BEGIN'); await auth(b); const result = hide(b, newer)
  await blocked(); await a.query('COMMIT'); await result; await b.query('COMMIT')
  expect((await state()).hidden_by_operation_id).toBe(newer)
})
