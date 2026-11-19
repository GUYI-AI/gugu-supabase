import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * file_urls_as decides message visibility for the messages a caller names, not for every attachment
 * message the planner happens to scan. With the visibility check as a scan filter, a hash join from the
 * refs to a message index ran chat.can_read_message once per attachment card in the database (seen on
 * staging: ~15k buffers per single-ref call). Each case runs inside BEGIN…ROLLBACK.
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => DatabaseClient }
let database: DatabaseClient

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('fileUrlsVisibilityCost.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => { await database.query('BEGIN') })
afterEach(async () => { await database.query('ROLLBACK') })

async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function human(): Promise<string> {
  await database.query('RESET role')
  const id = randomUUID()
  await database.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${id}@file-urls-cost.invalid`])
  await database.query("INSERT INTO identity.users (id, type, display_name) VALUES ($1, 'human', 'file urls cost') ON CONFLICT (id) DO NOTHING", [id])
  return id
}
async function group(members: string[]): Promise<string> {
  await database.query('RESET role')
  const id = randomUUID()
  await database.query("INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1, 'group', NULL, $2)", [id, members[0]])
  await database.query("INSERT INTO chat.chat_members (chat_id, user_id, role) SELECT $1, u, 'member' FROM unnest($2::text[]) u", [id, members])
  return id
}
/**
 * `count` whisper cards from `sender` in `chat` to `to`: messages that name their bytes directly (file_blob_id), the only
 * attachments a message reference resolves since old chat-media cards were adopted into files (20261110053000).
 */
async function cards(sender: string, chat: string, count: number, to: string): Promise<string[]> {
  await database.query('RESET role')
  const { rows } = await database.query<{ id: string }>(`
    WITH o AS (
      INSERT INTO storage.objects (bucket_id, name, metadata)
      SELECT 'chat-media', $1 || '/' || gen_random_uuid() || '-card.bin', '{"size":409,"mimetype":"application/octet-stream"}'
        FROM generate_series(1, $3::integer)
      RETURNING name), b AS (
      SELECT gen_random_uuid()::text AS message, chat.file_blob_for_object('chat-media', o.name) AS blob FROM o), u AS (
      INSERT INTO chat.file_blob_uploads (staging_key, uploader, blob_id, message_id)
      SELECT 'staging/' || $1 || '/' || gen_random_uuid(), $1, b.blob, b.message FROM b RETURNING message_id, blob_id)
    INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, is_whisper, to_user_ids, file_blob_id)
    SELECT u.message_id, $2, $1, chat.attachment_envelope('card.bin', 409, 'application/octet-stream'), 'attachment', true, ARRAY[$4], u.blob_id
      FROM u
    RETURNING id`, [sender, chat, count, to])
  return rows.map(r => r.id)
}
async function urls(as: string, refs: unknown[]): Promise<{ message_id: string; object_name: string }[]> {
  await asUser(as)
  const { rows } = await database.query<{ message_id: string; object_name: string }>('SELECT * FROM chat.file_urls_as($1::jsonb, $2)', [JSON.stringify(refs), as])
  await database.query('RESET role')
  return rows
}
/** Buffers one call touches, nested statements included (they are charged to the function scan). */
async function buffers(as: string, refs: unknown[]): Promise<number> {
  await asUser(as)
  const { rows } = await database.query<{ 'QUERY PLAN': [{ Plan: Record<string, number> }] }>(
    'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM chat.file_urls_as($1::jsonb, $2)', [JSON.stringify(refs), as])
  await database.query('RESET role')
  const plan = rows[0]!['QUERY PLAN'][0].Plan
  return plan['Shared Hit Blocks']! + plan['Shared Read Blocks']!
}

describe('file_urls_as visibility cost', () => {
  it('does not grow with attachment messages the caller did not name', async () => {
    const alice = await human(), reader = await human(), stranger = await human()
    const shared = await group([alice, reader])
    const [target] = await cards(alice, shared, 1, reader)
    // The staging plan: refs hashed against a scan of a message index. Force that join shape so the
    // check does not depend on this database's statistics.
    await database.query('SET LOCAL enable_nestloop = off')
    const quiet = await buffers(reader, [{ message_id: target }])
    await cards(alice, await group([alice, stranger]), 300, stranger)
    const busy = await buffers(reader, [{ message_id: target }])
    expect(busy - quiet).toBeLessThan(150)
    expect(await urls(reader, [{ message_id: target }])).toEqual([expect.objectContaining({ message_id: target })])
  })

  it('returns exactly the named cards the caller may read, once each', async () => {
    const alice = await human(), reader = await human(), stranger = await human()
    const shared = await group([alice, reader]), hidden = await group([alice, stranger])
    const [mine, other] = await cards(alice, shared, 2, reader)
    const [secret] = await cards(alice, hidden, 1, stranger)
    const asked = [{ message_id: mine }, { message_id: secret }, { message_id: mine }, { message_id: other }, { message_id: 'not-a-message' }]
    expect((await urls(reader, asked)).map(r => r.message_id).sort()).toEqual([mine, other].sort())
    expect((await urls(stranger, asked)).map(r => r.message_id)).toEqual([secret])
    await database.query('UPDATE chat.messages SET retracted_at = now() WHERE id = $1', [mine])
    expect((await urls(reader, asked)).map(r => r.message_id)).toEqual([other])
  })

  it('keeps its grants: signed-in callers only', async () => {
    const { rows } = await database.query<{ role: string; allowed: boolean }>(
      "SELECT r AS role, has_function_privilege(r, 'chat.file_urls_as(jsonb,text)', 'EXECUTE') AS allowed FROM unnest(ARRAY['authenticated','anon']) r")
    expect(rows).toEqual([{ role: 'authenticated', allowed: true }, { role: 'anon', allowed: false }])
  })
})
