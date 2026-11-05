import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

type Db = {
  connect(): Promise<void>
  end(): Promise<void>
  query<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (options: { connectionString: string }) => Db }
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let db: Db
let owner: string, viewer: string, outsider: string, agent: string
beforeAll(async () => {
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('Presence budget requires disposable loopback PostgreSQL')
  db = new Client({ connectionString: url })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, viewer, outsider, agent] = Array.from({ length: 4 }, randomUUID)
  for (const id of [owner, viewer, outsider]) await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, `${id}@presence-budget.example.test`])
  const device = `presence-budget-${randomUUID()}`
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,status) VALUES($1,$2,'Presence budget','isolated','linux','online')", [device, owner])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,desired_status) VALUES($1,'agent','Presence agent',$2,$3,'online')", [agent, owner, device])
  const chat = randomUUID()
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Presence budget',$2)", [chat, owner])
  for (const id of [owner, viewer, agent]) await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,$3)", [chat, id, id === owner ? 'owner' : 'member'])
})
afterEach(async () => { await db.query('ROLLBACK') })

async function asUser<T>(user: string, sql: string, args: unknown[]): Promise<T[]> {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [user])
  try { return (await db.query<T>(sql, args)).rows } finally { await db.query('RESET ROLE') }
}
const write = (status: string, detail: string, actions: string[], lastAction: string) => asUser(owner,
  `SELECT identity.set_agent_runtime_state(p_agent_user_id=>$1,p_runtime_status=>'online',p_activity_status=>'running',
    p_runtime_kind=>'gugu',p_runtime_label=>'Presence budget',p_agent_status=>$2,p_agent_status_detail=>$3,
    p_recent_actions=>$4::text[],p_last_action_at=>$5::timestamptz)`, [agent, status, detail, actions, lastAction])
type Revision = { user_id: string; revision: string; resource_key: { agent_user_id: string; presence?: Record<string, unknown> } }
const revisions = async () => (await db.query<Revision>("SELECT user_id,revision,resource_key FROM chat.account_revisions WHERE event='presence_changed' AND resource_key->>'agent_user_id'=$1 ORDER BY user_id,revision", [agent])).rows
const key = (row: Revision) => `${row.user_id}:${row.revision}`

it('persists recent actions without fanning out an unchanged status', async () => {
  await write('working', 'running', ['Read'], '2026-11-02T00:00:00Z')
  const before = new Set((await revisions()).map(key))
  await write('working', 'running', ['Edit'], '2026-11-02T00:00:30Z')
  expect((await revisions()).filter(row => !before.has(key(row)))).toEqual([])
  const { rows } = await db.query<{ actions: string[]; at: string }>('SELECT recent_actions AS actions,last_action_at::text AS at FROM identity.agent_runtime_states WHERE agent_user_id=$1', [agent])
  expect(rows[0]?.actions).toEqual(['Edit'])
  expect(Date.parse(rows[0]!.at)).toBe(Date.parse('2026-11-02T00:00:30Z'))
})

it('fans a real reading edge to the same authorized humans with the already built presence', async () => {
  await write('working', 'running', ['Read'], '2026-11-02T00:00:00Z')
  const before = new Set((await revisions()).map(key))
  await write('needs_user', 'approval', ['Edit'], '2026-11-02T00:00:01Z')
  const changed = (await revisions()).filter(row => !before.has(key(row)))
  expect(changed.map(row => row.user_id).sort()).toEqual([owner, viewer].sort())
  const { rows } = await db.query<{ presence: Record<string, unknown> }>('SELECT identity.build_agent_presence_payload($1) AS presence', [agent])
  const presence = rows[0]!.presence.presence as Record<string, unknown>
  for (const row of changed) {
    expect(row.resource_key).toMatchObject({ agent_user_id: agent, presence })
    expect(row.resource_key.presence).not.toHaveProperty('presence')
  }
  expect(changed.some(row => row.user_id === outsider || row.user_id === agent)).toBe(false)
  const [synced] = await asUser<{ page: { operations: Array<{ event: string; payload: Revision['resource_key'] }> } }>(viewer, 'SELECT chat.sync_since(0,500) AS page', [])
  const delivered = synced!.page.operations.filter(row => row.event === 'presence_changed' && row.payload.agent_user_id === agent)
  expect(delivered.at(-1)?.payload).toMatchObject({ agent_user_id: agent, presence })
})

// Cross-repository acceptance supplies the module built from the exact client source.
// Backend-only CI still validates the flat journal contract above without a client checkout.
const clientParserModule = process.env.GUGU_INTEGRATION_CLIENT_PRESENCE_MODULE
it.runIf(Boolean(clientParserModule)).each(['runtime', 'device'] as const)(
  'delivers a %s edge that the real client presence parser accepts', async (source) => {
    const { parseAgentPresencePayload } = await import(/* @vite-ignore */ clientParserModule!)
    const before = new Set((await revisions()).map(key))
    if (source === 'runtime') await write('working', 'running', ['Read'], '2026-11-02T00:00:00Z')
    else await db.query("UPDATE identity.gugu_devices SET status='offline' WHERE device_id=(SELECT device_id FROM identity.users WHERE id=$1)", [agent])
    const changed = (await revisions()).filter(row => !before.has(key(row)))
    expect(changed.map(row => row.user_id).sort()).toEqual([owner, viewer].sort())
    for (const row of changed) {
      const parsed = parseAgentPresencePayload({ presence: row.resource_key.presence })
      expect(parsed).toMatchObject({ agentUserId: agent })
      if (source === 'runtime') expect(parsed.status).toEqual({ status: 'working', detail: 'running' })
      else expect(parsed.deviceStatus).toBe('offline')
    }
  },
)
