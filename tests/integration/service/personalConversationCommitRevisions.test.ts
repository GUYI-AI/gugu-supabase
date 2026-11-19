import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let db: pg.Client
let owner: string, peer: string, room: string
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Requires disposable loopback database')
  db = new pg.Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  ;[owner, peer, room] = Array.from({ length: 3 }, randomUUID)
  for (const id of [owner, peer]) await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, id + '@conversation-commit.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Commit fixture',$2)", [room, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [room, owner, peer])
})
afterEach(async () => {
  await db.query('ROLLBACK')
  await db.query('DELETE FROM chat.chats WHERE id=$1', [room])
  await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[owner, peer]])
})
const head = async () => (await db.query('SELECT revision::text AS revision FROM chat.account_revision_heads WHERE user_id=$1', [owner])).rows[0].revision as string

it('keeps ordinary message revisions deferred until commit', async () => {
  const before = await head()
  await db.query('BEGIN')
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Deferred publication')", [randomUUID(), room, peer])
  expect(await head()).toBe(before)
  expect((await db.query('SELECT count(*)::int AS count FROM chat.pending_user_revisions WHERE transaction_id=pg_current_xact_id()')).rows[0].count).toBeGreaterThan(0)
  await db.query('COMMIT')
  expect(BigInt(await head())).toBeGreaterThan(BigInt(before))
})

it.each(['hide_my_conversation', 'delete_my_conversation'])('returns a durable %s receipt with the committed account revision', async operation => {
  const before = await head()
  const operationId = randomUUID()
  await db.query('BEGIN')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner])
  await db.query('SET LOCAL ROLE authenticated')
  const receipt = (await db.query(`SELECT chat.${operation}($1,$2) AS receipt`, [room, operationId])).rows[0].receipt
  await db.query('COMMIT')
  expect(BigInt(receipt.account_revision)).toBeGreaterThan(BigInt(before))
  expect(await head()).toBe(receipt.account_revision)
  await db.query('BEGIN')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner])
  await db.query('SET LOCAL ROLE authenticated')
  const retry = (await db.query(`SELECT chat.${operation}($1,$2) AS receipt`, [room, operationId])).rows[0].receipt
  await db.query('COMMIT')
  expect(retry).toEqual(receipt)
  expect(await head()).toBe(receipt.account_revision)
})

it('does not expose revision finalization to API roles', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    expect((await db.query("SELECT has_function_privilege($1,'chat.flush_pending_user_revisions()','EXECUTE') AS allowed", [role])).rows[0].allowed).toBe(false)
  }
})
