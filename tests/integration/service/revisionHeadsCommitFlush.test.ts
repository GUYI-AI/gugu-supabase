import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Revision heads are written once per transaction, at commit (chat.flush_user_revisions); who is a member of a line is
// serialized by the line lock (chat.lock_lines). See 20261116160000_revision_heads_commit_flush.sql for the contract.
//
// The regression: provision_taskpage_agent published to the owner while minting an agent, then locked the members of
// the project group; add_group_agent of another session locked {member, its agent, owner} in id order. Each held a
// head the other needed (40P01) and the born-in-chat join was lost. Interleavings below are driven deterministically.
interface Client {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>
}
const { Client: PgClient } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => Client }
const url = (process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '').trim()
const clients: Client[] = []
let admin: Client
const humans: string[] = [], agents: string[] = [], chats: string[] = [], devices: string[] = []

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
async function begin(client: Client, as?: string): Promise<void> {
  await client.query('BEGIN')
  if (as) {
    await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: as, role: 'authenticated' })])
    await client.query('SET LOCAL ROLE authenticated')
  }
}
async function human(name: string): Promise<string> {
  const id = randomUUID()
  humans.push(id)
  await admin.query('INSERT INTO auth.users(id,email) VALUES ($1::uuid,$2)', [id, `${id}@heads-flush.test`])
  await admin.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human',$2) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name", [id, name])
  return id
}
async function device(owner: string): Promise<string> {
  const id = `heads-flush-${randomUUID()}`
  devices.push(id)
  await admin.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES ($1,$2,'flush','flush','linux')", [id, owner])
  return id
}
async function agent(owner: string, host: string, name: string): Promise<string> {
  const id = randomUUID()
  agents.push(id)
  await admin.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES ($1,'agent',$2,$3,$4)", [id, name, owner, host])
  return id
}
async function group(owner: string, members: string[]): Promise<string> {
  const id = randomUUID()
  chats.push(id)
  await admin.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','heads flush',$2)", [id, owner])
  await admin.query("INSERT INTO chat.chat_members(chat_id,user_id,role) SELECT $1,u,CASE WHEN u=$2 THEN 'owner' ELSE 'member' END FROM unnest($3::text[]) u", [id, owner, [owner, ...members]])
  return id
}
async function revisions(user: string): Promise<{ head: number; rows: number[] }> {
  const head = (await admin.query<{ revision: string }>('SELECT revision FROM chat.account_revision_heads WHERE user_id=$1', [user])).rows[0]?.revision ?? '0'
  const rows = (await admin.query<{ revision: string }>('SELECT revision FROM chat.account_revisions WHERE user_id=$1 ORDER BY revision', [user])).rows
  return { head: Number(head), rows: rows.map((row) => Number(row.revision)) }
}
const contiguous = ({ head, rows }: { head: number; rows: number[] }) => rows.length === head && rows.every((r, i) => r === i + 1)

beforeAll(async () => {
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
    throw new Error('revisionHeadsCommitFlush requires a disposable loopback PostgreSQL database')
  }
  admin = await connect()
})
afterAll(async () => {
  await admin.query('DELETE FROM chat.chats WHERE id=ANY($1::text[]) OR source_chat_id=ANY($1::text[])', [chats])
  await admin.query('DELETE FROM identity.gugu_device_commands WHERE device_id=ANY($1::text[])', [devices])
  await admin.query('DELETE FROM identity.agent_runtime_states WHERE agent_user_id=ANY($1::text[])', [agents])
  await admin.query('DELETE FROM identity.users WHERE id=ANY($1::text[])', [agents])
  await admin.query('DELETE FROM identity.gugu_devices WHERE device_id=ANY($1::text[])', [devices])
  await admin.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [humans])
  await admin.query('DELETE FROM identity.users WHERE id=ANY($1::text[])', [humans])
  await admin.query('DELETE FROM chat.account_revisions WHERE user_id=ANY($1::text[])', [[...humans, ...agents]])
  await admin.query('DELETE FROM chat.account_revision_heads WHERE user_id=ANY($1::text[])', [[...humans, ...agents]])
  await Promise.all(clients.map((client) => client.end()))
})

describe('account revision heads are taken once, at commit', () => {
  it('a birth-group join and another session minting into the project group never wait on each other', async () => {
    const owner = await human('heads owner'), guest = await human('heads guest')
    const host = await device(owner)
    const sibling = await agent(owner, host, 'Flush 1')
    const project = await group(owner, [sibling])
    const birth = await group(owner, [guest])
    const a = await connect(), p = await connect()
    await begin(a, owner)
    await a.query('SELECT chat.add_group_agent($1,$2,NULL,$3,false)', [birth, sibling, owner])
    // Before: the join holds the heads of {guest, sibling, owner}; minting publishes to the owner first and waits.
    await begin(p, owner)
    await p.query("SET LOCAL statement_timeout = '3s'")
    const minted = randomUUID()
    agents.push(minted)
    const mint = await outcome(p.query(`SELECT * FROM identity.provision_taskpage_agent($1::uuid,'Flush 2','explicit','claude-code',$2,NULL,$3,$4,'heads flush')`,
      [minted, host, project, randomUUID()]))
    expect(mint).toBeNull()
    await p.query('COMMIT')
    await a.query('COMMIT')
    const seats = await admin.query<{ chat_id: string; user_id: string }>('SELECT chat_id,user_id FROM chat.chat_members WHERE (chat_id,user_id) IN (($1,$2),($3,$4))', [birth, sibling, project, minted])
    expect(seats.rowCount).toBe(2)
    expect(contiguous(await revisions(owner))).toBe(true)
  })

  it('stages inside the transaction and writes heads only when it commits', async () => {
    const reader = await human('heads reader')
    const base = (await revisions(reader)).head
    const t = await connect(), probe = await connect()
    await begin(t)
    for (let i = 0; i < 3; i++) {
      await t.query("SELECT chat.publish_user_revision($1,'chat_changed',jsonb_build_object('chat_id',$2::text))", [reader, randomUUID()])
    }
    // Nothing holds the reader's head yet: another transaction can take it without waiting.
    await probe.query('BEGIN')
    await probe.query("INSERT INTO chat.account_revision_heads(user_id) VALUES ($1) ON CONFLICT DO NOTHING", [reader])
    expect((await probe.query('SELECT 1 FROM chat.account_revision_heads WHERE user_id=$1 FOR NO KEY UPDATE NOWAIT', [reader])).rowCount).toBe(1)
    await probe.query('COMMIT')
    await t.query('COMMIT')
    const after = await revisions(reader)
    expect(contiguous(after) && after.head === base + 3).toBe(true)
    // One wake per user per transaction, carrying the head it reached.
    const wakes = await admin.query<{ payload: { revision: number } }>(`SELECT payload FROM realtime.messages
      WHERE topic=$1 AND event='im_revision_advanced' AND (payload->>'revision')::bigint > $2 ORDER BY inserted_at`, [`gugu:user:${reader}:events`, base])
    expect(wakes.rows.map((row) => Number(row.payload.revision))).toEqual([base + 3])
    expect((await admin.query('SELECT 1 FROM chat.pending_user_revisions')).rowCount).toBe(0)
  })

  it('two transactions publishing to the same two users in opposite orders both commit', async () => {
    const [low, high] = [await human('heads low'), await human('heads high')].sort()
    const base = { low: (await revisions(low!)).head, high: (await revisions(high!)).head }
    const a = await connect(), b = await connect()
    const publish = (client: Client, user: string) => client.query("SELECT chat.publish_user_revision($1,'chat_changed','{}'::jsonb)", [user])
    await begin(a); await begin(b)
    await publish(a, high!); await publish(b, low!)
    await publish(a, low!); await publish(b, high!)
    expect({ a: await outcome(a.query('COMMIT')), b: await outcome(b.query('COMMIT')) }).toEqual({ a: null, b: null })
    for (const [user, start] of [[low!, base.low], [high!, base.high]] as const) {
      const after = await revisions(user)
      expect(contiguous(after) && after.head === start + 2).toBe(true)
    }
  })
})

describe('membership and fan-out of one line stay serialized', () => {
  // The guarantee the members' heads used to give: a fan-out either finishes before someone joins (the joiner then
  // reads its result) or sees the joiner as a recipient.
  async function fixture() {
    const owner = await human('line owner'), reader = await human('line reader'), joiner = await human('line joiner')
    const chat = await group(owner, [reader])
    const message = randomUUID()
    await admin.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES ($1,$2,$3,'line','text')", [message, chat, owner])
    return { reader, joiner, chat, message }
  }
  const react = (client: Client, message: string, user: string) =>
    client.query("INSERT INTO chat.message_reactions(message_id,user_id,emoji) VALUES ($1,$2,'+1')", [message, user])
  const join = (client: Client, chat: string, user: string) =>
    client.query("SELECT chat.insert_group_member($1,$2,'active',false)", [chat, user])
  const reactionRevisions = async (user: string, message: string) => (await admin.query(
    "SELECT 1 FROM chat.account_revisions WHERE user_id=$1 AND event='reaction_changed' AND resource_key->>'entity_id'=$2", [user, message])).rowCount

  it('a reaction during a join waits for it and reaches the joiner', async () => {
    const { reader, joiner, chat, message } = await fixture()
    const j = await connect(), r = await connect()
    const rPid = await pidOf(r), jPid = await pidOf(j)
    await begin(j); await join(j, chat, joiner)
    await begin(r)
    const reacting = outcome(react(r, message, reader).then(() => r.query('COMMIT')))
    await blockedBy(rPid, jPid, 'the reaction did not wait for the join')
    await j.query('COMMIT')
    expect(await reacting).toBeNull()
    expect(await reactionRevisions(joiner, message)).toBe(1)
  })

  it('a join during a reaction waits for it', async () => {
    const { reader, joiner, chat, message } = await fixture()
    const j = await connect(), r = await connect()
    const rPid = await pidOf(r), jPid = await pidOf(j)
    await begin(r); await react(r, message, reader)
    await begin(j)
    const joining = outcome(join(j, chat, joiner).then(() => j.query('COMMIT')))
    await blockedBy(jPid, rPid, 'the join did not wait for the reaction')
    await r.query('COMMIT')
    expect(await joining).toBeNull()
    expect((await admin.query('SELECT 1 FROM chat.message_reactions WHERE message_id=$1', [message])).rowCount).toBe(1)
  })

  it('a fan-out in another line does not wait for a join', async () => {
    const one = await fixture(), other = await fixture()
    const j = await connect(), r = await connect()
    await begin(j); await join(j, one.chat, one.joiner)
    await begin(r)
    await r.query("SET LOCAL statement_timeout = '3s'")
    expect(await outcome(react(r, other.message, other.reader))).toBeNull()
    await r.query('COMMIT'); await j.query('COMMIT')
  })
})

describe('removing an identity and its direct chats stay serialized', () => {
  // archive_user takes the direct chats' rows and the lines of every chat the identity is in before it removes it;
  // a message in one of those chats holds that row from sequence assignment on.
  async function fixture() {
    const owner = await human('dm owner'), peer = await human('dm peer')
    const host = await device(owner)
    const removed = await agent(owner, host, 'Flush DM')
    const dm = randomUUID()
    chats.push(dm)
    await admin.query("INSERT INTO chat.chats(id,kind,creator_user_id) VALUES ($1,'dm',$2)", [dm, peer])
    await admin.query("INSERT INTO chat.chat_members(chat_id,user_id,role) SELECT $1,u,'member' FROM unnest($2::text[]) u", [dm, [peer, removed]])
    return { owner, peer, removed, dm }
  }
  const say = (client: Client, dm: string, sender: string) => client.query(
    "INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES ($1,$2,$3,'dm','text')", [randomUUID(), dm, sender])
  const remove = (client: Client, removed: string) => client.query('SELECT identity.archive_user($1,true)', [removed])

  it('a removal during a direct message waits for it', async () => {
    const { owner, peer, removed, dm } = await fixture()
    const m = await connect(), x = await connect()
    const mPid = await pidOf(m), xPid = await pidOf(x)
    await begin(m); await say(m, dm, peer)
    await begin(x, owner)
    const removing = outcome(remove(x, removed).then(() => x.query('COMMIT')))
    await blockedBy(xPid, mPid, 'the removal did not wait for the message')
    await m.query('COMMIT')
    expect(await removing).toBeNull()
  })

  it('a direct message during a removal waits for it', async () => {
    const { owner, peer, removed, dm } = await fixture()
    const m = await connect(), x = await connect()
    const mPid = await pidOf(m), xPid = await pidOf(x)
    await begin(x, owner); await remove(x, removed)
    await begin(m)
    const saying = outcome(say(m, dm, peer)).then(async (error) => { await m.query(error ? 'ROLLBACK' : 'COMMIT'); return error })
    await blockedBy(mPid, xPid, 'the message did not wait for the removal')
    await x.query('COMMIT')
    await saying
    expect((await admin.query('SELECT removed_at IS NOT NULL AS removed FROM identity.users WHERE id=$1', [removed])).rows).toEqual([{ removed: true }])
  })
})

describe('the commit flush stays the only writer of heads', () => {
  it('no function writes heads or revisions except the flush and account erasure', async () => {
    const { rows } = await admin.query<{ fn: string }>(`SELECT p.oid::regprocedure::text AS fn FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema')
        AND p.prosrc ~* '(insert\\s+into|update|delete\\s+from)\\s+chat\\.account_revision(s|_heads)\\M' ORDER BY 1`)
    expect(rows.map((row) => row.fn)).toEqual(['chat.flush_user_revisions()', 'identity.erase_account_references(text[])'])
  })

  it('no function makes every deferred constraint immediate (that would run the flush mid-transaction)', async () => {
    const { rows } = await admin.query<{ fn: string }>(`SELECT p.oid::regprocedure::text AS fn FROM pg_proc p
      WHERE p.prosrc ~* 'set\\s+constraints\\s+all\\s+immediate'`)
    expect(rows).toEqual([])
  })
})
