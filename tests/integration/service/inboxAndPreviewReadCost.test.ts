// Read cost of the agent inbox pull, messages_view and the messages row policy — against a real database,
// with structural assertions (function call counts in this transaction, grants, definitions), never wall-clock.
//
//   · Existing columns return exactly what the previous definitions returned. The attachment metadata release
//     appends file_metadata; the text/system fixtures here must have NULL in that display-only column.
//     Previous definitions are read from their releases and compared row for row, for every viewer.
//   · pull_agent_inbox_v2 checks the reply preview only for the rows it returns, however long the backlog.
//   · messages_view evaluates the reply preview only for returned rows whose reply columns are read; a query
//     that does not read them never calls it, even when it sorts the whole chat.
//   · The row policy no longer runs chat.is_member once per message for a member without a history floor.
//
// Loopback PostgreSQL via GUGU_INTEGRATION_DATABASE_URL; every case runs in BEGIN … ROLLBACK and installs no DDL.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
const { Client: PgClient } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => Client }
let db: Client

const id = (n: number) => `7e5d0000-7e5d-4000-8000-${String(n).padStart(12, '0')}`
const OWNER = id(1), ALICE = id(2), PEER = id(3), LATE = id(4), OUTSIDER = id(5), AGENT = id(6)
const GROUP = id(11)
/** Another group in which LATE and OUTSIDER are members without a floor: their membership elsewhere must not leak into GROUP. */
const ELSEWHERE = id(12)
const EARLY = id(21), TARGET = id(22), WAKE = id(23), WHISPER_TO_AGENT = id(24), WHISPER_TO_PEER = id(25), DELETED = id(26)
/** Woken rows whose reply preview is NULL: the target was deleted; a system line with no sender. */
const WAKE_GONE_TARGET = id(27), WAKE_SYSTEM = id(28)
const PULLED = [WAKE, WHISPER_TO_AGENT, WAKE_GONE_TARGET, WAKE_SYSTEM]
const BACKLOG = 40
const backlogId = (i: number) => id(100 + i)

function migration(name: string): string {
  return readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), 'utf8')
}
function between(text: string, start: string, end: string, from = 0): string {
  const a = text.indexOf(start, from)
  if (a < 0) throw new Error(`marker not found: ${start}`)
  const b = text.indexOf(end, a + start.length)
  if (b < 0) throw new Error(`marker not found: ${end}`)
  return text.slice(a + start.length, b)
}

const foundation = migration('20261021000000_foundation.sql')
/** The previous messages_view body. */
const OLD_VIEW = between(foundation, "CREATE VIEW chat.messages_view WITH (security_invoker='true') AS\n", ';\n')
/** The previous messages_select_member USING expression. */
const OLD_POLICY = between(foundation, 'CREATE POLICY messages_select_member ON chat.messages FOR SELECT TO authenticated USING ', ';\n')
/** The previous inbox query, its parameters bound positionally ($6 = scan fence). */
const OLD_PULL = (() => {
  const text = migration('20261028095412_session_agent_archival.sql')
  const fn = text.indexOf('CREATE OR REPLACE FUNCTION identity.pull_agent_inbox_v2(')
  const body = between(text, 'RETURN QUERY\n', 'LIMIT GREATEST(COALESCE(p_limit, 80), 1);', fn)
  return (body + 'LIMIT GREATEST(COALESCE(p_limit, 80), 1)')
    .replace(/\bp_agent_user_id\b/g, '$1::text').replace(/\bp_chat_id\b/g, '$2::text')
    .replace(/\bp_after_seq\b/g, '$3::bigint').replace(/\bp_limit\b/g, '$4::integer')
    .replace(/\bp_scan_after\b/g, '$5::jsonb').replace(/\bv_fence\b/g, '$6::bigint')
})()

const FN = {
  canRead: 'chat.can_read_message(text,text)',
  previewFor: 'chat.message_reply_preview_for(text,text)',
  isMember: 'chat.is_member(text)',
  ownChats: 'chat.caller_member_chats_without_floor()',
} as const
type Counted = keyof typeof FN

beforeAll(async () => {
  const connectionString = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('inboxAndPreviewReadCost requires loopback PostgreSQL')
  }
  db = new PgClient({ connectionString })
  await db.connect()
  await db.query("SET statement_timeout = '20s'")
})
afterAll(async () => { await db?.end() })

async function rollback(body: () => Promise<void>): Promise<void> {
  await db.query('BEGIN')
  try {
    await db.query(`SET LOCAL track_functions = 'all'`)
    await body()
  } finally {
    await db.query('ROLLBACK')
  }
}
/** Runs as `viewer` with the caller's claims; `role` authenticated applies row policies, postgres does not. */
async function as<T>(viewer: string, sql: string, values: unknown[] = [], role: 'authenticated' | 'postgres' = 'authenticated'): Promise<T[]> {
  await db.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('role', $2, true)`,
    [JSON.stringify({ sub: viewer, role: 'authenticated' }), role])
  try {
    return (await db.query<T>(sql, values)).rows
  } finally {
    await db.query(`SELECT set_config('role', 'postgres', true)`)
  }
}
async function calls(): Promise<Record<Counted, number>> {
  const { rows } = await db.query<{ key: Counted; n: string }>(
    `SELECT key, COALESCE(pg_stat_get_xact_function_calls(sig::regprocedure), 0)::text AS n FROM jsonb_each_text($1::jsonb) AS f(key, sig)`,
    [JSON.stringify(FN)])
  return Object.fromEntries(rows.map((r) => [r.key, Number(r.n)])) as Record<Counted, number>
}
async function delta<T>(body: () => Promise<T>): Promise<[T, Record<Counted, number>]> {
  const before = await calls()
  const result = await body()
  const after = await calls()
  return [result, Object.fromEntries((Object.keys(FN) as Counted[]).map((k) => [k, after[k] - before[k]])) as Record<Counted, number>]
}

/**
 * One group: owner (creator), Alice, a peer, a late joiner (history floor an hour ago), the owner's passive agent.
 * Alice wrote two targets (one before the floor). The peer then sent BACKLOG replies to Alice that do not wake
 * the agent; the owner sent one reply that names the agent. Two whispers, one deleted line, a topic with a line.
 */
async function seed(): Promise<{ topic: string }> {
  for (const [user, name] of [[OWNER, 'owner'], [ALICE, 'Alice'], [PEER, 'Peer'], [LATE, 'Late'], [OUTSIDER, 'Outsider']] as const) {
    await db.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)`, [user, name])
  }
  await db.query(`INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ('dev-7e5d',$1,'t','t','darwin')`, [OWNER])
  await db.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent','Agent',$2,'dev-7e5d')`, [AGENT, OWNER])
  await db.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','group',$2)`, [GROUP, OWNER])
  for (const user of [OWNER, ALICE, PEER, LATE, AGENT]) {
    await db.query(`INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode) VALUES ($1,$2,$3,$4)`,
      [GROUP, user, user === OWNER ? 'owner' : 'member', user === AGENT ? 'passive' : 'active'])
  }
  await db.query(`UPDATE chat.chat_members SET hide_history_before = NULL WHERE chat_id = $1`, [GROUP])
  await db.query(`UPDATE chat.chat_members SET hide_history_before = now() - interval '1 hour' WHERE chat_id = $1 AND user_id = $2`, [GROUP, LATE])
  await db.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','elsewhere',$2)`, [ELSEWHERE, LATE])
  for (const user of [LATE, OUTSIDER]) {
    await db.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)`, [ELSEWHERE, user, user === LATE ? 'owner' : 'member'])
  }
  await db.query(`UPDATE chat.chat_members SET hide_history_before = NULL WHERE chat_id = $1`, [ELSEWHERE])
  const post = (msg: string, sender: string, minutesAgo: number, extra: { to?: string[]; whisper?: boolean; replyTo?: string } = {}) =>
    db.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, is_whisper, reply_to_message_id, created_at)
              VALUES ($1,$2,$3,$4,'text',$5,$6,$7, now() - make_interval(mins => $8))`,
    [msg, GROUP, sender, `line ${msg.slice(-3)}`, extra.to ?? null, !!extra.whisper, extra.replyTo ?? null, minutesAgo])
  await post(EARLY, ALICE, 180)
  await post(TARGET, ALICE, 120)
  for (let i = 0; i < BACKLOG; i++) await post(backlogId(i), PEER, 100 - i, { to: [ALICE], replyTo: i % 2 ? TARGET : EARLY })
  await post(WAKE, OWNER, 50, { to: [AGENT], replyTo: TARGET })
  await post(WHISPER_TO_AGENT, ALICE, 40, { to: [AGENT], whisper: true, replyTo: TARGET })
  await post(WHISPER_TO_PEER, OWNER, 30, { to: [PEER], whisper: true })
  await post(DELETED, ALICE, 20)
  await db.query('UPDATE chat.messages SET deleted_at = now() WHERE id = $1', [DELETED])
  await post(WAKE_GONE_TARGET, OWNER, 10, { to: [AGENT], replyTo: DELETED })
  await db.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, created_at)
                  VALUES ($1,$2,NULL,'notice','system',$3, now() - interval '5 minutes')`, [WAKE_SYSTEM, GROUP, [AGENT]])
  const topic = (await as<{ chat_id: string }>(OWNER, 'SELECT chat_id FROM chat.create_topic($1,$2,$3,NULL,NULL)', [GROUP, TARGET, 'topic']))[0]!.chat_id
  await db.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, reply_to_message_id) VALUES ($1,$2,$3,'in topic','text',$4)`,
    [id(31), topic, ALICE, TARGET])
  await db.query('ANALYZE chat.messages; ANALYZE chat.chat_members; ANALYZE chat.message_agent_wakes')
  return { topic }
}
const VIEWERS = [OWNER, ALICE, PEER, LATE, OUTSIDER]
const fence = async () => (await db.query<{ v: string }>(
  `SELECT pg_sequence_last_value(pg_get_serial_sequence('chat.messages', 'ingest_seq')::regclass)::text AS v`)).rows[0]!.v

describe('inbox pull, messages_view and message row policy: same results, cost bounded by returned rows', () => {
  it('the row policy admits exactly the rows the previous policy admitted, for every viewer', async () => rollback(async () => {
    const { topic } = await seed()
    for (const viewer of VIEWERS) {
      // Premise of evaluating the previous expression without row policies: its chat_members probe only ever
      // looked at the caller's own rows, and the caller's chat_members policy admits all of them.
      const own = 'SELECT chat_id, hide_history_before FROM chat.chat_members WHERE user_id = $1 ORDER BY chat_id'
      expect(await as(viewer, own, [viewer]), `own memberships of ${viewer}`).toEqual(await as(viewer, own, [viewer], 'postgres'))
      const now = (await as<{ id: string }>(viewer, 'SELECT id FROM chat.messages WHERE chat_id = ANY($1) ORDER BY id', [[GROUP, topic]])).map((r) => r.id)
      const before = (await as<{ id: string }>(viewer,
        `SELECT id FROM chat.messages AS messages WHERE chat_id = ANY($1) AND ${OLD_POLICY} ORDER BY id`, [[GROUP, topic]], 'postgres')).map((r) => r.id)
      expect(now, `visible rows for ${viewer}`).toEqual(before)
    }
    // The cases the rule distinguishes are all present: the floor hides early lines, whispers stay private, outsiders see nothing.
    const count = async (viewer: string) => (await as<{ n: string }>(viewer, 'SELECT count(*)::text AS n FROM chat.messages WHERE chat_id = $1', [GROUP]))[0]!.n
    // LATE and OUTSIDER are floorless members of ELSEWHERE: that must neither lift LATE's floor in GROUP
    // nor let OUTSIDER into GROUP (an uncorrelated membership check would do both).
    const floorless = await as<{ chat_id: string }>(OUTSIDER, 'SELECT chat_id FROM chat.chat_members WHERE user_id = $1 AND hide_history_before IS NULL', [OUTSIDER])
    expect(floorless.map((r) => r.chat_id)).toEqual([ELSEWHERE])
    expect(Number(await count(OWNER))).toBeGreaterThan(Number(await count(LATE)))
    expect(await count(OUTSIDER)).toBe('0')
    const alice = (await as<{ id: string }>(ALICE, 'SELECT id FROM chat.messages WHERE chat_id = $1', [GROUP])).map((r) => r.id)
    expect(alice).toContain(WHISPER_TO_AGENT)
    expect(alice).not.toContain(WHISPER_TO_PEER)
    expect(alice).not.toContain(DELETED)
  }))

  it('messages_view preserves every previous column and appends only display metadata, for every viewer', async () => rollback(async () => {
    const { topic } = await seed()
    for (const viewer of VIEWERS) {
      const now = await as<{ row: unknown }>(viewer,
        'SELECT to_jsonb(v) AS row FROM chat.messages_view v WHERE v.chat_id = ANY($1) ORDER BY v.chat_id, v.seq', [[GROUP, topic]])
      const before = await as<{ row: Record<string, unknown> }>(viewer,
        `WITH v AS (${OLD_VIEW}) SELECT to_jsonb(v) AS row FROM v WHERE v.chat_id = ANY($1) ORDER BY v.chat_id, v.seq`, [[GROUP, topic]])
      // These fixtures are text/system rows. Keep all prior keys and values (including reply previews)
      // exact; accepting an arbitrary subset would hide a breaking change to an old client's select.
      expect(now, `messages_view for ${viewer}`).toEqual(before.map(({ row }) => ({ row: { ...row, file_metadata: null } })))
    }
    const replies = await as<{ reply_to_content: string | null }>(ALICE,
      'SELECT reply_to_content FROM chat.messages_view WHERE chat_id = $1 AND reply_to_message_id IS NOT NULL', [GROUP])
    expect(replies.filter((r) => r.reply_to_content !== null).length).toBeGreaterThan(BACKLOG / 2) // previews are really there
  }))

  it('the chat-list preview calls the reply preview only for returned rows; unread columns never call it', async () => rollback(async () => {
    await seed()
    const preview = `SELECT v.id, v.reply_to_message_id, chat.preview(v) AS preview FROM chat.messages_view v
                      WHERE v.chat_id = ANY($1) AND v.is_whisper = false ORDER BY v.seq DESC LIMIT 4`
    const [rows, cost] = await delta(() => as<{ reply_to_message_id: string | null }>(ALICE, preview, [[GROUP]]))
    expect(rows).toHaveLength(4)
    const replyRows = rows.filter((r) => r.reply_to_message_id).length
    expect(replyRows).toBeGreaterThan(0) // the counter is live: returned reply rows do pay
    // preview(v) takes the whole row: each returned reply row reads its three reply columns; the other
    // BACKLOG reply rows of the chat are read and sorted, but never call the preview.
    expect(cost.previewFor).toBe(3 * replyRows)

    const [, unread] = await delta(() => as(ALICE,
      'SELECT v.id, v.seq FROM chat.messages_view v WHERE v.chat_id = ANY($1) ORDER BY v.seq DESC LIMIT 4', [[GROUP]]))
    expect(unread.previewFor).toBe(0)

  }))

  it('a member without a history floor is checked against one set per query, not chat.is_member per row', async () => rollback(async () => {
    await seed()
    const [rows, cost] = await delta(() => as<{ n: string }>(ALICE, 'SELECT count(*)::text AS n FROM chat.messages WHERE chat_id = $1', [GROUP]))
    expect(Number(rows[0]!.n)).toBeGreaterThan(BACKLOG)
    expect(cost.isMember).toBe(0)
    expect(cost.ownChats).toBe(1)
    // Positive control: reading chat_members as the caller still runs its row policy.
    const [, members] = await delta(() => as(ALICE, 'SELECT user_id FROM chat.chat_members WHERE chat_id = $1', [GROUP]))
    expect(members.isMember).toBeGreaterThan(0)
  }))

  it('pull_agent_inbox_v2 returns what the previous query returned, for every page shape', async () => rollback(async () => {
    const { topic } = await seed()
    const scan = await fence()
    const cases: unknown[][] = [
      [AGENT, null, null, 80, null, scan],
      [AGENT, GROUP, null, 80, null, scan],
      [AGENT, null, null, 1, null, scan],
      [AGENT, null, null, 80, { chat_id: GROUP, seq: 1 }, scan],
      [AGENT, topic, null, 80, null, scan],
      [AGENT, null, 10_000, 80, null, scan],
    ]
    for (const args of cases) {
      // Positional comparison: the previous query's columns are unnamed duplicates (rm.sender_user_id, rm.content).
      // Only the columns the previous query had: group_rules and named_identities were appended later
      // (inboxPullDeliveryContext.test.ts covers them).
      const now = await as<{ row: string }>(OWNER, 'SELECT ROW(p.chat_id, p.chat_kind, p.chat_public_id, p.chat_name, p.chat_creator_user_id, p.listen_mode, p.notification_level, p.last_read_seq, p.id, p.seq, p.sender_user_id, p.sender_type, p.sender_display_name, p.sender_gugu_number, p.content, p.content_type, p.to_user_ids, p.is_whisper, p.reply_to_message_id, p.reply_to_sender_user_id, p.reply_to_content, p.thread_root_id, p.is_thread_root, p.created_at, p.scan_max_ingest_seq, p.via_app, p.file_item_id, p.file_version, p.file_blob_id)::text AS row FROM identity.pull_agent_inbox_v2($1,$2,$3,$4,$5,$6) p', args)
      const before = await as<{ row: string }>(OWNER, `SELECT p::text AS row FROM (${OLD_PULL}) p`, args, 'postgres')
      expect(now, `pull ${JSON.stringify(args.slice(1, 5))}`).toEqual(before)
    }
    const rows = await as<{ id: string; reply_to_content: string | null; sender_display_name: string | null }>(OWNER,
      'SELECT id, reply_to_content, sender_display_name FROM identity.pull_agent_inbox_v2($1)', [AGENT])
    expect(rows.map((r) => r.id)).toEqual(PULLED)
    // The rows whose left joins find nothing are kept, with NULLs: a deleted reply target, a sender-less system line.
    expect(rows.find((r) => r.id === WAKE_GONE_TARGET)!.reply_to_content).toBeNull()
    expect(rows.find((r) => r.id === WAKE_SYSTEM)!.sender_display_name).toBeNull()
    // A consumed row leaves both, identically.
    await db.query(`INSERT INTO chat.message_deliveries (message_id, device_id, status, read_at) VALUES ($1, 'gugu-agent:' || $2, 'read', now())`, [WAKE, AGENT])
    const after = await as<{ id: string }>(OWNER, 'SELECT id FROM identity.pull_agent_inbox_v2($1,NULL,NULL,80,NULL,$2)', [AGENT, scan])
    const afterBefore = await as<{ id: string }>(OWNER, `SELECT p.id FROM (${OLD_PULL}) p`, [AGENT, null, null, 80, null, scan], 'postgres')
    expect(after.map((r) => r.id)).toEqual(PULLED.slice(1))
    expect(afterBefore.map((r) => r.id)).toEqual(PULLED.slice(1))
  }))

  it('pull_agent_inbox_v2 checks reply readability only for the rows it returns, not for the backlog', async () => rollback(async () => {
    await seed()
    const pull = () => delta(() => as<{ id: string }>(OWNER, 'SELECT id FROM identity.pull_agent_inbox_v2($1)', [AGENT]))
    const [rows, cost] = await pull()
    expect(rows.map((r) => r.id)).toEqual(PULLED)
    expect(cost.canRead).toBeGreaterThan(0) // the counter is live: both returned rows are replies
    // Triple the backlog: more replies after the agent's read cursor that do not wake it. Same page, same cost.
    for (let i = BACKLOG; i < 3 * BACKLOG; i++) {
      await db.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, to_user_ids, reply_to_message_id)
                      VALUES ($1,$2,$3,'more','text',$4,$5)`, [backlogId(i), GROUP, PEER, [ALICE], TARGET])
    }
    const [again, more] = await pull()
    expect(again.map((r) => r.id)).toEqual(PULLED)
    expect(more.canRead).toBe(cost.canRead)
  }))

  it('keeps grants, the invoker view and its column list', async () => rollback(async () => {
    const can = async (role: string, fn: string) => (await db.query<{ ok: boolean }>(
      'SELECT has_function_privilege($1, $2::regprocedure, \'EXECUTE\') AS ok', [role, fn])).rows[0]!.ok
    const pull = 'identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint)'
    expect([await can('authenticated', pull), await can('service_role', pull), await can('anon', pull)]).toEqual([true, true, false])
    // Row policies run with the caller's privileges, so the policy helper is executable by authenticated only.
    expect([await can('authenticated', FN.ownChats), await can('anon', FN.ownChats)]).toEqual([true, false])
    const view = await db.query<{ options: string[]; select: boolean; anon: boolean; columns: string[] }>(
      `SELECT c.reloptions AS options, has_table_privilege('authenticated', c.oid, 'SELECT') AS select,
              has_table_privilege('anon', c.oid, 'SELECT') AS anon,
              ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid = c.oid AND attnum > 0 AND NOT attisdropped ORDER BY attnum) AS columns
         FROM pg_class c WHERE c.oid = 'chat.messages_view'::regclass`)
    expect(view.rows[0]).toEqual({
      options: ['security_invoker=true'], select: true, anon: false,
      columns: ['id', 'chat_id', 'sender_user_id', 'to_user_ids', 'sender_name', 'sender_avatar', 'seq', 'content', 'content_type',
        'reply_to_message_id', 'reply_to_sender_user_id', 'reply_to_sender_name', 'reply_to_content', 'deleted_at', 'deleted_for_user_ids',
        'retracted_at', 'created_at', 'forwarded_from_message_id', 'thread_root_id', 'edited_at', 'is_whisper', 'is_thread_root',
        'client_message_id', 'is_imported_history_root', 'via_app', 'file_item_id', 'file_version', 'sent_by_agent', 'agent_sender', 'file_blob_id',
        'file_metadata'],
    })
  }))
})
