import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// A file message (attachment_commit: place the file, which publishes to the members, then insert the message) and a
// plain message insert in one group. The plain insert locks the chats row, then the members' heads; attachment_commit
// used to lock the heads, then the chats row, so the two deadlocked (40P01, seen on the shared backend 2026-11-05).
// A third transaction holding the last member's head parks attachment_commit in the middle of its fan-out, exactly
// where the plain insert can get between; releasing it replays the production interleaving deterministically.
interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client: PgClient } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => Client }
const url = (process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '').trim()
const clients: Client[] = []
let admin: Client
let users: string[], group: string

async function connect(): Promise<Client> {
  const client = new PgClient({ connectionString: url })
  await client.connect()
  clients.push(client)
  await client.query("SET statement_timeout = '10s'")
  return client
}
const pidOf = async (client: Client) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
async function blockedBy(pid: number, blocker: number, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const { rows } = await admin.query<{ blocked: boolean }>('SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked', [pid, blocker])
    if (rows[0]!.blocked) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`RIG-FAIL: ${what}`)
}
const outcome = (run: Promise<unknown>) => run.then(() => null, (error: { code?: string; message?: string }) => error.code ?? error.message ?? 'error')

beforeAll(async () => {
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
    throw new Error('fileMessageLockOrder requires a disposable loopback PostgreSQL database')
  }
  admin = await connect()
  users = Array.from({ length: 3 }, () => randomUUID()).sort()
  group = randomUUID()
  await admin.query(`INSERT INTO auth.users(id,email) SELECT id::uuid, id || '@lock-order.invalid' FROM unnest($1::text[]) id`, [users])
  await admin.query(`INSERT INTO identity.users(id,type,display_name) SELECT id,'human','lock order' FROM unnest($1::text[]) id ON CONFLICT(id) DO NOTHING`, [users])
  await admin.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','lock order',$2)`, [group, users[0]])
  await admin.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) SELECT $1,id,CASE WHEN id=$2 THEN 'owner' ELSE 'member' END FROM unnest($3::text[]) id`, [group, users[0], users])
})
afterAll(async () => {
  await admin.query('DELETE FROM chat.chats WHERE id=$1', [group])
  await admin.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [users])
  await admin.query('DELETE FROM chat.account_revision_heads WHERE user_id=ANY($1::text[])', [users])
  await Promise.all(clients.map((client) => client.end()))
})

describe('file message vs plain message lock order', () => {
  it('attachment_commit and a plain insert in one group both commit, with consecutive seq', async () => {
    const [sender, poster] = [users[0]!, users[1]!]
    const last = users[users.length - 1]!
    const hold = await connect(), file = await connect(), plain = await connect()
    const [holdPid, filePid, plainPid] = await Promise.all([pidOf(hold), pidOf(file), pidOf(plain)])
    const key = `staging/${sender}/${randomUUID()}`, fileId = randomUUID(), plainId = randomUUID()
    await admin.query('SET ROLE service_role')
    await admin.query("SELECT * FROM chat.file_blob_register($1,$2,$3,32,'text/plain',NULL,NULL)", [sender, key, createHash('sha256').update(key).digest('hex')])
    await admin.query('RESET ROLE')

    await hold.query('BEGIN')
    await hold.query('SELECT 1 FROM chat.account_revision_heads WHERE user_id=$1 FOR NO KEY UPDATE', [last])
    await file.query('BEGIN')
    await file.query('SET LOCAL ROLE authenticated')
    await file.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: sender, role: 'authenticated' })])
    const fileSend = outcome(file.query("SELECT * FROM chat.attachment_commit($1,$2,$3,$4,'lock-order.txt')", [key, fileId, group, sender]).then(() => file.query('COMMIT')))
    await blockedBy(filePid, holdPid, 'attachment_commit never reached the held head').catch(async (error) => { throw new Error(`${error.message}; attachment_commit: ${JSON.stringify(await Promise.race([fileSend, new Promise((resolve) => setTimeout(() => resolve('still running'), 500))]))}`) })
    await plain.query('BEGIN')
    const plainSend = outcome(plain.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,client_message_id)
      VALUES ($1,$2,$3,'plain','text',$1)`, [plainId, group, poster]).then(() => plain.query('COMMIT')))
    await blockedBy(plainPid, filePid, 'the plain insert never queued behind attachment_commit')
    await hold.query('COMMIT')
    const outcomes = { file: await fileSend, plain: await plainSend }
    console.info(JSON.stringify(outcomes))
    if (outcomes.file) await file.query('ROLLBACK')
    if (outcomes.plain) await plain.query('ROLLBACK')
    expect(outcomes).toEqual({ file: null, plain: null })
    const { rows } = await admin.query<{ id: string; seq: string }>('SELECT id, seq FROM chat.messages WHERE chat_id=$1 ORDER BY seq', [group])
    expect(rows.map((row) => row.id)).toEqual([fileId, plainId])
    expect(Number(rows[1]!.seq) - Number(rows[0]!.seq)).toBe(1)
  })
})
