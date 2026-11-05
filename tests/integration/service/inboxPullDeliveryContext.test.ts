import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// identity.pull_agent_inbox_v2 hands the host what it used to read one call at a time after the pull: the rules
// in force on the line (chat.chat_facts, and the topic's source group) and the identities the envelope names.

let db: Client
let owner: string, outsider: string, agent: string, peer: string, device: string, group: string

async function asOwner() {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
}

async function pull() {
  await asOwner()
  const { rows } = await db.query('SELECT id, chat_kind, group_rules, named_identities FROM identity.pull_agent_inbox_v2($1) ORDER BY chat_id, seq', [agent])
  await db.query('RESET ROLE')
  return new Map(rows.map((row) => [row.id as string, row]))
}

async function send(chat: string, to: string[] | null, options: { sender?: string; replyTo?: string } = {}) {
  const id = randomUUID()
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,to_user_ids,reply_to_message_id)
    VALUES($1,$2,$3,'Delivery context fixture',$4,$5)`, [id, chat, options.sender ?? owner, to, options.replyTo ?? null])
  return id
}

async function topicIn(chat: string, prompt: string | null) {
  const anchor = randomUUID(), id = randomUUID()
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,'source message')`, [anchor, chat, owner])
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id,source_chat_id,source_message_id,group_prompt)
    VALUES ($1,'topic','topic',$2,$3,$4,$5)`, [id, owner, chat, anchor, prompt])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role,listen_mode) VALUES ($1,$2,'owner','passive'),($1,$3,'member','passive')`, [id, owner, agent])
  return id
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Inbox delivery context requires the disposable loopback database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, outsider, agent, peer, device, group] = Array.from({ length: 6 }, randomUUID)
  for (const id of [owner, outsider]) {
    await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@inbox-context.invalid`])
  }
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'Context fixture','Context fixture','darwin')`, [device, owner])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,desired_status)
    VALUES($1,'agent','Claude 1',$3,$4,'online'),($2,'agent','Peer agent',$3,$4,'online')`, [agent, peer, owner, device])
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id,group_prompt) VALUES($1,'group','Context fixture',$2,'Group rules')`, [group, owner])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role,listen_mode)
    VALUES($1,$2,'owner','passive'),($1,$3,'member','passive'),($1,$4,'member','passive'),($1,$5,'member','passive')`,
  [group, owner, outsider, agent, peer])
})
afterEach(async () => { await db.query('ROLLBACK') })

describe('pull_agent_inbox_v2 delivery context', () => {
  it('returns the rules in force on each room line, inherited by a topic without its own', async () => {
    const inGroup = await send(group, [agent])
    const inheriting = await send(await topicIn(group, null), [agent])
    const own = await send(await topicIn(group, 'Topic rules'), [agent])
    await db.query("UPDATE chat.chats SET group_prompt='   ' WHERE id=(SELECT chat_id FROM chat.messages WHERE id=$1)", [inheriting])
    const rows = await pull()
    expect(rows.get(inGroup)?.group_rules).toBe('Group rules')
    expect(rows.get(inheriting)?.group_rules).toBe('Group rules')
    expect(rows.get(own)?.group_rules).toBe('Topic rules')
  })

  it("returns '' on a room with no rules", async () => {
    await db.query('UPDATE chat.chats SET group_prompt=NULL WHERE id=$1', [group])
    const message = await send(group, [agent])
    expect((await pull()).get(message)?.group_rules).toBe('')
  })

  it('judges blank rules by exactly the characters the hosts trim', async () => {
    // Every BMP code point but NUL (which text cannot hold) and the lone surrogates (which UTF-8 cannot).
    const points = Array.from({ length: 0x10000 }, (_, point) => point).filter((point) => point > 0 && (point < 0xd800 || point > 0xdfff))
    const { rows } = await db.query<{ point: number; present: boolean }>(
      'SELECT point, chat.group_prompt_present(chr(point)) AS present FROM unnest($1::int[]) AS point', [points])
    const disagree = rows.filter((row) => row.present !== (String.fromCodePoint(row.point).trim() !== '')).map((row) => row.point)
    expect(rows).toHaveLength(points.length)
    expect(disagree).toEqual([])
    expect((await db.query("SELECT chat.group_prompt_present(NULL) AS a, chat.group_prompt_present('') AS b")).rows[0]).toEqual({ a: false, b: false })
  })

  it('stores no blank rules from any writer, keeps text as given, and a topic with blank rules inherits', async () => {
    const blank = '\n\t\u00a0\u3000\ufeff '
    const topic = await topicIn(group, blank)
    const stored = async (id: string) => (await db.query('SELECT group_prompt FROM chat.chats WHERE id=$1', [id])).rows[0]?.group_prompt
    expect(await stored(topic)).toBeNull()
    const inTopic = await send(topic, [agent])
    expect((await pull()).get(inTopic)?.group_rules).toBe('Group rules')
    await db.query('UPDATE chat.chats SET group_prompt=$2 WHERE id=$1', [group, blank])
    expect(await stored(group)).toBeNull()
    await db.query('UPDATE chat.chats SET group_prompt=$2 WHERE id=$1', [group, '\n  Rules with an edge \n'])
    expect(await stored(group)).toBe('\n  Rules with an edge \n')
  })

  it('names the recipients and the quoted sender, never the sender itself', async () => {
    const quoted = await send(group, null, { sender: peer })
    const message = await send(group, [agent, peer, '*'], { sender: outsider, replyTo: quoted })
    const named = (await pull()).get(message)?.named_identities as Record<string, { type: string; display_name: string }>
    expect(Object.keys(named).sort()).toEqual([agent, peer].sort())
    expect(named[agent]).toMatchObject({ type: 'agent', display_name: 'Claude 1' })
    expect(named[outsider]).toBeUndefined()
  })

  it('keeps the arguments, the grant and the closed anon access of the replaced function', async () => {
    const signature = 'identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint)'
    expect((await db.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed).toBe(true)
    expect((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed).toBe(false)
  })
})
