import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: pg.Client, owner: string, outsider: string, chat: string
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Owned loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); outsider = randomUUID(); chat = randomUUID()
  for (const id of [owner, outsider]) await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Preview fixture')", [id])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Preview fixture',$2)", [chat, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [chat, owner])
})
afterEach(async () => { await db.query('ROLLBACK') })

async function post(content: string, type = 'text') {
  const id = randomUUID()
  await db.query('INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,$4,$5)', [id, chat, owner, content, type])
  return id
}
async function read(actor: string) {
  await db.query('SAVEPOINT reader; SET LOCAL ROLE authenticated')
  try {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor])
    const result = await db.query('SELECT id,preview,preview_source FROM chat.list_chat_previews($1)', [[chat]])
    return result.rows
  } finally { await db.query('ROLLBACK TO SAVEPOINT reader; RELEASE SAVEPOINT reader') }
}

describe('the chat list preview carries reference source only when it may', () => {
  it('keeps ordinary long replies at the old 100-character preview without transporting their body', async () => {
    const id = await post('ordinary '.repeat(16000))
    expect(await read(owner)).toEqual([{ id, preview: ('ordinary '.repeat(16000)).slice(0, 100), preview_source: null }])
  })

  it.each(['gugu-widget://one', 'gugu-chat://one/two', 'GuGu-WiDgEt://one', '`gugu-widget://inline-code`'])('returns original source for the shared AST to classify: %s', async href => {
    const source = 'prefix '.repeat(15) + '\n\n' + href
    const id = await post(source)
    expect(await read(owner)).toEqual([{ id, preview: source.slice(0, 100), preview_source: source }])
  })

  it('does not return source for attachments or widget specs that happen to contain a marker', async () => {
    await post('[附件] file.txt (text/plain)\n[URL] gugu-widget://example', 'attachment')
    expect((await read(owner))[0]?.preview_source).toBeNull()
    await post(JSON.stringify({ v: 2, text: 'gugu-widget://example', app: 'counter', view: 'main' }), 'widget')
    expect((await read(owner))[0]?.preview_source).toBeNull()
  })

  it('inherits the messages RLS; one visibility rule for the whole row (personal deletion, recall)', async () => {
    const earlier = await post('earlier line')
    const id = await post('gugu-widget://private')
    expect((await read(owner))[0]?.id).toBe(id)
    expect(await read(outsider)).toEqual([])
    expect((await read(owner))[0]?.preview_source).toBe('gugu-widget://private')
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [chat, outsider])
    await db.query('UPDATE chat.messages SET deleted_for_user_ids=$1::jsonb WHERE id=$2', [JSON.stringify([owner]), id])
    // Deleted for the owner: not the owner's latest message any more (20261110054000), as in the owner's transcript.
    expect(await read(owner)).toEqual([{ id: earlier, preview: 'earlier line', preview_source: null }])
    expect((await read(outsider))[0]?.preview_source).toBe('gugu-widget://private')
    await db.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1', [id])
    // Recalled: still the latest message, saying nothing of what it said.
    expect(await read(outsider)).toEqual([{ id, preview: '[Recalled]', preview_source: null }])
  })

  it('keeps the list RPC a stable invoker function for signed-in people only, and adds no messages column', async () => {
    const { rows } = await db.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon
      FROM pg_proc p WHERE p.oid='chat.list_chat_previews(text[])'::regprocedure`)
    expect(rows).toEqual([{ prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], authenticated: true, anon: false }])
    expect((await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='chat' AND table_name='messages' AND column_name='preview_source'")).rows).toEqual([])
    expect((await db.query("SELECT chat.message_preview('gugu-widget://one','text') AS preview")).rows).toEqual([{ preview: 'gugu-widget://one' }])
  })
})
