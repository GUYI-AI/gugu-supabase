import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

// Removing an agent closes its DMs with the personal deletion state; nothing else about them changes.
let db: Client, connectionString: string, committed = false
let owner: string, friend: string, agent: string, device: string, ownerDm: string, friendDm: string, group: string, message: string
async function admin() { await db.query('RESET ROLE') }
async function as(client: Client, user: string) {
  await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  await client.query('SET LOCAL ROLE authenticated')
}
async function archive(flag = true) {
  await as(db, owner)
  const receipt = (await db.query('SELECT identity.archive_user($1,$2) AS r', [agent, flag])).rows[0].r
  await admin(); return receipt
}
async function listed(user: string) {
  await as(db, user)
  const rows = (await db.query('SELECT chat_id FROM chat.list_my_chats_as($1)', [user])).rows.map(row => row.chat_id)
  await admin(); return rows
}
const seats = async (chats: string[]) => (await db.query(
  'SELECT * FROM chat.chat_members WHERE chat_id=ANY($1) ORDER BY chat_id,user_id', [chats])).rows
const heads = async (users: string[]) => (await db.query(
  'SELECT user_id,revision FROM chat.account_revision_heads WHERE user_id=ANY($1) ORDER BY user_id', [users])).rows

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Requires the disposable loopback database')
  }
  connectionString = url.href
  db = new Client({ connectionString }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  committed = false
  await db.query('BEGIN')
  ;[owner, friend, agent, device, ownerDm, friendDm, group, message] = Array.from({ length: 8 }, randomUUID)
  for (const id of [owner, friend]) await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,now(),now())`, [id, `${id}@close-dms.invalid`])
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'close fixture','fixture','linux')`, [device, owner])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,agent_public)
    VALUES($1,'agent','Close fixture',$2,$3,true)`, [agent, owner, device])
  for (const [id, kind, human] of [[ownerDm, 'dm', owner], [friendDm, 'dm', friend], [group, 'group', owner]]) {
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,$2,'Close fixture',$3)", [id, kind, human])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [id, human, agent])
  }
  await db.query('UPDATE chat.chat_members SET inbox_published_at=clock_timestamp() WHERE chat_id=ANY($1)', [[ownerDm, friendDm, group]])
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Retained history')", [message, ownerDm, agent])
})
afterEach(async () => {
  await db.query('ROLLBACK'); await admin()
  if (committed) {
    await db.query('DELETE FROM chat.chats WHERE id=ANY($1)', [[ownerDm, friendDm, group]])
    await db.query('DELETE FROM identity.users WHERE id=$1', [agent])
    await db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1', [device])
    await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[owner, friend]])
  }
})

it('closes every DM of the removed agent for the other member and keeps seats, history and groups', async () => {
  const before = await seats([ownerDm, friendDm, group])
  const history = (await db.query('SELECT * FROM chat.messages WHERE chat_id=$1', [ownerDm])).rows
  const revisions = await heads([owner, friend])
  expect(await listed(owner)).toEqual(expect.arrayContaining([ownerDm, group]))
  expect(await listed(friend)).toContain(friendDm)

  const receipt = await archive()
  expect(receipt.removed_at).toBeTruthy()

  expect(await listed(owner)).not.toContain(ownerDm)
  expect(await listed(owner)).toContain(group)
  expect(await listed(friend)).not.toContain(friendDm)
  const after = await seats([ownerDm, friendDm, group])
  const closed = after.filter(row => row.conversation_deleted_at).map(row => [row.chat_id, row.user_id])
  expect(closed.sort()).toEqual([[ownerDm, owner], [friendDm, friend]].sort())
  // Only conversation_deleted_at changed, and only on those two seats.
  expect(after.map(row => ({ ...row, conversation_deleted_at: null }))).toEqual(before)
  expect((await db.query('SELECT * FROM chat.messages WHERE chat_id=$1', [ownerDm])).rows).toEqual(history)
  expect((await db.query('SELECT status FROM chat.chats WHERE id=ANY($1)', [[ownerDm, friendDm]])).rows)
    .toEqual([{ status: 'active' }, { status: 'active' }])
  // Each closed seat published a revision to its own account, so live lists drop the row.
  const after_ = new Map((await heads([owner, friend])).map(row => [row.user_id, BigInt(row.revision)]))
  for (const user of [owner, friend]) {
    const prior = revisions.find(row => row.user_id === user)
    expect(after_.get(user)! > BigInt(prior?.revision ?? 0)).toBe(true)
  }
  // History stays readable for the owner, as after a personal Delete.
  await as(db, owner)
  expect((await db.query('SELECT id FROM chat.messages_view WHERE chat_id=$1', [ownerDm])).rows).toEqual([{ id: message }])
  await admin()
  // The retry is the archive's idempotent receipt and closes nothing again.
  const closedSeats = await seats([ownerDm, friendDm])
  expect(await archive()).toEqual(receipt)
  expect(await seats([ownerDm, friendDm])).toEqual(closedSeats)
})

it('keeps an earlier personal deletion time and leaves DMs open when the social identity is kept', async () => {
  await db.query("UPDATE chat.chat_members SET conversation_deleted_at='2026-11-01T00:00:00Z' WHERE chat_id=$1 AND user_id=$2", [ownerDm, owner])
  expect(await archive(false)).toMatchObject({ removed_at: null })
  expect(await listed(friend)).toContain(friendDm)
  await archive()
  expect((await db.query('SELECT conversation_deleted_at FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [ownerDm, owner])).rows)
    .toEqual([{ conversation_deleted_at: new Date('2026-11-01T00:00:00Z') }])
})

it('a human removing their own account does not close their DMs for others', async () => {
  await as(db, friend)
  await db.query('SELECT identity.archive_user($1,true)', [friend])
  await admin()
  expect((await db.query('SELECT count(*)::int AS n FROM chat.chat_members WHERE conversation_deleted_at IS NOT NULL AND chat_id=ANY($1)',
    [[ownerDm, friendDm, group]])).rows[0].n).toBe(0)
})

it.each(['delete-first', 'remove-first'])('commits %s personal deletion and removal of the same DM without a lock cycle', async (order) => {
  await db.query('COMMIT'); committed = true
  const deleting = new Client({ connectionString }), removing = new Client({ connectionString })
  await deleting.connect(); await removing.connect()
  try {
    for (const client of [deleting, removing]) await client.query("BEGIN; SET LOCAL statement_timeout='5s'")
    await db.query('UPDATE identity.users SET session_archived_at=now() WHERE id=$1', [agent])
    await as(deleting, owner); await as(removing, owner)
    const remove = () => removing.query('SELECT identity.archive_user($1,true)', [agent])
    const del = () => deleting.query('SELECT chat.delete_my_dm_conversation($1) AS r', [ownerDm])
    // The second statement blocks on the first transaction's chat row and finishes after it commits.
    if (order === 'delete-first') {
      await del()
      const pending = remove()
      await deleting.query('COMMIT'); await pending; await removing.query('COMMIT')
    } else {
      await remove()
      const pending = del()
      await removing.query('COMMIT'); expect((await pending).rows[0].r.already).toBe(true); await deleting.query('COMMIT')
    }
    expect((await db.query('SELECT count(*)::int AS n FROM chat.chat_members WHERE chat_id=ANY($1) AND conversation_deleted_at IS NOT NULL',
      [[ownerDm, friendDm]])).rows[0].n).toBe(2)
  } finally {
    await deleting.query('ROLLBACK').catch(() => undefined); await removing.query('ROLLBACK').catch(() => undefined)
    await deleting.end(); await removing.end()
  }
})

// The client archives the session first (#236: the agent leaves its groups, keeps its DMs), then removes the identity.
it('closes the DMs of an agent that was session-archived before removal', async () => {
  await db.query('UPDATE identity.users SET session_archived_at=now() WHERE id=$1', [agent])
  expect((await db.query('SELECT chat_id FROM chat.active_members WHERE user_id=$1 ORDER BY chat_id', [agent])).rows.map(r => r.chat_id))
    .toEqual([ownerDm, friendDm].sort())
  await archive()
  expect((await db.query('SELECT chat_id FROM chat.chat_members WHERE chat_id=ANY($1) AND user_id<>$2 AND conversation_deleted_at IS NOT NULL ORDER BY chat_id',
    [[ownerDm, friendDm, group], agent])).rows.map(r => r.chat_id)).toEqual([ownerDm, friendDm].sort())
  expect(await listed(owner)).not.toContain(ownerDm)
  expect(await listed(friend)).not.toContain(friendDm)
})
