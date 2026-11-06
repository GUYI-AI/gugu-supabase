import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let owner: string, peer: string, topics: string[]

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Owned-agent realtime contracts require a disposable loopback database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); peer = randomUUID()
  topics = [`gugu:user:${owner}:agents`, `gugu:user:${peer}:agents`, `other:user:${owner}:agents`, `gugu:other:${owner}:agents`, `gugu:user:${owner}:other`, `gugu:user:${owner}:events`, `gugu:user:${peer}:events`]
  for (const topic of topics) {
    await db.query(`INSERT INTO realtime.messages(topic,event,payload,extension,private) VALUES($1,'agent_changed','{}','broadcast',true)`, [topic])
  }
})
afterEach(async () => { if (db) await db.query('ROLLBACK') })

async function as(role: 'authenticated' | 'anon', userId: string | null): Promise<void> {
  await db.query(`SELECT set_config('role',$1,true),set_config('request.jwt.claims',$2,true)`, [role, JSON.stringify({ sub: userId, role })])
}

describe('owned-agent private broadcasts', () => {
  it('lets each authenticated owner read only its own agent topic', async () => {
    await as('authenticated', owner)
    const read = () => db.query('SELECT topic FROM realtime.messages WHERE topic=ANY($1) ORDER BY topic', [topics])
    expect((await read()).rows).toEqual([{ topic: topics[0] }, { topic: topics[5] }])
    await db.query('RESET ROLE')
    await as('authenticated', peer)
    expect((await read()).rows).toEqual([{ topic: topics[1] }, { topic: topics[6] }])
  })

  it('does not admit an anonymous subscriber', async () => {
    await db.query('SAVEPOINT anonymous_read')
    await as('anon', null)
    try {
      expect((await db.query('SELECT topic FROM realtime.messages WHERE topic=ANY($1)', [topics])).rows).toEqual([])
    } catch (error) {
      expect((error as { code?: string }).code).toBe('42501')
      await db.query('ROLLBACK TO SAVEPOINT anonymous_read')
    }
  })

  it('does not let the owner forge agent broadcasts', async () => {
    await db.query('SAVEPOINT forged_broadcast')
    await as('authenticated', owner)
    let failure: unknown
    try {
      await db.query(`INSERT INTO realtime.messages(topic,event,payload,extension,private) VALUES($1,'agent_changed','{}','broadcast',true)`, [topics[0]])
    } catch (error) { failure = error }
    await db.query('ROLLBACK TO SAVEPOINT forged_broadcast')
    expect((failure as { code?: string } | undefined)?.code).toBe('42501')
  })

  it('publishes the same owner-scoped agent change on events and the retiring legacy topic', async () => {
    const agent = randomUUID()
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Event owner'),($2,'human','Peer')", [owner, peer])
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id) VALUES($1,'agent','Agent',$2)", [agent, owner])
    const { rows } = await db.query('SELECT topic,private,payload FROM realtime.messages WHERE event=$1 AND payload #>> $2=$3 ORDER BY topic',
      ['agent_changed', '{agent,id}', agent])
    expect(rows.map(row => ({ topic: row.topic, private: row.private }))).toEqual([
      { topic: topics[0], private: true }, { topic: topics[5], private: true },
    ])
    expect(rows[0].payload).toEqual(rows[1].payload)
    await as('authenticated', peer)
    expect((await db.query('SELECT topic FROM realtime.messages WHERE payload #>> $1=$2', ['{agent,id}', agent])).rows).toEqual([])
  })
})
