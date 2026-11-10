import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

// 20261110054000: a chat's preview has one definition (chat.list_chat_previews); the cold-start snapshot calls it.
// Before, sync_snapshot had no preview_source (a link changed shape on hydrate), and both took a recalled message's text
// and a message deleted for the viewer as the preview.
let db: Client
let viewer: string, peer: string
const chats = new Map<string, string>()

async function asViewer<Row = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<Row[]> {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: viewer, role: 'authenticated' })])
  await db.query('SET LOCAL ROLE authenticated')
  try { return (await db.query(sql, values)).rows as Row[] } finally { await db.query('RESET ROLE') }
}
async function chat(label: string, latest: string, change?: (id: string) => Promise<unknown>, extra: { whisper?: boolean } = {}) {
  const id = randomUUID(), message = randomUUID()
  chats.set(label, id)
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group',$2,$3)", [id, label, viewer])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [id, viewer, peer])
  await db.query('UPDATE chat.chat_members SET inbox_published_at=clock_timestamp() WHERE chat_id=$1', [id])
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'earlier')", [randomUUID(), id, peer])
  await db.query('INSERT INTO chat.messages(id,chat_id,sender_user_id,content,is_whisper,to_user_ids) VALUES($1,$2,$3,$4,$5,$6)',
    [message, id, peer, latest, extra.whisper ?? false, extra.whisper ? [viewer] : null])
  await change?.(message)
}
type Row = { chat_id: string; id: string | null; preview: string | null; preview_source: string | null; retracted_at: string | null }
const pick = (r: Row) => ({ id: r.id, preview: r.preview, preview_source: r.preview_source, retracted: r.retracted_at !== null })

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
  chats.clear(); [viewer, peer] = [randomUUID(), randomUUID()]
  await db.query("INSERT INTO identity.users(id,type,display_name) SELECT id,'human','Preview fixture' FROM unnest($1::text[]) id", [[viewer, peer]])
  await chat('link', 'see gugu-chat://abc/def')
  await chat('recalled', 'secret gugu-chat://x', id => db.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1', [id]))
  await chat('deleted_for_me', 'gone for me', id => db.query('UPDATE chat.messages SET deleted_for_user_ids=jsonb_build_array($2::text) WHERE id=$1', [id, viewer]))
  await chat('whisper', 'psst', undefined, { whisper: true })
  await chat('text', 'hello')
})
afterEach(async () => { await db.query('ROLLBACK') })

it('the snapshot and the hydrate read return the same preview for every chat', async () => {
  const snapshot = (await asViewer<{ s: { previews: Row[] } }>('SELECT chat.sync_snapshot() AS s'))[0]!.s.previews
  const listed = await asViewer<Row>('SELECT * FROM chat.list_chat_previews($1)', [[...chats.values()]])
  for (const [label, id] of chats) {
    const a = snapshot.find(r => r.chat_id === id), b = listed.find(r => r.chat_id === id)
    expect(a && pick(a), label).toEqual(b && pick(b))
  }
  const by = (label: string) => listed.find(r => r.chat_id === chats.get(label))!
  expect(by('link').preview_source).toBe('see gugu-chat://abc/def')
  expect([by('recalled').preview, by('recalled').preview_source, by('recalled').retracted_at === null]).toEqual(['[Recalled]', null, false])
  expect(by('deleted_for_me').preview).toBe('earlier')
  expect(by('whisper').preview).toBe('earlier')
  expect(by('text').preview).toBe('hello')
})
