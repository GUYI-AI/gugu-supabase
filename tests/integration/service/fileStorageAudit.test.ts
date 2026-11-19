import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let db: pg.Client, owner: string, member: string, outsider: string, group: string
const value = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0].v
const admin = () => db.query('RESET ROLE')
async function user(id = owner) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function rejected(sql: string, args: unknown[] = []) {
  await db.query('SAVEPOINT refused')
  try { await db.query(sql, args) } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT refused'); return error as pg.DatabaseError
  }
  throw Error('Expected refusal')
}
async function upload(as = owner) {
  await user(as)
  const permit = await value('SELECT chat.file_managed_upload_as($1,$2,$3,60) AS v', [randomUUID(), group, as])
  await admin()
  const blob = (await db.query('SELECT * FROM chat.file_blob_register($1,$2,$3,60,$4)', [as, permit.staging_key, randomBytes(32).toString('hex'), 'application/pdf'])).rows[0].blob_id
  await db.query('SELECT chat.file_managed_upload_registered($1,$2)', [permit.staging_key, as])
  await user(as)
  const message = randomUUID()
  const item = (await db.query('SELECT * FROM chat.attachment_commit($1,$2,$3,$4,$5)', [permit.staging_key, message, group, as, 'fixture.pdf'])).rows[0].file_item_id
  await admin()
  const storage = await value('SELECT id AS v FROM chat.file_transfer_storage WHERE blob_id=$1', [blob])
  return { blob, item, message, storage }
}
async function mark(refs: unknown[], action: string, as = owner, actor: string | null = null) {
  await user(as)
  const n = await value('SELECT chat.file_storage_mark_as($1,$2,$3) AS v', [JSON.stringify(refs), action, actor])
  await admin(); return n
}
const events = async () => (await db.query('SELECT * FROM file_private.storage_action_audit WHERE actor_user_id=$1 ORDER BY occurred_at,id', [owner])).rows
const changes = async () => (await db.query('SELECT i.* FROM file_private.storage_action_audit_items i JOIN file_private.storage_action_audit a ON a.id=i.operation_id WHERE a.actor_user_id=$1 ORDER BY i.operation_id,i.change_no', [owner])).rows
const expiry = (storage: string) => value('SELECT expires_at AS v FROM chat.file_transfer_storage_refs WHERE storage_id=$1 AND chat_id=$2', [storage, group])
beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw Error('Audit tests require an owned loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); member = randomUUID(); outsider = randomUUID(); group = randomUUID()
  for (const id of [owner, member, outsider]) await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}',now(),now())", [id, id + '@file-audit.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','audit fixture',$2)", [group, owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [group, owner, member])
  const baseline = Number(await value("SELECT chat.file_transfer_usage('upload','global','*') AS v"))
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings", [{
    inventory_ready: true, storage_global_bytes: baseline + 1000000, storage_account_bytes: 1000000, storage_group_bytes: 1000000,
    download_global_bytes: 1000000, download_account_bytes: 1000000, download_group_bytes: 1000000,
    upload_permit_seconds: 120, upload_edge_seconds:400, upload_sign_seconds:900, upload_inflight_seconds:600, sign_window_seconds: 60, sign_account_count: 1000, sign_group_count: 1000,
    file_max_bytes: 10000, temporary_group_bytes: 1000000,
  }])
})
afterEach(async () => { await db.query('ROLLBACK') })

describe('committed file retention action audit', () => {
  it('records actor, exact message/item/version/copy and before/after deadlines', async () => {
    const file = await upload()
    expect(await mark([{ message_id: file.message }], 'temporary')).toBe(1)
    const [event] = await events(), [change] = await changes()
    expect(event).toMatchObject({ actor_user_id: owner, effective_actor_id: owner, action: 'temporary', entrypoint: 'file_storage_mark_as', changed_copy_count: 1, requested_message_ids: [file.message], backend_pid: null, transaction_id: null })
    expect(change).toMatchObject({ operation_id: event.id, storage_id: file.storage, blob_id: file.blob, chat_id: group, before_expires_at: null, item_ids: [file.item], versions: [1] })
    expect(change.after_expires_at).toEqual(await expiry(file.storage))
    expect(change.after_expires_at.getTime()).toBeGreaterThan(Date.now())
    expect(event.occurred_at).toBeInstanceOf(Date)
    expect(await value("SELECT NULLIF(current_setting('gugu.storage_audit_operation',true),'') AS v")).toBeNull()
  })
  it('records zero matches and each retry, including equal-value updates', async () => {
    expect(await mark([{ class: 'kept', chat_id: group }], 'permanent')).toBe(0)
    const file = await upload()
    expect(await mark([{ item_id: file.item }], 'permanent')).toBe(1)
    expect(await mark([{ item_id: file.item }], 'permanent')).toBe(1)
    expect((await events()).map(row => row.changed_copy_count)).toEqual([0, 1, 1])
    expect(await changes()).toHaveLength(2)
  })
  it('expands a class to the precise owned set and preserves overlapping updates', async () => {
    const first = await upload(), second = await upload(), theirs = await upload(member)
    expect(await mark([{ class: 'kept', chat_id: group }], 'temporary')).toBe(2)
    const rows = await changes()
    expect(rows.map(row => row.storage_id).sort()).toEqual([first.storage, second.storage].sort())
    expect(rows.flatMap(row => row.item_ids).sort()).toEqual([first.item, second.item].sort())
    expect(await expiry(theirs.storage)).toBeNull()
    expect(await mark([{ item_id: first.item }, { item_id: first.item }], 'temporary')).toBe(2)
    const last = (await events()).at(-1)!
    expect(last).toMatchObject({ changed_copy_count: 2, requested_item_ids: [first.item] })
    const repeated = (await changes()).filter(row => row.operation_id === last.id)
    expect(repeated.map(row => Number(row.change_no))).toEqual([1, 2])
    for (const row of repeated) expect(row.after_expires_at).toEqual(row.before_expires_at)
    expect(await changes()).toHaveLength(4)
  })
  it('records a delegated actor from authorization, rather than trusting a caller-supplied identity', async () => {
    const file = await upload(), device = randomUUID(), agent = randomUUID()
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", [device, owner])
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','fixture',$2,$3)", [agent, owner, device])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member')", [group, agent])
    expect(await mark([{ item_id: file.item }], 'temporary', owner, agent)).toBe(1)
    expect((await events())[0]).toMatchObject({ actor_user_id: owner, effective_actor_id: agent })
    await user(member)
    expect((await rejected('SELECT chat.file_storage_mark_as($1,$2,$3)', [JSON.stringify([{ item_id: file.item }]), 'permanent', agent])).message).toMatch(/Not allowed to act/)
    await admin(); expect(await events()).toHaveLength(1)
  })
  it('rolls back all changes and audit rows when a later reference is rejected', async () => {
    const mine = await upload(), theirs = await upload(member)
    await user()
    expect((await rejected('SELECT chat.file_storage_mark_as($1,$2)', [JSON.stringify([{ item_id: mine.item }, { item_id: theirs.item }]), 'temporary'])).hint).toBe('file_transfer_denied')
    await admin()
    expect(await expiry(mine.storage)).toBeNull(); expect(await events()).toHaveLength(0); expect(await changes()).toHaveLength(0)
    await user(outsider)
    expect((await rejected('SELECT chat.file_storage_mark_as($1,$2)', [JSON.stringify([{ message_id: mine.message }]), 'release'])).hint).toBe('file_transfer_denied')
    await admin(); expect(await events()).toHaveLength(0)
  })
  it('fails the action when the audit cannot be written', async () => {
    const file = await upload()
    await db.query('ALTER TABLE file_private.storage_action_audit ADD CONSTRAINT fixture_audit_failure CHECK(false) NOT VALID')
    await user()
    expect((await rejected('SELECT chat.file_storage_mark_as($1,$2)', [JSON.stringify([{ item_id: file.item }]), 'temporary'])).code).toBe('23514')
    await admin(); expect(await expiry(file.storage)).toBeNull(); expect(await events()).toHaveLength(0)
  })
  it('keeps unrelated expiry-consumer work out of the human action record', async () => {
    const mine = await upload(), overdue = await upload()
    await db.query("UPDATE chat.file_transfer_storage_refs SET expires_at=now()-interval '1 day' WHERE storage_id=$1", [overdue.storage])
    expect(await events()).toHaveLength(0)
    expect(await mark([{ item_id: mine.item }], 'release')).toBe(1)
    expect((await changes()).map(row => row.storage_id)).toEqual([mine.storage])
    expect((await changes())[0].after_expired_at).not.toBeNull()
    expect(await value('SELECT expired_at AS v FROM chat.file_transfer_storage_refs WHERE storage_id=$1', [overdue.storage])).not.toBeNull()
  })
  it('keeps audit evidence after file/chat deletion and has no source-identity cascade', async () => {
    const file = await upload(); await mark([{ item_id: file.item }], 'temporary')
    await db.query('DELETE FROM chat.chats WHERE id=$1', [group])
    expect(await events()).toHaveLength(1); expect(await changes()).toHaveLength(1)
    expect((await changes())[0]).toMatchObject({ item_ids: [file.item], storage_id: file.storage })
  })
  it('prunes only records strictly older than 180 UTC days, independent of caller timezone', async () => {
    const file = await upload()
    for (let i = 0; i < 3; i++) await mark([{ item_id: file.item }], 'permanent')
    const rows = await events()
    await db.query("UPDATE file_private.storage_action_audit SET occurred_at=now()-interval '181 days' WHERE id=$1", [rows[0].id])
    await db.query("UPDATE file_private.storage_action_audit SET occurred_at=now()-interval '15552000 seconds' WHERE id=$1", [rows[1].id])
    await db.query("UPDATE file_private.storage_action_audit SET occurred_at=now()-interval '15552000 seconds'+interval '1 second' WHERE id=$1", [rows[2].id])
    await db.query("SET LOCAL TimeZone='America/New_York'")
    expect(await value('SELECT file_private.prune_storage_action_audit(1) AS v')).toBe(1)
    expect(await value('SELECT file_private.prune_storage_action_audit(1) AS v')).toBe(0)
    expect((await events()).map(row => row.id).sort()).toEqual([rows[1].id, rows[2].id].sort())
    expect(await changes()).toHaveLength(2)
    expect((await rejected('SELECT file_private.prune_storage_action_audit(1001)')).message).toMatch(/Invalid audit cleanup limit/)
  })
  it('closes audit tables, implementation and prune functions to all API roles', async () => {
    for (const role of ['anon','authenticated','service_role']) {
      for (const table of ['storage_action_audit','storage_action_audit_items']) {
        for (const privilege of ['SELECT','INSERT','UPDATE','DELETE']) expect(await value('SELECT has_table_privilege($1,$2,$3) AS v', [role, 'file_private.' + table, privilege])).toBe(false)
      }
      for (const fn of ['storage_mark_audit_base(jsonb,text,text)','collect_storage_action_audit()','prune_storage_action_audit(integer)','erase_storage_action_audit(text[])']) {
        expect(await value("SELECT has_function_privilege($1,$2,'EXECUTE') AS v", [role, 'file_private.' + fn])).toBe(false)
      }
    }
    expect(await value("SELECT has_function_privilege('authenticated','chat.file_storage_mark_as(jsonb,text,text)','EXECUTE') AS v")).toBe(true)
    await user()
    expect((await rejected('SELECT file_private.storage_mark_audit_base($1,$2)', [JSON.stringify([{ class: 'kept' }]), 'release'])).code).toBe('42501')
  })
  it('bounds detail cleanup even when one old class action has multiple targets', async () => {
    await upload(); await upload()
    await mark([{ class: 'kept', chat_id: group }], 'permanent')
    const [event] = await events()
    await db.query("UPDATE file_private.storage_action_audit SET occurred_at=now()-interval '181 days' WHERE id=$1", [event.id])
    expect(await value('SELECT file_private.prune_storage_action_audit(1) AS v')).toBe(0)
    expect(await changes()).toHaveLength(1); expect(await events()).toHaveLength(1)
    expect(await value('SELECT file_private.prune_storage_action_audit(1) AS v')).toBe(1)
    expect(await changes()).toHaveLength(0); expect(await events()).toHaveLength(0)
  })
  it('requires the exact private lifecycle context and refuses a caller-set erasure flag', async () => {
    await db.query("SELECT set_config('gugu.privacy_erasure','1',true)")
    expect((await rejected('SELECT file_private.erase_storage_action_audit($1)', [[owner]])).code).toBe('42501')
    await db.query("INSERT INTO identity.account_lifecycle_context(transaction_id,operation,subject_user_id,delete_user_ids) VALUES(pg_current_xact_id(),'privacy_erasure',$1,$2)", [owner, [owner]])
    expect((await rejected('SELECT file_private.erase_storage_action_audit($1)', [[member]])).code).toBe('42501')
    await user()
    expect((await rejected('SELECT file_private.erase_storage_action_audit($1)', [[owner]])).code).toBe('42501')
  })
  it('irreversibly replaces actors and clears embedded typed identity references without losing action evidence', async () => {
    const mine = await upload(); await mark([{ item_id: mine.item }], 'permanent')
    const [first] = await events()
    const theirs = await upload(member); await mark([{ item_id: theirs.item }], 'permanent', member)
    const second = (await db.query('SELECT * FROM file_private.storage_action_audit WHERE actor_user_id=$1', [member])).rows[0]
    const agent = randomUUID(), ids = [owner, agent, 'agent_%']
    await db.query('UPDATE file_private.storage_action_audit SET effective_actor_id=$2 WHERE id=$1', [first.id, agent])
    await db.query('UPDATE file_private.storage_action_audit SET requested_item_ids=$2,requested_message_ids=$3 WHERE id=$1',
      [second.id, [owner, theirs.item], ['message:' + agent, 'literal-agent_%', 'literal-agent-XY', theirs.message]])
    await db.query('UPDATE file_private.storage_action_audit_items SET storage_id=$2,blob_id=$3,chat_id=$4,item_ids=$5,versions=$6 WHERE operation_id=$1',
      [second.id, owner, agent, 'room:' + owner, [agent, theirs.item], [7, 1]])
    await db.query("INSERT INTO identity.account_lifecycle_context(transaction_id,operation,subject_user_id,delete_user_ids) VALUES(pg_current_xact_id(),'privacy_erasure',$1,$2)", [owner, ids])
    await db.query('SELECT file_private.erase_storage_action_audit($1)', [ids])
    const read = async () => ({
      events: (await db.query('SELECT * FROM file_private.storage_action_audit WHERE id=ANY($1) ORDER BY id', [[first.id, second.id]])).rows,
      items: (await db.query('SELECT * FROM file_private.storage_action_audit_items WHERE operation_id=ANY($1) ORDER BY operation_id,change_no', [[first.id, second.id]])).rows,
    })
    const after = await read(), a = after.events.find(row => row.id === first.id)!, b = after.events.find(row => row.id === second.id)!
    expect(a.actor_user_id).toMatch(/^erased:[0-9a-f-]{36}$/); expect(a.effective_actor_id).toBe(a.actor_user_id)
    expect(a).toMatchObject({ action: first.action, occurred_at: first.occurred_at, changed_copy_count: first.changed_copy_count })
    expect(b).toMatchObject({ actor_user_id: member, effective_actor_id: member, requested_item_ids: [theirs.item], requested_message_ids: ['literal-agent-XY', theirs.message] })
    expect(after.items.find(row => row.operation_id === second.id)).toMatchObject({ storage_id: null, blob_id: null, chat_id: null, item_ids: [theirs.item], versions: [1] })
    expect(after.events).toHaveLength(2); expect(after.items).toHaveLength(2)
    expect(JSON.stringify(after).toLowerCase()).not.toContain(owner.toLowerCase())
    expect(JSON.stringify(after).toLowerCase()).not.toContain(agent.toLowerCase())
    expect(await expiry(mine.storage)).toBeNull(); expect(await expiry(theirs.storage)).toBeNull()
    expect(Number(await value('SELECT count(*) AS v FROM chat.workspace_items WHERE id=ANY($1)', [[mine.item, theirs.item]]))).toBe(2)
    await db.query('SELECT file_private.erase_storage_action_audit($1)', [ids])
    expect(await read()).toEqual(after)
  })
  it('holds the shared owner erasure fence through the caller transaction', async () => {
    await mark([{ class: 'kept', chat_id: group }], 'permanent')
    const other = new pg.Client({ connectionString: url }); await other.connect()
    try {
      await other.query('BEGIN')
      expect((await other.query("SELECT pg_try_advisory_xact_lock_shared(hashtextextended('identity:erase-human:'||$1::text,0)) AS v", [owner])).rows[0].v).toBe(true)
      expect((await other.query("SELECT pg_try_advisory_xact_lock(hashtextextended('identity:erase-human:'||$1::text,0)) AS v", [owner])).rows[0].v).toBe(false)
    } finally { await other.query('ROLLBACK'); await other.end() }
  })
  it('refuses a late JWT subject without a live identity before recording any action', async () => {
    await user(randomUUID())
    expect((await rejected('SELECT chat.file_storage_mark_as($1,$2)', [JSON.stringify([{ class: 'kept' }]), 'permanent'])).hint).toBe('file_transfer_denied')
    await admin(); expect(await events()).toHaveLength(0)
  })
  it('refuses an existing removed identity even for a zero-match action', async () => {
    await db.query('UPDATE identity.users SET removed_at=clock_timestamp() WHERE id=$1', [owner])
    await user()
    expect((await rejected('SELECT chat.file_storage_mark_as($1,$2)', [JSON.stringify([{ class: 'kept' }]), 'permanent'])).hint).toBe('file_transfer_denied')
    await admin(); expect(await events()).toHaveLength(0)
  })
  it('cannot use an older repeatable-read identity snapshot after removal commits', async () => {
    const subject = randomUUID(), remover = new pg.Client({ connectionString: url }), reader = new pg.Client({ connectionString: url })
    await remover.connect(); await reader.connect()
    try {
      await remover.query("SET statement_timeout='5s'; SET lock_timeout='2s'")
      await reader.query("SET statement_timeout='5s'; SET lock_timeout='2s'")
      await remover.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [subject, subject + '@file-audit.invalid'])
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      expect((await reader.query('SELECT id FROM identity.users WHERE id=$1', [subject])).rowCount).toBe(1)
      await remover.query('BEGIN')
      await remover.query("SELECT pg_advisory_xact_lock(hashtextextended('identity:erase-human:'||$1::text,0))", [subject])
      await remover.query('UPDATE identity.users SET removed_at=clock_timestamp() WHERE id=$1', [subject])
      await remover.query('COMMIT')
      await reader.query('SET LOCAL ROLE authenticated')
      await reader.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: subject, role: 'authenticated' })])
      await expect(reader.query('SELECT chat.file_storage_mark_as($1,$2)', [JSON.stringify([{ class: 'kept' }]), 'permanent'])).rejects.toMatchObject({ code: '40001' })
      await reader.query('ROLLBACK')
      expect((await remover.query('SELECT count(*)::int AS n FROM file_private.storage_action_audit WHERE actor_user_id=$1', [subject])).rows[0].n).toBe(0)
    } finally {
      await reader.query('ROLLBACK').catch(() => undefined)
      await remover.query('ROLLBACK').catch(() => undefined)
      // Removal is intentionally irreversible; clean this committed fixture
      // through Auth deletion rather than trying to resurrect its identity.
      await remover.query('DELETE FROM auth.users WHERE id=$1', [subject])
      await reader.end(); await remover.end()
    }
  })
})
