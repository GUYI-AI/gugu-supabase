import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let owner: string, reader: string, group: string

async function asUser(id = owner) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}

async function insert(id: string, chat = group, timestamp?: string) {
  const columns = timestamp === undefined ? '' : ',created_at'
  const value = timestamp === undefined ? '' : ',$4'
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type${columns})
    VALUES($1,$2,$3,'Timestamp fixture','text'${value})`,
  timestamp === undefined ? [id, chat, owner] : [id, chat, owner, timestamp])
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Message timestamps require a disposable loopback database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, reader, group] = Array.from({ length: 3 }, randomUUID)
  for (const id of [owner, reader]) {
    await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@message-timestamp.invalid`])
  }
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Timestamp fixture',$2)`, [group, owner])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role,hide_history_before)
    VALUES($1,$2,'owner',NULL)`, [group, owner])
  await asUser()
})
afterEach(async () => { await db?.query('ROLLBACK') })

describe('message insertion clock', () => {
  it('caps a future direct insert at the server clock and preserves an explicit past time', async () => {
    const future = randomUUID(), past = randomUUID()
    const before = (await db.query('SELECT clock_timestamp() AS at')).rows[0].at
    await insert(future, group, '2099-01-01T00:00:00Z')
    await insert(past, group, '2000-01-01T00:00:00Z')
    const after = (await db.query('SELECT clock_timestamp() AS at')).rows[0].at
    const rows = (await db.query('SELECT id,created_at FROM chat.messages WHERE id=ANY($1::text[])', [[future, past]])).rows
    const capped = rows.find(row => row.id === future).created_at.getTime()
    expect(capped).toBeGreaterThanOrEqual(before.getTime())
    expect(capped).toBeLessThanOrEqual(after.getTime())
    expect(rows.find(row => row.id === past).created_at.toISOString()).toBe('2000-01-01T00:00:00.000Z')
  })

  for (const topic of [false, true]) {
    for (const explicit of [false, true]) {
      it(`${topic ? 'topic/source' : 'group'} history keeps a post-join ${explicit ? 'future' : 'default'} insert visible in an older transaction`, async () => {
        await db.query('RESET ROLE')
        // The transaction is already in flight. Establish a strictly later join
        // floor, then insert without resetting its transaction-start timestamp.
        await db.query('SELECT pg_sleep(0.01)')
        await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role,hide_history_before)
          VALUES($1,$2,'member',clock_timestamp())`, [group, reader])
        let chat = group
        if (topic) {
          chat = randomUUID()
          await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id)
            VALUES($1,'topic','Timestamp topic',$2,$3)`, [chat, owner, group])
        }
        const floor = (await db.query('SELECT hide_history_before FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [group, reader])).rows[0].hide_history_before
        const start = (await db.query('SELECT now() AS at')).rows[0].at
        expect(floor.getTime()).toBeGreaterThan(start.getTime())
        await asUser()
        const id = randomUUID()
        await insert(id, chat, explicit ? '2099-01-01T00:00:00Z' : undefined)
        await asUser(reader)
        const rows = (await db.query('SELECT id,created_at FROM chat.messages WHERE id=$1', [id])).rows
        expect(rows).toHaveLength(1)
        expect(rows[0].created_at.getTime()).toBeGreaterThanOrEqual(floor.getTime())
        expect((await db.query('SELECT chat.can_read_message($1,$2) AS ok', [id, reader])).rows[0].ok).toBe(true)
      })
    }
  }

  it('keeps the ordinary invoker RPC usable and its timestamp stable on replay', async () => {
    const id = randomUUID()
    const send = async () => (await db.query(`SELECT chat.send_message_with_overlays(
      $1,$2,$3,NULL,'Timestamp replay','text',NULL,NULL,false,false) AS result`, [id, group, owner])).rows[0].result.message
    const first = await send()
    await db.query('SELECT pg_sleep(0.01)')
    const replay = await send()
    expect(replay.id).toBe(first.id)
    expect(replay.seq).toBe(first.seq)
    expect(replay.created_at).toBe(first.created_at)
    expect((await db.query('SELECT count(*)::int AS n FROM chat.messages WHERE id=$1', [id])).rows[0].n).toBe(1)
    expect((await db.query("SELECT has_table_privilege('authenticated','chat.messages','INSERT') AS ok")).rows[0].ok).toBe(true)
  })

  it('retains explicit NULL rejection instead of silently generating a timestamp', async () => {
    await db.query('SAVEPOINT null_timestamp')
    await expect(db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,created_at)
      VALUES($1,$2,$3,'Null timestamp',NULL)`, [randomUUID(), group, owner])).rejects.toMatchObject({ code: '23502' })
    await db.query('ROLLBACK TO SAVEPOINT null_timestamp')
  })
})
