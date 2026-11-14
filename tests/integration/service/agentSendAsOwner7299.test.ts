import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => DatabaseClient }
let db: DatabaseClient
let owner: string, friend: string, stranger: string, agent: string
async function asUser(id: string, role = 'authenticated') {
  await db.query('RESET role')
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role })])
  await db.query(`SET LOCAL role TO ${role}`)
}
async function rejected(sql: string, values: unknown[]) {
  await db.query('SAVEPOINT expected_failure')
  try { await db.query(sql, values) } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT expected_failure')
    return (error as Error).message
  }
  throw new Error('Expected rejection, operation succeeded')
}
async function send(key = 'one', text = '明天下午两点见') {
  return (await db.query<{ result: { chat_id: string; message_id: string; sender_user_id: string; sent_by_agent: boolean } }>(
    'SELECT chat.send_friend_message_as_owner($1,$2,$3,$4) AS result', [agent, friend, text, key],
  )).rows[0]!.result
}
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Requires an isolated loopback PostgreSQL database')
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); friend = randomUUID(); stranger = randomUUID(); agent = randomUUID()
  for (const [id, name] of [[owner, 'Owner'], [friend, 'Friend'], [stranger, 'Stranger']]) {
    await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`, [id, `${id}@agent-send-fixture.invalid`])
    await db.query('INSERT INTO identity.users(id,type,display_name) VALUES ($1,\'human\',$2) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name', [id, name])
  }
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'fixture','fixture','linux')`, [`send-${owner}`, owner])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id)
    VALUES ($1,'agent','Private Researcher',$2,$3)`, [agent, owner, `send-${owner}`])
  await db.query('INSERT INTO identity.friendships(user_a_id,user_b_id) VALUES (LEAST($1,$2),GREATEST($1,$2))', [owner, friend])
  await asUser(owner)
})
afterEach(async () => {
  try { await db.query('RESET role'); await db.query('SET CONSTRAINTS ALL IMMEDIATE') } finally { await db.query('ROLLBACK') }
})

describe('Agent sends on behalf of its owner (#7299)', () => {
  // Files go through send_friend_file_as_owner (the attachments function); since 20261110053000 this RPC sends text only:
  // no content type or storage parameters to name.
  it('sends text only: no attachment or system kind to ask for, and a card\'s words stay text', async () => {
    expect(await rejected('SELECT chat.send_friend_message_as_owner($1,$2,$3,$4,$5,$6,$7)',
      [agent, friend, 'system', 'bad-kind', 'system', null, null])).toMatch(/does not exist/)
    const object = `${owner}/${randomUUID()}.pdf`
    await db.query('RESET role')
    await db.query('INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES (\'chat-media\',$1,$2,\'{"size":3}\')', [object, owner])
    await asUser(owner)
    const card = `[附件] 研究资料.pdf (application/pdf)\n[URL] https://storage.test/storage/v1/object/public/chat-media/${object}\n[Size] 3\n[Kind] file`
    // The same words sent as text stay text: no attachment, no Storage reference.
    const sent = (await db.query<{ result: { message_id: string } }>('SELECT chat.send_friend_message_as_owner($1,$2,$3,$4) AS result',
      [agent, friend, card, 'card-as-text'])).rows[0]!.result
    await db.query('RESET role')
    expect((await db.query('SELECT content_type,storage_bucket_id,file_item_id,file_blob_id FROM chat.messages WHERE id=$1', [sent.message_id])).rows)
      .toEqual([{ content_type: 'text', storage_bucket_id: null, file_item_id: null, file_blob_id: null }])
  })
  it('writes a human-owned DM with exactly two people, no invitation or Agent membership', async () => {
    const result = await send()
    expect(result).toMatchObject({ sender_user_id: owner, sent_by_agent: true })
    expect(result.message_id).not.toContain(agent)
    const row = (await db.query('SELECT * FROM chat.messages_view WHERE id=$1', [result.message_id])).rows[0]!
    expect(row).toMatchObject({ sender_user_id: owner, content: '明天下午两点见', content_type: 'text', to_user_ids: [friend], sent_by_agent: true, agent_sender: { id: agent, name: 'Private Researcher' }, thread_root_id: null })
    expect((await db.query<{ user_id: string }>('SELECT user_id FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id', [result.chat_id])).rows.map(r => r.user_id)).toEqual([owner, friend].sort())
    for (const viewer of [owner, friend]) {
      await asUser(viewer)
      expect((await db.query('SELECT chat_id FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2 AND inbox_published_at IS NOT NULL', [result.chat_id, viewer])).rows).toEqual([{ chat_id: result.chat_id }])
    }
    await db.query('RESET role')
    expect((await db.query('SELECT id FROM chat.group_invitations WHERE inviter_user_id=$1', [agent])).rows).toEqual([])
    expect((await db.query('SELECT id FROM chat.chats WHERE creator_user_id=$1 AND kind=\'group\'', [owner])).rows).toEqual([])
  })
  it('keeps the Agent identity private in direct reads, base rows, and SECURITY DEFINER synchronization', async () => {
    const result = await send()
    await asUser(friend)
    expect((await db.query('SELECT sent_by_agent,agent_sender FROM chat.messages_view WHERE id=$1', [result.message_id])).rows).toEqual([{ sent_by_agent: true, agent_sender: null }])
    expect((await db.query('SELECT * FROM chat.message_agent_sends WHERE message_id=$1', [result.message_id])).rows).toEqual([])
    const base = (await db.query('SELECT * FROM chat.messages WHERE id=$1', [result.message_id])).rows[0]
    expect(JSON.stringify(base)).not.toContain(agent)
    const sync = (await db.query<{ value: { operations: Array<{ payload: { message?: { id: string; sent_by_agent: boolean; agent_sender: unknown } } }> } }>('SELECT chat.sync_since(0,500) AS value')).rows[0]!.value
    const incoming = sync.operations.flatMap(op => op.payload.message?.id === result.message_id ? [op.payload.message] : [])
    expect(incoming).toEqual([expect.objectContaining({ sent_by_agent: true, agent_sender: null })])
    await asUser(owner)
    expect((await db.query('SELECT agent_sender FROM chat.messages_view WHERE id=$1', [result.message_id])).rows).toEqual([{ agent_sender: { id: agent, name: 'Private Researcher' } }])
    await asUser(stranger)
    expect((await db.query('SELECT * FROM chat.messages_view WHERE id=$1', [result.message_id])).rows).toEqual([])
    expect((await db.query('SELECT * FROM chat.message_agent_sends WHERE message_id=$1', [result.message_id])).rows).toEqual([])
  })
  it('reuses its stable request key and rejects a changed replay', async () => {
    const first = await send()
    expect(await send()).toEqual(first)
    expect((await db.query('SELECT id FROM chat.messages WHERE chat_id=$1', [first.chat_id])).rows).toHaveLength(1)
    expect(await rejected('SELECT chat.send_friend_message_as_owner($1,$2,$3,$4)', [agent, friend, 'Changed text', 'one'])).toContain('Idempotency conflict')
    expect((await send('two')).message_id).not.toBe(first.message_id)
  })
  it('refuses another owner, a non-friend, an Agent target, itself, and anonymous callers', async () => {
    const sql = 'SELECT chat.send_friend_message_as_owner($1,$2,$3,$4)'
    await asUser(stranger)
    expect(await rejected(sql, [agent, friend, 'hi', 'one'])).toContain('not owned')
    await asUser(owner)
    for (const target of [stranger, agent, owner]) expect(await rejected(sql, [agent, target, 'hi', 'one'])).toContain('not an owner friend')
    await asUser(owner, 'anon')
    expect(await rejected(sql, [agent, friend, 'hi', 'one'])).toContain('permission denied')
  })
  it('rechecks friendship at send time and leaves no partial source record after rejection', async () => {
    await send()
    await db.query('RESET role')
    await db.query('DELETE FROM identity.friendships WHERE user_a_id=LEAST($1,$2) AND user_b_id=GREATEST($1,$2)', [owner, friend])
    await asUser(owner)
    expect(await rejected('SELECT chat.send_friend_message_as_owner($1,$2,$3,$4)', [agent, friend, 'hi', 'two'])).toContain('not an owner friend')
    expect((await db.query('SELECT * FROM chat.message_agent_sends WHERE agent_user_id=$1', [agent])).rows).toHaveLength(1)
  })
  it('retains the source name when the Agent is removed', async () => {
    const result = await send()
    await db.query('RESET role')
    await db.query('DELETE FROM identity.users WHERE id=$1', [agent])
    await asUser(owner)
    expect((await db.query('SELECT sent_by_agent,agent_sender FROM chat.messages_view WHERE id=$1', [result.message_id])).rows).toEqual([{ sent_by_agent: true, agent_sender: { id: null, name: 'Private Researcher' } }])
  })
  it('leaves ordinary message sends unchanged and refuses a forged AI marker', async () => {
    const result = await send()
    const id = randomUUID()
    const ordinary = (await db.query('SELECT sent_by_agent,agent_sender FROM chat.send_message_idempotent($1,$2,$3,$4,$5,\'text\',NULL,NULL,false,false,NULL)', [id, result.chat_id, owner, [friend], 'ordinary'])).rows
    expect(ordinary).toEqual([{ sent_by_agent: false, agent_sender: null }])
    expect(await rejected('UPDATE chat.messages SET sent_by_agent=true WHERE id=$1', [id])).toContain('permission denied')
    expect((await db.query('SELECT sent_by_agent FROM chat.messages WHERE id=$1', [id])).rows).toEqual([{ sent_by_agent: false }])
  })
})
