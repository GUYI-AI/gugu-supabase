import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let owner: string, peer: string, outsider: string, agent: string, device: string, rooms: string[], dm: string
async function admin() { await db.query('RESET ROLE') }
async function user(id = owner) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function archive(flag = true, id = agent) {
  await user()
  const result = (await db.query('SELECT identity.archive_user($1,$2) AS r', [id, flag])).rows[0].r
  await admin(); return result
}
async function denied(sql: string, args: unknown[] = [], account = owner) {
  await db.query('SAVEPOINT refusal')
  try { await user(account); await db.query(sql, args) } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT refusal'); await admin()
    return error as Error & { code: string }
  }
  throw new Error('Expected refusal')
}
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Archive contracts require the disposable loopback database')
  }
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, peer, outsider, agent, device, dm] = Array.from({ length: 6 }, randomUUID)
  rooms = Array.from({ length: 3 }, randomUUID)
  for (const id of [owner, peer, outsider]) await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,now(),now())`, [id, `${id}@archive.invalid`])
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'archive fixture','fixture','linux')`, [device, owner])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,agent_public)
    VALUES($1,'agent','Archive fixture',$2,$3,true)`, [agent, owner, device])
  for (const id of [...rooms, dm]) {
    await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,$2,'Archive fixture',$3)`, [id, id === dm ? 'dm' : 'group', owner])
    await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')`, [id, owner, agent])
    if (id !== dm) await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')`, [id, peer])
  }
  await db.query(`INSERT INTO identity.friendships(user_a_id,user_b_id) VALUES(LEAST($1,$2),GREATEST($1,$2))`, [agent, peer])
  await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Retained history')`, [randomUUID(), dm, agent])
})
afterEach(async () => { if (db) { await admin(); await db.query('ROLLBACK') } })

describe('archive terminates identity without touching seats or history', () => {
  it('one update removes N=3 rosters/mentions/counts/send permission, zero member DML, retry is idempotent', async () => {
    const seats = (await db.query('SELECT * FROM chat.chat_members WHERE user_id=$1 ORDER BY chat_id', [agent])).rows
    const history = (await db.query('SELECT * FROM chat.messages WHERE chat_id=$1 ORDER BY id', [dm])).rows
    const heads = (await db.query('SELECT * FROM chat.account_revision_heads WHERE user_id=ANY($1) ORDER BY user_id', [[owner, peer]])).rows
    // This suite is serial: transactional trigger DDL and counters roll back.
    await db.query('CREATE TEMP TABLE archive_write_log(kind text) ON COMMIT DROP')
    await db.query(`CREATE FUNCTION pg_temp.archive_watch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        IF TG_TABLE_NAME='users' THEN
          IF NEW.id=current_setting('archive.fixture_id') THEN INSERT INTO pg_temp.archive_write_log VALUES('identity'); END IF;
        ELSE
          IF COALESCE(NEW.user_id,OLD.user_id)=current_setting('archive.fixture_id') THEN INSERT INTO pg_temp.archive_write_log VALUES('member'); END IF;
        END IF;
        RETURN COALESCE(NEW,OLD);
      END $$`)
    await db.query("SELECT set_config('archive.fixture_id',$1,true)", [agent])
    await db.query('CREATE TRIGGER archive_fixture_identity AFTER UPDATE ON identity.users FOR EACH ROW EXECUTE FUNCTION pg_temp.archive_watch()')
    await db.query('CREATE TRIGGER archive_fixture_members AFTER INSERT OR UPDATE OR DELETE ON chat.chat_members FOR EACH ROW EXECUTE FUNCTION pg_temp.archive_watch()')
    const first = await archive()
    expect(first).toMatchObject({ user_id: agent, remove_social_identity: true })
    expect(first.removed_at).toBeTruthy()
    expect(await archive()).toEqual(first)
    expect((await db.query('SELECT kind,count(*)::int AS n FROM archive_write_log GROUP BY kind')).rows).toEqual([{ kind: 'identity', n: 1 }])
    expect((await db.query('SELECT * FROM chat.chat_members WHERE user_id=$1 ORDER BY chat_id', [agent])).rows).toEqual(seats)
    expect((await db.query('SELECT * FROM chat.messages WHERE chat_id=$1 ORDER BY id', [dm])).rows).toEqual(history)
    expect((await db.query('SELECT * FROM chat.account_revision_heads WHERE user_id=ANY($1) ORDER BY user_id', [[owner, peer]])).rows).toEqual(heads)
    const events = (await db.query(`SELECT event,topic,private,payload FROM realtime.messages
      WHERE topic='gugu:identity:lifecycle' AND payload->>'id'=$1`, [agent])).rows
    expect(events).toEqual([{ event: 'identity_removed', topic: 'gugu:identity:lifecycle', private: true, payload: { id: agent, removed_at: first.removed_at } }])
    await user()
    for (const room of rooms) {
      expect((await db.query('SELECT user_id FROM chat.list_member_ids($1)', [room])).rows.map(r => r.user_id)).not.toContain(agent)
      expect((await db.query('SELECT count(*)::int AS n FROM chat.active_members WHERE chat_id=$1', [room])).rows[0].n).toBe(2)
      expect((await db.query('SELECT chat.is_addressable_in($1,$2) AS yes,chat.can_act_as($2,$1) AS send', [room, agent])).rows[0]).toEqual({ yes: false, send: false })
    }
    expect((await db.query('SELECT id FROM identity.active_users WHERE id=$1', [agent])).rows).toEqual([])
    await user(peer)
    expect((await db.query('SELECT * FROM identity.friendships WHERE user_a_id=$1 OR user_b_id=$1', [agent])).rows).toEqual([])
    await user()
    expect((await db.query('SELECT * FROM chat.historical_dm_peer($1)', [dm])).rows).toEqual([{ user_id: agent, removed_at: new Date(first.removed_at) }])
    expect((await db.query('SELECT sender_user_id FROM chat.messages WHERE chat_id=$1', [dm])).rows).toContainEqual({ sender_user_id: agent })
    expect((await denied('SELECT identity.archive_user($1,false)', [agent])).code).toBe('55000')
    expect((await denied('SELECT identity.set_agent_session_archival($1,$2,$3,1,NULL,\'[]\'::jsonb)', [agent, device, randomUUID()])).code).toBe('55000')
    expect((await denied('INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,\'no\')', [randomUUID(), rooms[0], agent])).code).toBe('42501')
  })
  it('false keeps identity and seats live; authorization and historical reads remain scoped', async () => {
    expect(await archive(false)).toEqual({ user_id: agent, removed_at: null, remove_social_identity: false })
    await user()
    expect((await db.query('SELECT chat.can_act_as($1,$2) AS yes', [agent, rooms[0]])).rows[0].yes).toBe(true)
    expect((await denied('SELECT identity.archive_user($1)', [agent], outsider)).code).toBe('42501')
    expect((await denied('SELECT * FROM chat.historical_dm_peer($1)', [dm], outsider)).code).toBe('42501')
    expect((await denied('SELECT * FROM chat.historical_dm_peer($1)', [rooms[0]])).code).toBe('42501')
    expect((await denied('SELECT identity.archive_user($1,NULL)', [agent])).code).toBe('22023')
    expect((await denied("INSERT INTO realtime.messages(topic,event,payload,extension,private) VALUES('gugu:identity:lifecycle','identity_removed','{}','broadcast',true)")).code).toBe('42501')
  })
  it('human removal uses the same predicate and retains relationships and seats', async () => {
    const before = (await db.query('SELECT * FROM chat.chat_members WHERE user_id=$1 ORDER BY chat_id', [peer])).rows
    await user(peer)
    expect((await db.query('SELECT identity.archive_user($1) AS r', [peer])).rows[0].r.removed_at).toBeTruthy()
    await admin()
    expect((await db.query('SELECT * FROM chat.chat_members WHERE user_id=$1 ORDER BY chat_id', [peer])).rows).toEqual(before)
    expect((await db.query('SELECT identity.user_is_live($1) AS yes', [peer])).rows[0].yes).toBe(false)
    expect((await db.query('SELECT * FROM identity.friendships WHERE user_a_id=$1 OR user_b_id=$1', [peer])).rows).toHaveLength(1)
  })
  it('restoration provisions a new identity into only its project group, never the old seats', async () => {
    await archive()
    const fresh = randomUUID()
    await user()
    const minted = (await db.query(`SELECT * FROM identity.provision_taskpage_agent($1,'Restored 1','serial','claude-code',$2,'/fixture/project',$3,NULL,'Project')`, [fresh, device, rooms[0]])).rows[0]
    expect(minted.agent_id).toBe(fresh)
    await admin()
    expect((await db.query('SELECT chat_id FROM chat.active_members WHERE user_id=$1 ORDER BY chat_id', [fresh])).rows).toEqual([{ chat_id: rooms[0] }])
    expect((await db.query('SELECT removed_at FROM identity.users WHERE id=$1', [agent])).rows[0].removed_at).not.toBeNull()
    expect((await denied(`SELECT * FROM identity.provision_taskpage_agent($1,'Old 1','serial','claude-code',$2)`, [agent, device])).code).toBe('55000')
  })
  it('installed functions and policies do not bypass live membership', async () => {
    const functions = (await db.query(`SELECT n.nspname||'.'||p.proname AS name,p.prosrc FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
      WHERE n.nspname IN ('chat','identity','file_private','public') AND l.lanname IN ('sql','plpgsql') AND p.prokind='f'`)).rows
    const physical = new Set(['chat.chats_membership_invariants','chat.chats_status_invariants','chat.historical_dm_peer'])
    expect(functions.filter(r => !physical.has(r.name) && /\b(?:FROM|JOIN|USING)\s+chat\.chat_members\b/i.test(
      r.prosrc.replace(/\bDELETE\s+FROM\s+chat\.chat_members\b/gi, 'DELETE TARGET'))).map(r => r.name)).toEqual([])
    expect(functions.find(r => r.name === 'chat.chats_membership_invariants')?.prosrc).toContain('FROM chat.active_members m')
    const policies = (await db.query(`SELECT p.polname,pg_get_expr(p.polqual,p.polrelid) AS using,pg_get_expr(p.polwithcheck,p.polrelid) AS check
      FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('chat','identity','storage','realtime')`)).rows
    expect(policies.filter(r => /\bchat_members\b/.test(`${r.using} ${r.check}`)).map(r => r.polname)).toEqual([])
    expect((await db.query("SELECT has_function_privilege('anon','identity.archive_user(text,boolean)','EXECUTE') AS anon,has_function_privilege('authenticated','identity.archive_user(text,boolean)','EXECUTE') AS user")).rows[0]).toEqual({ anon: false, user: true })
  })
})
