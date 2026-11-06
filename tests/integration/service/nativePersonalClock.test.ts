import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const past = '2026-01-01T00:00:00.000Z'
const future = '2099-01-01T00:00:00.000Z'
let db: pg.Client
let owner: string, device: string, agent: string, dm: string

beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw Error('Clock tests require a disposable loopback database')
  db = new pg.Client({ connectionString: url })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, device, agent, dm] = Array.from({ length: 4 }, randomUUID)
  await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [owner, owner + '@personal-clock.invalid'])
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Clock fixture','fixture','linux')", [device, owner])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Clock fixture',$2,$3)", [agent, owner, device])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'dm','Personal clock',$2)", [dm, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')", [dm, owner, agent])
  expect((await db.query('UPDATE chat.chat_members SET inbox_published_at=clock_timestamp() WHERE chat_id=$1', [dm])).rowCount).toBe(2)
})
afterEach(async () => { await db.query('ROLLBACK') })

async function asOwner(sql: string, values: unknown[] = []) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner])
  try { return (await db.query(sql, values)).rows } finally { await db.query('RESET ROLE').catch(() => undefined) }
}
const publish = async (id = randomUUID(), at = past) =>
  (await asOwner('SELECT chat.publish_native_conversation_message($1,$2,$3,$4,$5,$6) AS value', [device, agent, 'clock-session', id, dm, at]))[0].value
const seats = async () => (await asOwner('SELECT to_jsonb(m) AS value FROM chat.list_conversation_memberships($1) m', [[dm]])).map(row => row.value)
const own = async () => (await seats()).find(row => row.user_id === owner)
const hide = async () => (await asOwner('SELECT chat.hide_my_conversation($1,$2) AS value', [dm, randomUUID()]))[0].value
const ledger = async (id: string) => (await db.query(
  'SELECT occurred_at::text,published_at::text,sort_at::text,personal_activity_applied_revision::text FROM chat.native_conversation_publications WHERE device_id=$1 AND session_id=$2 AND message_id=$3',
  [device, 'clock-session', id],
)).rows[0]
async function rejects(action: () => Promise<unknown>, code: string) {
  await db.query('SAVEPOINT rejected')
  try { await expect(action()).rejects.toMatchObject({ code }) } finally { await db.query('ROLLBACK TO SAVEPOINT rejected') }
}

it('distinguishes absent caller sort from peer not-applicable fields', async () => {
  const rows = await seats()
  expect(rows.find(row => row.user_id === owner)).toMatchObject({ native_personal_activity_at: null, native_personal_sort_at: null, native_personal_activity_revision: '0' })
  expect(rows.find(row => row.user_id === agent)).toMatchObject({ native_personal_activity_at: null, native_personal_sort_at: null, native_personal_activity_revision: null, personal_state_observed_revision: null })
})

it('keeps an original past time without moving it to receipt time', async () => {
  const id = randomUUID()
  const receipt = await publish(id)
  const row = await own(), entry = await ledger(id)
  expect(new Date(row.native_personal_sort_at).toISOString()).toBe(past)
  expect(entry.sort_at).toBe(entry.occurred_at)
  expect(entry.personal_activity_applied_revision).toBe(receipt.account_revision)
  expect(row.native_personal_activity_revision).toBe(entry.personal_activity_applied_revision)
})

it('caps future sorting at the first durable server receipt while retaining the raw time', async () => {
  const id = randomUUID()
  await publish(id, future)
  const row = await own(), entry = await ledger(id)
  expect(new Date(row.native_personal_activity_at).toISOString()).toBe(future)
  expect(entry.sort_at).toBe(entry.published_at)
  expect(new Date(row.native_personal_sort_at).toISOString()).toBe(new Date(entry.published_at).toISOString())
  expect(new Date(entry.sort_at).getTime()).toBeLessThan(new Date(entry.occurred_at).getTime())
})

it('does not replace the first receive/sort/association on a later matching retry across hide', async () => {
  const id = randomUUID()
  await publish(id, future)
  const before = await ledger(id), beforeRow = await own()
  await hide()
  expect((await publish(id, future)).already).toBe(true)
  expect(await ledger(id)).toEqual(before)
  const after = await own()
  expect(after.conversation_hidden_at).not.toBeNull()
  expect(after.native_personal_sort_at).toBe(beforeRow.native_personal_sort_at)
  expect(after.native_personal_activity_revision).toBe(beforeRow.native_personal_activity_revision)
})

it('aggregates each message minimum rather than the minimum of two aggregate maxima', async () => {
  const first = randomUUID()
  await publish(first, future)
  const midway = (await db.query(
    'SELECT (published_at+(clock_timestamp()-published_at)/2)::text AS value FROM chat.native_conversation_publications WHERE device_id=$1 AND message_id=$2', [device, first],
  )).rows[0].value
  const second = randomUUID()
  await publish(second, midway)
  const check = (await db.query(`SELECT a.native_personal_sort_at=$3::timestamptz AS exact,
    a.native_personal_sort_at=greatest(p.sort_at,q.sort_at) AS per_message,
    a.native_personal_sort_at<least(greatest(p.occurred_at,q.occurred_at),greatest(p.published_at,q.published_at)) AS different
    FROM chat.native_personal_conversation_activity a
    JOIN chat.native_conversation_publications p ON p.device_id=$1 AND p.message_id=$2
    JOIN chat.native_conversation_publications q ON q.device_id=$1 AND q.message_id=$4
    WHERE a.user_id=$5 AND a.chat_id=$6`, [device, first, midway, second, owner, dm])).rows[0]
  expect(check).toEqual({ exact: true, per_message: true, different: true })
})

it.each([past, '2025-12-31T23:59:00.000Z'])('advances the actual facet for another first message at %s with unchanged maxima', async at => {
  await publish()
  const before = await own(), id = randomUUID()
  const receipt = await publish(id, at)
  const after = await own()
  expect(after.native_personal_activity_at).toBe(before.native_personal_activity_at)
  expect(after.native_personal_sort_at).toBe(before.native_personal_sort_at)
  expect(BigInt(after.native_personal_activity_revision)).toBeGreaterThan(BigInt(before.native_personal_activity_revision))
  expect((await ledger(id)).personal_activity_applied_revision).toBe(receipt.account_revision)
})

it('retains the original payload conflict check after fixing the sorting time', async () => {
  const id = randomUUID()
  await publish(id, future)
  const before = await ledger(id)
  await rejects(() => publish(id, past), '23505')
  expect(await ledger(id)).toEqual(before)
})

it('does not create a legacy migration baseline for a new C-only conversation', async () => {
  await publish()
  expect((await db.query('SELECT legacy_personal_sort_at,legacy_sort_migrated_at FROM chat.native_personal_conversation_activity WHERE user_id=$1 AND chat_id=$2', [owner, dm])).rows[0]).toEqual({ legacy_personal_sort_at: null, legacy_sort_migrated_at: null })
})

it('returns an exact complete tuple through the same snapshot above the JS integer boundary', async () => {
  await db.query('UPDATE chat.account_revision_heads SET revision=9007199254740992 WHERE user_id=$1', [owner])
  await publish()
  const row = await own()
  expect(row.native_personal_activity_revision).toBe('9007199254740993')
  expect(row.personal_state_observed_revision).toBe('9007199254740993')
  const snapshot = (await asOwner('SELECT chat.sync_snapshot() AS value'))[0].value
  expect(snapshot.memberships.find((seat: { user_id: string }) => seat.user_id === owner)).toMatchObject({
    native_personal_activity_at: row.native_personal_activity_at,
    native_personal_sort_at: row.native_personal_sort_at,
    native_personal_activity_revision: row.native_personal_activity_revision,
    personal_state_observed_revision: snapshot.revision,
  })
})

it('does not fill metadata-only receipt evidence or make a personal fact through a matching retry', async () => {
  const id = randomUUID()
  await db.query('INSERT INTO chat.native_conversation_publications(owner_user_id,device_id,session_id,message_id,agent_user_id,chat_id,occurred_at,sort_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)', [owner, device, 'clock-session', id, agent, dm, past])
  await hide()
  expect((await publish(id)).already).toBe(true)
  expect(await own()).toMatchObject({ native_personal_activity_at: null, native_personal_sort_at: null, native_personal_activity_revision: '0' })
  expect((await ledger(id)).personal_activity_applied_revision).toBeNull()
  expect((await own()).conversation_hidden_at).not.toBeNull()
})

it('rolls the complete sort tuple and per-publication association back together', async () => {
  const id = randomUUID()
  await db.query('SAVEPOINT publication')
  await publish(id, future)
  expect((await ledger(id)).personal_activity_applied_revision).toMatch(/^[1-9][0-9]*$/)
  await db.query('ROLLBACK TO SAVEPOINT publication')
  expect(await ledger(id)).toBeUndefined()
  expect(await own()).toMatchObject({ native_personal_activity_at: null, native_personal_sort_at: null, native_personal_activity_revision: '0' })
})

it('rejects a persisted partial fact rather than exposing it as a valid old NULL sorting state', async () => {
  await publish()
  await rejects(() => db.query('UPDATE chat.native_personal_conversation_activity SET native_personal_sort_at=NULL WHERE user_id=$1 AND chat_id=$2', [owner, dm]), '23502')
})
