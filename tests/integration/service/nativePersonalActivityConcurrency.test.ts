import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const at = '2026-01-01T00:00:00.000Z'
let a: pg.Client, b: pg.Client
let owner: string, device: string, agent: string, dm: string, aPid: number, bPid: number

beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw Error('Native activity concurrency requires a disposable loopback database')
  }
  a = new pg.Client({ connectionString: url })
  b = new pg.Client({ connectionString: url })
  await a.connect(); await b.connect()
  for (const client of [a, b]) await client.query("SET statement_timeout='8s'")
  aPid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
})
afterAll(async () => { await a?.end(); await b?.end() })
beforeEach(async () => {
  ;[owner, device, agent, dm] = Array.from({ length: 4 }, randomUUID)
  await a.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [owner, owner + '@native-race.invalid'])
  await a.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Fixture','fixture','linux')", [device, owner])
  await a.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Fixture',$2,$3)", [agent, owner, device])
  await a.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'dm','Native race',$2)", [dm, owner])
  await a.query("INSERT INTO chat.chat_members(chat_id,user_id,role,inbox_published_at) VALUES($1,$2,'member',clock_timestamp()),($1,$3,'member',clock_timestamp())", [dm, owner, agent])
})
afterEach(async () => {
  await a.query('ROLLBACK'); await b.query('ROLLBACK')
  await a.query('DELETE FROM chat.chats WHERE id=$1', [dm])
  await a.query('DELETE FROM auth.users WHERE id=$1', [owner])
})
const auth = (client: pg.Client) => client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner])
const publish = (client: pg.Client, id = randomUUID()) => client.query(
  'SELECT chat.publish_native_conversation_message($1,$2,$3,$4,$5,$6) AS value',
  [device, agent, 'race-session', id, dm, at],
)
const hide = (client: pg.Client) => client.query('SELECT chat.hide_my_conversation($1,$2) AS value', [dm, randomUUID()])
const own = async (client: pg.Client) => (await client.query(
  'SELECT to_jsonb(m) AS value FROM chat.list_conversation_memberships($1) m WHERE m.user_id=$2', [[dm], owner],
)).rows[0].value
async function waitingOnA() {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    const row = (await a.query('SELECT pg_blocking_pids($1) AS blockers', [bPid])).rows[0]
    if (row.blockers.includes(aPid)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw Error('The native/hide transaction never reached the intended blocker')
}

it('holds hide before a first native admission, then restores with one activity fact', async () => {
  await a.query('BEGIN'); await auth(a); await hide(a)
  await b.query('BEGIN'); await auth(b)
  const sent = publish(b)
  await waitingOnA()
  await a.query('COMMIT')
  const receipt = (await sent).rows[0].value
  await b.query('COMMIT')
  await a.query('BEGIN'); await auth(a)
  const row = await own(a)
  expect(row.conversation_hidden_at).toBeNull()
  expect(row.native_personal_activity_revision).toBe(receipt.account_revision)
  expect(new Date(row.native_personal_activity_at).toISOString()).toBe(at)
})

it('holds first native admission before hide without letting a later retry restore again', async () => {
  const id = randomUUID()
  await a.query('BEGIN'); await auth(a)
  const original = (await publish(a, id)).rows[0].value
  await b.query('BEGIN'); await auth(b)
  const hiding = hide(b)
  await waitingOnA()
  await a.query('COMMIT'); await hiding; await b.query('COMMIT')
  await a.query('BEGIN'); await auth(a)
  expect((await publish(a, id)).rows[0].value.already).toBe(true)
  const row = await own(a)
  expect(row.conversation_hidden_at).not.toBeNull()
  expect(row.native_personal_activity_revision).toBe(original.account_revision)
  expect(BigInt(row.personal_state_observed_revision)).toBeGreaterThan(BigInt(row.native_personal_activity_revision))
})

it('observes activity and its account boundary from one MVCC snapshot during a concurrent admission', async () => {
  await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await auth(a)
  const before = await own(a)
  expect(before.native_personal_activity_revision).toBe('0')
  await b.query('BEGIN'); await auth(b)
  const published = (await publish(b)).rows[0].value
  await b.query('COMMIT')
  const during = (await a.query('SELECT chat.sync_snapshot() AS value')).rows[0].value
  expect(during.revision).toBe(before.personal_state_observed_revision)
  expect(during.memberships.find((seat: { user_id: string }) => seat.user_id === owner)).toMatchObject({
    native_personal_activity_at: null,
    native_personal_activity_revision: '0',
    personal_state_observed_revision: before.personal_state_observed_revision,
  })
  await a.query('COMMIT')
  await a.query('BEGIN'); await auth(a)
  const after = await own(a)
  expect(after.native_personal_activity_revision).toBe(published.account_revision)
  expect(after.personal_state_observed_revision).toBe(published.account_revision)
})
