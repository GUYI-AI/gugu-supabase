import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const reply = 'chat.message_reply_preview_for(text,text)'
const callCount = async db => Number((await db.query('SELECT COALESCE(pg_stat_get_xact_function_calls($1::regprocedure),0) AS n', [reply])).rows[0].n)
async function as(db, user, sql, values = []) {
  await db.query("SELECT set_config('request.jwt.claims',$1,true),set_config('role','authenticated',true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  const result = await db.query(sql, values)
  await db.query('RESET ROLE')
  return result.rows
}
async function world(db) {
  const owner = randomUUID(), viewer = randomUUID(), outsider = randomUUID()
  const busy = randomUUID(), quiet = randomUUID()
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Owner'),($2,'human','Viewer'),($3,'human','Outsider')", [owner, viewer, outsider])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Busy',$3),($2,'group','Quiet',$3)", [busy, quiet, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role,inbox_published_at,hide_history_before) VALUES($1,$3,'owner',now(),NULL),($1,$4,'member',now(),NULL),($2,$3,'owner',now(),NULL),($2,$4,'member',now(),NULL)", [busy, quiet, owner, viewer])
  const post = async (chat, content, replyTo = null, whisper = false) => {
    const id = randomUUID()
    await db.query('INSERT INTO chat.messages(id,chat_id,sender_user_id,content,reply_to_message_id,is_whisper,to_user_ids) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, chat, owner, content, replyTo, whisper, whisper ? [viewer] : null])
    return id
  }
  return { owner, viewer, outsider, busy, quiet, post }
}

export const budgetCases = [
  ['reply columns share one function evaluation per row without changing visibility', async db => {
    const w = await world(db), replies = []
    for (let n = 0; n < 4; n++) replies.push(await w.post(w.busy, `reply-${n}`, await w.post(w.busy, `target-${n}`)))
    const before = await callCount(db)
    const rows = await as(db, w.viewer, 'SELECT id,reply_to_sender_user_id,reply_to_sender_name,reply_to_content FROM chat.messages_view WHERE id=ANY($1::text[]) ORDER BY reply_to_content', [replies])
    const calls = await callCount(db) - before
    assert.equal(rows.length, 4)
    assert.deepEqual(rows.map(row => row.reply_to_content), ['target-0','target-1','target-2','target-3'])
    assert.equal(calls, 4, 'all three reply columns share one call per distinct reply target')
    const beforeUnread = await callCount(db)
    await as(db, w.viewer, 'SELECT id,seq FROM chat.messages_view WHERE id=ANY($1::text[]) ORDER BY seq DESC', [replies])
    assert.equal(await callCount(db) - beforeUnread, 0, 'readers that omit reply columns must not compute them')
    assert.deepEqual(await as(db, w.outsider, 'SELECT id FROM chat.messages_view WHERE id=ANY($1::text[])', [replies]), [])
  }],
  ['per-chat top-one previews include quiet chats, preserve RLS and never call reply projection', async db => {
    const w = await world(db)
    const target = await w.post(w.busy, 'target')
    const quiet = await w.post(w.quiet, 'quiet-last')
    for (let n = 0; n < 12; n++) await w.post(w.busy, `busy-${n}`, target)
    const latest = await w.post(w.busy, 'busy-last', target)
    await w.post(w.busy, 'private-later', null, true)
    const before = await callCount(db)
    const rows = await as(db, w.viewer, 'SELECT * FROM chat.list_chat_previews($1)', [[w.busy,w.quiet,w.busy]])
    assert.equal(rows.length, 2)
    assert.equal(rows.find(row => row.chat_id === w.quiet).id, quiet)
    assert.equal(rows.find(row => row.chat_id === w.busy).id, latest)
    assert.equal(rows.find(row => row.chat_id === w.busy).preview, 'busy-last')
    assert.equal(await callCount(db) - before, 0)
    assert.deepEqual(await as(db, w.viewer, 'SELECT * FROM chat.list_chat_previews($1)', [[]]), [])
    assert.deepEqual(await as(db, w.outsider, 'SELECT * FROM chat.list_chat_previews($1)', [[w.busy,w.quiet]]), [])
    const columns = (await db.query("SELECT reloptions FROM pg_class WHERE oid='chat.messages_view'::regclass")).rows[0].reloptions
    assert.ok(columns.includes('security_invoker=true'))
  }],
  ['unread arrays retain the old result shape, exclude other chats and preserve old API grants', async db => {
    const w = await world(db)
    await w.post(w.busy, 'busy-unread'); await w.post(w.quiet, 'quiet-unread')
    const old = await as(db, w.viewer, 'SELECT * FROM chat.list_unread_locators($1)', [w.busy])
    assert.ok(old.length > 0, 'positive unread control')
    const selected = await as(db, w.viewer, 'SELECT * FROM chat.list_unread_locators_for_chats($1)', [[w.busy,w.busy]])
    assert.deepEqual(selected, old)
    assert.deepEqual(await as(db, w.viewer, 'SELECT * FROM chat.list_unread_locators_for_chats($1)', [[]]), [])
    assert.deepEqual(await as(db, w.outsider, 'SELECT * FROM chat.list_unread_locators_for_chats($1)', [[w.busy]]), [])
    for (const signature of ['chat.list_chat_previews(text[])','chat.list_unread_locators_for_chats(text[])','chat.list_unread_locators(text)']) {
      const permission = (await db.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS allowed,has_function_privilege('anon',$1,'EXECUTE') AS anonymous", [signature])).rows[0]
      assert.deepEqual(permission, { allowed: true, anonymous: false })
    }
    const cursor = (await db.query('SELECT revision::text FROM chat.account_revision_heads WHERE user_id=$1', [w.viewer])).rows[0].revision
    const newest = (await db.query('SELECT next_message_seq-1 AS seq FROM chat.chats WHERE id=$1', [w.busy])).rows[0].seq
    const read = await as(db, w.viewer, 'SELECT * FROM chat.mark_stream_read($1,$2,$3)', [w.busy, `main:${w.busy}`, newest])
    const sync = (await as(db, w.viewer, 'SELECT chat.sync_since($1,100) AS page', [cursor]))[0].page.operations
    const state = sync.find(operation => operation.event === 'member_read_changed').payload
    assert.equal(Number(state.version), read[0].version)
    assert.equal(state.stream_id, `main:${w.busy}`)
    assert.equal(state.is_marked_unread, false)
    const messageCursor = (await db.query('SELECT revision::text FROM chat.account_revision_heads WHERE user_id=$1', [w.viewer])).rows[0].revision
    const message = await w.post(w.busy, 'from-sync')
    const next = (await as(db, w.viewer, 'SELECT chat.sync_since($1,100) AS page', [messageCursor]))[0].page.operations
    assert.equal(next.find(operation => operation.event === 'message_created' && operation.payload.entity_id === message).payload.message.preview, 'from-sync')
    await db.query('UPDATE chat.chat_members SET conversation_deleted_at=now() WHERE chat_id=$1 AND user_id=$2', [w.busy,w.viewer])
    assert.deepEqual(await as(db, w.viewer, 'SELECT * FROM chat.list_unread_locators($1)', [w.busy]), [])
    assert.deepEqual(await as(db, w.viewer, 'SELECT * FROM chat.list_unread_locators_for_chats($1)', [[w.busy]]), [])
    assert.deepEqual((await as(db, w.viewer, 'SELECT * FROM chat.list_unread_locators_for_chats($1)', [[w.busy,w.quiet]])).map(row => row.chat_id), [w.quiet])
    assert.deepEqual(await as(db, w.viewer, 'SELECT * FROM chat.list_chat_previews($1)', [[w.busy]]), [])
    assert.deepEqual((await as(db, w.viewer, 'SELECT * FROM chat.list_chat_previews($1)', [[w.busy,w.quiet]])).map(row => row.chat_id), [w.quiet])
  }],
  ['unread hydrate runs one shared set query while the legacy signature delegates once', async db => {
    const w = await world(db)
    await w.post(w.busy, 'busy-unread'); await w.post(w.quiet, 'quiet-unread')
    const calls = async signature => Number((await db.query('SELECT COALESCE(pg_stat_get_xact_function_calls($1::regprocedure),0) AS n', [signature])).rows[0].n)
    const legacy = 'chat.list_unread_locators(text)', selected = 'chat.list_unread_locators_for_chats(text[])'
    const beforeLegacy = await calls(legacy)
    const rows = await as(db, w.viewer, 'SELECT * FROM chat.list_unread_locators_for_chats($1)', [[w.busy,w.quiet,w.busy,null]])
    assert.equal(rows.length, 2)
    assert.equal(await calls(legacy) - beforeLegacy, 0, 'array hydrate must not execute the old body once per conversation')
    const beforeSelected = await calls(selected)
    const all = await as(db, w.viewer, 'SELECT * FROM chat.list_unread_locators(NULL)')
    assert.deepEqual(all, rows)
    assert.equal(await calls(selected) - beforeSelected, 1, 'legacy NULL delegates to the same set body once')
    assert.deepEqual(await as(db, w.viewer, 'SELECT * FROM chat.list_unread_locators()'), rows)
    const metadata = (await db.query("SELECT prosecdef,provolatile,proconfig,proowner::regrole::text AS owner,pronargdefaults,proacl::text AS acl FROM pg_proc WHERE oid=$1::regprocedure", [legacy])).rows[0]
    assert.deepEqual(metadata, { prosecdef: true, provolatile: 's', proconfig: ['search_path=chat, public, pg_catalog'], owner: 'postgres', pronargdefaults: 1, acl: '{postgres=X/postgres,authenticated=X/postgres}' })
    assert.deepEqual(await as(db, w.outsider, 'SELECT * FROM chat.list_unread_locators_for_chats($1)', [[w.busy,w.quiet]]), [])
    await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1', [w.viewer])
    assert.deepEqual(await as(db, w.viewer, 'SELECT * FROM chat.list_unread_locators_for_chats($1)', [[w.busy,w.quiet]]), [])
  }],
]
