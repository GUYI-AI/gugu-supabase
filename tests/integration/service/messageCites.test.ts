import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * A cite's words ride with its pills (migration *_message_cites): the composer passes them as p_cites, the row keeps them,
 * and the agent inbox hands them over beside the text. Every case runs inside BEGIN…ROLLBACK.
 */
let db: Client
let owner: string, agent: string, device: string, group: string

async function asUser(id = owner) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}

const pill = '@[notes.md (Line 57)](gugu-file://00000000-0000-4000-8000-000000000001?v=1#lines=57)'
const cites = [{ link: 'gugu-file://00000000-0000-4000-8000-000000000001?v=1#lines=57', text: 'the picked words' }]

async function send(id: string, content: string, withCites: unknown) {
  return (await db.query(`SELECT chat.send_message_with_overlays(
    $1,$2,$3,$4,$5,'text',NULL,NULL,false,false,NULL,NULL,NULL,NULL,NULL,$6) AS result`,
  [id, group, owner, [agent], content, withCites === null ? null : JSON.stringify(withCites)])).rows[0].result
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Message cites require a disposable loopback database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, agent, device, group] = Array.from({ length: 4 }, randomUUID)
  await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [owner, `${owner}@message-cites.invalid`])
  await db.query(`INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Citer')
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [owner])
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'Cites fixture','fixture','linux')`, [device, owner])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id)
    VALUES($1,'agent','Cites agent',$2,$3)`, [agent, owner, device])
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Cites fixture',$2)`, [group, owner])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role,listen_mode)
    VALUES($1,$2,'owner','passive'),($1,$3,'member','passive')`, [group, owner, agent])
  await asUser()
})
afterEach(async () => { await db?.query('ROLLBACK') })

describe('a cite keeps its words beside the text', () => {
  it('the row keeps p_cites; a message sent without them has none', async () => {
    const cited = randomUUID(), plain = randomUUID()
    await send(cited, `${pill}\nwhy?`, cites)
    await send(plain, 'just words', null)
    await db.query('RESET ROLE')
    const rows = (await db.query('SELECT id, content, cites FROM chat.messages WHERE id = ANY($1)', [[cited, plain]])).rows
    expect(Object.fromEntries(rows.map(row => [row.id, [row.content, row.cites]]))).toEqual({
      [cited]: [`${pill}\nwhy?`, cites],
      [plain]: ['just words', null],
    })
  })

  it('the agent inbox hands the cites over with the message', async () => {
    const id = randomUUID()
    await send(id, `${pill}\nwhy?`, cites)
    const rows = (await db.query('SELECT id, content, cites FROM identity.pull_agent_inbox_v2($1,$2)', [agent, group])).rows
    expect(rows.map(row => [row.id, row.cites])).toEqual([[id, cites]])
  })
})
