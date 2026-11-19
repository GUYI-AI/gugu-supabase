import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFixtureGroup } from '../../support/groupFixture'

// Exercise the native project's actual SQL entry point, not an attachment_commit mock.
// Each test owns its data in a rollback transaction on a disposable loopback database.
let db: pg.Client
let sender: string, reader: string, group: string, device: string, agent: string
type Sent = { id: string; content: string; send_group_id: string | null; send_group_size: number | null }
const publishSql = `SELECT chat.file_device_publish(p_item=>$1,p_chat=>$2,p_device=>$3,
  p_path=>$4,p_sha=>$5,p_size=>12,p_filename=>$6,p_type=>'image/png',p_project=>'root',p_message=>$7::jsonb) AS receipt`

async function asUser(id: string) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function publish(metadata: Record<string, unknown> = {}, item = randomUUID()) {
  await asUser(sender)
  return (await db.query<{ receipt: { message: Sent } }>(publishSql, [item, group, device,
    `data/${item}.png`, 'ab'.repeat(32), `${item}.png`, JSON.stringify({ message_id: randomUUID(), sender_user_id: sender, ...metadata })])).rows[0]!.receipt
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw Error('Project send-group tests require a disposable loopback database')
  }
  db = new pg.Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[sender, reader, group, device] = Array.from({ length: 4 }, randomUUID)
  for (const id of [sender, reader]) await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`, [id, `${id}@project-send-groups.invalid`])
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'Send groups','fixture','darwin')`, [device, sender])
  agent = randomUUID()
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'Agent device','fixture','darwin')`, [`reader-${reader}`, reader])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,agent_public,device_id)
    VALUES($1,'agent','Screenshot reader',$2,true,$3)`, [agent, reader, `reader-${reader}`])
  await asUser(sender)
  await createFixtureGroup(db, [group, 'Four screenshots', sender, JSON.stringify([reader, agent].map(user_id => ({ user_id, role: 'member' })))])
  await db.query('RESET ROLE')
  await db.query(`INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id)
    VALUES($1,$2,'root','Screenshots','/private/fixture',now(),$3)`, [device, sender, group])
})
afterEach(async () => {
  if (!db) return
  try { await db.query('RESET ROLE'); await db.query('SET CONSTRAINTS ALL IMMEDIATE') }
  finally { await db.query('ROLLBACK') }
})

describe('#2581 native project-file sends', () => {
  it('four screenshots plus text persist as one send, including receipts and a fresh reader view', async () => {
    const send = randomUUID()
    const receipts: Sent[] = []
    for (let index = 0; index < 4; index++) receipts.push((await publish({
      send_group_id: send, send_group_size: 4, to_user_ids: [agent], ...(index === 3 ? { caption: '你看看' } : {}),
    })).message)
    expect(receipts.map(row => [row.send_group_id, row.send_group_size]),
      `ALBUM_GROUP_RECEIPTS:${JSON.stringify(receipts.map(row => [row.send_group_id, row.send_group_size]))}`).toEqual(Array(4).fill([send, 4]))
    await asUser(reader)
    const rows = (await db.query<Sent>('SELECT id,content,send_group_id,send_group_size FROM chat.messages_view WHERE chat_id=$1 ORDER BY seq', [group])).rows
    expect(rows.map(row => row.id)).toEqual(receipts.map(row => row.id))
    expect(rows.map(row => [row.send_group_id, row.send_group_size])).toEqual(Array(4).fill([send, 4]))
    expect(rows.map(row => row.content.includes('你看看'))).toEqual([false, false, false, true])
    expect(new Set(rows.map(row => row.send_group_id ?? row.id)).size).toBe(1)
    const inbox = (await db.query<Sent>('SELECT id,content,send_group_id,send_group_size FROM identity.pull_agent_inbox_v2($1,$2)', [agent, group])).rows
    expect(inbox.map(row => row.id)).toEqual(receipts.map(row => row.id))
    expect(inbox.map(row => [row.send_group_id, row.send_group_size])).toEqual(Array(4).fill([send, 4]))
    expect(inbox.map(row => row.content.includes('你看看'))).toEqual([false, false, false, true])
    await db.query('RESET ROLE')
    expect((await db.query('SELECT count(*)::integer AS n FROM chat.messages WHERE chat_id=$1', [group])).rows[0]!.n).toBe(4)
  })

  it('does not leak the group into the next single-file publication on the same connection', async () => {
    await publish({ send_group_id: randomUUID(), send_group_size: 4 })
    const single = (await publish({ caption: 'alone' })).message
    expect(single).toMatchObject({ send_group_id: null, send_group_size: null })
    expect((await db.query("SELECT current_setting('chat.send_group_message',true) AS message,current_setting('chat.send_group',true) AS send")).rows[0]).toEqual({ message: '', send: '' })
  })

  it.each([
    { send_group_id: randomUUID() }, { send_group_size: 4 },
    { send_group_id: randomUUID(), send_group_size: 1 },
    { send_group_id: randomUUID(), send_group_size: 11 },
    { send_group_id: randomUUID(), send_group_size: 4.5 },
    { send_group_id: 'not-a-uuid', send_group_size: 4 },
    { send_group_id: randomUUID(), send_group_size: '4' },
  ])('rejects malformed grouping before indexing a revision: %j', async metadata => {
    const item = randomUUID()
    await db.query('SAVEPOINT invalid_group')
    let failure: unknown
    try { await publish(metadata, item) } catch (error) { failure = error }
    await db.query('ROLLBACK TO SAVEPOINT invalid_group')
    expect(failure).toMatchObject({ hint: 'send_group_invalid' })
    await db.query('RESET ROLE')
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1', [item])).rows).toEqual([])
  })
})
