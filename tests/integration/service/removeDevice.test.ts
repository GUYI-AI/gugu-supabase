import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
let owner: string, peer: string, device: string, otherDevice: string
const switchName = 'identity.device_removal_device_id'
async function admin() { await db.query('RESET ROLE') }
async function asOwner() {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
}
async function remove(cascade = false) {
  await asOwner()
  await db.query('SELECT identity.remove_device($1,$2)', [device, cascade])
  await admin()
}
async function rejected(action: () => Promise<unknown>) {
  await db.query('SAVEPOINT refusal')
  try { await action() } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT refusal'); await admin()
    return error as Error & { code: string }
  }
  throw new Error('Expected device removal refusal')
}
async function agent(archived = false, account = owner) {
  const id = randomUUID()
  const row = (await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,mycel_id)
    VALUES($1,'agent','Device removal agent',$2,$3,nextval('identity.mycel_id_seq'))
    RETURNING mycel_id,gugu_number`, [id, account, device])).rows[0]
  expect(row.gugu_number).toBeTypeOf('number')
  expect(row.gugu_number).toBe(row.mycel_id)
  if (archived) {
    await asOwner()
    if (account !== owner) await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: account, role: 'authenticated' })])
    await db.query('SELECT identity.remove_owned_agent($1)', [id]); await admin()
  }
  return id
}
async function identities(ids: string[]) {
  return (await db.query('SELECT id,device_id,removed_at,mycel_id,gugu_number FROM identity.users WHERE id=ANY($1) ORDER BY id', [ids])).rows
}
async function setting(value: string) { await db.query('SELECT set_config($1,$2,true)', [switchName, value]) }

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Device removal requires the disposable loopback database')
  }
  db = new Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, peer, device, otherDevice] = Array.from({ length: 4 }, randomUUID)
  for (const id of [owner, peer]) await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,now(),now())`, [id, `${id}@remove-device.invalid`])
  for (const id of [device, otherDevice]) await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'Device removal fixture','fixture','linux')`, [id, owner])
  await db.query(`INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at)
    VALUES($1,$2,'fixture','Fixture','/fixture',now())`, [device, owner])
})
afterEach(async () => { if (db) { await admin(); await db.query('ROLLBACK') } })

describe('remove_device with retained archived identities', () => {
  it.each([
    ['C0', 0, 0, false],
    ['C2', 1, 0, true],
    ['C3', 0, 1, false],
    ['C4', 0, 1, true],
    ['C5', 2, 1, true],
  ] as const)('%s removes the device and preserves archived identities', async (_cell, live, archived, cascade) => {
    const ids: string[] = []
    for (let i = 0; i < live; i++) ids.push(await agent())
    for (let i = 0; i < archived; i++) ids.push(await agent(true))
    const before = await identities(ids)
    await remove(cascade)
    expect((await db.query('SELECT device_id FROM identity.gugu_devices WHERE device_id=$1', [device])).rows).toEqual([])
    expect((await db.query('SELECT device_id FROM identity.device_projects WHERE device_id=$1', [device])).rows).toEqual([])
    const rows = await identities(ids)
    expect(rows).toHaveLength(ids.length)
    for (const row of rows) {
      expect(row.device_id).toBeNull()
      expect(row.removed_at).not.toBeNull()
      const prior = before.find(item => item.id === row.id)!
      if (prior.removed_at) expect(row.removed_at).toEqual(prior.removed_at)
      expect(row.gugu_number).toBe(prior.gugu_number)
      expect(row.mycel_id).toBe(prior.mycel_id)
    }
    expect((await db.query('SELECT id FROM identity.active_users WHERE id=ANY($1)', [ids])).rows).toEqual([])
    expect((await db.query('SELECT current_setting($1,true) AS value', [switchName])).rows[0].value).toBe('')
  })

  it('C1 preserves the DEVICE_HAS_AGENTS error and live identities without cascade', async () => {
    const id = await agent(), before = await identities([id])
    const error = await rejected(() => remove())
    expect(error.message).toBe('DEVICE_HAS_AGENTS: 1 agent(s) bound to this device')
    expect(await identities([id])).toEqual(before)
    expect((await db.query('SELECT device_id FROM identity.gugu_devices WHERE device_id=$1', [device])).rows).toHaveLength(1)
  })

  it.each([false, true])('a live agent cannot move or detach, even with the removal switch=%s', async enabled => {
    const id = await agent()
    if (enabled) await setting(device)
    for (const next of [otherDevice, null]) {
      const error = await rejected(() => db.query('UPDATE identity.users SET device_id=$1 WHERE id=$2', [next, id]))
      expect(error.message).toContain('device_id is immutable once set')
    }
    expect((await identities([id]))[0].device_id).toBe(device)
  })

  it.each([false, true])('an archived agent cannot change another column, switch=%s', async enabled => {
    const id = await agent(true)
    if (enabled) await setting(device)
    for (const detach of [false, true]) {
      const error = await rejected(() => db.query(`UPDATE identity.users SET display_name='Changed',
        device_id=CASE WHEN $1 THEN NULL ELSE device_id END WHERE id=$2`, [detach, id]))
      expect(error.message).toMatch(/identity_removed|device_id is immutable/)
    }
    expect((await db.query('SELECT display_name FROM identity.users WHERE id=$1', [id])).rows[0].display_name).toBe('Device removal agent')
  })

  it('a switch naming a different device does not allow detachment', async () => {
    const id = await agent(true)
    await setting(otherDevice)
    expect((await rejected(() => db.query('UPDATE identity.users SET device_id=NULL WHERE id=$1', [id]))).message).toContain('device_id is immutable')
  })

  it('P1 detaches a numbered archived identity without changing any other column', async () => {
    const id = await agent(true)
    const before = (await identities([id]))[0]
    expect(before.gugu_number).toBeTypeOf('number')
    await setting(device)
    await db.query('UPDATE identity.users SET device_id=NULL WHERE id=$1', [id])
    expect((await identities([id]))[0]).toEqual({ ...before, device_id: null })
  })

  it('discovers generated columns dynamically while still protecting mycel_id', async () => {
    await db.query(`ALTER TABLE identity.users ADD COLUMN remove_device_generated_fixture bigint
      GENERATED ALWAYS AS (mycel_id::bigint + 1) STORED`)
    const id = await agent(true)
    const before = (await identities([id]))[0]
    await setting(device)
    const error = await rejected(() => db.query('UPDATE identity.users SET device_id=NULL,mycel_id=mycel_id+1000000 WHERE id=$1', [id]))
    expect(error.code).toBe('55000')
    expect((await identities([id]))[0]).toEqual(before)
    await db.query('UPDATE identity.users SET device_id=NULL WHERE id=$1', [id])
    expect((await identities([id]))[0]).toEqual({ ...before, device_id: null })
    expect((await db.query('SELECT remove_device_generated_fixture FROM identity.users WHERE id=$1', [id])).rows[0].remove_device_generated_fixture)
      .toBe(String(before.mycel_id + 1))
  })

  it('the CHECK still rejects a live agent with no device', async () => {
    const error = await rejected(() => db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id)
      VALUES($1,'agent','No device',$2)`, [randomUUID(), owner]))
    expect(error.code).toBe('23514')
    expect(error.message).toContain('users_agent_device_required')
  })

  it('residual references fail by name and roll back every newly archived identity', async () => {
    const own = await agent(), foreign = await agent(false, peer)
    const before = await identities([own, foreign])
    const error = await rejected(() => remove(true))
    expect(error.code).toBe('P0001')
    expect(error.message).toBe('DEVICE_HAS_REFERENCES: device still referenced by users')
    expect(await identities([own, foreign])).toEqual(before)
    expect((await db.query('SELECT device_id FROM identity.device_projects WHERE device_id=$1', [device])).rows).toHaveLength(1)
  })

  it('a failure after archive and detach rolls back the entire call', async () => {
    const id = await agent(), before = await identities([id])
    await db.query(`CREATE FUNCTION pg_temp.fail_device_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected device delete failure'; END $$`)
    await db.query('CREATE TRIGGER remove_device_failure BEFORE DELETE ON identity.gugu_devices FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_device_delete()')
    expect((await rejected(() => remove(true))).message).toBe('injected device delete failure')
    expect(await identities([id])).toEqual(before)
    expect((await db.query('SELECT device_id FROM identity.device_projects WHERE device_id=$1', [device])).rows).toHaveLength(1)
    expect((await db.query("SELECT payload FROM realtime.messages WHERE event='identity_removed' AND payload->>'id'=$1", [id])).rows).toEqual([])
  })

  it('C6 retires panel and coordinator state without restoring the archived identity', async () => {
    const id = await agent(), operation = randomUUID(), work = randomUUID()
    await db.query(`INSERT INTO identity.assistant_panel_items(assistant_user_id,owner_user_id,domain,resource_key,device_id)
      VALUES($1,$2,'control','__head__',$3),($1,$2,'tasks','task',$3)`, [id, owner, device])
    await db.query(`INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,domain,resource_key,
      device_id,source,operation,expected_item_revision,request_hash,payload,status)
      VALUES($1,$2,$3,'tasks','task',$4,'panel','save',0,'fixture',jsonb_build_object('deviceId',$4::text),'pending')`, [operation, id, owner, device])
    await db.query(`INSERT INTO identity.assistant_work(owner_user_id,work_id,assistant_user_id,title,coordinator_session_id,
      coordinator_device_id,executors,initial_task) VALUES($1,$2,$3,'Fixture','session',$4,'[]','{}')`, [owner, work, id, device])
    await remove(true)
    expect((await db.query('SELECT device_id,payload FROM identity.assistant_panel_changes WHERE operation_id=$1', [operation])).rows)
      .toEqual([{ device_id: null, payload: { deviceId: null } }])
    expect((await db.query('SELECT current_coordinator_session_id,current_coordinator_device_id FROM identity.assistant_work WHERE work_id=$1', [work])).rows)
      .toEqual([{ current_coordinator_session_id: null, current_coordinator_device_id: null }])
    expect((await identities([id]))[0]).toMatchObject({ device_id: null, removed_at: expect.any(Date) })
    expect((await db.query('SELECT identity.user_is_live($1) AS live', [id])).rows[0].live).toBe(false)
    // Both unconditional user UPDATE broadcasters ran; neither may re-list it.
    await asOwner()
    expect((await db.query('SELECT id FROM identity.active_users WHERE id=$1', [id])).rows).toEqual([])
    await admin()
  })

  it('keeps effective owners, definer/search_path settings, ACLs and the restrictive FK', async () => {
    const rows = (await db.query(`SELECT p.proname,p.prosecdef,p.proconfig,
      p.proowner=(SELECT proowner FROM pg_proc WHERE oid='identity.archive_user(text,boolean)'::regprocedure) AS same_owner,
      ARRAY(SELECT CASE WHEN a.grantee=p.proowner THEN 'owner' ELSE pg_get_userbyid(a.grantee) END
        FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE privilege_type='EXECUTE' ORDER BY 1) AS executors
      FROM pg_proc p WHERE p.oid IN ('identity.remove_device(text,boolean)'::regprocedure,
        'identity.guard_removed_identity()'::regprocedure,'identity.users_block_device_id_change()'::regprocedure,
        'identity.assistant_panel_home_changed()'::regprocedure) ORDER BY p.proname`)).rows
    expect(rows).toEqual([
      { proname: 'assistant_panel_home_changed', prosecdef: true, proconfig: ['search_path=pg_catalog'], same_owner: true, executors: ['owner'] },
      { proname: 'guard_removed_identity', prosecdef: false, proconfig: ['search_path=""'], same_owner: true, executors: ['owner'] },
      { proname: 'remove_device', prosecdef: true, proconfig: ['search_path=identity, chat, public, pg_catalog'], same_owner: true, executors: ['authenticated', 'owner'] },
      { proname: 'users_block_device_id_change', prosecdef: false, proconfig: null, same_owner: true, executors: ['owner'] },
    ])
    expect((await db.query("SELECT confdeltype FROM pg_constraint WHERE conrelid='identity.users'::regclass AND conname='users_device_fk'")).rows[0].confdeltype).toBe('r')
    expect((await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='identity.users'::regclass AND NOT tgisinternal
      AND tgname IN ('assistant_panel_home_changed','assistant_work_coordinator_left') ORDER BY tgname`)).rows.map(row => row.tgname))
      .toEqual(['assistant_panel_home_changed', 'assistant_work_coordinator_left'])
  })
})
