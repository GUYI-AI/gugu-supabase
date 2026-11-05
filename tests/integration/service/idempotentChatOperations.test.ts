import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
let db: Client
let owner: string, reader: string, outsider: string, origin: string, destination: string, anchor: string
async function as(actor: string, sql: string, values: unknown[] = []) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role: 'authenticated' })])
  const rows = (await db.query(sql, values)).rows
  await db.query('RESET ROLE')
  return rows
}
async function denied(actor: string, sql: string, values: unknown[] = []) {
  await db.query('SAVEPOINT denied')
  try { await as(actor, sql, values) } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT denied')
    await db.query('RESET ROLE')
    return (error as Error).message
  }
  throw new Error('Expected rejection')
}
async function topic(id?: string, source = anchor, actor = owner) {
  return as(actor, 'SELECT * FROM chat.create_topic($1,$2,$3,$4,NULL,$5)', [origin, source, 'Outbox topic', [reader], id ?? null])
}
async function forwardText(source = anchor, id = randomUUID()) {
  return as(owner, `SELECT * FROM chat.send_message_idempotent($1,$2,$3,NULL,'Forwarded','text',NULL,NULL,false,false,NULL,NULL,NULL,$4)`, [id, destination, owner, source])
}
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Requires disposable loopback database')
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, reader, outsider, origin, destination, anchor] = Array.from({ length: 6 }, randomUUID)
  for (const id of [owner, reader, outsider]) await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@outbox.invalid`])
  for (const id of [origin, destination]) {
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Outbox fixture',$2)", [id, owner])
    for (const user of [owner, reader]) await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,$3)", [id, user, user === owner ? 'owner' : 'member'])
  }
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Source')", [anchor, origin, owner])
})
afterEach(async () => { await db.query('ROLLBACK') })

it('the client topic id converges across retries without repeating enrollment', async () => {
  const id = randomUUID()
  expect((await topic(id))[0].chat_id).toBe(id)
  const members = (await db.query('SELECT user_id,joined_at FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id', [id])).rows
  await db.query("UPDATE chat.chats SET name='Renamed after creation' WHERE id=$1", [id])
  expect((await topic(id))[0]).toMatchObject({ chat_id: id, name: 'Renamed after creation' })
  expect((await db.query('SELECT user_id,joined_at FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id', [id])).rows).toEqual(members)
})
it('a topic id cannot be reused for another actor or source and cannot bypass source membership', async () => {
  const id = randomUUID()
  await topic(id)
  const another = randomUUID()
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Other source')", [another, origin, owner])
  expect(await denied(owner, 'SELECT * FROM chat.create_topic($1,$2,NULL,NULL,NULL,$3)', [origin, another, id])).toMatch(/already used/)
  expect(await denied(reader, 'SELECT * FROM chat.create_topic($1,$2,NULL,NULL,NULL,$3)', [origin, anchor, id])).toMatch(/already used/)
  expect(await denied(outsider, 'SELECT * FROM chat.create_topic($1,$2,NULL,NULL,NULL,$3)', [origin, anchor, id])).toMatch(/Not a member/)
})
it('legacy callers can still create different topics without supplying an id', async () => {
  const first = (await as(owner, 'SELECT * FROM chat.create_topic($1,$2)', [origin, anchor]))[0]
  const second = (await as(owner, 'SELECT * FROM chat.create_topic($1,$2)', [origin, anchor]))[0]
  expect(first.chat_id).not.toBe(second.chat_id)
})
it('legacy named four- and five-argument callers retain generated topic ids', async () => {
  const four = (await as(owner, 'SELECT * FROM chat.create_topic(p_source_chat_id => $1, p_source_message_id => $2, p_name => NULL, p_member_user_ids => NULL)', [origin, anchor]))[0]
  const five = (await as(owner, 'SELECT * FROM chat.create_topic(p_source_chat_id => $1, p_source_message_id => $2, p_name => NULL, p_member_user_ids => NULL, p_as_user_id => $3)', [origin, anchor, owner]))[0]
  expect(four.chat_id).toMatch(/^[0-9a-f-]{36}$/)
  expect(five.chat_id).toMatch(/^[0-9a-f-]{36}$/)
  expect(four.chat_id).not.toBe(five.chat_id)
  expect([four, five]).toEqual([expect.objectContaining({ source_chat_id: origin, source_message_id: anchor, creator_user_id: owner }), expect.objectContaining({ source_chat_id: origin, source_message_id: anchor, creator_user_id: owner })])
})
it('text forwarding refuses missing and retracted sources, but accepted ids replay after retraction', async () => {
  const id = randomUUID()
  await forwardText(anchor, id)
  await db.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1', [anchor])
  expect((await forwardText(anchor, id))[0].id).toBe(id)
  for (const source of [anchor, randomUUID()]) {
    expect(await denied(owner, `SELECT * FROM chat.send_message_idempotent($1,$2,$3,NULL,'Forwarded','text',NULL,NULL,false,false,NULL,NULL,NULL,$4)`, [randomUUID(), destination, owner, source])).toMatch(/Original message/)
  }
})
it('forwarding as an owned agent uses the authenticated callers source access', async () => {
  const agent = randomUUID(), id = randomUUID(), device = `outbox-${randomUUID()}`
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Outbox fixture','fixture','linux')", [device, owner])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,agent_public) VALUES($1,'agent','Outbox agent',$2,$3,true)", [agent, owner, device])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [destination, agent])
  const rows = await as(owner, `SELECT * FROM chat.send_message_idempotent($1,$2,$3,NULL,'Forwarded','text',NULL,NULL,false,false,NULL,NULL,NULL,$4)`, [id, destination, agent, anchor])
  expect(rows[0]).toMatchObject({ id, sender_user_id: agent })
  expect((await db.query('SELECT user_id FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [origin, agent])).rows).toEqual([])
})
it.each([false, true])('attachment forward replay publishes only one message and file (whisper=%s)', async whisper => {
  const blob = randomUUID(), hash = randomUUID().replaceAll('-', '').repeat(2), key = `staging/${owner}/${randomUUID()}`, source = randomUUID(), id = randomUUID()
  await db.query("INSERT INTO chat.file_blobs(id,bucket_id,object_name,sha256,size_bytes,content_type) VALUES($1,'oss',$2,$3,3,'text/plain')", [blob, hash.slice(0, 2) + '/' + hash, hash])
  await db.query('INSERT INTO chat.file_blob_uploads(staging_key,uploader,blob_id) VALUES($1,$2,$3)', [key, owner, blob])
  await as(owner, 'SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,false)', [key, source, origin, owner, 'proof.txt', []])
  const values = [source, id, destination, owner, whisper ? [reader] : [], whisper]
  const sql = 'SELECT * FROM chat.attachment_forward($1,$2,$3,$4,$5,NULL,false,$6,NULL)'
  const first = (await as(owner, sql, values))[0]
  const files = (await db.query('SELECT id,version,source_message_ids FROM chat.workspace_items WHERE chat_id=$1 ORDER BY id', [destination])).rows
  await db.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1', [source])
  expect((await as(owner, sql, values))[0]).toMatchObject({ id, file_item_id: first.file_item_id, file_blob_id: first.file_blob_id })
  expect((await db.query('SELECT id,version,source_message_ids FROM chat.workspace_items WHERE chat_id=$1 ORDER BY id', [destination])).rows).toEqual(files)
  expect((await db.query('SELECT id FROM chat.messages WHERE id=$1', [id])).rows).toEqual([{ id }])
})

it('concurrent topic deliveries converge on one topic id', async () => {
  const id = randomUUID()
  await db.query('COMMIT')
  const clients = [new Client({ connectionString: process.env.GUGU_INTEGRATION_DATABASE_URL }), new Client({ connectionString: process.env.GUGU_INTEGRATION_DATABASE_URL })]
  try {
    await Promise.all(clients.map(async client => {
      await client.connect()
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE authenticated')
      await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
    }))
    const results = await Promise.all(clients.map(async client => {
      const result = await client.query('SELECT * FROM chat.create_topic($1,$2,$3,NULL,NULL,$4)', [origin, anchor, 'Concurrent topic', id])
      await client.query('COMMIT')
      return result.rows[0].chat_id
    }))
    expect(results).toEqual([id, id])
    expect((await db.query('SELECT id FROM chat.chats WHERE source_message_id=$1', [anchor])).rows).toEqual([{ id }])
  } finally {
    for (const client of clients) { await client.query('ROLLBACK').catch(() => {}); await client.end() }
    await db.query('DELETE FROM chat.chats WHERE id=ANY($1::text[])', [[id, origin, destination]])
    await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[owner, reader, outsider]])
    await db.query('BEGIN')
  }
})

it('concurrent attachment forwards place one file for the same message id', async () => {
  const blob = randomUUID(), hash = randomUUID().replaceAll('-', '').repeat(2), source = randomUUID(), id = randomUUID(), key = `staging/${owner}/${randomUUID()}`
  await db.query("INSERT INTO chat.file_blobs(id,bucket_id,object_name,sha256,size_bytes,content_type) VALUES($1,'oss',$2,$3,3,'text/plain')", [blob, hash.slice(0, 2) + '/' + hash, hash])
  await db.query('INSERT INTO chat.file_blob_uploads(staging_key,uploader,blob_id) VALUES($1,$2,$3)', [key, owner, blob])
  await as(owner, 'SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5,$6,NULL,NULL,false,false)', [key, source, origin, owner, 'concurrent.txt', []])
  await db.query('COMMIT')
  const clients = [new Client({ connectionString: process.env.GUGU_INTEGRATION_DATABASE_URL }), new Client({ connectionString: process.env.GUGU_INTEGRATION_DATABASE_URL })]
  try {
    await Promise.all(clients.map(async client => {
      await client.connect()
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE authenticated')
      await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
    }))
    const results = await Promise.all(clients.map(async client => {
      const result = await client.query('SELECT * FROM chat.attachment_forward($1,$2,$3,$4,ARRAY[]::text[],NULL,false,false,NULL)', [source, id, destination, owner])
      await client.query('COMMIT')
      return result.rows[0]
    }))
    expect(results[0].id).toBe(id)
    expect(results[1]).toMatchObject({ id, file_item_id: results[0].file_item_id, file_blob_id: results[0].file_blob_id })
    expect((await db.query("SELECT id,blob_id FROM chat.workspace_items WHERE chat_id=$1 AND kind='file'", [destination])).rows).toEqual([{ id: results[0].file_item_id, blob_id: blob }])
  } finally {
    for (const client of clients) { await client.query('ROLLBACK').catch(() => {}); await client.end() }
    await db.query('DELETE FROM chat.chats WHERE id=ANY($1::text[])', [[origin, destination]])
    await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[owner, reader, outsider]])
    await db.query('DELETE FROM chat.file_blob_uploads WHERE blob_id=$1', [blob])
    await db.query('DELETE FROM chat.file_blobs WHERE id=$1', [blob])
    await db.query('BEGIN')
  }
})

it('replaced outbox writers retain authenticated execution and stay closed to anonymous callers', async () => {
  for (const signature of [
    'chat.create_topic(text,text,text,text[],text,text)',
    'chat.send_message_idempotent(text,text,text,text[],text,text,text,text,boolean,boolean,text,uuid,integer,text,uuid)',
    'chat.attachment_forward(text,text,text,text,text[],text,boolean,boolean,text)',
  ]) {
    expect((await db.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed).toBe(true)
    expect((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed).toBe(false)
  }
})
