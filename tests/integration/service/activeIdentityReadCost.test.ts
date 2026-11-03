import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let owner: string, peer: string, removed: string, outsider: string, room: string, contacts: string
async function asUser(id = owner) {
  await db.query('RESET ROLE')
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function refused(sql: string, args: unknown[]) {
  await db.query('SAVEPOINT refusal')
  try { await db.query(sql, args) } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT refusal')
    return (error as { code: string }).code
  }
  throw new Error('Expected permission refusal: ' + sql)
}
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Active identity contracts require a disposable loopback database')
  }
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, peer, removed, outsider, room, contacts] = Array.from({ length: 6 }, randomUUID)
  for (const id of [owner, peer, removed, outsider]) await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,now(),now())`, [id, `${id}@active-cost.invalid`])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Active identity fixture',$2)", [room, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')", [room, owner, peer, removed])
  await db.query("INSERT INTO identity.contact_groups(id,owner_user_id,name) VALUES($1,$2,'Active identity fixture')", [contacts, owner])
  for (const id of [peer, removed]) {
    await db.query('INSERT INTO identity.friendships(user_a_id,user_b_id) VALUES(LEAST($1,$2),GREATEST($1,$2))', [owner, id])
    await db.query('INSERT INTO identity.friend_requests(sender_id,receiver_id) VALUES($1,$2)', [owner, id])
    await db.query('INSERT INTO chat.contacts(owner_user_id,contact_user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [owner, id])
    await db.query('INSERT INTO identity.contact_group_members(group_id,contact_user_id) VALUES($1,$2)', [contacts, id])
    await db.query("INSERT INTO identity.contact_overrides(owner_user_id,contact_user_id,alias) VALUES($1,$2,'Private name')", [owner, id])
  }
  await db.query("INSERT INTO identity.contact_overrides(owner_user_id,target_kind,group_chat_id,alias) VALUES($1,'group',$2,'Private group name')", [owner, room])
  await db.query("UPDATE identity.users SET removed_at=now() WHERE id=$1", [removed])
  await asUser()
})
afterEach(async () => { await db.query('RESET ROLE'); await db.query('ROLLBACK') })

describe('the eight live-identity RLS policies preserve their permission boundaries', () => {
  it('members_select_peer retains live peer rows and denies outsiders', async () => {
    expect((await db.query('SELECT user_id FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id', [room])).rows.map(r => r.user_id)).toEqual([owner, peer].sort())
    await asUser(outsider)
    expect((await db.query('SELECT user_id FROM chat.chat_members WHERE chat_id=$1', [room])).rows).toEqual([])
  })
  it('members_live_write permits own preferences, denies peer preferences and removed callers', async () => {
    expect((await db.query('UPDATE chat.chat_members SET is_pinned=true WHERE chat_id=$1 AND user_id=$2', [room, owner])).rowCount).toBe(1)
    expect((await db.query('UPDATE chat.chat_members SET is_pinned=true WHERE chat_id=$1 AND user_id=$2', [room, peer])).rowCount).toBe(0)
    await asUser(removed)
    expect((await db.query('UPDATE chat.chat_members SET is_pinned=true WHERE chat_id=$1 AND user_id=$2', [room, removed])).rowCount).toBe(0)
  })
  for (const [policy, sql, values] of [
    ['friendships_live', 'SELECT user_a_id,user_b_id FROM identity.friendships WHERE user_a_id=$1 OR user_b_id=$1', () => [owner]],
    ['friend_requests_live', 'SELECT receiver_id FROM identity.friend_requests WHERE sender_id=$1', () => [owner]],
    ['contacts_live', 'SELECT contact_user_id FROM chat.contacts WHERE owner_user_id=$1', () => [owner]],
    ['contact_group_members_live', 'SELECT contact_user_id FROM identity.contact_group_members WHERE group_id=$1', () => [contacts]],
  ] as const) {
    it(`${policy} hides removed identities without exposing another owner`, async () => {
      expect((await db.query(sql, values())).rows).toHaveLength(1)
      await asUser(outsider)
      expect((await db.query(sql, values())).rows).toEqual([])
    })
  }
  it('contact_overrides_live retains group overrides and hides removed user overrides', async () => {
    const rows = (await db.query('SELECT target_kind,contact_user_id FROM identity.contact_overrides WHERE owner_user_id=$1', [owner])).rows
    expect(rows).toHaveLength(2)
    expect(rows).toContainEqual({ target_kind: 'contact', contact_user_id: peer })
    expect(rows).toContainEqual({ target_kind: 'group', contact_user_id: null })
    await asUser(outsider)
    expect((await db.query('SELECT target_kind FROM identity.contact_overrides WHERE owner_user_id=$1', [owner])).rows).toEqual([])
  })
  it('identity_lifecycle_events_select permits a live subscriber and rejects a removed subscriber', async () => {
    await db.query('RESET ROLE')
    await db.query(`INSERT INTO realtime.messages(topic,event,payload,extension,private)
      VALUES('gugu:identity:lifecycle','identity_removed',jsonb_build_object('probe',$1::text),'broadcast',true)`, [room])
    await asUser()
    expect((await db.query("SELECT event FROM realtime.messages WHERE topic='gugu:identity:lifecycle' AND payload->>'probe'=$1", [room])).rows).toHaveLength(1)
    await asUser(removed)
    expect((await db.query("SELECT event FROM realtime.messages WHERE topic='gugu:identity:lifecycle' AND payload->>'probe'=$1", [room])).rows).toEqual([])
  })
  it('WITH CHECK and existing table grants still reject removed targets and direct membership writes', async () => {
    for (const [sql, args] of [
      ['INSERT INTO chat.contacts(owner_user_id,contact_user_id) VALUES($1,$2)', [owner, removed]],
      ['INSERT INTO identity.contact_group_members(group_id,contact_user_id) VALUES($1,$2)', [contacts, removed]],
      ["INSERT INTO identity.contact_overrides(owner_user_id,contact_user_id,alias) VALUES($1,$2,'no')", [owner, removed]],
      ["INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [room, outsider]],
      ['INSERT INTO identity.friendships(user_a_id,user_b_id) VALUES(LEAST($1,$2),GREATEST($1,$2))', [owner, outsider]],
      ['INSERT INTO identity.friend_requests(sender_id,receiver_id) VALUES($1,$2)', [owner, removed]],
    ] as const) expect(await refused(sql, [...args])).toBe('42501')
  })
})

it('keeps invoker views and the file reader scoped without granting access to the users table', async () => {
  expect((await db.query('SELECT * FROM chat.chat_members WHERE chat_id=$1', [room])).rows).toHaveLength(2)
  await db.query('RESET ROLE')
  await db.query('GRANT gugu_files TO postgres') // Fixture-only role membership; afterEach rolls it back.
  await db.query('SET LOCAL ROLE gugu_files')
  expect((await db.query('SELECT user_id FROM chat.active_members WHERE chat_id=$1 ORDER BY user_id', [room])).rows.map(r => r.user_id)).toEqual([owner, peer].sort())
  expect(await refused('SELECT id,removed_at FROM identity.users WHERE id=$1', [owner])).toBe('42501')
  await db.query('RESET ROLE')
  const views = (await db.query(`SELECT relname,reloptions FROM pg_class
    WHERE oid=ANY(ARRAY['chat.active_members'::regclass,'identity.active_users'::regclass,'identity.active_friendships'::regclass]) ORDER BY relname`)).rows
  expect(views).toHaveLength(3)
  for (const view of views) expect(view.reloptions).toContain('security_invoker=true')
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await db.query(`SET LOCAL ROLE ${role}`)
    await db.query('SAVEPOINT view_permission')
    try {
      const n = (await db.query('SELECT id FROM identity.active_users WHERE id=ANY($1) ORDER BY id', [[owner, peer, removed, outsider]])).rows.length
      expect(role).not.toBe('anon'); expect(n).toBe(3)
    } catch (error) {
      await db.query('ROLLBACK TO SAVEPOINT view_permission')
      if (role !== 'anon') throw error
      expect((error as { code: string }).code).toBe('42501')
    }
    await db.query('RESET ROLE')
  }
})

it('plans active members and users without a per-row user_is_live call', async () => {
  await db.query('RESET ROLE')
  for (const relation of ['chat.active_members', 'identity.active_users']) {
    const plan = (await db.query(`EXPLAIN (VERBOSE, FORMAT JSON) SELECT * FROM ${relation}`)).rows
    expect(JSON.stringify(plan)).not.toContain('user_is_live')
  }
})

it('synchronizes removal without changing seat fields, history or membership revision heads', async () => {
  await db.query('RESET ROLE')
  const seats = (await db.query("SELECT to_jsonb(m)-'user_removed_at' AS seat FROM chat.chat_members m WHERE chat_id=$1 ORDER BY user_id", [room])).rows
  const heads = (await db.query('SELECT * FROM chat.account_revision_heads WHERE user_id=ANY($1) ORDER BY user_id', [[owner, peer]])).rows
  await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1', [peer])
  expect((await db.query('SELECT user_id FROM chat.active_members WHERE chat_id=$1', [room])).rows).toEqual([{ user_id: owner }])
  expect((await db.query("SELECT to_jsonb(m)-'user_removed_at' AS seat FROM chat.chat_members m WHERE chat_id=$1 ORDER BY user_id", [room])).rows).toEqual(seats)
  expect((await db.query('SELECT * FROM chat.account_revision_heads WHERE user_id=ANY($1) ORDER BY user_id', [[owner, peer]])).rows).toEqual(heads)
  expect((await db.query(`SELECT count(*)::int AS n FROM chat.chat_members m JOIN identity.users u ON u.id=m.user_id
    WHERE m.chat_id=$1 AND m.user_removed_at IS DISTINCT FROM u.removed_at`, [room])).rows[0].n).toBe(0)
})

it('initializes late seats for removed users and rejects attempts to forge the cache', async () => {
  await db.query('RESET ROLE')
  const otherRoom = randomUUID()
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Late seat fixture',$2)", [otherRoom, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [otherRoom, owner, removed])
  await db.query('UPDATE chat.chat_members SET user_removed_at=NULL WHERE chat_id=$1 AND user_id=$2', [otherRoom, removed])
  expect((await db.query('SELECT user_id FROM chat.active_members WHERE chat_id=$1', [otherRoom])).rows).toEqual([{ user_id: owner }])
  expect((await db.query('SELECT user_removed_at IS NOT NULL AS removed FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [otherRoom, removed])).rows[0].removed).toBe(true)
})

for (const order of ['insert-first', 'remove-first']) it(`serializes concurrent removal and admission: ${order}`, async () => {
  await db.query('RESET ROLE')
  const url = process.env.GUGU_INTEGRATION_DATABASE_URL!
  const a = new Client({ connectionString: url }), b = new Client({ connectionString: url })
  await a.connect(); await b.connect()
  const host = randomUUID(), target = randomUUID(), group = randomUUID()
  let pending: Promise<{ error?: unknown }> | undefined
  try {
    for (const id of [host, target]) await a.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at)
      VALUES($1,'authenticated','authenticated',$2,now(),now())`, [id, `${id}@active-race.invalid`])
    await a.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Admission race fixture',$2)", [group, host])
    await a.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [group, host])
    const firstPid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const secondPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const insert = "INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')"
    const remove = 'UPDATE identity.users SET removed_at=now() WHERE id=$1'
    await a.query('BEGIN'); await b.query('BEGIN')
    if (order === 'insert-first') {
      await a.query(insert, [group, target])
      pending = b.query(remove, [target]).then(() => ({}), error => ({ error }))
    } else {
      await a.query(remove, [target])
      pending = b.query(insert, [group, target]).then(() => ({}), error => ({ error }))
    }
    // Observe the actual database lock dependency, not elapsed execution time.
    let blocked = false
    for (let attempt = 0; attempt < 1000; attempt++) {
      blocked = (await db.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked', [firstPid, secondPid])).rows[0].blocked
      if (blocked) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(blocked).toBe(true)
    await a.query('COMMIT')
    expect((await pending).error).toBeUndefined()
    await b.query('COMMIT')
    expect((await a.query(`SELECT m.user_removed_at IS NOT DISTINCT FROM u.removed_at AS synchronized,
      m.user_removed_at IS NOT NULL AS removed,EXISTS(SELECT 1 FROM chat.active_members v
      WHERE v.chat_id=m.chat_id AND v.user_id=m.user_id) AS visible
      FROM chat.chat_members m JOIN identity.users u ON u.id=m.user_id
      WHERE m.chat_id=$1 AND m.user_id=$2`, [group, target])).rows).toEqual([{ synchronized: true, removed: true, visible: false }])
  } finally {
    await a.query('ROLLBACK'); await b.query('ROLLBACK')
    await pending
    await a.query('DELETE FROM chat.chats WHERE id=$1', [group])
    await a.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [[host, target]])
    await a.end(); await b.end()
  }
})
