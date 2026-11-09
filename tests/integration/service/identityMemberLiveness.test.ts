import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client, type QueryResultRow } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let db: Client
let owner: string, peer: string, outsider: string, agent: string, device: string, room: string, secondRoom: string
let committed = false
const connectionString = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
beforeAll(async () => {
  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Liveness contracts require a disposable loopback database')
  }
  db = new Client({ connectionString }); await db.connect()
  await db.query("SET statement_timeout='5s'")
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN'); committed = false
  ;[owner, peer, outsider, agent, device, room, secondRoom] = Array.from({ length: 7 }, randomUUID)
  for (const id of [owner, peer, outsider]) await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, `${id}@member-liveness.invalid`])
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Fixture','fixture','linux')", [device, owner])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Fixture',$2,$3)", [agent, owner, device])
  for (const chat of [room, secondRoom]) {
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Fixture',$2)", [chat, owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [chat, owner, peer])
  }
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [room, agent])
})
afterEach(async () => {
  await db.query('ROLLBACK'); await db.query('RESET ROLE')
  if (committed) {
    await db.query('DELETE FROM chat.chats WHERE id=ANY($1)', [[room, secondRoom]])
    await db.query('DELETE FROM identity.users WHERE id=$1', [agent])
    await db.query('DELETE FROM identity.gugu_devices WHERE device_id=$1', [device])
    await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[owner, peer, outsider]])
  }
})

async function as<T extends QueryResultRow = QueryResultRow>(role: 'authenticated' | 'gugu_files' | 'anon', caller: string, sql: string, args: unknown[] = []) {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: caller, role })])
  await db.query(`SET LOCAL ROLE ${role}`)
  try { return (await db.query<T>(sql, args)).rows } finally { await db.query('RESET ROLE').catch(() => undefined) }
}
async function denial(role: 'authenticated' | 'anon', sql: string) {
  await db.query('SAVEPOINT denied')
  try { await expect(as(role, owner, sql)).rejects.toMatchObject({ code: '42501' }) }
  finally { await db.query('ROLLBACK TO SAVEPOINT denied') }
}

it('keeps cache reads within visible member rows, denies writes and does not expose unrelated identities', async () => {
  const visible = await as<{ user_id: string }>('authenticated', owner, 'SELECT DISTINCT user_id FROM chat.chat_members ORDER BY user_id')
  expect(await as('authenticated', owner, 'SELECT user_id FROM identity.member_liveness ORDER BY user_id')).toEqual(visible)
  expect(await as('authenticated', outsider, 'SELECT user_id FROM identity.member_liveness')).toEqual([])
  expect(await as('authenticated', outsider, 'SELECT user_id FROM identity.member_liveness WHERE user_id=ANY($1)', [[owner, agent, outsider]])).toEqual([])
  for (const statement of ['SELECT * FROM identity.member_liveness', 'INSERT INTO identity.member_liveness VALUES(\'unknown\',true)']) {
    await denial('anon', statement)
  }
  for (const statement of ['UPDATE identity.member_liveness SET is_live=false', 'DELETE FROM identity.member_liveness', 'TRUNCATE identity.member_liveness', 'SELECT identity.sync_member_liveness()']) {
    await denial('authenticated', statement)
  }
  for (const role of ['authenticated', 'service_role', 'gugu_files']) {
    expect((await db.query("SELECT has_table_privilege($1,'identity.member_liveness','INSERT,UPDATE,DELETE,TRUNCATE') AS writes", [role])).rows[0].writes).toBe(false)
  }
  const original = (await db.query('SELECT user_id FROM chat.chat_members WHERE chat_id=$1 AND identity.user_is_live(user_id) ORDER BY user_id', [room])).rows
  // Reuse the file-contract fixture: the installer has ADMIN, but not SET, on
  // gugu_files. This grant belongs to this test transaction and rolls back.
  await db.query("DO $$ BEGIN EXECUTE format('GRANT gugu_files TO %I', current_user); END $$")
  for (const role of ['authenticated', 'gugu_files'] as const) {
    expect(await as(role, owner, 'SELECT user_id FROM chat.active_members WHERE chat_id=$1 ORDER BY user_id', [room])).toEqual(original)
  }
})

it('maintains one identity fact synchronously, with no member writes, and follows transaction rollback', async () => {
  const before = (await db.query('SELECT * FROM chat.chat_members WHERE user_id=$1 ORDER BY chat_id', [agent])).rows
  await db.query('CREATE TEMP TABLE member_liveness_writes(kind text) ON COMMIT DROP')
  await db.query(`CREATE FUNCTION pg_temp.watch_member_liveness() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN INSERT INTO pg_temp.member_liveness_writes VALUES(TG_TABLE_NAME); RETURN COALESCE(NEW,OLD); END $$`)
  await db.query('CREATE TRIGGER member_liveness_fixture AFTER INSERT OR UPDATE OR DELETE ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION pg_temp.watch_member_liveness()')
  await db.query('SAVEPOINT before_remove')
  await as('authenticated', owner, 'SELECT identity.archive_user($1,true)', [agent])
  expect((await db.query('SELECT is_live FROM identity.member_liveness WHERE user_id=$1', [agent])).rows).toEqual([{ is_live: false }])
  expect((await db.query('SELECT * FROM chat.active_members WHERE user_id=$1', [agent])).rows).toEqual([])
  expect((await db.query('SELECT * FROM chat.chat_members WHERE user_id=$1 ORDER BY chat_id', [agent])).rows).toEqual(before)
  expect((await db.query('SELECT * FROM member_liveness_writes')).rows).toEqual([])
  await db.query('ROLLBACK TO SAVEPOINT before_remove')
  expect((await db.query('SELECT is_live FROM identity.member_liveness WHERE user_id=$1', [agent])).rows).toEqual([{ is_live: true }])
  expect((await db.query('SELECT * FROM chat.active_members WHERE user_id=$1 ORDER BY chat_id', [agent])).rows).toEqual(before)
  await db.query('DELETE FROM identity.users WHERE id=$1', [outsider])
  expect((await db.query('SELECT * FROM identity.member_liveness WHERE user_id=$1', [outsider])).rows).toEqual([])
})

it('restores predecessor views on operational rollback without changing source rows, ledger or view access', async () => {
  const definitions = async () => (await db.query(`SELECT oid::regclass::text AS name,pg_get_viewdef(oid) AS definition
    FROM pg_class WHERE oid IN ('chat.active_members'::regclass,'identity.active_users'::regclass) ORDER BY 1`)).rows
  // Compare the complete canonical definitions from the immutable predecessors;
  // pg_get_viewdef may omit a redundant qualifier such as m.user_id.
  await db.query('SAVEPOINT predecessor_views')
  for (const [name, file] of [
    ['chat.active_members', '20261103134000_delete_my_archived_agent_dm.sql'],
    ['identity.active_users', '20261103061000_task_agent_clash_suffix.sql'],
  ]) {
    const source = readFileSync(new URL(`../../../supabase/migrations/${file}`, import.meta.url), 'utf8')
    const start = source.indexOf(`CREATE OR REPLACE VIEW ${name} `)
    expect(start).toBeGreaterThanOrEqual(0)
    await db.query(source.slice(start, source.indexOf(';', start) + 1))
  }
  const predecessors = await definitions()
  await db.query('ROLLBACK TO SAVEPOINT predecessor_views')
  const viewAccess = async () => (await db.query(`SELECT oid::regclass::text AS name,relacl::text,reloptions,
    (SELECT jsonb_agg(attname ORDER BY attnum) FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped) AS columns
    FROM pg_class c WHERE oid IN ('chat.active_members'::regclass,'identity.active_users'::regclass) ORDER BY 1`)).rows
  const access = await viewAccess()
  const ledger = (await db.query('SELECT * FROM gugu_install.releases ORDER BY version')).rows
  const seats = (await db.query('SELECT * FROM chat.chat_members WHERE chat_id=ANY($1) ORDER BY chat_id,user_id', [[room, secondRoom]])).rows
  await as('authenticated', owner, 'SELECT identity.archive_user($1,true)', [agent])
  const identities = (await db.query('SELECT * FROM identity.users WHERE id=ANY($1) ORDER BY id', [[owner, peer, outsider, agent]])).rows
  const expected = await as('authenticated', owner, 'SELECT * FROM chat.active_members WHERE chat_id=ANY($1) ORDER BY chat_id,user_id', [[room, secondRoom]])
  await db.query('SAVEPOINT operational_rollback')
  // Later releases that depend on the cache roll back first, newest first.
  for (const later of ['rollback-removed-agent-mentions.sql', 'rollback-archived-agents-leave-groups.sql']) {
    await db.query(readFileSync(new URL(`../../../ops/${later}`, import.meta.url), 'utf8').replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''))
  }
  const rollback = readFileSync(new URL('../../../ops/rollback-identity-member-liveness.sql', import.meta.url), 'utf8').replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')
  await db.query(rollback)
  expect((await db.query("SELECT to_regclass('identity.member_liveness') AS cache,to_regprocedure('identity.sync_member_liveness()') AS sync")).rows).toEqual([{ cache: null, sync: null }])
  expect(await viewAccess()).toEqual(access)
  expect(await definitions()).toEqual(predecessors)
  expect(await as('authenticated', owner, 'SELECT * FROM chat.active_members WHERE chat_id=ANY($1) ORDER BY chat_id,user_id', [[room, secondRoom]])).toEqual(expected)
  expect((await db.query('SELECT * FROM chat.chat_members WHERE chat_id=ANY($1) ORDER BY chat_id,user_id', [[room, secondRoom]])).rows).toEqual(seats)
  expect((await db.query('SELECT * FROM identity.users WHERE id=ANY($1) ORDER BY id', [[owner, peer, outsider, agent]])).rows).toEqual(identities)
  expect((await db.query('SELECT * FROM gugu_install.releases ORDER BY version')).rows).toEqual(ledger)
  await db.query('ROLLBACK TO SAVEPOINT operational_rollback')
  expect((await db.query("SELECT to_regclass('identity.member_liveness') IS NOT NULL AS restored")).rows[0].restored).toBe(true)
})

it('rolls archived-agent group membership back without changing seats, identities or ledger', async () => {
  await db.query('UPDATE identity.users SET session_archived_at=now() WHERE id=$1', [agent])
  const counted = async () => (await db.query('SELECT count(*)::int AS n FROM chat.active_members WHERE chat_id=$1', [room])).rows[0].n
  expect(await counted()).toBe(2)
  const returned = async () => (await db.query(`SELECT tombstone FROM chat.account_revisions WHERE user_id=$1 AND event='chat_members_changed'
    AND resource_key=jsonb_build_object('chat_id',$2::text,'user_id',$3::text,'kind','roster') ORDER BY revision DESC LIMIT 1`, [owner, room, agent])).rows[0]?.tombstone
  expect(await returned()).toBe(true)
  const seats = (await db.query('SELECT * FROM chat.chat_members WHERE chat_id=ANY($1) ORDER BY chat_id,user_id', [[room, secondRoom]])).rows
  const identities = (await db.query('SELECT * FROM identity.users WHERE id=ANY($1) ORDER BY id', [[owner, peer, agent]])).rows
  const ledger = (await db.query('SELECT * FROM gugu_install.releases ORDER BY version')).rows
  const access = (await db.query("SELECT relacl::text,reloptions FROM pg_class WHERE oid='chat.active_members'::regclass")).rows
  await db.query('SAVEPOINT archived_seat_rollback')
  // The later release that lives in chat_private rolls back first.
  for (const file of ['rollback-removed-agent-mentions.sql', 'rollback-archived-agents-leave-groups.sql']) {
    await db.query(readFileSync(new URL(`../../../ops/${file}`, import.meta.url), 'utf8').replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''))
  }
  expect(await counted()).toBe(3)
  // Cached member lists learn that the archived agent is a member again.
  expect(await returned()).toBe(false)
  expect((await db.query("SELECT to_regnamespace('chat_private') AS schema, pg_get_expr(polqual,polrelid) AS policy FROM pg_policy WHERE polname='members_select_peer'")).rows)
    .toEqual([{ schema: null, policy: '(identity.user_is_live(user_id) AND chat.is_member(chat_id))' }])
  expect((await db.query(`SELECT to_regclass('chat.live_identity_members') AS view,to_regprocedure('chat_private.is_direct_chat(text)') AS helper,
    to_regprocedure('chat.publish_session_archival_roster()') AS roster,to_regprocedure('chat.is_retained_member(text,text)') AS retained,
    (SELECT count(*)::int FROM pg_attribute WHERE attrelid='identity.member_liveness'::regclass AND attname='in_groups') AS columns,
    (SELECT count(*)::int FROM pg_proc WHERE prosrc LIKE '%live_identity_members%') AS readers`)).rows)
    .toEqual([{ view: null, helper: null, roster: null, retained: null, columns: 0, readers: 0 }])
  expect((await db.query("SELECT relacl::text,reloptions FROM pg_class WHERE oid='chat.active_members'::regclass")).rows).toEqual(access)
  expect((await db.query('SELECT * FROM chat.chat_members WHERE chat_id=ANY($1) ORDER BY chat_id,user_id', [[room, secondRoom]])).rows).toEqual(seats)
  expect((await db.query('SELECT * FROM identity.users WHERE id=ANY($1) ORDER BY id', [[owner, peer, agent]])).rows).toEqual(identities)
  expect((await db.query('SELECT * FROM gugu_install.releases ORDER BY version')).rows).toEqual(ledger)
  await db.query('ROLLBACK TO SAVEPOINT archived_seat_rollback')
  expect(await counted()).toBe(2)
})

// #2383's rollback lives here, beside the rollbacks that chain it: each takes table locks on
// chat.messages, and tests in one file run serially.
it('rolls removed-agent mentions back to rejection without changing messages, seats or ledger', async () => {
  const policy = async () => (await db.query(`SELECT pg_get_expr(polwithcheck,polrelid) AS check FROM pg_policy
    WHERE polrelid='chat.messages'::regclass AND polname='messages_insert_member'`)).rows[0].check
  const constraint = async () => (await db.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid='chat.message_agent_delivery_blocks'::regclass AND conname='message_agent_delivery_blocks_reason_check'`)).rows[0].def
  const mention = (id: string) => as('authenticated', owner,
    "INSERT INTO chat.messages(id,chat_id,sender_user_id,content,to_user_ids) VALUES($1,$2,$3,'hello',$4)", [id, room, owner, [agent]])
  const current = await policy()
  expect(current).toContain('chat_private.is_removed_agent_recipient(messages.chat_id, target.target_user_id)')
  await as('authenticated', owner, 'SELECT identity.archive_user($1,true)', [agent])
  const accepted = randomUUID()
  await mention(accepted)
  expect((await db.query('SELECT reason FROM chat.message_agent_delivery_blocks WHERE message_id=$1', [accepted])).rows).toEqual([{ reason: 'identity_removed' }])
  const messages = (await db.query('SELECT * FROM chat.messages WHERE chat_id=$1 ORDER BY id', [room])).rows
  const seats = (await db.query('SELECT * FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id', [room])).rows
  const ledger = (await db.query('SELECT * FROM gugu_install.releases ORDER BY version')).rows
  await db.query('SAVEPOINT removed_mention_rollback')
  await db.query(readFileSync(new URL('../../../ops/rollback-removed-agent-mentions.sql', import.meta.url), 'utf8').replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''))
  expect(await policy()).toBe(current.replace(' AND (NOT chat_private.is_removed_agent_recipient(messages.chat_id, target.target_user_id))', ''))
  expect(await constraint()).toBe("CHECK ((reason = 'agent_archived'::text))")
  expect((await db.query(`SELECT to_regprocedure('chat_private.is_removed_agent_recipient(text,text)') AS recipient,
    to_regprocedure('chat_private.is_removed_agent_seat(text,text)') AS seat,
    to_regprocedure('chat.record_message_removed_agent_refusals()') AS refusals`)).rows[0]).toEqual({ recipient: null, seat: null, refusals: null })
  expect((await db.query('SELECT * FROM chat.messages WHERE chat_id=$1 ORDER BY id', [room])).rows).toEqual(messages)
  expect((await db.query('SELECT * FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id', [room])).rows).toEqual(seats)
  expect((await db.query('SELECT * FROM gugu_install.releases ORDER BY version')).rows).toEqual(ledger)
  expect((await db.query('SELECT * FROM chat.message_agent_delivery_blocks WHERE message_id=$1', [accepted])).rows).toEqual([])
  await db.query('SAVEPOINT rejected_again')
  await expect(mention(randomUUID())).rejects.toMatchObject({ code: '42501' })
  await db.query('ROLLBACK TO SAVEPOINT rejected_again')
  await db.query('ROLLBACK TO SAVEPOINT removed_mention_rollback')
  expect(await policy()).toBe(current)
})

it('removes liveness function calls from invoker view bodies without a wall-clock assertion', async () => {
  await db.query("SET LOCAL track_functions='all'")
  const calls = async () => Number((await db.query("SELECT COALESCE(pg_stat_get_xact_function_calls('identity.user_is_live(text)'::regprocedure),0) AS n")).rows[0].n)
  const before = await calls()
  await db.query('SELECT identity.user_is_live($1)', [owner])
  expect(await calls() - before).toBe(1)
  const afterControl = await calls()
  await db.query('SELECT count(*) FROM chat.active_members WHERE chat_id=ANY($1)', [[room, secondRoom]])
  await db.query('SELECT count(*) FROM identity.active_users WHERE id=ANY($1)', [[owner, peer, agent]])
  expect(await calls() - afterControl).toBe(0)
})

it.each(['remove-first', 'seat-first'])('commits %s admission/removal with no cache/member lock inversion or stale seat', async (order) => {
  await db.query('COMMIT'); committed = true
  const removing = new Client({ connectionString }), seating = new Client({ connectionString })
  await removing.connect(); await seating.connect()
  try {
    for (const client of [removing, seating]) await client.query("BEGIN; SET LOCAL statement_timeout='5s'")
    await removing.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
    await removing.query('SET LOCAL ROLE authenticated')
    const remove = () => removing.query('SELECT identity.archive_user($1,true)', [agent])
    const seat = () => seating.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [secondRoom, agent])
    if (order === 'remove-first') { await remove(); await seat() }
    else { await seat(); await remove() }
    await removing.query('COMMIT'); await seating.query('COMMIT')
    expect((await db.query('SELECT count(*)::int AS n FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [secondRoom, agent])).rows[0].n).toBe(1)
    expect((await db.query('SELECT * FROM chat.active_members WHERE user_id=$1', [agent])).rows).toEqual([])
    expect((await db.query('SELECT is_live FROM identity.member_liveness WHERE user_id=$1', [agent])).rows).toEqual([{ is_live: false }])
  } finally {
    await removing.query('ROLLBACK'); await seating.query('ROLLBACK')
    await removing.end(); await seating.end()
  }
})
