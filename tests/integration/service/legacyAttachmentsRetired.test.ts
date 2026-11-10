import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

// 20261110053000: old chat-media cards are retired. A message never names a Storage object, through any door: a member's
// direct insert (the old client path), a trusted writer, or the owner-send RPC; the readers of the old shape are gone.
// The adoption of existing cards is rehearsed against 192 production-shaped cards (gugu-dev evidence, see the PR).
let db: Client
let owner: string, member: string, group: string, object: string

async function asUser<Row = Record<string, unknown>>(user: string, sql: string, values: unknown[] = []): Promise<Row[]> {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  await db.query(`SELECT set_config('request.headers','{"host":"db.example"}',true)`)
  await db.query('SET LOCAL ROLE authenticated')
  // A refused statement aborts the transaction: the caller rolls back to its savepoint, which also undoes the role.
  const rows = (await db.query(sql, values)).rows as Row[]
  await db.query('RESET ROLE')
  return rows
}
async function refused(run: () => Promise<unknown>, pattern: RegExp) {
  await db.query('SAVEPOINT door')
  await expect(run()).rejects.toThrow(pattern)
  await db.query('ROLLBACK TO SAVEPOINT door')
}
const card = (id: string) => `[附件] x.png (image/png)\n[URL] http://db.example/storage/v1/object/public/chat-media/${id}\n[Size] 1\n[Kind] image`

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Requires the disposable loopback database')
  }
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, member, group] = [randomUUID(), randomUUID(), randomUUID()]
  for (const id of [owner, member]) await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,now(),now())`, [id, `${id}@legacy-retired.invalid`])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Legacy retired',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [group, owner, member])
  object = `${member}/x.png`
  await db.query(`INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES('chat-media',$1,$2,'{"size":1,"mimetype":"image/png"}')`, [object, member])
})
afterEach(async () => { await db.query('ROLLBACK') })

it('a member cannot post a card naming a chat-media object, with or without the storage columns', async () => {
  await refused(() => asUser(member, `INSERT INTO chat.messages(id,chat_id,sender_user_id,content_type,content,storage_bucket_id,storage_object_name)
    VALUES($1,$2,$3,'attachment',$4,'chat-media',$5)`, [randomUUID(), group, member, card(object), object]), /permission denied|retired|Storage object/)
  await refused(() => asUser(member, `INSERT INTO chat.messages(id,chat_id,sender_user_id,content_type,content)
    VALUES($1,$2,$3,'attachment',$4)`, [randomUUID(), group, member, card(object)]), /Storage object/)
  // A trusted writer gets the same answer: the rule is the table's, not a grant.
  await refused(() => db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content_type,content,storage_bucket_id,storage_object_name)
    VALUES($1,$2,$3,'attachment',$4,'chat-media',$5)`, [randomUUID(), group, member, card(object), object]), /Storage object/)
  expect((await db.query('SELECT count(*)::int AS n FROM chat.messages WHERE storage_bucket_id IS NOT NULL')).rows[0].n).toBe(0)
})

it('the owner-send RPC sends text only, and the readers of the old shape are gone', async () => {
  const fn = async (signature: string) => (await db.query('SELECT to_regprocedure($1) AS f', [signature])).rows[0].f
  expect(await fn('chat.send_friend_message_as_owner(text,text,text,text,text,text,text)')).toBeNull()
  expect(await fn('chat.send_friend_message_as_owner(text,text,text,text)')).not.toBeNull()
  expect(await fn('chat.attachment_legacy_source(text)')).toBeNull()
  expect(await fn('chat.legacy_attachment_name(text)')).toBeNull()
  expect(await fn('chat.attachment_forward(text,text,text,text,text[],text,boolean,boolean,text)')).toBeNull()
  expect(await fn('chat.attachment_forward(text,text,text,text,text[],text,boolean,boolean)')).not.toBeNull()
})
