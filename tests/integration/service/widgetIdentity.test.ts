import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const origin = { text: 'Counter', app: 'counter', view: 'main' }
let db: pg.Client
let databaseUrl: string
const owner = randomUUID(), peer = randomUUID(), outsider = randomUUID(), agent = randomUUID(), group = randomUUID()
const sendSql = 'SELECT * FROM chat.send_widget($1,$2,$3,$4,$5,$6,$7::json,$8,$9)'

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Widget identity tests require disposable loopback PostgreSQL')
  }
  databaseUrl = url.href
  db = new pg.Client({ connectionString: databaseUrl })
  await db.connect()
  for (const [id, name] of [[owner, 'Widget owner'], [peer, 'Widget peer'], [outsider, 'Widget outsider']]) {
    await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@widget.invalid`])
    await db.query(`INSERT INTO identity.users(id,type,display_name) VALUES($1,'human',$2)
      ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name`, [id, name])
  }
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'widget fixture','widget fixture','linux')`, [agent, owner])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id)
    VALUES($1,'agent','Widget agent',$2,$1)`, [agent, owner])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Widget identity fixture',$2)", [group, owner])
  for (const id of [owner, peer, agent]) {
    await db.query('INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,$3)', [group, id, id === owner ? 'owner' : 'member'])
  }
})
afterAll(async () => { await db?.end() })
beforeEach(async () => { await db.query('BEGIN') })
afterEach(async () => { await db.query('ROLLBACK') })

async function as<T extends pg.QueryResultRow = pg.QueryResultRow>(actor: string, sql: string, params: unknown[] = []) {
  await db.query('SAVEPOINT actor')
  try {
    await db.query('SET LOCAL ROLE authenticated')
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor])
    const result = await db.query<T>(sql, params)
    await db.query('RESET ROLE')
    await db.query('RELEASE SAVEPOINT actor')
    return result.rows
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT actor')
    await db.query('RELEASE SAVEPOINT actor')
    throw error
  }
}

function params(id = randomUUID(), sender = agent, data: string | null = null, text = origin.text) {
  return [id, group, sender, text, origin.app, origin.view, data, null, null]
}
const send = (values = params(), actor = owner) => as<{ message_id: string; widget_id: string; seq: string }>(actor, sendSql, values)
const read = (actor: string, id: string) => as(actor, 'SELECT id,chat_id,message_id,app,view,text,data,created_by FROM chat.widgets WHERE id=$1', [id])

describe('widget identities', () => {
  it('assigns an independent id, registers the original sender, and replays one message', async () => {
    const values = params(randomUUID(), agent, '{"count":1}')
    const [first] = await send(values)
    expect(first!.widget_id).not.toBe(first!.message_id)
    expect(await send(values)).toEqual([first])
    const message = (await db.query('SELECT content,seq,client_message_id FROM chat.messages WHERE id=$1', [first!.message_id])).rows[0]
    expect(JSON.parse(message.content)).toEqual({ v: 2, ...origin, data: { count: 1 }, wid: first!.widget_id })
    expect(message.client_message_id).toBe(first!.message_id)
    expect(await read(peer, first!.widget_id)).toEqual([expect.objectContaining({
      id: first!.widget_id, message_id: first!.message_id, chat_id: group, created_by: agent, data: { count: 1 },
    })])
    await expect(send(params(String(values[0]), agent, '{"count":2}'))).rejects.toMatchObject({ code: '23505' })
    expect((await db.query('SELECT id FROM chat.widgets WHERE message_id=$1', [first!.message_id])).rows).toHaveLength(1)
    expect((await db.query('SELECT message_id FROM chat.widget_id_grants')).rows).toEqual([])
  })

  it('keeps the original raw JSON data byte boundary rather than jsonb whitespace', async () => {
    const raw = JSON.stringify({ p: 'x'.repeat(4088) })
    expect(Buffer.byteLength(raw)).toBe(4096)
    const [row] = await send(params(randomUUID(), agent, raw))
    const bytes = (await db.query('SELECT octet_length(data::text) AS bytes FROM chat.widgets WHERE id=$1', [row!.widget_id])).rows[0].bytes
    expect(bytes).toBeGreaterThan(4096)
    const invalid = params(randomUUID(), agent, JSON.stringify({ p: 'x'.repeat(4089) }))
    await expect(send(invalid)).rejects.toMatchObject({ code: '23514', constraint: 'messages_widget_shape' })
    expect((await db.query('SELECT id FROM chat.messages WHERE id=$1', [invalid[0]])).rows).toEqual([])
  })

  it('preserves the existing height override through the idempotent widget writer', async () => {
    const values = params()
    const sql = 'SELECT * FROM chat.send_widget($1,$2,$3,$4,$5,$6,$7::json,$8,$9,$10)'
    const sent = await as(owner, sql, [...values, 360])
    expect(await as(owner, sql, [...values, 360])).toEqual(sent)
    expect(JSON.parse((await db.query('SELECT content FROM chat.messages WHERE id=$1', [values[0]])).rows[0].content))
      .toMatchObject({ ...origin, height: 360, wid: sent[0]!.widget_id })
    await expect(as(owner, sql, [...params(), 521])).rejects.toMatchObject({ code: '23514' })
    await expect(as(owner, sql, [...values, 480])).rejects.toMatchObject({ code: '23505' })
  })

  it('projects registry ids through the original actor-scoped history rather than the owner view', async () => {
    const [row] = await send(params(randomUUID(), owner))
    const history = () => as(owner, 'SELECT id,widget_id FROM chat.message_history_as($1,$2)', [group, agent])
    expect(await history()).toEqual([{ id: row!.message_id, widget_id: row!.widget_id }])
    expect(await as(owner, 'SELECT id,content_type,is_whisper FROM chat.message_history_as($1,$2)', [group, agent]))
      .toEqual([{ id: row!.message_id, content_type: 'widget', is_whisper: false }])
    await db.query('UPDATE chat.messages SET deleted_for_user_ids=$1::jsonb WHERE id=$2', [JSON.stringify([owner]), row!.message_id])
    expect(await read(owner, row!.widget_id)).toEqual([])
    expect(await history()).toEqual([{ id: row!.message_id, widget_id: row!.widget_id }])
    await db.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1', [row!.message_id])
    expect(await history()).toEqual([{ id: row!.message_id, widget_id: null }])
    expect(await as(outsider, 'SELECT id,widget_id FROM chat.message_history_as($1,$2)', [group, outsider])).toEqual([])
  })

  it('adds registry ids to the existing inbox page only for registered widget messages', async () => {
    const widgetId = randomUUID(), textId = randomUUID()
    await as(owner, `INSERT INTO chat.messages(id,chat_id,sender_user_id,to_user_ids,content,content_type)
      VALUES($1,$2,$3,$4,$5,'widget'),($6,$2,$3,$4,'ordinary','text')`,
      [widgetId, group, owner, [agent], JSON.stringify({ v: 2, ...origin }), textId])
    // Widgets do not create wakes. Exercise the projection of an existing
    // persisted wake without changing that canonical send-time rule.
    expect((await db.query('SELECT message_id FROM chat.message_agent_wakes WHERE message_id=$1', [widgetId])).rows).toEqual([])
    expect(await as(owner, 'SELECT id,widget_id FROM identity.pull_agent_inbox_v2($1,$2)', [agent, group]))
      .toEqual([{ id: textId, widget_id: null }])
    await db.query('INSERT INTO chat.message_agent_wakes(message_id,agent_user_id) VALUES($1,$2)', [widgetId, agent])
    expect(await as(owner, 'SELECT id,widget_id FROM identity.pull_agent_inbox_v2($1,$2)', [agent, group]))
      .toEqual([{ id: widgetId, widget_id: widgetId }, { id: textId, widget_id: null }])
    expect(await as(owner, 'SELECT id,content_type FROM identity.pull_agent_inbox_v2($1,$2)', [agent, group]))
      .toEqual([{ id: widgetId, content_type: 'widget' }, { id: textId, content_type: 'text' }])
  })

  it('uses the same registration for a legacy direct send without changing its content', async () => {
    const id = randomUUID(), content = JSON.stringify({ v: 2, ...origin, data: { legacy: true } })
    await as(owner, `INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type)
      VALUES($1,$2,$3,$4,'widget')`, [id, group, agent, content])
    expect(await read(peer, id)).toEqual([expect.objectContaining({ id, message_id: id, data: { legacy: true } })])
    expect((await db.query('SELECT content FROM chat.messages WHERE id=$1', [id])).rows[0].content).toBe(content)
    for (const legacy of ['{', '{"id":"old","title":"Legacy"}', '{"v":"2"}']) {
      const oldId = randomUUID()
      await as(owner, `INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type)
        VALUES($1,$2,$3,$4,'widget')`, [oldId, group, agent, legacy])
      expect(await read(peer, oldId)).toEqual([])
    }
  })

  it('refuses a client-selected wid even when authenticated spoofs the exact transaction marker', async () => {
    const id = randomUUID(), wid = randomUUID()
    await db.query('SAVEPOINT forged_marker')
    try {
      await db.query('SET LOCAL ROLE authenticated')
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('gugu.send_widget',$2,true)", [owner, JSON.stringify({ message_id: id, wid })])
      await expect(db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type)
        VALUES($1,$2,$3,$4,'widget')`, [id, group, agent, JSON.stringify({ v: 2, ...origin, wid })])).rejects.toMatchObject({ code: '42501' })
    } finally {
      await db.query('ROLLBACK TO SAVEPOINT forged_marker')
      await db.query('RELEASE SAVEPOINT forged_marker')
    }
    expect((await db.query('SELECT id FROM chat.messages WHERE id=$1', [id])).rows).toEqual([])
    expect((await db.query('SELECT id FROM chat.widgets WHERE id=$1', [wid])).rows).toEqual([])
  })

  it('refuses other people, nonmembers and direct specification writes', async () => {
    await expect(send(params(randomUUID(), peer))).rejects.toMatchObject({ code: '42501' })
    await expect(send(params(randomUUID(), outsider), outsider)).rejects.toMatchObject({ code: '42501' })
    const [row] = await send()
    await expect(as(owner, "UPDATE chat.widgets SET text='Changed' WHERE id=$1", [row!.widget_id])).rejects.toMatchObject({ code: '42501' })
    await expect(as(owner, 'DELETE FROM chat.widgets WHERE id=$1', [row!.widget_id])).rejects.toMatchObject({ code: '42501' })
    await expect(as(owner, 'SELECT chat.register_widget_message(m) FROM chat.messages m WHERE id=$1', [row!.message_id])).rejects.toMatchObject({ code: '42501' })
    await expect(as(owner, 'INSERT INTO chat.widget_id_grants(message_id,wid) VALUES($1,$2)', [randomUUID(), row!.widget_id])).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses a spoofed marker through the public canonical message writer too', async () => {
    const [existing] = await send()
    const id = randomUUID(), content = JSON.stringify({ v: 2, ...origin, wid: existing!.widget_id })
    await as(owner, "SELECT set_config('gugu.send_widget',$1,true)", [JSON.stringify({ message_id: id, wid: existing!.widget_id })])
    await expect(as(owner, `SELECT * FROM chat.send_message_idempotent($1,$2,$3,NULL,$4,'widget',NULL,NULL,false,false)`,
      [id, group, agent, content])).rejects.toMatchObject({ code: '42501' })
    expect((await db.query('SELECT id FROM chat.messages WHERE id=$1', [id])).rows).toEqual([])
    expect((await db.query('SELECT message_id FROM chat.widget_id_grants')).rows).toEqual([])
  })

  it('rejects a legacy message whose fallback id aliases another widget without revealing its origin', async () => {
    const [existing] = await send()
    await expect(as(owner, `INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type)
      VALUES($1,$2,$3,$4,'widget')`, [existing!.widget_id, group, agent, JSON.stringify({ v: 2, ...origin, app: 'another-app' })]))
      .rejects.toMatchObject({ code: '23505', message: 'Widget could not be sent', detail: undefined })
    expect((await db.query('SELECT id FROM chat.messages WHERE id=$1', [existing!.widget_id])).rows).toEqual([])
    expect(await read(owner, existing!.widget_id)).toEqual([expect.objectContaining({ message_id: existing!.message_id, app: origin.app })])
  })

  it('rolls back a generated identity collision through the same unique constraint', async () => {
    const values = params()
    // Occupy the generated id immediately before the RPC message is inserted.
    // The nested legacy send still registers through the real insert trigger.
    await db.query(`CREATE FUNCTION chat.fixture_widget_collision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${values[0]}' THEN
          INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type)
            VALUES(NEW.content::jsonb->>'wid',NEW.chat_id,NEW.sender_user_id,
              '{"v":2,"text":"Occupied legacy identity","app":"legacy","view":"main"}','widget');
        END IF;
        RETURN NEW;
      END $$`)
    await db.query('CREATE TRIGGER aaa_fixture_widget_collision BEFORE INSERT ON chat.messages FOR EACH ROW EXECUTE FUNCTION chat.fixture_widget_collision()')
    await expect(send(values)).rejects.toMatchObject({ code: '23505', message: 'Widget could not be sent', detail: undefined })
    expect((await db.query('SELECT id FROM chat.messages WHERE id=$1', [values[0]])).rows).toEqual([])
    expect((await db.query('SELECT message_id FROM chat.widget_id_grants')).rows).toEqual([])
  })

  it('keeps widget content and type immutable while preserving metadata-only retraction', async () => {
    const [row] = await send(params(randomUUID(), owner))
    const before = (await db.query('SELECT content FROM chat.messages WHERE id=$1', [row!.message_id])).rows[0].content
    await expect(as(owner, 'UPDATE chat.messages SET content=$1 WHERE id=$2', [JSON.stringify({ v: 2, ...origin }), row!.message_id])).rejects.toMatchObject({ code: '42501' })
    await expect(as(owner, "UPDATE chat.messages SET content_type='text' WHERE id=$1", [row!.message_id])).rejects.toMatchObject({ code: '42501' })
    const textId = randomUUID()
    await as(owner, "INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'ordinary')", [textId, group, owner])
    await expect(as(owner, "UPDATE chat.messages SET content_type='widget',content=$1 WHERE id=$2", [JSON.stringify({ v: 2, ...origin }), textId])).rejects.toMatchObject({ code: '42501' })
    await as(owner, 'UPDATE chat.messages SET retracted_at=now(),content=content WHERE id=$1', [row!.message_id])
    expect((await db.query('SELECT content,retracted_at FROM chat.messages WHERE id=$1', [row!.message_id])).rows[0]).toMatchObject({ content: before, retracted_at: expect.any(Date) })
    expect(await read(owner, row!.widget_id)).toEqual([])
  })

  it('follows original-message RLS, delete-for-me, retraction and membership removal', async () => {
    const [row] = await send()
    expect(await read(outsider, row!.widget_id)).toEqual([])
    await db.query('UPDATE chat.messages SET deleted_for_user_ids=$1::jsonb WHERE id=$2', [JSON.stringify([peer]), row!.message_id])
    expect(await read(peer, row!.widget_id)).toEqual([])
    expect(await read(owner, row!.widget_id)).toHaveLength(1)
    await db.query('UPDATE chat.messages SET deleted_for_user_ids=\'[]\',retracted_at=now() WHERE id=$1', [row!.message_id])
    expect(await read(owner, row!.widget_id)).toEqual([])
    await db.query('UPDATE chat.messages SET retracted_at=NULL WHERE id=$1', [row!.message_id])
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [group, peer])
    expect(await read(peer, row!.widget_id)).toEqual([])
  })

  it('resolves a cold retracted reference without exposing its specification or an unreadable origin', async () => {
    const [row] = await send()
    const lookup = (actor: string) => as(actor, 'SELECT * FROM chat.widget_origin($1)', [row!.widget_id])
    expect(await lookup(peer)).toEqual([{ widget_id: row!.widget_id, origin_message_id: row!.message_id, is_retracted: false }])
    expect(await lookup(outsider)).toEqual([])
    expect(await as(peer, 'SELECT * FROM chat.widget_origin($1)', [randomUUID()])).toEqual([])
    await db.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1', [row!.message_id])
    expect(await read(peer, row!.widget_id)).toEqual([])
    expect(await lookup(peer)).toEqual([{ widget_id: row!.widget_id, origin_message_id: row!.message_id, is_retracted: true }])
    await db.query('UPDATE chat.messages SET deleted_for_user_ids=$1::jsonb WHERE id=$2', [JSON.stringify([peer]), row!.message_id])
    expect(await lookup(peer)).toEqual([])
    expect(await lookup(owner)).toHaveLength(1)
    await db.query('UPDATE chat.messages SET deleted_for_user_ids=\'[]\' WHERE id=$1', [row!.message_id])
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [group, peer])
    expect(await lookup(peer)).toEqual([])
  })

  it('keeps cold origin lookup subject to whisper visibility and supports legacy text ids', async () => {
    const id = `legacy/widget-${randomUUID()}`
    await as(owner, `INSERT INTO chat.messages(id,chat_id,sender_user_id,to_user_ids,is_whisper,content,content_type)
      VALUES($1,$2,$3,$4,true,$5,'widget')`, [id, group, owner, [agent], JSON.stringify({ v: 2, ...origin })])
    await db.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1', [id])
    expect(await as(owner, 'SELECT * FROM chat.widget_origin($1)', [id]))
      .toEqual([{ widget_id: id, origin_message_id: id, is_retracted: true }])
    expect(await as(peer, 'SELECT * FROM chat.widget_origin($1)', [id])).toEqual([])
    await db.query('DELETE FROM chat.messages WHERE id=$1', [id])
    expect(await as(owner, 'SELECT * FROM chat.widget_origin($1)', [id])).toEqual([])
  })

  it('does not reveal a legacy whisper specification to another member', async () => {
    const id = randomUUID()
    await as(owner, `INSERT INTO chat.messages(id,chat_id,sender_user_id,to_user_ids,is_whisper,content,content_type)
      VALUES($1,$2,$3,$4,true,$5,'widget')`, [id, group, owner, [agent], JSON.stringify({ v: 2, ...origin })])
    expect(await read(owner, id)).toHaveLength(1)
    expect(await read(peer, id)).toEqual([])
    await db.query('DELETE FROM chat.messages WHERE id=$1', [id])
    expect((await db.query('SELECT id FROM chat.widgets WHERE id=$1', [id])).rows).toEqual([])
  })

  it('allocates once when the same message is sent concurrently', async () => {
    const clients = [new pg.Client({ connectionString: databaseUrl }), new pg.Client({ connectionString: databaseUrl })]
    const values = params()
    try {
      await Promise.all(clients.map(async client => {
        await client.connect()
        await client.query('SET ROLE authenticated')
        await client.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner])
      }))
      const [a, b] = await Promise.all(clients.map(client => client.query(sendSql, values)))
      expect(a!.rows).toEqual(b!.rows)
      expect((await db.query('SELECT id FROM chat.widgets WHERE message_id=$1', [values[0]])).rows).toHaveLength(1)
    } finally {
      await Promise.all(clients.map(client => client.end()))
    }
  })
})
