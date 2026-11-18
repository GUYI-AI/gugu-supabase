import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { BEGIN_READING_REVISIONS, FLUSH_REVISIONS } from '../../support/revisionTransaction'

// Runs against the migrated, disposable PostgreSQL instance owned by schema-baseline CI.
// Authenticated role + real JWT claims exercise RPC grants and RLS; every case rolls back.
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
let owner: string
let receiver: string
let outsider: string
let ownAgent: string
let externalAgent: string
let siblingAgent: string

type Decision = { status: string; invitation_id: string; chat_id: string; message_id?: string | null }
async function asUser(id: string) {
  await database.query('SET LOCAL role TO authenticated')
  await database.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asService() { await database.query('RESET role') }
async function result<T>(sql: string, values: unknown[]): Promise<T> {
  return (await database.query<{ result: T }>(sql, values)).rows[0]!.result
}
async function reject(sql: string, values: unknown[]) {
  await database.query('SAVEPOINT rejected_invitation')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT rejected_invitation')
    return String((error as Error).message)
  }
  throw new Error('Expected invitation operation to fail, but it succeeded')
}
async function newGroup(maxMembers = 100) {
  const id = randomUUID()
  await asUser(owner)
  await database.query('SELECT chat.create_gugu_group($1, $2, $3, $4::jsonb)', [
    id, 'Invitation consent', owner, JSON.stringify([{ user_id: ownAgent, role: 'admin' }]),
  ])
  await asService()
  await database.query('UPDATE chat.chats SET max_members = $2 WHERE id = $1', [id, maxMembers])
  return id
}
async function members(chatId: string) {
  await asService()
  return (await database.query<{ user_id: string }>('SELECT user_id FROM chat.chat_members WHERE chat_id = $1', [chatId])).rows.map((row) => row.user_id).sort()
}
async function invite(chatId: string, invitee = externalAgent) {
  await asUser(owner)
  return result<Decision>('SELECT chat.request_group_invitation_as($1,$3,$4,$2) AS result', [chatId, ownAgent, invitee, '请协助评审'])
}
async function decide(actor: string, id: string, accept: boolean) {
  await asUser(actor)
  return result<Decision>('SELECT chat.decide_group_invitation_as($1,$2,auth.uid()::text) AS result', [id, accept])
}
async function decisionError(actor: string, id: string, accept: boolean) {
  await asUser(actor)
  return reject('SELECT chat.decide_group_invitation_as($1,$2,auth.uid()::text)', [id, accept])
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Invitation tests require a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query(BEGIN_READING_REVISIONS)
  owner = randomUUID(); receiver = randomUUID(); outsider = randomUUID()
  ownAgent = randomUUID(); externalAgent = randomUUID(); siblingAgent = randomUUID()
  for (const id of [owner, receiver, outsider]) {
    await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
    [id, `${id}@invitation-fixture.invalid`])
  }
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES
    ($1,'human','Inviter Owner'),($2,'human','Receiver Owner'),($3,'human','Outsider')
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [owner, receiver, outsider])
  const ownerDevice = `invite-${owner}`
  const receiverDevice = `invite-${receiver}`
  await database.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'inviter fixture','fixture','darwin'),($3,$4,'receiver fixture','fixture','darwin')`,
  [ownerDevice, owner, receiverDevice, receiver])
  await database.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, agent_public, device_id) VALUES
    ($1,'agent','Inviter',$4,true,$6),($2,'agent','External',$5,true,$7),($3,'agent','Sibling',$4,true,$6)`,
  [ownAgent, externalAgent, siblingAgent, owner, receiver, ownerDevice, receiverDevice])
})
afterEach(async () => {
  if (!database) return
  try {
    // Check deferred membership invariants as COMMIT would, then discard the fixture.
    await database.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await database.query('ROLLBACK')
  }
})

describe('Agent group invitation consent', () => {
  it('keeps an external Agent and owner outside until the owner accepts, idempotently', async () => {
    const group = await newGroup()
    const invitation = await invite(group)
    expect(invitation.status).toBe('pending')
    const sent = await database.query<{ id: string }>('SELECT * FROM chat.list_group_invitations_as($1,true,false)', [ownAgent])
    expect(sent.rows.map((row) => row.id)).toEqual([invitation.invitation_id])
    const messageId = randomUUID()
    await asUser(owner)
    await database.query(`INSERT INTO chat.messages (id,chat_id,sender_user_id,content,content_type)
      VALUES ($1,$2,$3,'Before consent','text')`, [messageId, group, owner])
    await asUser(receiver)
    expect((await database.query('SELECT id FROM chat.messages_view WHERE id = $1', [messageId])).rows).toEqual([])
    expect(await members(group)).toEqual([owner, ownAgent].sort())
    expect((await invite(group)).invitation_id).toBe(invitation.invitation_id)
    await asUser(receiver)
    const inbox = await database.query<{ id: string; owner_will_join: boolean }>('SELECT * FROM chat.list_group_invitations_as(auth.uid()::text,false,false)')
    expect(inbox.rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: invitation.invitation_id, owner_will_join: true })]))
    expect(await decisionError(outsider, invitation.invitation_id, true)).toMatch(/invitation_not_addressed_to_actor/)
    expect(await decisionError(owner, invitation.invitation_id, true)).toMatch(/invitation_not_addressed_to_actor/)
    expect(await members(group)).toEqual([owner, ownAgent].sort())
    await decide(receiver, invitation.invitation_id, true)
    await decide(receiver, invitation.invitation_id, true)
    expect(await members(group)).toEqual([owner, ownAgent, receiver, externalAgent].sort())
    expect((await invite(group)).status).toBe('already_member')
    await asUser(receiver)
    // Positive control: the same account and message become visible only after acceptance.
    expect((await database.query('SELECT id FROM chat.messages_view WHERE id = $1', [messageId])).rows).toEqual([{ id: messageId }])
  })
  it('lets the human decline without creating membership', async () => {
    const group = await newGroup()
    const invitation = await invite(group, receiver)
    await decide(receiver, invitation.invitation_id, false)
    await decide(receiver, invitation.invitation_id, false)
    expect(await members(group)).toEqual([owner, ownAgent].sort())
    expect(await decisionError(receiver, invitation.invitation_id, true)).toMatch(/invitation_already_decided/)
  })
  it('lists decided invitations only when asked, with their status (#6704)', async () => {
    const declined = await invite(await newGroup(), receiver)
    await decide(receiver, declined.invitation_id, false)
    const waiting = await invite(await newGroup(), receiver)
    const inbox = async (includeDecided: boolean) => {
      await asUser(receiver)
      const { rows } = await database.query<{ id: string; status: string }>('SELECT id, status FROM chat.list_group_invitations_as(auth.uid()::text,false,$1)', [includeDecided])
      return Object.fromEntries(rows.map((row) => [row.id, row.status]))
    }
    expect(await inbox(false)).toEqual({ [waiting.invitation_id]: 'pending' })
    expect(await inbox(true)).toEqual({ [waiting.invitation_id]: 'pending', [declined.invitation_id]: 'rejected' })
  })
  it('lets an invited human accept for themselves', async () => {
    const group = await newGroup()
    const invitation = await invite(group, receiver)
    await decide(receiver, invitation.invitation_id, true)
    expect(await members(group)).toEqual([owner, ownAgent, receiver].sort())
  })
  it('counts both external Agent and owner against the member limit without partial joins', async () => {
    const group = await newGroup(3)
    const invitation = await invite(group)
    expect(await decisionError(receiver, invitation.invitation_id, true)).toMatch(/member_limit_reached/)
    expect(await members(group)).toEqual([owner, ownAgent].sort())
    const { rows } = await database.query<{ status: string }>('SELECT status FROM chat.group_invitations WHERE id = $1', [invitation.invitation_id])
    expect(rows[0]!.status).toBe('pending')
  })
  it('rechecks inviter membership at acceptance', async () => {
    const group = await newGroup()
    const invitation = await invite(group)
    await invite(group, siblingAgent)
    await asService()
    await database.query('DELETE FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2', [group, ownAgent])
    expect(await decisionError(receiver, invitation.invitation_id, true)).toMatch(/actor_not_member/)
    expect(await members(group)).not.toContain(receiver)
    await decide(receiver, invitation.invitation_id, false)
  })
  it('adds an owned Agent through the same capacity-checked path', async () => {
    const group = await newGroup(3)
    expect((await invite(group, siblingAgent)).status).toBe('joined')
    expect(await members(group)).toEqual([owner, ownAgent, siblingAgent].sort())
  })
  it('publishes an invitation revision that reaches an offline owner on catch-up', async () => {
    const group = await newGroup()
    const invitation = await invite(group)
    await database.query(FLUSH_REVISIONS)
    await asUser(receiver)
    const revision = await result<unknown>('SELECT chat.sync_since($1,$2) AS result', [0, 500])
    expect(JSON.stringify(revision)).toContain('group_invitations_changed')
    expect(JSON.stringify(revision)).toContain(invitation.invitation_id)
  })
  it('keeps contact_friend pending until the friend accepts and then reuses the group', async () => {
    await database.query('INSERT INTO identity.friendships (user_a_id,user_b_id) VALUES (LEAST($1::text,$2::text),GREATEST($1::text,$2::text))', [owner, receiver])
    const contact = async () => {
      await asUser(owner)
      return result<Decision>('SELECT chat.request_agent_friend_contact($1,$2,$3) AS result', [ownAgent, receiver, '请帮忙评审'])
    }
    const invitation = await contact()
    expect(invitation.status).toBe('pending')
    expect(invitation.message_id).toBeNull()
    expect(await members(invitation.chat_id)).toEqual([owner, ownAgent].sort())
    expect((await contact()).invitation_id).toBe(invitation.invitation_id)
    await decide(receiver, invitation.invitation_id, true)
    expect(await contact()).toMatchObject({ status: 'already_member', chat_id: invitation.chat_id })
    expect(await members(invitation.chat_id)).toEqual([owner, ownAgent, receiver].sort())
  })
  describe('contact_friend: the note becomes the agent\'s first group message when the friend accepts', () => {
    type Posted = { sender_user_id: string; content: string; content_type: string; to_user_ids: string[] | null; client_message_id: string | null; seq: string }
    async function befriend() {
      await asService()
      await database.query('INSERT INTO identity.friendships (user_a_id,user_b_id) VALUES (LEAST($1::text,$2::text),GREATEST($1::text,$2::text))', [owner, receiver])
    }
    async function contact(note: string) {
      await asUser(owner)
      return result<Decision>('SELECT chat.request_agent_friend_contact($1,$2,$3) AS result', [ownAgent, receiver, note])
    }
    async function posted(chatId: string) {
      await asService()
      return (await database.query<Posted>(
        `SELECT sender_user_id, content, content_type, to_user_ids, client_message_id, seq::text AS seq
           FROM chat.messages WHERE chat_id = $1 AND content_type <> 'system' ORDER BY seq`, [chatId])).rows
    }
    async function kindOf(invitationId: string) {
      await asService()
      return (await database.query<{ kind: string }>('SELECT kind FROM chat.group_invitations WHERE id = $1', [invitationId])).rows[0]!.kind
    }
    /** 入群灰字不发给「与建群同一个事务写进来的」成员;用例整条在一个事务里,把建群时刻往前挪。 */
    async function backdate(chatId: string) {
      await asService()
      await database.query("UPDATE chat.chats SET created_at = now() - interval '1 minute' WHERE id = $1", [chatId])
    }

    it('posts the note once, from the agent to the friend, after the join notice', async () => {
      await befriend()
      const invitation = await contact('想请你帮忙看一下这份方案')
      expect(invitation.status).toBe('pending')
      expect(await kindOf(invitation.invitation_id)).toBe('friend_contact')
      // 接受之前群里没有任何消息(#6000:接受前不投递)。
      expect(await posted(invitation.chat_id)).toEqual([])
      await backdate(invitation.chat_id)

      await decide(receiver, invitation.invitation_id, true)
      const after = await posted(invitation.chat_id)
      expect(after).toHaveLength(1)
      expect(after[0]).toMatchObject({
        sender_user_id: ownAgent,
        content: '想请你帮忙看一下这份方案',
        content_type: 'text',
        to_user_ids: [receiver],
        client_message_id: `invitation-note:${invitation.invitation_id}`,
      })
      await asService()
      const joinNotices = (await database.query<{ seq: string }>(
        "SELECT seq::text AS seq FROM chat.messages WHERE chat_id = $1 AND client_message_id LIKE 'member-joined:%'", [invitation.chat_id])).rows
      expect(joinNotices).toHaveLength(1)
      expect(BigInt(joinNotices[0]!.seq) < BigInt(after[0]!.seq)).toBe(true)

      // 重复接受(幂等返回)与再次 contact_friend(already_member)都不会再落一条。
      expect(await decide(receiver, invitation.invitation_id, true)).toMatchObject({ status: 'accepted' })
      expect(await contact('想请你帮忙看一下这份方案')).toMatchObject({ status: 'already_member', chat_id: invitation.chat_id })
      expect(await posted(invitation.chat_id)).toHaveLength(1)
    })

    it('posts nothing when the friend rejects', async () => {
      await befriend()
      const invitation = await contact('想请你帮忙看一下这份方案')
      expect(await decide(receiver, invitation.invitation_id, false)).toMatchObject({ status: 'rejected' })
      expect(await posted(invitation.chat_id)).toEqual([])
      expect(await members(invitation.chat_id)).toEqual([owner, ownAgent].sort())
    })

    it('leaves an ordinary message_invite invitation as before: accepting posts no note', async () => {
      const group = await newGroup()
      await backdate(group)
      const invitation = await invite(group, receiver)
      expect(await kindOf(invitation.invitation_id)).toBe('group')
      expect(await decide(receiver, invitation.invitation_id, true)).toMatchObject({ status: 'accepted' })
      expect(await members(group)).toEqual([owner, ownAgent, receiver].sort())
      // 正对照是上一条用例:同一个 decide,friend_contact 就会落一条。
      expect(await posted(group)).toEqual([])
    })
  })
  it('does not let outsiders read or mutate invitation rows directly', async () => {
    const group = await newGroup()
    const invitation = await invite(group)
    await asUser(outsider)
    expect((await database.query('SELECT id FROM chat.group_invitations WHERE id = $1', [invitation.invitation_id])).rows).toEqual([])
    await asUser(receiver)
    expect((await database.query('SELECT id FROM chat.group_invitations WHERE id = $1', [invitation.invitation_id])).rows).toEqual([{ id: invitation.invitation_id }])
    expect(await reject("UPDATE chat.group_invitations SET status = 'accepted' WHERE id = $1", [invitation.invitation_id])).toMatch(/permission denied/)
    expect(await members(group)).toEqual([owner, ownAgent].sort())
  })
  it('blocks the legacy direct-add RPC while preserving owner-approved incoming Agent requests', async () => {
    await asUser(owner)
    expect(await reject('SELECT * FROM chat.get_or_create_agent_social_group($1,$2::text[])', [ownAgent, [receiver]])).toMatch(/permission denied/)
    await asService()
    const request = randomUUID()
    await database.query('INSERT INTO identity.friend_requests (id,sender_id,receiver_id) VALUES ($1,$2,$3)', [request, receiver, ownAgent])
    await asUser(owner)
    const { rows } = await database.query<{ chat_id: string }>('SELECT * FROM identity.accept_friend_request_by_id($1)', [request])
    expect(await members(rows[0]!.chat_id)).toEqual([owner, ownAgent, receiver].sort())
  })
})
