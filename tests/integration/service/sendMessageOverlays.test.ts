import { createHash, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let owner: string, bystander: string, agent: string, device: string, group: string

async function asUser(id = owner) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}

async function send(id: string, whisper = false, sender = owner) {
  return (await db.query(`SELECT chat.send_message_with_overlays(
    $1,$2,$3,$4,'Overlay fixture','text',NULL,NULL,false,$5) AS result`, [id, group, sender, [agent], whisper])).rows[0].result
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Message overlays require a disposable loopback database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, bystander, agent, device, group] = Array.from({ length: 5 }, randomUUID)
  for (const id of [owner, bystander]) {
    await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@message-overlays.invalid`])
  }
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'Overlay fixture','fixture','linux')`, [device, owner])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id)
    VALUES($1,'agent','Archived agent',$2,$3)`, [agent, owner, device])
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Overlay fixture',$2)`, [group, owner])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role,listen_mode)
    VALUES($1,$2,'owner','passive'),($1,$3,'member','passive'),($1,$4,'member','passive')`, [group, owner, bystander, agent])
  await asUser()
  const archivedAt = new Date(Date.now() - 20_000).toISOString()
  await db.query('SELECT identity.set_agent_session_archival($1,$2,$3,1,$4,$5)',
    [agent, device, randomUUID(), archivedAt, JSON.stringify([{ id: randomUUID(), archived_at: archivedAt, restored_at: null }])])
})
afterEach(async () => { await db?.query('ROLLBACK') })

describe('send_message_with_overlays returns caller-visible message overlays', () => {
  it('returns the refusal created by the insert trigger and current overlays on replay', async () => {
    const id = randomUUID()
    const first = await send(id)
    expect(first.reactions).toEqual([])
    expect(first.deliveries).toEqual([])
    expect(first.delivery_blocks).toEqual([{ message_id: id, agent_user_id: agent, reason: 'agent_archived' }])
    await db.query('RESET ROLE')
    await db.query(`INSERT INTO chat.message_reactions(message_id,user_id,emoji) VALUES($1,$2,'ok')`, [id, owner])
    await db.query(`INSERT INTO chat.message_deliveries(message_id,device_id,status) VALUES($1,$2,'read')`, [id, `gugu-agent:${agent}`])
    await asUser()
    const replay = await send(id)
    expect(replay.message.id).toBe(first.message.id)
    expect(replay.message.seq).toBe(first.message.seq)
    expect(replay.reactions).toEqual([{ message_id: id, user_id: owner, emoji: 'ok' }])
    expect(replay.deliveries).toEqual([{ message_id: id, device_id: `gugu-agent:${agent}`, status: 'read' }])
    expect(replay.delivery_blocks).toEqual(first.delivery_blocks)
  })

  it('denies a nonrecipient whisper replay and hides every overlay under the same RLS', async () => {
    const id = randomUUID()
    const first = await send(id, true)
    expect(first.delivery_blocks).toEqual([{ message_id: id, agent_user_id: agent, reason: 'agent_archived' }])
    await db.query('RESET ROLE')
    await db.query(`INSERT INTO chat.message_reactions(message_id,user_id,emoji) VALUES($1,$2,'ok')`, [id, owner])
    await db.query(`INSERT INTO chat.message_deliveries(message_id,device_id,status) VALUES($1,$2,'read')`, [id, `gugu-agent:${agent}`])
    await asUser(bystander)
    for (const table of ['message_reactions', 'message_deliveries', 'message_agent_delivery_blocks']) {
      expect((await db.query(`SELECT * FROM chat.${table} WHERE message_id=$1`, [id])).rows).toEqual([])
    }
    await db.query('SAVEPOINT replay_denied')
    await expect(send(id, true)).rejects.toThrow()
    await db.query('ROLLBACK TO SAVEPOINT replay_denied')
    // The same caller can still send an ordinary visible message.
    expect((await send(randomUUID(), false, bystander)).delivery_blocks).toEqual([
      { message_id: expect.any(String), agent_user_id: agent, reason: 'agent_archived' },
    ])
    await asUser()
    expect((await send(id, true)).reactions).toEqual([{ message_id: id, user_id: owner, emoji: 'ok' }])
  })

  it('remains invoker-only with the original authenticated execution grant', async () => {
    const signature = 'chat.send_message_with_overlays(text,text,text,text[],text,text,text,text,boolean,boolean,text,uuid,integer,text,uuid)'
    const result = (await db.query(`SELECT prosecdef,
      has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated,
      has_function_privilege('anon',oid,'EXECUTE') AS anon
      FROM pg_proc WHERE oid=$1::regprocedure`, [signature])).rows[0]
    expect(result).toEqual({ prosecdef: false, authenticated: true, anon: false })
  })

  it('preserves the own-agent whisper acknowledgement without exposing overlays hidden from the caller', async () => {
    const id = randomUUID(), sender = randomUUID()
    await db.query('RESET ROLE')
    await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id)
      VALUES($1,'agent','Sending agent',$2,$3)`, [sender, owner, device])
    await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')`, [group, sender])
    await asUser()
    const query = `SELECT chat.send_message_with_overlays($1,$2,$3,$4,'Private App message','text',NULL,NULL,false,true,'fixture') AS result`
    const args = [id, group, sender, [bystander]]
    const first = (await db.query(query, args)).rows[0].result
    expect(first.message).toMatchObject({ id, sender_user_id: sender, is_whisper: true })
    expect((await db.query('SELECT id FROM chat.messages_view WHERE id=$1', [id])).rows).toEqual([])
    await db.query('RESET ROLE')
    await db.query(`INSERT INTO chat.message_reactions(message_id,user_id,emoji) VALUES($1,$2,'ok')`, [id, bystander])
    await db.query(`INSERT INTO chat.message_deliveries(message_id,device_id,status) VALUES($1,$2,'read')`, [id, `gugu-agent:${sender}`])
    await asUser()
    const replay = (await db.query(query, args)).rows[0].result
    expect(replay.message.id).toBe(id)
    expect(replay.reactions).toEqual([])
    expect(replay.deliveries).toEqual([])
    expect(replay.delivery_blocks).toEqual([])
  })

  it('keeps attachment commit, share and forward results equal to the messages_view columns', async () => {
    await db.query('RESET ROLE')
    const columns = (await db.query(`SELECT attname FROM pg_attribute
      WHERE attrelid='chat.messages_view'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`)).rows.map(({ attname }) => attname)
    const key = `staging/${owner}/${randomUUID()}`
    await db.query('SET LOCAL ROLE service_role')
    await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,32,\'text/plain\',NULL,NULL)',
      [owner, key, createHash('sha256').update('attachment shape fixture').digest('hex')])
    await asUser()
    const committed = (await db.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,\'shape.txt\')',
      [key, randomUUID(), group, owner])).rows[0]
    const shared = (await db.query('SELECT * FROM chat.attachment_share($1,NULL,$2,$3,$4)',
      [committed.file_item_id, randomUUID(), group, owner])).rows[0]
    const forwarded = (await db.query('SELECT * FROM chat.attachment_forward($1,$2,$3,$4)',
      [committed.id, randomUUID(), group, owner])).rows[0]
    for (const message of [committed, shared, forwarded]) {
      expect(Object.keys(message)).toEqual(columns)
      expect(message.content_type).toBe('attachment')
      expect(message.file_metadata).toBeTruthy()
    }
  })
})
