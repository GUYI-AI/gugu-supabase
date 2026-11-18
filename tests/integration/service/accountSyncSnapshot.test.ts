import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BEGIN_READING_REVISIONS } from '../../support/revisionTransaction'

type Row = Record<string, unknown>
interface Db {
  connect(): Promise<void>
  end(): Promise<void>
  query<T = Row>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (options: { connectionString: string }) => Db }
const connectionString = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let db: Db
beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('snapshot tests require disposable loopback PostgreSQL')
  db = new Client({ connectionString })
  await db.connect()
})
afterAll(async () => { await db?.end() })

async function as<T = Row>(viewer: string, sql: string, values: unknown[] = []) {
  await db.query('SAVEPOINT snapshot_role')
  try {
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: viewer, role: 'authenticated' })])
    await db.query('SET LOCAL ROLE authenticated')
    return (await db.query<T>(sql, values)).rows
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT snapshot_role')
    await db.query('RELEASE SAVEPOINT snapshot_role')
  }
}
async function fixture(body: (f: { owner: string; peer: string; stranger: string; chat: string }) => Promise<void>) {
  const [owner, peer, stranger, chat] = Array.from({ length: 4 }, () => randomUUID())
  await db.query(BEGIN_READING_REVISIONS)
  try {
    await db.query("INSERT INTO identity.users(id,type,display_name) SELECT id,'human','snapshot fixture' FROM unnest($1::text[]) id", [[owner, peer, stranger]])
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','snapshot group',$2)", [chat, owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')", [chat, owner, peer])
    await body({ owner, peer, stranger, chat })
  } finally { await db.query('ROLLBACK') }
}
type Snapshot = { account_id: string; revision: string; chats: Row[]; memberships: Row[]; previews: Row[]; identities: Row[] }
async function snapshot(viewer: string) {
  return (await as<{ value: Snapshot }>(viewer, 'SELECT chat.sync_snapshot() AS value'))[0]!.value
}

describe('consistent account snapshot', () => {
  it('returns current state at the matching head without replaying historical revisions', async () => fixture(async (f) => {
    const before = await snapshot(f.owner)
    expect(before.chats.map((c) => c.id)).toEqual([f.chat])
    expect(before.identities.map((u) => u.id).sort()).toEqual([f.owner, f.peer].sort())
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES ($1,$2,$3,'new visible value','text')", [randomUUID(), f.chat, f.peer])
    const after = await snapshot(f.owner)
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision))
    expect(after.previews[0]!.preview).toBe('new visible value')
    const [{ value }] = await as<{ value: { operations: { revision: string }[] } }>(f.owner, 'SELECT chat.sync_since($1,100) AS value', [before.revision])
    expect(value!.operations[0]!.revision).toBe(String(BigInt(before.revision) + 1n))
    expect((await as<{ value: { operations: unknown[] } }>(f.owner, 'SELECT chat.sync_since($1,100) AS value', [after.revision]))[0]!.value.operations).toEqual([])
  }))

  it('uses caller RLS for private chats, whispers and hidden history, including an empty visible preview', async () => fixture(async (f) => {
    const [visible, secret, old] = Array.from({ length: 3 }, () => randomUUID())
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,created_at)
      VALUES ($1,$2,$3,'hidden old content','text',now()-interval '2 hours')`, [old, f.chat, f.owner])
    await db.query("UPDATE chat.chat_members SET hide_history_before=now()-interval '1 hour' WHERE chat_id=$1 AND user_id=$2", [f.chat, f.peer])
    expect(JSON.stringify(await snapshot(f.peer))).not.toContain('hidden old content')
    expect((await snapshot(f.owner)).previews[0]!.preview).toBe('hidden old content')
    expect((await snapshot(f.peer)).previews[0]!.preview).toBeNull()
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES ($1,$2,$3,'visible current content','text')", [visible, f.chat, f.owner])
    const recipient = randomUUID()
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','whisper recipient')", [recipient])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'member')", [f.chat, recipient])
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,is_whisper,to_user_ids)
      VALUES ($1,$2,$3,'private whisper content','text',true,$4)`, [secret, f.chat, f.owner, [recipient]])
    expect(await as(recipient, 'SELECT id FROM chat.messages_view WHERE id=$1', [secret])).toEqual([{ id: secret }])
    const peer = await snapshot(f.peer)
    expect(peer.previews[0]!.preview).toBe('visible current content')
    expect(JSON.stringify(peer)).not.toContain('private whisper content')
    const outsider = await snapshot(f.stranger)
    expect(outsider.chats).toEqual([])
    expect(outsider.memberships).toEqual([])
    expect(JSON.stringify(outsider)).not.toContain('visible current content')
  }))

  it('allows only the caller head and denies anonymous snapshot access', async () => fixture(async (f) => {
    expect((await as<{ user_id: string }>(f.owner, 'SELECT user_id FROM chat.account_revision_heads')).map((r) => r.user_id)).toEqual([f.owner])
    expect(await as(f.peer, 'SELECT user_id FROM chat.account_revision_heads WHERE user_id=$1', [f.owner])).toEqual([])
    expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('anon','chat.sync_snapshot()','EXECUTE') AS allowed")).rows[0]!.allowed).toBe(false)
    expect((await db.query<{ provolatile: string; prosecdef: boolean }>("SELECT provolatile,prosecdef FROM pg_proc WHERE oid='chat.sync_snapshot()'::regprocedure")).rows).toEqual([{ provolatile: 's', prosecdef: false }])
    expect((await db.query<{ provolatile: string }>("SELECT provolatile FROM pg_proc WHERE oid='chat.list_unread_locators(text)'::regprocedure")).rows[0]!.provolatile).toBe('s')
  }))

  it('rejects an oversized snapshot instead of silently truncating current state', async () => fixture(async (f) => {
    await db.query("UPDATE identity.users SET bio=repeat('x',16777216) WHERE id=$1", [f.owner])
    await expect(snapshot(f.owner)).rejects.toThrow(/response budget is 16777216 bytes/)
  }))

  it('keeps an uncommitted mutation out of both snapshot and head, then resumes at head + 1', async () => {
    const writer = new Client({ connectionString })
    await writer.connect()
    const owner = randomUUID()
    try {
      await db.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','snapshot concurrent')", [owner])
      await db.query("SELECT chat.append_user_revision($1,'agent_changed','{}',false)", [owner])
      await writer.query('BEGIN')
      await writer.query("UPDATE identity.users SET display_name='committed later' WHERE id=$1", [owner])
      const barrier = 173812403
      await writer.query('SELECT pg_advisory_xact_lock($1)', [barrier])
      await db.query(BEGIN_READING_REVISIONS)
      const pid = (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      const blocked = as<{ value: Snapshot }>(owner,
        'WITH barrier AS MATERIALIZED (SELECT pg_advisory_xact_lock($1)) SELECT chat.sync_snapshot() AS value FROM barrier', [barrier])
      // Prove the snapshot statement started; commit while that statement is
      // blocked, rather than relying on a sleep or a wall-clock assertion.
      let waiting = false
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        waiting = (await writer.query<{ waiting: boolean }>("SELECT wait_event='advisory' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting === true
        if (waiting) break
        await writer.query('SELECT pg_stat_clear_snapshot()')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(waiting).toBe(true)
      await writer.query('COMMIT')
      const before = (await blocked)[0]!.value
      expect(before.identities[0]!.display_name).toBe('snapshot concurrent')
      await db.query('COMMIT')
      await db.query(BEGIN_READING_REVISIONS)
      const after = await snapshot(owner)
      expect(after.identities[0]!.display_name).toBe('committed later')
      const [{ value }] = await as<{ value: { operations: { revision: string }[] } }>(owner, 'SELECT chat.sync_since($1,100) AS value', [before.revision])
      expect(value!.operations[0]!.revision).toBe(String(BigInt(before.revision) + 1n))
    } finally {
      await writer.query('ROLLBACK')
      await db.query('ROLLBACK')
      await writer.end()
      await db.query('DELETE FROM chat.account_revision_heads WHERE user_id=$1', [owner])
      await db.query('DELETE FROM identity.users WHERE id=$1', [owner])
    }
  })
})
