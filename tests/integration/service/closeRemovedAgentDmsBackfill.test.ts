import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

// One-time cleanup for agents removed before 20261109200000: close their still-open DMs for the other
// member, with a backup and an exact rollback. The scripts run here inside the test transaction.
let db: Client
let owner: string, friend: string, stranger: string, agent: string, live: string, device: string
let ownerDm: string, friendDm: string, deletedDm: string, liveDm: string, group: string
const script = (name: string) => readFileSync(new URL(`../../../ops/${name}`, import.meta.url), 'utf8')
  .replace(/^BEGIN( READ ONLY)?;$/m, '').replace(/^(COMMIT|ROLLBACK);$/m, '')
async function run(name: string) {
  // One statement returns a result; several return one result per statement. The last one is the report.
  const results = [await db.query(script(name)) as unknown as { rows: Record<string, unknown>[] }].flat()
  return results[results.length - 1].rows[0]
}
const seat = async (chat: string, user: string) => (await db.query(
  'SELECT conversation_deleted_at FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chat, user])).rows[0].conversation_deleted_at
async function listed(user: string) {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  await db.query('SET LOCAL ROLE authenticated')
  const rows = (await db.query('SELECT chat_id FROM chat.list_my_chats_as($1)', [user])).rows.map(r => r.chat_id)
  await db.query('RESET ROLE'); return rows
}

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
  ;[owner, friend, stranger, agent, live, device, ownerDm, friendDm, deletedDm, liveDm, group] = Array.from({ length: 11 }, randomUUID)
  for (const id of [owner, friend, stranger]) await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,now(),now())`, [id, `${id}@dm-backfill.invalid`])
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'backfill','fixture','linux')`, [device, owner])
  for (const id of [agent, live]) await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,agent_public)
    VALUES($1,'agent','Backfill fixture',$2,$3,true)`, [id, owner, device])
  for (const [id, kind, human, bot] of [[ownerDm, 'dm', owner, agent], [friendDm, 'dm', friend, agent], [deletedDm, 'dm', stranger, agent],
    [liveDm, 'dm', owner, live], [group, 'group', owner, agent]]) {
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,$2,'Backfill fixture',$3)", [id, kind, human])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [id, human, bot])
  }
  await db.query('UPDATE chat.chat_members SET inbox_published_at=clock_timestamp() WHERE chat_id=ANY($1)', [[ownerDm, friendDm, deletedDm, liveDm, group]])
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Retained history')", [randomUUID(), ownerDm, agent])
  // The stranger deleted their DM before; that time must survive.
  await db.query("UPDATE chat.chat_members SET conversation_deleted_at='2026-11-01T00:00:00Z' WHERE chat_id=$1 AND user_id=$2", [deletedDm, stranger])
  // Removed before 20261109200000 existed: identity removed, DMs left open.
  await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1', [agent])
  await db.query('SET CONSTRAINTS ALL IMMEDIATE')
})
afterEach(async () => { if (db) await db.query('ROLLBACK') })

it('counts read-only, closes exactly the removed agent\'s open DMs with a backup, and refuses a second run', async () => {
  const before = (await db.query('SELECT * FROM chat.chat_members WHERE chat_id=ANY($1) ORDER BY chat_id,user_id', [[liveDm, group]])).rows
  const history = (await db.query('SELECT * FROM chat.messages WHERE chat_id=$1', [ownerDm])).rows
  const heads = async () => Object.fromEntries((await db.query('SELECT user_id,revision FROM chat.account_revision_heads WHERE user_id=ANY($1)', [[owner, friend]])).rows
    .map(r => [r.user_id, Number(r.revision)]))
  const revisionsBefore = await heads()
  expect(await listed(owner)).toContain(ownerDm)
  // Counts include other removed agents' DMs on a shared database, so compare the difference this fixture makes.
  const counted = await run('count-removed-agent-dms-to-close.sql')
  expect(Number(counted.seats_to_close)).toBeGreaterThanOrEqual(2)
  const result = await run('close-removed-agent-dms-backfill.sql')
  expect(Number(result.seats_closed)).toBe(Number(counted.seats_to_close))
  expect(await seat(ownerDm, owner)).not.toBeNull()
  expect(await seat(friendDm, friend)).not.toBeNull()
  expect((await seat(deletedDm, stranger)).toISOString()).toBe('2026-11-01T00:00:00.000Z')
  expect((await db.query('SELECT * FROM chat.chat_members WHERE chat_id=ANY($1) ORDER BY chat_id,user_id', [[liveDm, group]])).rows).toEqual(before)
  expect((await db.query('SELECT * FROM chat.messages WHERE chat_id=$1', [ownerDm])).rows).toEqual(history)
  expect((await db.query(`SELECT chat_id,user_id,agent_user_id FROM chat_private.removed_agent_dm_close_backup
    WHERE agent_user_id=$1 ORDER BY chat_id`, [agent])).rows)
    .toEqual([{ chat_id: ownerDm, user_id: owner, agent_user_id: agent }, { chat_id: friendDm, user_id: friend, agent_user_id: agent }]
      .sort((a, b) => a.chat_id.localeCompare(b.chat_id)))
  const revisionsAfter = await heads()
  for (const user of [owner, friend]) expect(revisionsAfter[user]).toBeGreaterThan(revisionsBefore[user] ?? 0)
  expect(await listed(owner)).not.toContain(ownerDm)
  expect(await listed(owner)).toContain(liveDm)
  expect(Number((await run('count-removed-agent-dms-to-close.sql')).seats_to_close)).toBe(0)
  await db.query('SAVEPOINT again')
  await expect(db.query(script('close-removed-agent-dms-backfill.sql'))).rejects.toThrow(/holds an applied run/)
  await db.query('ROLLBACK TO SAVEPOINT again')
})

it('rolls back exactly the seats it closed and leaves seats changed since alone', async () => {
  await run('close-removed-agent-dms-backfill.sql')
  const changed = '2026-11-20T00:00:00Z'
  await db.query('UPDATE chat.chat_members SET conversation_deleted_at=$3 WHERE chat_id=$1 AND user_id=$2', [friendDm, friend, changed])
  const result = await run('rollback-close-removed-agent-dms-backfill.sql')
  expect(Number(result.seats_changed_since_left_alone)).toBeGreaterThanOrEqual(1)
  expect(await seat(ownerDm, owner)).toBeNull()
  expect((await seat(friendDm, friend)).toISOString()).toBe('2026-11-20T00:00:00.000Z')
  expect((await seat(deletedDm, stranger)).toISOString()).toBe('2026-11-01T00:00:00.000Z')
  expect(await listed(owner)).toContain(ownerDm)
  expect((await db.query('SELECT count(*)::int AS n FROM chat_private.removed_agent_dm_close_backup WHERE agent_user_id=$1 AND rolled_back_at IS NULL', [agent])).rows[0].n).toBe(0)
  // After a rollback the cleanup may run again.
  await run('close-removed-agent-dms-backfill.sql')
  expect(await seat(ownerDm, owner)).not.toBeNull()
})

it('keeps the backup away from every API role', async () => {
  await run('close-removed-agent-dms-backfill.sql')
  for (const role of ['anon', 'authenticated', 'service_role', 'gugu_files']) {
    expect((await db.query("SELECT has_table_privilege($1,'chat_private.removed_agent_dm_close_backup','SELECT,INSERT,UPDATE,DELETE') AS any", [role])).rows[0].any).toBe(false)
  }
})
