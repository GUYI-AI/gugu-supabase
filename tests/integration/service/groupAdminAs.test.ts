import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

interface Database {
  connect(): Promise<void>
  end(): Promise<void>
  query<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => Database }
let db: Database
let owner: string, agentOwner: string, human: string, outsider: string
let memberAgent: string, adminAgent: string, freshAgent: string, externalAgent: string, room: string

async function asUser(id: string) {
  await db.query('SET LOCAL role TO authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function service() { await db.query('RESET role') }
async function rpc(name: string, args: Record<string, unknown>, account: string, actor = account) {
  if (!/^[a-z_]+$/.test(name)) throw new Error('Invalid fixture RPC')
  await asUser(account)
  const all = { ...args, p_as_user_id: actor }
  const { rows } = await db.query<{ value: Record<string, unknown> }>(
    `SELECT chat.${name}(${Object.keys(all).map((key, i) => `${key} => $${i + 1}`).join(',')}) AS value`, Object.values(all))
  return rows[0]!.value
}
async function rejected(work: () => Promise<unknown>) {
  await db.query('SAVEPOINT denied')
  try { await work() } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT denied')
    return String((error as Error).message)
  }
  throw new Error('Expected authorization rejection')
}
async function present(id: string, chat = room) {
  await service()
  return (await db.query('SELECT 1 FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [chat, id])).rows.length === 1
}
async function invite(target: string, account = owner, actor = account) {
  return rpc('request_group_invitation_as', { p_chat_id: room, p_invitee_user_id: target, p_message: '请加入' }, account, actor)
}
async function decide(id: unknown, account: string, accept = true) {
  return rpc('decide_group_invitation_as', { p_invitation_id: id, p_accept: accept }, account)
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('groupAdminAs requires the disposable loopback database')
  }
  db = new Client({ connectionString: url.href }); await db.connect()
  // Install outside fixture transactions: upgrading a held member-table lock to
  // DDL mid-test deadlocks with parallel suites. Only this connection's local
  // setting enables the fault; other test sessions always pass through.
  await db.query(`CREATE FUNCTION chat.fixture_reject_group_member_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.chat_id = current_setting('gugu.fixture_reject_member_delete', true) THEN
        RAISE EXCEPTION 'fixture_reject_member_delete';
      END IF;
      RETURN OLD;
    END $$`)
  await db.query('CREATE TRIGGER fixture_reject_group_member_delete BEFORE DELETE ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION chat.fixture_reject_group_member_delete()')
})
afterAll(async () => {
  if (!db) return
  try {
    await db.query('DROP TRIGGER IF EXISTS fixture_reject_group_member_delete ON chat.chat_members')
    await db.query('DROP FUNCTION IF EXISTS chat.fixture_reject_group_member_delete()')
  } finally { await db.end() }
})
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); agentOwner = randomUUID(); human = randomUUID(); outsider = randomUUID()
  memberAgent = randomUUID(); adminAgent = randomUUID(); freshAgent = randomUUID(); externalAgent = randomUUID(); room = randomUUID()
  for (const id of [owner, agentOwner, human, outsider]) {
    await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@group-admin.invalid`])
    await db.query(`INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human',$2)
      ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [id, id])
    await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
      VALUES ($1,$2,'7676','fixture','darwin')`, [`d-${id}`, id])
  }
  for (const [id, account] of [[memberAgent, owner], [adminAgent, agentOwner], [freshAgent, owner], [externalAgent, outsider]]) {
    await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,agent_public)
      VALUES ($1,'agent',$1,$2,$3,true)`, [id, account, `d-${account}`])
  }
  // Fixture setup is privileged; product actions below use authenticated claims.
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id,allow_member_invite)
    VALUES ($1,'group','Group admin fixture',$2,false)`, [room, owner])
  await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES
    ($1,$2,'owner'),($1,$3,'member'),($1,$4,'member'),($1,$5,'member'),($1,$6,'admin')`,
  [room, owner, agentOwner, human, memberAgent, adminAgent])
})
afterEach(async () => {
  if (!db) return
  try { await service(); await db.query('SET CONSTRAINTS ALL IMMEDIATE') } finally { await db.query('ROLLBACK') }
})

describe('one actor authority for people and Agents', () => {
  it('Agent admin may remove a human although its owner is only a member', async () => {
    const receipt = await rpc('remove_group_member_as', { p_chat_id: room, p_member_user_id: human }, agentOwner, adminAgent)
    expect(receipt.status).toBe('removed'); expect(await present(human)).toBe(false)
  })
  it('Agent member cannot borrow its human group owner’s authority', async () => {
    expect(await rejected(() => rpc('remove_group_member_as', { p_chat_id: room, p_member_user_id: human }, owner, memberAgent)))
      .toContain('group_manager_required')
    expect(await present(human)).toBe(true)
  })
  it('self leave in a two-person group keeps the human owner and active group', async () => {
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id<>ALL($2::text[])', [room, [owner, memberAgent]])
    await rpc('remove_group_member_as', { p_chat_id: room, p_member_user_id: memberAgent }, owner, memberAgent)
    await service(); await db.query('SET CONSTRAINTS ALL IMMEDIATE')
    expect((await db.query<{ status: string }>('SELECT status FROM chat.chats WHERE id=$1', [room])).rows[0]!.status).toBe('active')
    expect(await present(owner)).toBe(true); expect(await present(memberAgent)).toBe(false)
    expect((await db.query('SELECT 1 FROM identity.users WHERE id=$1', [memberAgent])).rows).toHaveLength(1)
  })
  it('a human owner can take their own Agent out without being a group manager', async () => {
    expect((await rpc('remove_group_member_as', { p_chat_id: room, p_member_user_id: adminAgent }, agentOwner)).status).toBe('removed')
    expect(await present(adminAgent)).toBe(false)
  })
  it('rolls back Agent state cleanup if deleting its membership fails', async () => {
    await db.query("INSERT INTO chat.group_agent_states(chat_id,agent_user_id,functional_role,capability_roles) VALUES ($1,$2,'member',ARRAY['member']::text[]) ON CONFLICT DO NOTHING", [room,memberAgent])
    await db.query("SELECT set_config('gugu.fixture_reject_member_delete',$1,true)", [room])
    expect(await rejected(() => rpc('remove_group_member_as', { p_chat_id: room, p_member_user_id: memberAgent }, owner))).toContain('fixture_reject_member_delete')
    expect(await present(memberAgent)).toBe(true)
    expect((await db.query('SELECT 1 FROM chat.group_agent_states WHERE chat_id=$1 AND agent_user_id=$2', [room,memberAgent])).rows).toHaveLength(1)
    await db.query("SELECT set_config('gugu.fixture_reject_member_delete','',true)")
    await rpc('remove_group_member_as', { p_chat_id: room, p_member_user_id: memberAgent }, owner)
    expect(await present(memberAgent)).toBe(false)
    expect((await db.query('SELECT 1 FROM chat.group_agent_states WHERE chat_id=$1 AND agent_user_id=$2', [room,memberAgent])).rows).toHaveLength(0)
  })
  it('cannot impersonate another account or remove the human group owner', async () => {
    expect(await rejected(() => rpc('remove_group_member_as', { p_chat_id: room, p_member_user_id: human }, outsider, adminAgent)))
      .toContain('group_actor_not_authorized')
    expect(await rejected(() => rpc('remove_group_member_as', { p_chat_id: room, p_member_user_id: owner }, agentOwner, adminAgent)))
      .toContain('group_owner_cannot_leave')
  })
  it('promotes and demotes non-owners; the next request observes revoked admin', async () => {
    expect((await rpc('set_group_member_role_as', { p_chat_id: room, p_member_user_id: human, p_role: 'admin' }, agentOwner, adminAgent)).role).toBe('admin')
    await rpc('set_group_member_role_as', { p_chat_id: room, p_member_user_id: adminAgent, p_role: 'member' }, owner)
    expect(await rejected(() => rpc('set_group_member_role_as', { p_chat_id: room, p_member_user_id: human, p_role: 'member' }, agentOwner, adminAgent)))
      .toContain('group_manager_required')
    expect(await rejected(() => rpc('set_group_member_role_as', { p_chat_id: room, p_member_user_id: owner, p_role: 'member' }, owner)))
      .toContain('group_owner_role_protected')
  })
  it('allows the human owner and actual group manager to choose an Agent listen mode', async () => {
    expect((await rpc('set_agent_listen_mode_as', { p_chat_id: room, p_agent_user_id: memberAgent, p_mode: 'passive' }, owner)).listen_mode).toBe('passive')
    expect((await rpc('set_agent_listen_mode_as', { p_chat_id: room, p_agent_user_id: memberAgent, p_mode: 'active' }, agentOwner, adminAgent)).listen_mode).toBe('active')
    expect(await rejected(() => rpc('set_agent_listen_mode_as', { p_chat_id: room, p_agent_user_id: memberAgent, p_mode: 'active' }, owner, memberAgent)))
      .toContain('agent_owner_or_group_manager_required')
  })
  it('revokes the old table mutations even for a group owner, but keeps personal preferences', async () => {
    await asUser(owner)
    for (const sql of [
      'UPDATE chat.chat_members SET role=role WHERE chat_id=$1',
      'UPDATE chat.chat_members SET listen_mode=listen_mode WHERE chat_id=$1',
      'DELETE FROM chat.chat_members WHERE chat_id=$1',
      "UPDATE chat.chats SET name='bypass' WHERE id=$1",
      'INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,\'member\')',
    ]) expect(await rejected(() => db.query(sql, sql.includes('$2') ? [room, outsider] : [room]))).toMatch(/permission denied/)
    await db.query('UPDATE chat.chat_members SET is_pinned=true WHERE chat_id=$1 AND user_id=$2', [room, owner])
    expect((await rpc('update_group_as', { p_chat_id: room, p_changes: { name: 'Confirmed' } }, owner)).name).toBe('Confirmed')
  })
  it('settings and announcements use the Agent’s actual role and author identity', async () => {
    const settings = await rpc('update_group_as', { p_chat_id: room, p_changes: { name: 'Agent edited', group_prompt: 'Rules' } }, agentOwner, adminAgent)
    expect(settings.name).toBe('Agent edited'); expect(settings.can_manage).toBe(true)
    const post = await rpc('post_group_announcement_as', { p_chat_id: room, p_text: 'Announcement' }, agentOwner, adminAgent)
    const edited = await rpc('update_group_announcement_as', { p_announcement_id: post.id, p_changes: { pinned: true } }, agentOwner, adminAgent)
    expect(edited.author_id).toBe(adminAgent); expect(edited.pinned).toBe(true)
    expect((await rpc('delete_group_announcement_as', { p_announcement_id: post.id }, agentOwner, adminAgent)).status).toBe('deleted')
  })
  it('only the actual human group owner can dissolve the group', async () => {
    expect(await rejected(() => rpc('archive_group_as', { p_chat_id: room }, agentOwner, adminAgent))).toContain('human_group_owner_required')
    expect((await rpc('archive_group_as', { p_chat_id: room }, owner)).status).toBe('archived')
  })
})

describe('topic authority comes from the source, while settings belong to the participant', () => {
  let topic: string
  beforeEach(async () => {
    const anchor = randomUUID()
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Topic authority')", [anchor, room, agentOwner])
    await asUser(agentOwner)
    const { rows } = await db.query<{ chat_id: string }>('SELECT * FROM chat.create_topic($1,$2,$3,$4)', [room, anchor, 'Permissions topic', [adminAgent, human]])
    topic = rows[0]!.chat_id
    await service()
  })
  it('creates only member seats and projects source roles without promoting the creator', async () => {
    expect((await db.query<{ role: string }>('SELECT role FROM chat.chat_members WHERE chat_id=$1', [topic])).rows.every((row) => row.role === 'member')).toBe(true)
    expect(await rpc('group_info_as', { p_chat_id: topic }, agentOwner)).toMatchObject({ my_role: 'member', can_manage: false, can_archive_topic: false })
    await asUser(agentOwner)
    const { rows } = await db.query<{ user_id: string; role: string }>('SELECT * FROM chat.list_member_ids($1)', [topic])
    expect(rows.find((row) => row.user_id === adminAgent)?.role).toBe('admin')
    expect(rows.find((row) => row.user_id === agentOwner)?.role).toBe('member')
  })
  it('lets a non-admin human owner change their own topic listen mode without changing the source', async () => {
    expect((await rpc('set_agent_listen_mode_as', { p_chat_id: topic, p_agent_user_id: adminAgent, p_mode: 'passive' }, agentOwner)).listen_mode).toBe('passive')
    await service()
    expect((await db.query<{ chat_id: string; listen_mode: string }>('SELECT chat_id,listen_mode FROM chat.chat_members WHERE user_id=$1 AND chat_id=ANY($2::text[])', [adminAgent, [room, topic]])).rows)
      .toEqual(expect.arrayContaining([{ chat_id: topic, listen_mode: 'passive' }, { chat_id: room, listen_mode: 'active' }]))
    expect(await rejected(() => rpc('set_agent_listen_mode_as', { p_chat_id: topic, p_agent_user_id: adminAgent, p_mode: 'active' }, human)))
      .toContain('agent_owner_or_group_manager_required')
    for (const [account, actor] of [[owner, owner], [agentOwner, adminAgent]]) {
      expect((await rpc('set_agent_listen_mode_as', { p_chat_id: topic, p_agent_user_id: adminAgent, p_mode: 'active' }, account, actor)).listen_mode).toBe('active')
    }
  })
  it('lets source managers administer a topic without participation, then observes source revocation', async () => {
    expect(await present(owner, topic)).toBe(false)
    expect(await rpc('group_info_as', { p_chat_id: topic }, owner)).toMatchObject({ my_role: 'owner', can_manage: true, can_archive_topic: true, can_dissolve: false })
    expect((await rpc('update_group_as', { p_chat_id: topic, p_changes: { name: 'Source manager edited', agent_flood_threshold: 7 } }, agentOwner, adminAgent)).name).toBe('Source manager edited')
    await rpc('set_group_member_role_as', { p_chat_id: room, p_member_user_id: adminAgent, p_role: 'member' }, owner)
    expect(await rejected(() => rpc('update_group_as', { p_chat_id: topic, p_changes: { name: 'Denied' } }, agentOwner, adminAgent))).toContain('group_manager_required')
  })
  it('ignores stale topic owner/admin roles and refuses independent topic role changes', async () => {
    await db.query("UPDATE chat.chat_members SET role='owner' WHERE chat_id=$1 AND user_id=$2", [topic, agentOwner])
    expect(await rejected(() => rpc('update_group_as', { p_chat_id: topic, p_changes: { name: 'Denied' } }, agentOwner))).toContain('group_manager_required')
    expect(await rejected(() => rpc('remove_group_member_as', { p_chat_id: topic, p_member_user_id: human }, agentOwner))).toContain('group_manager_required')
    expect(await rejected(() => rpc('set_group_member_role_as', { p_chat_id: topic, p_member_user_id: human, p_role: 'admin' }, owner))).toContain('group_roles_require_source_group')
  })
  it('lets the human owner remove their own Agent and lets a source manager remove other participants', async () => {
    expect((await rpc('remove_group_member_as', { p_chat_id: topic, p_member_user_id: adminAgent }, agentOwner)).status).toBe('removed')
    expect(await present(adminAgent, topic)).toBe(false)
    expect(await present(adminAgent, room)).toBe(true)
    expect((await rpc('remove_group_member_as', { p_chat_id: topic, p_member_user_id: human }, owner)).status).toBe('removed')
    expect(await present(human, room)).toBe(true)
    await service()
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [topic, owner])
    await rpc('remove_group_member_as', { p_chat_id: topic, p_member_user_id: owner }, agentOwner, adminAgent)
    expect(await present(owner, topic)).toBe(false)
    expect(await present(owner, room)).toBe(true)
    expect((await rpc('remove_group_member_as', { p_chat_id: topic, p_member_user_id: agentOwner }, agentOwner)).status).toBe('removed')
  })
  it('keeps pin/mute personal and does not reopen direct role or listen-mode writes', async () => {
    await asUser(human)
    await db.query("UPDATE chat.chat_members SET is_pinned=true,notification_level='none' WHERE chat_id=$1 AND user_id=$2", [topic, human])
    expect((await db.query('UPDATE chat.chat_members SET is_pinned=true WHERE chat_id=$1 AND user_id=$2 RETURNING user_id', [topic, agentOwner])).rows).toEqual([])
    expect(await rejected(() => db.query("UPDATE chat.chat_members SET listen_mode='passive' WHERE chat_id=$1", [topic]))).toContain('permission denied')
    expect(await rejected(() => db.query("UPDATE chat.chat_members SET role='admin' WHERE chat_id=$1", [topic]))).toContain('permission denied')
    await service()
    expect((await db.query('SELECT is_pinned,notification_level FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [topic, human])).rows[0])
      .toEqual({ is_pinned: true, notification_level: 'none' })
  })
  it('authorizes topic decisions from source management, not topic seat roles', async () => {
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [topic, owner])
    const write = (account: string) => async () => {
      await asUser(account)
      await db.query("INSERT INTO chat.gugu_decision_events(chat_id,event_type,created_by_user_id) VALUES($1,'group_stop',$2)", [topic, account])
    }
    await write(owner)()
    expect(await rejected(write(human))).toContain('row-level security')
    await service()
  })
  it.each(['dm', 'ai'])('retains human creator management inside a %s source without a topic owner role', async (kind) => {
    const source = randomUUID(), anchor = randomUUID()
    await db.query('INSERT INTO chat.chats(id,kind,creator_user_id) VALUES($1,$2,$3)', [source, kind, agentOwner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')", [source, agentOwner, human])
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Private source')", [anchor, source, agentOwner])
    // A topic Agent must belong to the source; this private source seats only the two humans.
    await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [topic, adminAgent])
    await db.query('UPDATE chat.chats SET source_chat_id=$1,source_message_id=$2 WHERE id=$3', [source, anchor, topic])
    expect((await rpc('update_group_as', { p_chat_id: topic, p_changes: { name: 'Creator edited' } }, agentOwner)).can_manage).toBe(true)
    expect(await rejected(() => rpc('update_group_as', { p_chat_id: topic, p_changes: { name: 'Peer denied' } }, human))).toContain('group_manager_required')
  })
})

describe('related membership and external consent', () => {
  it('human invitations remain pending; they do not add the target immediately', async () => {
    const invitation = await invite(outsider)
    expect(invitation.status).toBe('pending'); expect(await present(outsider)).toBe(false)
    expect((await decide(invitation.invitation_id, outsider)).status).toBe('accepted')
    expect(await present(outsider)).toBe(true)
  })
  it('adds one’s own Agent directly, and an Agent directly adds its human owner', async () => {
    expect((await invite(freshAgent)).status).toBe('joined'); expect(await present(freshAgent)).toBe(true)
    await service(); await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [room, agentOwner])
    expect(await present(adminAgent)).toBe(false)
    // A new owner departure carries its Agent. Re-create a legacy Agent-only
    // group seat to retain coverage of the existing related invitation path.
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'admin')", [room, adminAgent])
    expect((await invite(agentOwner, agentOwner, adminAgent)).status).toBe('joined')
    expect(await present(agentOwner)).toBe(true)
  })
  it('an external Agent requires its owner to consent; an admin cannot accept for them', async () => {
    const invitation = await invite(externalAgent)
    expect(await present(externalAgent)).toBe(false)
    expect(await rejected(() => decide(invitation.invitation_id, owner))).toContain('invitation_not_addressed_to_actor')
    expect((await decide(invitation.invitation_id, outsider)).status).toBe('accepted')
    expect(await present(outsider)).toBe(true); expect(await present(externalAgent)).toBe(true)
  })
  it('approval exemption follows the inviting Agent admin, not its member owner', async () => {
    await db.query('UPDATE chat.chats SET agent_join_approval=true WHERE id=$1', [room])
    const invitation = await invite(externalAgent, agentOwner, adminAgent)
    expect((await decide(invitation.invitation_id, outsider)).status).toBe('accepted')
    expect(await present(externalAgent)).toBe(true)
  })
  it('a member Agent does not borrow its group owner’s approval exemption', async () => {
    await db.query('UPDATE chat.chats SET agent_join_approval=true WHERE id=$1', [room])
    const result = await rpc('add_group_agent', { p_chat_id: room, p_agent_user_id: freshAgent, p_message: null }, owner, memberAgent)
    expect(result.status).toBe('pending_approval'); expect(await present(freshAgent)).toBe(false)
    expect((await rpc('decide_group_join', { p_request_id: result.request_id, p_accept: true }, agentOwner, adminAgent)).status).toBe('accepted')
    expect(await present(freshAgent)).toBe(true)
  })
  it('a nonmember Agent may request its own enrollment, then an actual admin can approve', async () => {
    await db.query('UPDATE chat.chats SET agent_join_approval=true WHERE id=$1', [room])
    const result = await rpc('add_group_agent', { p_chat_id: room, p_agent_user_id: freshAgent, p_message: null }, owner, freshAgent)
    expect(result.status).toBe('pending_approval'); expect(await present(freshAgent)).toBe(false)
    expect((await rpc('decide_group_join', { p_request_id: result.request_id, p_accept: true }, agentOwner, adminAgent)).status).toBe('accepted')
    expect(await present(freshAgent)).toBe(true)
  })
  it('rechecks invitation authority at acceptance, without partial membership', async () => {
    const invitation = await invite(outsider, agentOwner, adminAgent)
    await service(); await db.query("UPDATE chat.chat_members SET role='member' WHERE chat_id=$1 AND user_id=$2", [room, adminAgent])
    expect(await rejected(() => decide(invitation.invitation_id, outsider))).toContain('member_invite_disabled')
    expect(await present(outsider)).toBe(false)
  })
  it('drops old RPC signatures rather than keeping compatibility routes', async () => {
    for (const signature of ['chat.add_group_agent(text,text,text)', 'chat.add_group_agent(text,text,text,text)', 'chat.decide_group_join(text,boolean)',
      'chat.request_agent_group_invitation(text,text,text,text)', 'chat.decide_agent_group_invitation(text,boolean)']) {
      expect((await db.query<{ fn: string | null }>('SELECT to_regprocedure($1)::text AS fn', [signature])).rows[0]!.fn).toBeNull()
    }
  })
})
