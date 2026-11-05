import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let admin: string, owner: string, outsider: string, agent: string, sibling: string, foreignAgent: string
let source: string, anchor: string, topic: string
async function asUser(id: string) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function open(actor = admin, members: string[] = []) {
  await asUser(actor === agent ? owner : actor === foreignAgent ? outsider : actor)
  const result = await db.query('SELECT * FROM chat.create_topic($1,$2,$3,$4,$5)', [source, anchor, 'Enrollment topic', members, actor])
  await db.query('RESET ROLE')
  return result.rows[0].chat_id as string
}
async function send(actor = admin, targets: string[] = [], id = randomUUID(), direct = false) {
  await asUser(actor === agent ? owner : actor === foreignAgent ? outsider : actor)
  if (direct) {
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,to_user_ids) VALUES($1,$2,$3,'Enrollment message',$4)`, [id, topic, actor, targets])
  } else {
    await db.query(`SELECT chat.send_message_idempotent(p_message_id=>$1,p_chat_id=>$2,p_sender_user_id=>$3,p_to_user_ids=>$4,p_content=>'Enrollment message',p_content_type=>'text',p_reply_to_message_id=>NULL,p_thread_root_id=>NULL,p_is_thread_root=>false,p_is_whisper=>false)`, [id, topic, actor, targets])
  }
  await db.query('RESET ROLE')
  return id
}
async function member(id: string, chat = topic) {
  return (await db.query('SELECT * FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chat, id])).rows[0]
}
async function denied(work: () => Promise<unknown>) {
  await db.query('SAVEPOINT denied')
  try { await work() } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT denied')
    await db.query('RESET ROLE')
    return (error as Error).message
  }
  throw new Error('Expected admission to fail')
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Topic enrollment requires the disposable loopback database')
  }
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[admin, owner, outsider, agent, sibling, foreignAgent, source, anchor] = Array.from({ length: 8 }, randomUUID)
  for (const id of [admin, owner, outsider]) {
    await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@topic-owner-enrollment.invalid`])
  }
  for (const human of [owner, outsider]) {
    await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','darwin')`, ['topic-owner-' + human, human])
  }
  for (const [id, human] of [[agent, owner], [sibling, owner], [foreignAgent, outsider]]) {
    await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Enrollment agent',$2,$3)`, [id, human, 'topic-owner-' + human])
  }
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Source',$2)`, [source, admin])
  for (const [id, role] of [[admin, 'owner'], [owner, 'member'], [agent, 'member'], [sibling, 'member'], [foreignAgent, 'member']]) {
    await db.query('INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,$3)', [source, id, role])
  }
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Topic source')`, [anchor, source, admin])
  topic = await open()
})
afterEach(async () => {
  try { await db.query('RESET ROLE'); await db.query('SET CONSTRAINTS ALL IMMEDIATE') }
  finally { await db.query('ROLLBACK') }
})

describe('Agent topic participation carries its eligible human owner', () => {
  it('enrolls the human owner of every initial Agent, once for shared owners', async () => {
    topic = await open(admin, [agent, sibling])
    expect(await member(owner)).toMatchObject({ role: 'member' })
    expect(await member(agent)).toBeTruthy()
    expect(await member(sibling)).toBeTruthy()
    expect((await db.query('SELECT user_id FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [topic, owner])).rows).toHaveLength(1)
  })
  it('preserves the human owner role when an Agent creates the topic', async () => {
    topic = await open(agent)
    expect(await member(owner)).toMatchObject({ role: 'member' })
    expect(await member(agent)).toMatchObject({ role: 'member' })
  })
  it.each([false, true])('enrolls a mentioned Agent and its owner through a message (direct=%s)', async (direct) => {
    const id = await send(admin, [agent], randomUUID(), direct)
    const message = (await db.query('SELECT ingest_seq FROM chat.messages WHERE id=$1', [id])).rows[0]
    expect(await member(owner)).toMatchObject({ role: 'member', joined_ingest_seq: String(BigInt(message.ingest_seq) - 1n) })
    expect(await member(agent)).toMatchObject({ joined_ingest_seq: String(BigInt(message.ingest_seq) - 1n) })
  })
  it('lets an Agent join by speaking and brings its source-member owner', async () => {
    await send(agent)
    expect(await member(owner)).toMatchObject({ role: 'member' })
    expect(await member(agent)).toBeTruthy()
  })
  it.each(['owner', 'agent'])('permits a related add-agent command initiated as %s before the owner participates', async (who) => {
    await asUser(owner)
    const result = await db.query('SELECT chat.add_group_agent($1,$2,$3,$4) AS receipt', [topic, agent, 'Enrollment', who === 'owner' ? owner : agent])
    await db.query('RESET ROLE')
    expect(result.rows[0].receipt.status).toBe('joined')
    expect(await member(owner)).toBeTruthy()
    expect(await member(agent)).toBeTruthy()
  })
  it('covers the related invitation RPC without turning topic participation into a pending group invitation', async () => {
    await asUser(owner)
    const result = await db.query('SELECT chat.request_group_invitation_as($1,$2,$3,$4) AS receipt', [topic, agent, 'Join this topic', owner])
    await db.query('RESET ROLE')
    expect(result.rows[0].receipt.status).toBe('joined')
    expect(await member(owner)).toBeTruthy()
    expect(await member(agent)).toBeTruthy()
  })
  it('does not reset an existing owner seat and is idempotent on message retry', async () => {
    topic = await open(owner)
    await db.query("UPDATE chat.chat_members SET listen_mode='passive',is_pinned=true WHERE chat_id=$1 AND user_id=$2", [topic, owner])
    const before = await member(owner)
    const id = await send(agent)
    await send(agent, [], id)
    expect(await member(owner)).toEqual(before)
    expect((await db.query('SELECT user_id FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [topic, agent])).rows).toHaveLength(1)
  })
  it('rejects a message whose target Agent owner cannot enter and rolls back sender/content/participants', async () => {
    const before = (await db.query('SELECT id FROM chat.messages WHERE chat_id=$1', [topic])).rows
    expect(await denied(() => send(admin, [agent, foreignAgent]))).toContain('human owner cannot join this topic')
    expect(await member(owner)).toBeUndefined()
    expect(await member(agent)).toBeUndefined()
    expect(await member(outsider)).toBeUndefined()
    expect(await member(foreignAgent)).toBeUndefined()
    expect((await db.query('SELECT id FROM chat.messages WHERE chat_id=$1', [topic])).rows).toEqual(before)
  })
  it('rejects invalid initial Agent ownership without leaving a half-created topic', async () => {
    const before = (await db.query("SELECT id FROM chat.chats WHERE kind='topic' AND source_chat_id=$1", [source])).rows
    expect(await denied(() => open(admin, [agent, foreignAgent]))).toContain('human owner cannot join this topic')
    expect((await db.query("SELECT id FROM chat.chats WHERE kind='topic' AND source_chat_id=$1", [source])).rows).toEqual(before)
  })
  it('rejects an ineligible Agent joining by speaking or its owner invoking add-agent', async () => {
    expect(await denied(() => send(foreignAgent))).toContain('not a member of its source conversation')
    await asUser(outsider)
    expect(await denied(() => db.query('SELECT chat.add_group_agent($1,$2,$3,$4)', [topic, foreignAgent, 'Join', foreignAgent]))).toContain('not a member of its source conversation')
    expect(await member(outsider)).toBeUndefined()
    expect(await member(foreignAgent)).toBeUndefined()
  })
  it('uses the same guard for privileged internal seat insertion', async () => {
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [topic, agent])
    expect(await member(owner)).toBeTruthy()
    expect(await denied(() => db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [topic, foreignAgent]))).toContain('not a member of its source conversation')
  })
  it('carries the owner when an internal caller moves an Agent seat to another topic', async () => {
    const previous = await open(admin, [agent])
    await db.query('UPDATE chat.chat_members SET chat_id=$1 WHERE chat_id=$2 AND user_id=$3', [topic, previous, agent])
    expect(await member(agent)).toBeTruthy()
    expect(await member(owner)).toBeTruthy()
    expect(await member(agent, previous)).toBeUndefined()
    expect(await member(owner, previous)).toBeTruthy()
  })
  it('keeps ordinary group admission restricted to members rather than auto-enrolling the owner there', async () => {
    const group = randomUUID()
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Other group',$2)", [group, admin])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [group, admin])
    await asUser(owner)
    expect(await denied(() => db.query('SELECT chat.add_group_agent($1,$2,$3,$4)', [group, agent, 'Enrollment', owner]))).toContain('actor_not_member')
    expect(await member(owner, group)).toBeUndefined()
    expect(await member(agent, group)).toBeUndefined()
  })
  it('keeps the trigger function private and member-table insertion closed to API callers', async () => {
    const grants = (await db.query(`SELECT has_function_privilege('anon','chat.enroll_topic_agent_owner()','execute') AS anon,
      has_function_privilege('authenticated','chat.enroll_topic_agent_owner()','execute') AS api,
      has_table_privilege('authenticated','chat.chat_members','insert') AS insert_allowed`)).rows[0]
    expect(grants).toEqual({ anon: false, api: false, insert_allowed: false })
  })
  it.each(['topic', 'source'])('cascades a human departure from %s through owned Agent seats and state', async (room) => {
    await asUser(owner)
    await db.query('SELECT chat.add_group_agent($1,$2,$3,$4)', [topic, agent, 'Join', owner])
    await db.query('RESET ROLE')
    expect((await db.query('SELECT agent_user_id FROM chat.group_agent_states WHERE chat_id=$1 AND agent_user_id=$2', [topic, agent])).rows).toHaveLength(1)
    await asUser(owner)
    await db.query('SELECT chat.remove_group_member_as($1,$2,$3)', [room === 'topic' ? topic : source, owner, owner])
    await db.query('RESET ROLE')
    expect(await member(owner)).toBeUndefined()
    expect(await member(agent)).toBeUndefined()
    expect((await db.query('SELECT agent_user_id FROM chat.group_agent_states WHERE chat_id=$1 AND agent_user_id=$2', [topic, agent])).rows).toEqual([])
    if (room === 'source') expect(await member(agent, source)).toBeUndefined()
    else expect(await member(agent, source)).toBeTruthy()
  })
  it('keeps the owner and sibling Agent when one Agent departs', async () => {
    await send(admin, [agent, sibling])
    await asUser(owner)
    await db.query('SELECT chat.remove_group_member_as($1,$2,$3)', [topic, agent, owner])
    await db.query('RESET ROLE')
    expect(await member(owner)).toBeTruthy()
    expect(await member(sibling)).toBeTruthy()
    expect(await member(agent)).toBeUndefined()
  })
  it('does not backfill or remove an already-present historical orphan on no-op admission/departure', async () => {
    // Simulate a committed pre-release seat without disabling other sessions' triggers.
    await db.query("SET LOCAL session_replication_role='replica'")
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role,joined_ingest_seq) VALUES($1,$2,'member',0)", [topic, agent])
    await db.query("SET LOCAL session_replication_role='origin'")
    const before = await member(agent)
    await asUser(owner)
    const existing = await db.query('SELECT chat.add_group_agent($1,$2,$3,$4) AS receipt', [topic, agent, 'Already joined', owner])
    expect(existing.rows[0].receipt.status).toBe('already_member')
    await db.query('SELECT chat.remove_group_member_as($1,$2,$3)', [topic, owner, owner])
    await db.query('RESET ROLE')
    expect(await member(owner)).toBeUndefined()
    expect(await member(agent)).toEqual(before)
    await send(agent)
    expect(await member(owner)).toBeUndefined()
    expect(await member(agent)).toEqual(before)
  })
})
