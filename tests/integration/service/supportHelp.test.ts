import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFixtureGroup } from '../../support/groupFixture'

interface Database {
  connect(): Promise<void>; end(): Promise<void>
  query<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (args: { connectionString: string }) => Database }
let db: Database; let owner: string; let visitor: string; let group: string
async function actor(id: string | null, role = 'authenticated') {
  await db.query('RESET ROLE')
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)", [id ?? '', role])
  await db.query('SET LOCAL ROLE ' + role)
}
async function publish() {
  await actor(owner)
  return (await db.query<{ result: { version: number } }>(
    "SELECT identity.publish_support_help_configuration(0,$1,$2,'{}','test','fixture') result", [group, owner])).rows[0]!.result
}
async function enabled() {
  await publish()
  await actor(owner, 'service_role')
  await db.query("SELECT identity.set_support_help_release_gate($1,true,'test-reviewed','test','fixture')", [owner])
}
async function info() { return (await db.query<{ result: any }>('SELECT identity.official_help_info() result')).rows[0]!.result }
async function join(version = 1, groupId = group) {
  return (await db.query<{ result: any }>('SELECT identity.official_help_join($1,$2) result', [version, groupId])).rows[0]!.result
}
async function rejects(sql: string, args: unknown[] = []) {
  await db.query('SAVEPOINT expected_refusal')
  try { await expect(db.query(sql, args)).rejects.toThrow() }
  finally { await db.query('ROLLBACK TO SAVEPOINT expected_refusal') }
}
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('A disposable loopback database is required')
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  await db.query("UPDATE support_help.release_gate SET environment='test'")
  owner = randomUUID(); visitor = randomUUID(); group = randomUUID()
  await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) SELECT id,'authenticated','authenticated',id::text||'@support-help.invalid','{}','{}',now(),now() FROM unnest(ARRAY[$1::uuid,$2::uuid]) id", [owner, visitor])
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Test duty'),($2,'human','Test visitor') ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name", [owner, visitor])
  await actor(owner)
  await createFixtureGroup(db, [group, 'Test support', owner, '[]'])
  await db.query('RESET ROLE')
  await db.query("UPDATE chat.chats SET join_mode='open' WHERE id=$1", [group])
  await db.query('INSERT INTO support_help.configuration_admins(user_id,can_publish,can_release) VALUES($1,true,true)', [owner])
})
afterEach(async () => { if (db) { await db.query('ROLLBACK'); await db.query('RESET ROLE') } })

describe('support help configuration and data-plane boundary', () => {
  it('has an identical closed shape for anonymous and authenticated callers, irrespective of configured group', async () => {
    for (const configured of [false, true]) {
      if (configured) await publish()
      await actor(null, 'anon'); expect(await info()).toEqual({ support_help_entry_enabled: false })
      await actor(visitor); expect(await info()).toEqual({ support_help_entry_enabled: false })
    }
  })
  it('requires a named administrator and writes configuration/audit atomically', async () => {
    await actor(visitor)
    await rejects("SELECT identity.publish_support_help_configuration(0,$1,$2,'{}','test','forged')", [group, owner])
    await publish()
    await db.query('RESET ROLE')
    expect((await db.query<{ n: string }>("SELECT count(*) n FROM support_help.audit WHERE operator_user_id=$1 AND action='publish'", [owner])).rows[0]!.n).toBe('1')
    await actor(owner)
    await rejects("SELECT identity.publish_support_help_configuration(1,$1,$2,'{}','test','invalid duty')", [group, visitor])
    await db.query('RESET ROLE')
    expect((await db.query<{ version: string }>('SELECT version FROM support_help.configuration')).rows[0]!.version).toBe('1')
  })
  it('gives anonymous readers no private identity IDs or invitation material', async () => {
    await enabled(); await actor(null, 'anon')
    const result = await info()
    expect(result.group).toMatchObject({ id: null, name: 'Test support', is_member: false })
    expect(result.duty_human).toBeNull(); expect(result.assistants).toEqual([])
    expect(JSON.stringify(result)).not.toContain('join_token')
    await rejects('SELECT * FROM support_help.configuration')
    await rejects('SELECT identity.official_help_join(1,$1)', [group])
  })
  it('joins once and opens existing membership idempotently', async () => {
    await enabled(); await actor(visitor)
    expect(await join()).toEqual({ status: 'joined', chat_id: group })
    expect(await join()).toEqual({ status: 'joined', chat_id: group })
    await db.query('RESET ROLE')
    expect((await db.query<{ n: string }>('SELECT count(*) n FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [group, visitor])).rows[0]!.n).toBe('1')
  })
  it('preserves approval and produces only one pending row', async () => {
    await enabled(); await db.query('RESET ROLE')
    await db.query("UPDATE chat.chats SET join_mode='approval' WHERE id=$1", [group])
    await actor(visitor)
    expect(await join()).toMatchObject({ status: 'pending' }); expect(await join()).toMatchObject({ status: 'pending' })
    await db.query('RESET ROLE')
    expect((await db.query<{ n: string }>('SELECT count(*) n FROM chat.group_join_requests WHERE chat_id=$1 AND requester_user_id=$2', [group, visitor])).rows[0]!.n).toBe('1')
  })
  it('does not leave membership or a request after a mismatched preview', async () => {
    await enabled(); await actor(visitor)
    expect(await join(0)).toMatchObject({ status: 'config_changed' })
    expect(await join(1, randomUUID())).toMatchObject({ status: 'config_changed' })
    await db.query('RESET ROLE')
    expect((await db.query<{ n: string }>('SELECT count(*) n FROM chat.group_join_requests WHERE requester_user_id=$1', [visitor])).rows[0]!.n).toBe('0')
    expect((await db.query<{ n: string }>('SELECT count(*) n FROM chat.chat_members WHERE user_id=$1', [visitor])).rows[0]!.n).toBe('0')
  })
  it.each(['full', 'archived', 'closed', 'invite_only'])('reports %s without joining', async (state) => {
    await enabled(); await db.query('RESET ROLE')
    if (state === 'full') await db.query('UPDATE chat.chats SET max_members=1 WHERE id=$1', [group])
    if (state === 'archived') await db.query("UPDATE chat.chats SET status='archived' WHERE id=$1", [group])
    if (state === 'closed') await db.query('UPDATE chat.chats SET invite_link_enabled=false WHERE id=$1', [group])
    if (state === 'invite_only') await db.query("UPDATE chat.chats SET join_mode='invite_only' WHERE id=$1", [group])
    await actor(visitor)
    expect(await info()).toMatchObject({ group: { availability: state } })
    expect(await join()).toMatchObject({ status: 'unavailable' })
  })
  it('cannot enable the release gate as an authenticated client or publish unverified assistants', async () => {
    await publish()
    await rejects("SELECT identity.set_support_help_release_gate($1,true,'fake','test','test')", [owner])
    const agent = randomUUID()
    const device = `support-help-${agent}`
    await db.query('RESET ROLE')
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Test device','isolated','linux')", [device, owner])
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Test agent',$2,$3)", [agent, owner, device])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [group, agent])
    await actor(owner)
    await rejects("SELECT identity.publish_support_help_configuration(1,$1,$2,ARRAY[$3],'test','unverified')", [group, owner, agent])
  })
  it('rolls configuration back if atomic audit writing fails', async () => {
    await db.query("CREATE FUNCTION pg_temp.reject_help_audit() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''test audit failure''; END;'")
    await db.query('CREATE TRIGGER test_reject_help_audit BEFORE INSERT ON support_help.audit FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_help_audit()')
    await actor(owner)
    await rejects("SELECT identity.publish_support_help_configuration(0,$1,$2,'{}','test','rollback')", [group, owner])
    await db.query('RESET ROLE')
    expect((await db.query<{ version: string }>('SELECT version FROM support_help.configuration')).rows[0]!.version).toBe('0')
  })
  it('grants only the intended RPCs and keeps helpers security-definer with an empty search path', async () => {
    await db.query('RESET ROLE')
    const { rows } = await db.query<{ signature: string; prosecdef: boolean; proconfig: string[] }>(
      "SELECT p.oid::regprocedure::text signature,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='support_help' OR (n.nspname='identity' AND p.proname IN ('official_help_info','official_help_join','publish_support_help_configuration','set_support_help_release_gate'))")
    for (const row of rows) { expect(row.prosecdef).toBe(true); expect(row.proconfig).toContain('search_path=""') }
    expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('anon','identity.official_help_info()','EXECUTE') allowed")).rows[0]!.allowed).toBe(true)
    expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('anon','identity.official_help_join(bigint,text)','EXECUTE') allowed")).rows[0]!.allowed).toBe(false)
    expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('authenticated','identity.set_support_help_release_gate(text,boolean,text,text,text)','EXECUTE') allowed")).rows[0]!.allowed).toBe(false)
  })
})
