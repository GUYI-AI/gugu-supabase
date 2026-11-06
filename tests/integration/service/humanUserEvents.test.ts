/** User-events belong to human accounts. Exercise every installed producer's
 * real function and real realtime.send output on a disposable loopback database.
 * Trigger probes use LIKE-shaped temporary rows, avoiding actual device work,
 * forum awards. All data and function probes roll back per case.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let db: DatabaseClient
let human: string
let agent: string
let sourceAgent: string
let chat: string
let device: string

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('humanUserEvents requires disposable loopback PostgreSQL')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
  await db.query("SET statement_timeout='15s'")
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  human = randomUUID(); agent = randomUUID(); sourceAgent = randomUUID()
  chat = randomUUID(); device = `human-events-${randomUUID()}`
  await db.query('INSERT INTO auth.users(id,email) VALUES ($1::uuid,$2)', [human, `${human}@example.test`])
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','event owner') ON CONFLICT (id) DO NOTHING", [human])
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,status) VALUES ($1,$2,'event test','isolated','linux','online')", [device, human])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,desired_status) VALUES ($1,'agent','viewer',$3,$4,'online'),($2,'agent','source',$3,$4,'online')", [agent, sourceAgent, human, device])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','event test',$2)", [chat, human])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')", [chat, human, agent, sourceAgent])
  const [a, b] = [human, agent].sort()
  await db.query('INSERT INTO identity.friendships(user_a_id,user_b_id) VALUES ($1,$2)', [a, b])
  await db.query('DELETE FROM chat.presence_wake_throttles WHERE viewer_user_id=ANY($1::text[])', [[human, agent, sourceAgent]])
  await db.query('DELETE FROM realtime.messages WHERE topic=ANY($1::text[])', [[human, agent, sourceAgent].map(topic)])
})
afterEach(async () => { await db?.query('ROLLBACK') })

function topic(user: string): string { return `gugu:user:${user}:events` }
async function triggerProbe(table: string, shape: string, fn: string, timing = 'AFTER INSERT OR UPDATE'): Promise<void> {
  // All identifiers come from the source list below, never external input.
  await db.query(`CREATE TEMP TABLE ${table} (LIKE ${shape} INCLUDING DEFAULTS) ON COMMIT DROP`)
  await db.query(`CREATE TRIGGER event_probe ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
}
async function events(user: string, event: string) {
  return (await db.query<{ event: string; topic: string; private: boolean; payload: Record<string, unknown> }>(
    'SELECT event,topic,private,payload FROM realtime.messages WHERE topic=$1 AND event=$2', [topic(user), event])).rows
}

const sources: { name: string; event: string; run: () => Promise<void> }[] = [
  {
    name: 'chat.publish_user_revision', event: 'im_revision_advanced',
    run: async () => {
      await db.query("SELECT chat.publish_user_revision($1,'chat_changed','{}'::jsonb,false)", [human])
      await db.query("SELECT chat.publish_user_revision($1,'chat_changed','{}'::jsonb,false)", [agent])
    },
  },
  {
    name: 'identity.broadcast_user_setting_changed', event: 'setting_changed',
    run: async () => {
      await triggerProbe('setting_probe', 'identity.user_settings', 'identity.broadcast_user_setting_changed')
      await db.query("INSERT INTO setting_probe(user_id,scope,config) VALUES ($1,'test','{}'),($2,'test','{}')", [human, agent])
    },
  },
  {
    name: 'identity.fan_agent_presence_to_viewers', event: 'im_revision_advanced',
    run: async () => {
      await db.query("SELECT identity.fan_agent_presence_to_viewers($1,'{}'::jsonb)", [sourceAgent])
    },
  },
  {
    name: 'moments.broadcast_feed_changed', event: 'moments_changed',
    run: async () => {
      // The function dispatches by TG_TABLE_NAME. Use a temp posts table with
      // its actual row shape; no post is published to the real feed.
      await triggerProbe('posts', 'moments.posts', 'moments.broadcast_feed_changed')
      await db.query("INSERT INTO posts(id,user_id,content) VALUES ($1,$2,'fixture')", [randomUUID(), human])
    },
  },
  {
    name: 'identity.broadcast_agent_deliver_outcome_7503', event: 'agent_deliver_changed',
    run: async () => {
      await triggerProbe('outcome_probe', 'identity.gugu_device_commands', 'identity.broadcast_agent_deliver_outcome_7503', 'AFTER UPDATE OF status')
      await db.query("INSERT INTO outcome_probe(user_id,device_id,type,status,payload) VALUES ($1::uuid,$3,'agent.deliver','pending',$4::jsonb),($2::uuid,$3,'agent.deliver','pending',$4::jsonb)", [human, agent, device, JSON.stringify({ agent_user_id: sourceAgent, chat_id: chat })])
      await db.query("UPDATE outcome_probe SET status='error'")
    },
  },
]

describe('retained community user-event producers', () => {
  it.each(sources)('$name preserves the human event and sends nothing to agents', async ({ run, event }) => {
    await run()
    const received = await events(human, event)
    expect(received).toHaveLength(1) // positive control against a dead emitter
    expect(received[0]).toMatchObject({ event, topic: topic(human), private: true })
    expect(received[0]!.payload).toBeTypeOf('object')
    expect(await events(agent, event)).toEqual([])
    expect(await events(sourceAgent, event)).toEqual([])
    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM chat.account_revisions WHERE user_id=ANY($1::text[])", [[agent, sourceAgent]])
    expect(rows).toEqual([{ n: '0' }])
  })

  it('publishes a topic-source journal fact without the redundant direct payload', async () => {
    await db.query("SELECT chat.broadcast_to_chat_member_user_events($1,'chat_changed',jsonb_build_object('topic_of_source_chat',$1::text,'chat_id',$1::text))", [chat])
    expect(await events(human, 'chat_changed')).toEqual([])
    const { rows } = await db.query("SELECT resource_key FROM chat.account_revisions WHERE user_id=$1 AND event='chat_changed' AND resource_key->>'entity_id'=$2", [human, chat])
    expect(rows).toHaveLength(1)
    expect(await events(human, 'im_revision_advanced')).toHaveLength(1)
  })

  it('keeps member and read facts in the journal without duplicate direct events', async () => {
    const before = (await db.query<{ revision: string }>('SELECT revision::text FROM chat.account_revision_heads WHERE user_id=$1', [human])).rows[0]!.revision
    await db.query('UPDATE chat.chat_members SET is_pinned=true,last_read_seq=1,version=version+1 WHERE chat_id=$1 AND user_id=$2', [chat, human])
    expect(await events(human, 'chat_members_changed')).toEqual([])
    expect(await events(human, 'member_stream_read_changed')).toEqual([])
    const { rows } = await db.query("SELECT event FROM chat.account_revisions WHERE user_id=$1 AND resource_key->>'chat_id'=$2 AND event=ANY($3::text[]) AND revision>$4::bigint ORDER BY event", [human, chat, ['chat_members_changed','member_read_changed'], before])
    expect(rows.map(row => row.event)).toEqual(['chat_members_changed','member_read_changed'])
  })

  it('keeps friend requests in the journal without their redundant direct event', async () => {
    const peer = randomUUID()
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Request peer')", [peer])
    await db.query('INSERT INTO identity.friend_requests(sender_id,receiver_id) VALUES($1,$2)', [human, peer])
    expect(await events(human, 'friend_requests_changed')).toEqual([])
    expect(await events(peer, 'friend_requests_changed')).toEqual([])
    const { rows } = await db.query("SELECT user_id FROM chat.account_revisions WHERE user_id=ANY($1::text[]) AND event='friend_requests_changed' ORDER BY user_id", [[human,peer]])
    expect(rows.map(row => row.user_id)).toEqual([human,peer].sort())
  })

  it('applies the points delta without the obsolete user-event payload', async () => {
    const before = (await db.query<{ balance: string }>('SELECT community_points::text AS balance FROM identity.users WHERE id=$1', [human])).rows[0]!.balance
    await triggerProbe('points_probe', 'public.forum_community_points', 'public.forum_points_apply', 'AFTER INSERT')
    await db.query("INSERT INTO points_probe(user_id,delta,source,ref) VALUES($1,1,'signup','test')", [human])
    expect((await db.query<{ balance: string }>('SELECT community_points::text AS balance FROM identity.users WHERE id=$1', [human])).rows[0]!.balance).toBe(String(BigInt(before)+1n))
    expect(await events(human, 'forum_points_changed')).toEqual([])
  })

  it('the community catalog has one journal INSERT and one direct user-events transport', async () => {
    const signatures = [
      'chat.append_user_revision(text,text,jsonb,boolean)',
      ...sources.map(({ name }) => `${name}${name === 'chat.publish_user_revision' ? '(text,text,jsonb,boolean)'
        : name === 'chat.broadcast_to_chat_member_user_events' ? '(text,text,jsonb)'
          : name === 'identity.fan_agent_presence_to_viewers' ? '(text,jsonb)' : '()'}`),
      'chat.send_user_event(jsonb,text,text,boolean)',
    ]
    const { rows: writers } = await db.query<{ signature: string }>(`
      SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.oid=ANY($1::regprocedure[])
        AND p.prosrc ~* 'INSERT[[:space:]]+INTO[[:space:]]+chat[.]account_revisions'`, [signatures])
    expect(writers).toEqual([{ signature: 'chat.append_user_revision(text,text,jsonb,boolean)' }])
    const { rows: senders } = await db.query<{ signature: string }>(`
      SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.oid=ANY($1::regprocedure[])
        AND p.prosrc LIKE '%gugu:user:%:events%' AND p.prosrc LIKE '%realtime.send(%'`, [signatures])
    expect(senders).toEqual([{ signature: 'chat.send_user_event(jsonb,text,text,boolean)' }])
    const { rows: routed } = await db.query<{ name: string }>(`
      SELECT n.nspname||'.'||p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.oid=ANY($1::regprocedure[]) AND p.prosrc LIKE '%chat.send_user_event(%' ORDER BY name`, [signatures])
    expect(routed.map((row) => row.name)).toEqual(sources.map((source) => source.name).sort())
  })

  it('one append validates every event, advances only human heads, and publish delegates once', async () => {
    const allowed = [
      'agent_changed', 'chat_changed', 'chat_members_changed', 'chat_meta_changed',
      'delivery_changed', 'device_changed', 'friend_requests_changed', 'friendship_changed',
      'group_collab_changed', 'group_invitations_changed', 'gugu_decision_event',
      'member_read_changed', 'member_stream_read_changed', 'message_created',
      'message_deleted', 'presence_changed', 'reaction_changed', 'workspace_changed',
    ]
    for (const event of allowed) {
      const { rows: headBefore } = await db.query<{ revision: string }>('SELECT revision FROM chat.account_revision_heads WHERE user_id=$1', [human])
      const { rows: appended } = await db.query<{ human: string; agent: string | null }>(
        "SELECT chat.append_user_revision($1,$3,'{}',false) AS human,chat.append_user_revision($2,$3,'{}',false) AS agent", [human, agent, event])
      expect(BigInt(appended[0]!.human)).toBe(BigInt(headBefore[0]!.revision) + 1n)
      expect(appended[0]!.agent).toBeNull()
      const before = (await events(human, 'im_revision_advanced')).length
      const { rows: published } = await db.query<{ human: string; agent: string | null }>(
        "SELECT chat.publish_user_revision($1,$3,'{}',false) AS human,chat.publish_user_revision($2,$3,'{}',false) AS agent", [human, agent, event])
      expect(BigInt(published[0]!.human)).toBe(BigInt(appended[0]!.human) + 1n)
      expect(published[0]!.agent).toBeNull()
      expect(await events(human, 'im_revision_advanced')).toHaveLength(before + 1)
    }
    const { rows: agentHead } = await db.query<{ revision: string }>('SELECT revision FROM chat.account_revision_heads WHERE user_id=$1', [agent])
    expect(agentHead).toEqual([{ revision: '0' }])
    const { rows: agentRows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM chat.account_revisions WHERE user_id=$1', [agent])
    expect(agentRows).toEqual([{ n: '0' }])
    expect(await events(agent, 'im_revision_advanced')).toEqual([])
  })

  it('delegation preserves validation, including for an agent recipient', async () => {
    for (const [id, event, key, error] of [
      ['', 'chat_changed', '{}', /revision user id is required/],
      [agent, 'not_an_event', '{}', /unsupported account revision event/],
      [human, 'chat_changed', '[]', /revision resource key must be an object/],
    ] as const) {
      await db.query('SAVEPOINT bad_revision')
      await expect(db.query('SELECT chat.publish_user_revision($1,$2,$3::jsonb,false)', [id, event, key])).rejects.toThrow(error)
      await db.query('ROLLBACK TO SAVEPOINT bad_revision')
    }
  })

  it('a human inserted earlier in the same operation is eligible immediately', async () => {
    const fresh = randomUUID()
    await db.query(`DO $test$ BEGIN
      INSERT INTO identity.users(id,type,display_name) VALUES ('${fresh}','human','fresh owner');
      PERFORM chat.send_user_event('{"fresh":true}'::jsonb,'fresh','gugu:user:${fresh}:events',true);
    END $test$`)
    expect(await events(fresh, 'fresh')).toHaveLength(1)
  })

  it('missing identities are skipped and the shared helpers do not expose an end-user RPC', async () => {
    const missing = randomUUID()
    const { rows } = await db.query<{ revision: string | null }>(
      "SELECT chat.publish_user_revision($1,'chat_changed','{}',false) AS revision", [missing])
    expect(rows).toEqual([{ revision: null }])
    await db.query("SELECT chat.send_user_event('{\"test\":true}','test',$1,true)", [topic(missing)])
    expect(await events(missing, 'test')).toEqual([])
    for (const fn of ['chat.is_user_event_recipient(text)', 'chat.send_user_event(jsonb,text,text,boolean)']) {
      const { rows: acl } = await db.query<{ anon: boolean; human: boolean; service: boolean }>(
        "SELECT has_function_privilege('anon',$1,'EXECUTE') AS anon,has_function_privilege('authenticated',$1,'EXECUTE') AS human,has_function_privilege('service_role',$1,'EXECUTE') AS service", [fn])
      expect(acl).toEqual([{ anon: false, human: false, service: true }])
    }
  })
})
