import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let owner: string, reader: string, chat: string, seq: string
const head = async (user: string) => (await db.query('SELECT revision::text FROM chat.account_revision_heads WHERE user_id=$1', [user])).rows[0]?.revision ?? '0'
async function asReader(sql: string, values: unknown[]) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: reader, role: 'authenticated' })])
  try { return (await db.query(sql, values)).rows }
  finally { await db.query('RESET ROLE') }
}
const changes = async (user: string, after: string) => (await db.query('SELECT event,resource_key FROM chat.account_revisions WHERE user_id=$1 AND revision>$2 ORDER BY revision', [user, after])).rows

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Main read revision tests require disposable loopback PostgreSQL')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); reader = randomUUID(); chat = randomUUID()
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Owner'),($2,'human','Reader')", [owner, reader])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Read fixture',$2)", [chat, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [chat, owner, reader])
  seq = (await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,'Unread message','text') RETURNING seq::text", [randomUUID(), chat, owner])).rows[0].seq
})
afterEach(async () => { await db?.query('ROLLBACK') })

describe('main read progress has one durable revision per recipient', () => {
  it('publishes the complete read tuple to the reader and peer without redundant own state', async () => {
    const readerBefore = await head(reader), peerBefore = await head(owner)
    const state = (await asReader('SELECT * FROM chat.mark_read($1,$2)', [chat, seq]))[0]
    const expected = [{ event: 'member_read_changed', resource_key: {
      chat_id: chat, entity_id: reader, last_read_seq: Number(seq), stream_id: `main:${chat}`,
      version: state.version, is_marked_unread: false,
    } }]
    expect(await changes(reader, readerBefore)).toEqual(expected)
    expect(await changes(owner, peerBefore)).toEqual(expected)
    expect((await asReader('SELECT unread_count FROM chat.list_unread_locators($1) WHERE stream_id=$2', [chat, `main:${chat}`]))[0]?.unread_count ?? '0').toBe('0')
  })

  it('keeps own invalidation when manual unread is cleared without advancing the cursor', async () => {
    await asReader('SELECT * FROM chat.mark_read($1,$2)', [chat, seq])
    await asReader('SELECT * FROM chat.mark_unread($1)', [chat])
    const before = await head(reader)
    await asReader('SELECT * FROM chat.mark_read($1,$2)', [chat, seq])
    expect(await changes(reader, before)).toEqual([{ event: 'chat_members_changed', resource_key: { chat_id: chat, user_id: reader, kind: 'own' } }])
    expect((await db.query('SELECT is_marked_unread FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chat, reader])).rows).toEqual([{ is_marked_unread: false }])
  })

  it.each(['is_pinned=true', "notification_level='none'", "contract='{}'::jsonb"])(
    'retains own state when a read also changes a non-read field: %s', async assignment => {
      const before = await head(reader)
      await db.query(`UPDATE chat.chat_members SET last_read_seq=$3,version=version+1,${assignment} WHERE chat_id=$1 AND user_id=$2`, [chat, reader, seq])
      expect((await changes(reader, before)).map(row => row.event).sort()).toEqual(['chat_members_changed', 'member_read_changed'])
    })

  it('treats newly added member fields as visible by default', async () => {
    await db.query('CREATE TEMP TABLE read_future_probe (LIKE chat.chat_members INCLUDING DEFAULTS) ON COMMIT DROP')
    await db.query('ALTER TABLE read_future_probe ADD COLUMN realtime_flow_future_field integer DEFAULT 0')
    await db.query('INSERT INTO read_future_probe SELECT m.*,0 FROM chat.chat_members m WHERE chat_id=$1 AND user_id=$2', [chat, reader])
    await db.query('CREATE TRIGGER revision_probe AFTER UPDATE ON read_future_probe FOR EACH ROW EXECUTE FUNCTION chat.publish_membership_revision()')
    const before = await head(reader)
    await db.query('UPDATE read_future_probe SET last_read_seq=$3,realtime_flow_future_field=1 WHERE chat_id=$1 AND user_id=$2', [chat, reader, seq])
    expect((await changes(reader, before)).map(row => row.event)).toEqual(['chat_members_changed'])
  })
})
