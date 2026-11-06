import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const past = '2026-01-01T00:00:00.000Z'
let db: pg.Client
let owner: string, outsider: string, device: string, agent: string, dm: string

beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw Error('Native activity tests require a disposable loopback database')
  }
  db = new pg.Client({ connectionString: url })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, outsider, device, agent, dm] = Array.from({ length: 5 }, randomUUID)
  for (const id of [owner, outsider]) {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, id + '@native-activity.invalid'])
  }
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Fixture','fixture','linux')", [device, owner])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Fixture',$2,$3)", [agent, owner, device])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'dm','Native activity',$2)", [dm, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role,inbox_published_at) VALUES($1,$2,'member',clock_timestamp()),($1,$3,'member',clock_timestamp())", [dm, owner, agent])
})
afterEach(async () => { await db.query('ROLLBACK') })

async function as(user: string, sql: string, values: unknown[] = []) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',json_build_object('sub',$1::text,'role','authenticated')::text,true)", [user])
  try { return (await db.query(sql, values)).rows } finally { await db.query('RESET ROLE').catch(() => undefined) }
}
const publish = async (id = randomUUID(), at = past, session = 'stable-session') =>
  (await as(owner, 'SELECT chat.publish_native_conversation_message($1,$2,$3,$4,$5,$6) AS value', [device, agent, session, id, dm, at]))[0].value
const hide = async () => (await as(owner, 'SELECT chat.hide_my_conversation($1,$2) AS value', [dm, randomUUID()]))[0].value
const seats = async (user = owner) =>
  (await as(user, 'SELECT to_jsonb(m) AS value FROM chat.list_conversation_memberships($1) m', [[dm]])).map(row => row.value)
const own = async () => (await seats()).find(row => row.user_id === owner)
const snapshot = async () => (await as(owner, 'SELECT chat.sync_snapshot() AS value'))[0].value
const head = async () => (await db.query('SELECT revision::text AS revision FROM chat.account_revision_heads WHERE user_id=$1', [owner])).rows[0].revision as string
const iso = (value: string) => {
  expect(typeof value).toBe('string')
  return new Date(value).toISOString()
}
async function denied(action: () => Promise<unknown>, code: string) {
  await db.query('SAVEPOINT expected_failure')
  try { await expect(action()).rejects.toMatchObject({ code }) } finally { await db.query('ROLLBACK TO SAVEPOINT expected_failure') }
}

it('distinguishes authorized absence, peer not-applicable fields and an unauthorized missing seat', async () => {
  const rows = await seats()
  expect(rows.find(row => row.user_id === owner)).toMatchObject({
    native_personal_activity_at: null,
    native_personal_activity_revision: '0',
    personal_state_observed_revision: await head(),
  })
  expect(rows.find(row => row.user_id === agent)).toMatchObject({
    native_personal_activity_at: null,
    native_personal_activity_revision: null,
    personal_state_observed_revision: null,
  })
  expect(await seats(outsider)).toEqual([])
})

it('materializes the original personal time and a caller-only activity version on first publication', async () => {
  const before = await head()
  const receipt = await publish()
  const row = await own()
  expect(receipt.already).toBe(false)
  expect(iso(row.native_personal_activity_at)).toBe(past)
  expect(BigInt(row.native_personal_activity_revision)).toBeGreaterThan(BigInt(before))
  expect(row.personal_state_observed_revision).toBe(receipt.account_revision)
  expect((await db.query('SELECT count(*)::int AS n FROM chat.messages WHERE chat_id=$1', [dm])).rows[0].n).toBe(0)
  const changed = (await db.query('SELECT user_id,event,resource_key FROM chat.account_revisions WHERE user_id=$1 AND revision>$2', [owner, before])).rows
  expect(changed).toEqual([{ user_id: owner, event: 'chat_members_changed', resource_key: { chat_id: dm, user_id: owner, kind: 'own' } }])
})

it.each([past, '2025-12-31T23:59:00.000Z'])('advances the facet for another first publication at %s without moving time backwards', async at => {
  await publish()
  const before = await own()
  await publish(randomUUID(), at)
  const after = await own()
  expect(iso(after.native_personal_activity_at)).toBe(past)
  expect(BigInt(after.native_personal_activity_revision)).toBeGreaterThan(BigInt(before.native_personal_activity_revision))
})

it('keeps the activity version on hide and a matching lost-receipt retry', async () => {
  const id = randomUUID()
  await publish(id)
  const before = await own()
  const hidden = await hide()
  const retry = await publish(id)
  const after = await own()
  expect(retry).toMatchObject({ already: true, account_revision: hidden.account_revision })
  expect(after.conversation_hidden_at).not.toBeNull()
  expect(after.native_personal_activity_at).toBe(before.native_personal_activity_at)
  expect(after.native_personal_activity_revision).toBe(before.native_personal_activity_revision)
  expect(after.personal_state_observed_revision).toBe(hidden.account_revision)
  expect(BigInt(after.personal_state_observed_revision)).toBeGreaterThan(BigInt(after.native_personal_activity_revision))
})

it('restores for a first delayed real publication without replacing its original sorting time', async () => {
  const hidden = await hide()
  await publish()
  const row = await own()
  expect(row.conversation_hidden_at).toBeNull()
  expect(iso(row.native_personal_activity_at)).toBe(past)
  expect(BigInt(row.native_personal_activity_revision)).toBeGreaterThan(BigInt(hidden.account_revision))
})

it('does not allow an old publication identity to change its original time', async () => {
  const id = randomUUID()
  await publish(id)
  const before = await own()
  await denied(() => publish(id, '2026-01-02T00:00:00.000Z'), '23505')
  expect(await own()).toEqual(before)
})

it('keeps a retained pre-upgrade receipt duplicate without manufacturing activity from unknown history', async () => {
  const id = randomUUID()
  await db.query(
    'INSERT INTO chat.native_conversation_publications(owner_user_id,device_id,session_id,message_id,agent_user_id,chat_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [owner, device, 'stable-session', id, agent, dm, past],
  )
  const hidden = await hide()
  expect((await publish(id)).already).toBe(true)
  expect(await own()).toMatchObject({
    native_personal_activity_at: null,
    native_personal_activity_revision: '0',
    personal_state_observed_revision: hidden.account_revision,
  })
  expect((await own()).conversation_hidden_at).not.toBeNull()
})

it('keeps activity and exact observation versions as decimal strings above the JS integer boundary', async () => {
  await db.query('UPDATE chat.account_revision_heads SET revision=9007199254740992 WHERE user_id=$1', [owner])
  await publish()
  const row = await own()
  expect(row.native_personal_activity_revision).toBe('9007199254740993')
  expect(row.personal_state_observed_revision).toBe('9007199254740993')
  const value = await snapshot()
  expect(value.revision).toBe('9007199254740993')
  expect(value.memberships.find((seat: { user_id: string }) => seat.user_id === owner)).toMatchObject({
    native_personal_activity_revision: '9007199254740993',
    personal_state_observed_revision: '9007199254740993',
  })
})

it('returns the same authoritative activity in the snapshot and narrow projection while retaining hidden addressing', async () => {
  await publish()
  await hide()
  const current = await own()
  const value = await snapshot()
  expect(value.chats).toContainEqual(expect.objectContaining({ id: dm }))
  expect(value.memberships.find((seat: { user_id: string }) => seat.user_id === owner)).toMatchObject({
    native_personal_activity_at: current.native_personal_activity_at,
    native_personal_activity_revision: current.native_personal_activity_revision,
    personal_state_observed_revision: value.revision,
    conversation_hidden_at: current.conversation_hidden_at,
  })
})

it('keeps the established fact when the Agent leaves the live directory', async () => {
  await publish()
  const before = await own()
  expect(before.native_personal_activity_revision).toMatch(/^[1-9][0-9]*$/)
  expect(iso(before.native_personal_activity_at)).toBe(past)
  await db.query('UPDATE identity.users SET removed_at=clock_timestamp() WHERE id=$1', [agent])
  const after = await own()
  expect(after.native_personal_activity_at).toBe(before.native_personal_activity_at)
  expect(after.native_personal_activity_revision).toBe(before.native_personal_activity_revision)
  expect((await seats()).find(row => row.user_id === agent).historical_only).toBe(true)
})

it('keeps the fact independent of device retention and protects it through a closed private table', async () => {
  await publish()
  const refs = (await db.query("SELECT confrelid::regclass::text AS parent FROM pg_constraint WHERE conrelid='chat.native_personal_conversation_activity'::regclass AND contype='f'")).rows.map(row => row.parent)
  expect(refs.sort()).toEqual(['chat.chats', 'identity.users'])
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect((await db.query("SELECT has_table_privilege($1,'chat.native_personal_conversation_activity',$2) AS allowed", [role, privilege])).rows[0].allowed).toBe(false)
    }
  }
  expect((await db.query("SELECT relrowsecurity AS enabled FROM pg_class WHERE oid='chat.native_personal_conversation_activity'::regclass")).rows[0].enabled).toBe(true)
  await denied(() => as(owner, 'SELECT * FROM chat.native_personal_conversation_activity'), '42501')
  expect((await db.query("SELECT pg_get_userbyid(proowner) AS owner,prosecdef,provolatile,proconfig FROM pg_proc WHERE oid='chat.list_conversation_memberships(text[])'::regprocedure")).rows[0]).toMatchObject({ owner: 'postgres', prosecdef: true, provolatile: 's', proconfig: ['search_path=""'] })
  expect((await db.query("SELECT prosecdef FROM pg_proc WHERE oid='chat.sync_snapshot()'::regprocedure")).rows[0].prosecdef).toBe(false)
})

it('rolls back publication identity, restoration, activity, journal and wake together', async () => {
  const hidden = await hide()
  const id = randomUUID()
  const wakes = async () => (await db.query(
    "SELECT count(*)::int AS n FROM realtime.messages WHERE event='im_revision_advanced' AND topic LIKE '%' || $1::text || '%'", [owner],
  )).rows[0].n as number
  const beforeWakes = await wakes()
  await db.query('SAVEPOINT publication')
  await publish(id)
  expect((await own()).native_personal_activity_revision).toMatch(/^[1-9][0-9]*$/)
  await db.query('ROLLBACK TO SAVEPOINT publication')
  expect(await own()).toMatchObject({ native_personal_activity_at: null, native_personal_activity_revision: '0', personal_state_observed_revision: hidden.account_revision })
  expect((await own()).conversation_hidden_at).not.toBeNull()
  expect((await db.query('SELECT count(*)::int AS n FROM chat.native_conversation_publications WHERE device_id=$1 AND message_id=$2', [device, id])).rows[0].n).toBe(0)
  expect((await db.query('SELECT count(*)::int AS n FROM chat.account_revisions WHERE user_id=$1 AND revision>$2', [owner, hidden.account_revision])).rows[0].n).toBe(0)
  expect(await wakes()).toBe(beforeWakes)
})

it('rejects non-finite activity without leaving a restored row or publication receipt', async () => {
  await hide()
  const id = randomUUID()
  await denied(() => publish(id, 'infinity'), '22023')
  expect((await own()).conversation_hidden_at).not.toBeNull()
  expect((await own()).native_personal_activity_revision).toBe('0')
  expect((await db.query('SELECT count(*)::int AS n FROM chat.native_conversation_publications WHERE device_id=$1 AND message_id=$2', [device, id])).rows[0].n).toBe(0)
})
