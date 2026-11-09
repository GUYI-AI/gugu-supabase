import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let admin: pg.Client, a: pg.Client, b: pg.Client
let owner: string, peer: string, agent: string, device: string, room: string, anchor: string, gate: string
let aPid: number, bPid: number, adminPid: number
let extraChats: string[]=[]
const events = (id: string) => `gugu:user:${id}:events`
async function connect() {
  const c = new pg.Client({ connectionString: url }); await c.connect()
  await c.query("SET statement_timeout='12s'")
  return c
}
beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw Error('Requires disposable loopback PostgreSQL')
  admin = await connect(); a = await connect(); b = await connect()
  expect(Math.floor(Number((await admin.query("SELECT current_setting('server_version_num')::int version")).rows[0].version) / 10000)).toBe(17)
  aPid = (await a.query('SELECT pg_backend_pid() pid')).rows[0].pid
  bPid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid
  adminPid = (await admin.query('SELECT pg_backend_pid() pid')).rows[0].pid
  // A fixture-only trigger pauses the real outer publisher immediately before its system notice.
  // No production function is rewritten. Only this connection's explicit local setting enables it.
  await admin.query(`CREATE FUNCTION chat.fixture_personal_hiding_latch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.chat_id = current_setting('gugu.fixture_hide_latch_chat',true) AND NEW.content_type='system' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(current_setting('gugu.fixture_hide_latch_key'),0));
      END IF;
      RETURN NEW;
    END $$`)
  await admin.query(`CREATE FUNCTION chat.fixture_personal_erasure_latch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id=current_setting('gugu.fixture_erase_latch_chat',true) AND NEW.name='已注销用户' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(current_setting('gugu.fixture_hide_latch_key'),0));
      END IF;
      RETURN NEW;
    END $$`)
  await admin.query('CREATE TRIGGER zz_fixture_personal_erasure_latch AFTER UPDATE ON chat.chats FOR EACH ROW EXECUTE FUNCTION chat.fixture_personal_erasure_latch()')
  await admin.query('CREATE TRIGGER messages_00_fixture_personal_hiding_latch BEFORE INSERT ON chat.messages FOR EACH ROW EXECUTE FUNCTION chat.fixture_personal_hiding_latch()')
})
afterAll(async () => {
  if (admin) {
    await admin.query('DROP TRIGGER IF EXISTS zz_fixture_personal_erasure_latch ON chat.chats')
    await admin.query('DROP FUNCTION IF EXISTS chat.fixture_personal_erasure_latch()')
    await admin.query('DROP TRIGGER IF EXISTS messages_00_fixture_personal_hiding_latch ON chat.messages')
    await admin.query('DROP FUNCTION IF EXISTS chat.fixture_personal_hiding_latch()')
  }
  await a?.end(); await b?.end(); await admin?.end()
})
beforeEach(async () => {
  extraChats=[]
  ;[owner, peer, agent, device, room, anchor, gate] = Array.from({ length: 7 }, randomUUID)
  for (const id of [owner, peer]) await admin.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, `${id}@hiding-review.invalid`])
  await admin.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", [device, owner])
  await admin.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','fixture',$2,$3)", [agent, owner, device])
  await admin.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Review fixture',$2)", [room, owner])
  await admin.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')", [room, owner, peer, agent])
  await admin.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'anchor')", [anchor, room, peer])
})
afterEach(async () => {
  await a.query('ROLLBACK'); await b.query('ROLLBACK'); await admin.query('ROLLBACK')
  await admin.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [gate])
  await admin.query('DELETE FROM chat.chats WHERE id=$1 OR source_chat_id=$1 OR id=ANY($2::text[])', [room,extraChats])
  await admin.query('DELETE FROM identity.users WHERE id=$1', [agent])
  await admin.query('DELETE FROM identity.gugu_devices WHERE device_id=$1', [device])
  await admin.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[owner, peer]])
})
async function auth(c: pg.Client, user = owner) { await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [user]) }
const hide = (c: pg.Client) => c.query('SELECT chat.hide_my_conversation($1,$2)', [room, randomUUID()])
async function ownState(c: pg.Client = admin) {
  await c.query('BEGIN'); await auth(c)
  const row = (await c.query('SELECT conversation_hidden_at FROM chat.list_conversation_memberships($1) WHERE user_id=$2', [[room], owner])).rows[0]
  await c.query('COMMIT'); return row.conversation_hidden_at
}
async function blocked(pid: number, blocker: number) {
  const until = Date.now() + 5000
  while (Date.now() < until) {
    if ((await admin.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) blocked', [pid, blocker])).rows[0].blocked) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw Error(`Fixture did not reach its intended lock (${pid} waits for ${blocker})`)
}
async function committed(c: pg.Client, sql: string, args: unknown[]) {
  try { await c.query(sql, args); await c.query('COMMIT'); return null }
  catch (error) { await c.query('ROLLBACK'); return (error as { code: string }).code }
}
it('keeps personal hidden state out of peer reads and real member-broadcast payloads', async () => {
  await admin.query('BEGIN'); await auth(admin)
  await admin.query('DELETE FROM realtime.messages WHERE topic=ANY($1)', [[events(owner), events(peer)]])
  await hide(admin)
  await admin.query('SET LOCAL ROLE authenticated'); await auth(admin, peer)
  const read = (await admin.query('SELECT to_jsonb(m) row FROM chat.active_members m WHERE chat_id=$1 AND user_id=$2', [room, owner])).rows[0].row
  expect.soft(read).not.toHaveProperty('conversation_hidden_at')
  const direct = (await admin.query('SELECT to_jsonb(m) row FROM chat.chat_members m WHERE chat_id=$1 AND user_id=$2', [room, owner])).rows[0].row
  expect.soft(direct).not.toHaveProperty('conversation_hidden_at')
  await admin.query('RESET ROLE')
  const payloads = (await admin.query('SELECT event,payload FROM realtime.messages WHERE topic=$1', [events(peer)])).rows
  expect.soft(payloads).toEqual([]) // Personal maintenance sends no peer event at all.
  const own = (await admin.query('SELECT event,payload FROM realtime.messages WHERE topic=$1', [events(owner)])).rows
  expect(own).toContainEqual({ event: 'im_revision_advanced', payload: expect.any(Object) })
  expect.soft(own.every(row => !JSON.stringify(row.payload).includes('conversation_hidden_at'))).toBe(true)
  await admin.query('ROLLBACK')
})
it.each(['notAdmitted', 'undelivered'])('does not restore for the canonical pending-delivery status %s', async reason => {
  await admin.query('BEGIN'); await auth(admin); await hide(admin)
  const id = randomUUID()
  await admin.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,client_message_id) VALUES($1,$2,$3,'waiting','system',$4)", [id, room, agent, `turn-failure:${id}:${reason}`])
  const rows = (await admin.query('SELECT conversation_hidden_at FROM chat.list_conversation_memberships($1) WHERE user_id=$2', [[room], owner])).rows
  expect(rows[0].conversation_hidden_at).not.toBeNull()
  await admin.query('ROLLBACK')
})
it.each(['group-role', 'agent-topic'] as const)('orders hide against the real outer publisher %s without 40P01', async kind => {
  await admin.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [gate])
  await a.query('BEGIN'); await auth(a)
  await a.query("SELECT set_config('gugu.fixture_hide_latch_chat',$1,true),set_config('gugu.fixture_hide_latch_key',$2,true)", [room, gate])
  const published = kind === 'group-role'
    ? committed(a, 'SELECT chat.set_group_member_role_as($1,$2,$3,$4)', [room, peer, 'admin', owner])
    : committed(a, "SELECT * FROM chat.create_topic($1,$2,'Review topic',NULL,$3,$4)", [room, anchor, agent, randomUUID()])
  await blocked(aPid, adminPid)
  await b.query('BEGIN'); await auth(b)
  const hidden = committed(b, 'SELECT chat.hide_my_conversation($1,$2)', [room, randomUUID()])
  await blocked(bPid, aPid)
  await admin.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [gate])
  expect(await Promise.all([published, hidden])).toEqual([null, null])
  expect(await ownState()).not.toBeNull()
})

it('takes the erasure lifecycle guard before FK parents and the owner head', async () => {
  await a.query('BEGIN'); await auth(a)
  await a.query("SELECT pg_advisory_xact_lock(hashtextextended('identity:erase-human:'||$1,0))",[owner])
  await a.query('SELECT chat.lock_revision_heads($1)',[[owner]])
  await b.query('BEGIN'); await auth(b)
  const hidden = committed(b,'SELECT chat.hide_my_conversation($1,$2)',[room,randomUUID()])
  await blocked(bPid,aPid)
  // Mirrors erasure after it has visited another conversation/head. The hide must not yet own
  // an identity FK parent lock while waiting, or this parent deletion lock closes a cycle.
  await a.query('SELECT 1 FROM identity.users WHERE id=$1 FOR UPDATE',[owner])
  await a.query('COMMIT')
  expect(await hidden).toBeNull()
  expect(await ownState()).not.toBeNull()
})

it('orders a different member account erasure across two DMs before surviving peer heads', async () => {
  const [first,second]=[randomUUID(),randomUUID()].sort()
  extraChats=[first,second]
  for (const id of [first,second]) {
    await admin.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'dm','peer DM',$2)",[id,owner])
    await admin.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')",[id,owner,peer])
  }
  await admin.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[gate])
  await a.query('BEGIN'); await auth(a,peer)
  await a.query("SELECT set_config('gugu.fixture_erase_latch_chat',$1,true),set_config('gugu.fixture_hide_latch_key',$2,true)",[first,gate])
  const erased=committed(a,'DELETE FROM auth.users WHERE id=$1::uuid',[peer])
  await blocked(aPid,adminPid)
  await b.query('BEGIN'); await auth(b)
  const hidden=committed(b,'SELECT chat.hide_my_conversation($1,$2)',[second,randomUUID()])
  await blocked(bPid,aPid)
  await admin.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[gate])
  expect(await Promise.all([erased,hidden])).toEqual([null,null])
  expect((await admin.query('SELECT conversation_hidden_at FROM chat.conversation_list_state WHERE chat_id=$1 AND user_id=$2',[second,owner])).rows[0].conversation_hidden_at).not.toBeNull()
})

it('does not visit an un-prelocked group admitted while erasure waits on an old DM member', async () => {
  const [first,joined]=[randomUUID(),randomUUID()].sort(); extraChats=[first,joined]
  await admin.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'dm','Earlier DM',$3),($2,'group','Late admission',$3)",[first,joined,owner])
  await admin.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$3,'member'),($1,$4,'member'),($2,$3,'owner'),($2,$5,'member')",[first,joined,owner,peer,agent])
  await b.query('BEGIN'); await auth(b)
  const invitation=(await b.query("SELECT chat.request_group_invitation_as($1,$2,'join',auth.uid()::text) receipt",[joined,peer])).rows[0].receipt.invitation_id
  await b.query('COMMIT')
  await admin.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[gate])
  await admin.query('BEGIN')
  await admin.query('SELECT 1 FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2 FOR UPDATE',[first,peer])
  await a.query('BEGIN'); await auth(a,peer)
  await a.query("SELECT set_config('gugu.fixture_erase_latch_chat',$1,true),set_config('gugu.fixture_hide_latch_key',$2,true)",[first,gate])
  const erased=committed(a,'DELETE FROM auth.users WHERE id=$1::uuid',[peer])
  await blocked(aPid,adminPid)
  await b.query('BEGIN'); await auth(b,peer)
  await b.query('SELECT chat.decide_group_invitation_as($1,true,auth.uid()::text)',[invitation])
  await b.query('COMMIT')
  expect((await admin.query('SELECT user_id FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2',[joined,peer])).rowCount).toBe(1)
  await admin.query('COMMIT')
  await blocked(aPid,adminPid) // The unchanged erase body now reached the first DM notice, after its heads.
  await b.query('BEGIN'); await auth(b)
  const hidden=committed(b,'SELECT chat.hide_my_conversation($1,$2)',[joined,randomUUID()])
  await blocked(bPid,aPid)
  await admin.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[gate])
  expect(await Promise.all([erased,hidden])).toEqual([null,null])
  expect((await admin.query('SELECT 1 FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2',[joined,peer])).rowCount).toBe(0)
  expect((await admin.query('SELECT conversation_hidden_at FROM chat.conversation_list_state WHERE chat_id=$1 AND user_id=$2',[joined,owner])).rows[0].conversation_hidden_at).not.toBeNull()
})
