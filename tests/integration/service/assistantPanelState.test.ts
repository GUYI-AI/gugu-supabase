import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { awaitFact } from '../../support/awaitFact'

let db: pg.Client
let owner: string, stranger: string, agent: string, ordinary: string, device: string, otherDevice: string, instance: string, chat: string
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
type Commit = { operationId: string; revision: string; status: string }
type Snapshot = { revision: string; application: { resourceKey: string; status: string; errorCode: string | null }[]; items: { resource_key: string; revision: string; data: Record<string, unknown>; deleted_at: string | null; body_item_id: string | null }[] }

async function as<T>(user: string, action: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  await db.query('SET LOCAL ROLE authenticated')
  try { return await action() } finally { await db.query('RESET ROLE').catch(() => undefined) }
}
async function failure(action: () => Promise<unknown>, pattern: RegExp) {
  await db.query('SAVEPOINT expected_failure')
  try { await expect(action()).rejects.toThrow(pattern) } finally { await db.query('ROLLBACK TO SAVEPOINT expected_failure') }
}
async function call<T = Record<string, unknown>>(name: string, args: unknown[]): Promise<T> {
  const sql = `SELECT identity.${name}(${args.map((_,i) => `$${i+1}`).join(',')}) AS result`
  return (await db.query<{ result: T }>(sql,args)).rows[0]!.result
}
async function commit(options: {
  key?: string; domain?: string; operation?: string; revision?: string; data?: unknown;
  id?: string; runtime?: string | null; device?: string | null; body?: string | null; hash?: string | null; assistant?: string;
} = {}): Promise<Commit> {
  return as(owner, () => call<Commit>('assistant_panel_commit', [options.assistant ?? agent,options.id ?? randomUUID(),
    options.domain ?? 'personality',options.key ?? 'current',options.revision ?? '0',options.operation ?? 'save',
    JSON.stringify(options.data ?? { text: 'Be concise' }),options.body ?? null,options.hash ?? null,
    options.device ?? null,options.runtime ?? null]))
}
const snapshot = () => as(owner, () => call<Snapshot>('assistant_panel_snapshot',[agent]))
type PendingChange = { operation_id: string; status: string; payload: unknown; device_id: string }
const pending = () => as(owner, () => call<{ revision: string; changes: PendingChange[]; notices: PendingChange[] }>('assistant_panel_pending',[agent,instance]))
const ack = (id: string, error: string | null = null) => as(owner, () => call('assistant_panel_ack',[agent,instance,id,error]))
const reject = (id: string, error: string) => as(owner, () => call('assistant_panel_reject',[agent,instance,id,error]))
const admit = (revision: string) => as(owner, () => call<{ admitted: boolean; domain?: string; resourceKey?: string; errorCode?: string }>('assistant_panel_admit',[agent,instance,revision]))

beforeAll(async () => {
  if (!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw new Error('Panel tests require a disposable loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  owner = randomUUID(); stranger = randomUUID(); agent = randomUUID(); ordinary = randomUUID()
  device = `panel-${randomUUID()}`; otherDevice = `panel-${randomUUID()}`; instance = randomUUID(); chat = randomUUID()
  for (const id of [owner,stranger]) {
    await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
      confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
      VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`,[id,`${id}@panel.invalid`])
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Panel fixture') ON CONFLICT DO NOTHING",[id])
  }
  for (const [id,ownedBy] of [[device,owner],[otherDevice,stranger]]) {
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')",[id,ownedBy])
  }
  for (const id of [agent,ordinary]) await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Panel assistant',$2,$3)",[id,owner,device])
  await db.query("INSERT INTO chat.chats(id,kind,creator_user_id) VALUES($1,'dm',$2)",[chat,owner])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')",[chat,owner,agent])
  const operation = randomUUID()
  await db.query("INSERT INTO identity.agent_provision_operations(id,owner_user_id,device_id,kind,payload_hash,blueprint,phase) VALUES($1,$2,$3,'single','fixture','{}','completed')",[operation,owner,device])
  await db.query(`INSERT INTO identity.agent_provisions(id,owner_user_id,operation_id,member_key,device_id,display_name,agent_type,
    inherit_memory,history_import_required,payload_hash,agent_user_id,provisioned_agent_user_id,dm_chat_id,phase)
    VALUES($1,$2,$3,'assistant',$4,'Panel assistant','claude-code',false,false,'fixture',$5::text,$5::text::uuid,$6,'completed')`,[randomUUID(),owner,operation,device,agent,chat])
  await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[instance,device,owner])
})
afterEach(async () => { await db.query('ROLLBACK') })

async function file(room = chat) {
  const id = randomUUID(), blob = randomUUID(), hash = randomUUID().replaceAll('-','').repeat(2)
  await db.query("INSERT INTO chat.file_blobs(id,bucket_id,object_name,sha256,size_bytes,content_type,created_by) VALUES($1,'workspace',$2,$3,10,'text/plain',$4)",[blob,`${room}/${blob}`,hash,owner])
  await db.query("INSERT INTO chat.workspace_items(id,chat_id,kind,filename,blob_id,created_by) VALUES($1,$2,'file',$3,$4,$5)",[id,room,`${id}.txt`,blob,owner])
  return { id,blob,hash }
}


async function moveHome() {
  const nextDevice = `panel-${randomUUID()}`, nextInstance = randomUUID()
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'new','new','linux')",[nextDevice,owner])
  await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[nextInstance,nextDevice,owner])
  await db.query("INSERT INTO identity.agent_profiles(id,owner_id,display_name,agent_type) VALUES($1,$2,'Panel assistant','claude-code')",[agent,owner])
  const move = randomUUID(), provision = randomUUID()
  const member = { provision_id: provision,member_key: 'single',display_name: 'Panel assistant',agent_type: 'claude-code',
    project_path: '',inherit_memory: false,history_import_required: false,existing_agent_user_id: agent }
  await as(owner,async () => {
    await db.query('SELECT identity.start_agent_provision_operation($1,$2,$3::jsonb,NULL,NULL,$4,NULL,$5,$6,NULL)',
      [move,nextDevice,JSON.stringify({ kind: 'single',members: [member] }),'platform:deepseek-v4-pro','full-access','claude'])
    await db.query('SELECT identity.claim_provision_slots($1)',[move])
    await db.query('SELECT identity.prepare_agent_provision($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL)',
      [provision,move,'single',nextDevice,'Panel assistant','claude-code',''])
  })
  await db.query("UPDATE identity.gugu_device_commands SET status='done',completed_at=now() WHERE id=(SELECT create_command_id FROM identity.agent_provisions WHERE id=$1)",[provision])
  await as(owner,async () => {
    await db.query('SELECT identity.settle_agent_provision_terminal($1)',[provision])
    await db.query('SELECT identity.complete_agent_provision($1)',[provision])
  })
  return { nextDevice,nextInstance }
}

describe('durable assistant panel contract', () => {
  it('settles an unapplicable change truthfully and releases later changes and turns', async () => {
    const broken = await commit()
    await ack(broken.operationId,'EACCES')
    const body = await file()
    const later = await commit({ domain: 'memory',key: 'later',data: { relativePath: 'later.md',title: 'Later' },body: body.id,hash: body.hash })
    expect(await reject(broken.operationId,'EACCES')).toMatchObject({ status: 'failed',terminal: true })
    const work = await pending()
    expect(work.changes.map(c => c.operation_id)).toEqual([later.operationId])
    expect(work.notices).toEqual([expect.objectContaining({ operation: 'notice',payload: { failure: expect.objectContaining({ operationId: broken.operationId,errorCode: 'EACCES',domain: 'personality',resourceKey: 'current' }) } })])
    expect((await snapshot()).application).toContainEqual(expect.objectContaining({ status: 'failed',terminal: true,errorCode: 'EACCES' }))
    await ack(later.operationId)
    expect(await admit(work.revision)).toMatchObject({ admitted: true })
    // Neither a lost response nor a late success can claim the rejected effect was applied.
    expect(await reject(broken.operationId,'EACCES')).toMatchObject({ status: 'failed',terminal: true })
    expect(await ack(broken.operationId)).toMatchObject({ status: 'failed',terminal: true })
    expect((await pending()).notices).toHaveLength(1)
    await ack(work.notices[0]!.operation_id)
    expect((await pending()).notices).toHaveLength(0)
    expect(await admit(work.revision)).toMatchObject({ admitted: true })
  })

  it('allows a new owner edit after a terminal failure and never resurrects a rejected deletion', async () => {
    const broken = await commit()
    await reject(broken.operationId,'PANEL_SCHEDULE_NOT_OWNED')
    const newer = await commit({ revision: broken.revision,data: { text: 'New owner intent' } })
    expect((await pending()).changes.map(c => c.operation_id)).toEqual([newer.operationId])
    await ack(newer.operationId)
    expect(await admit(newer.revision)).toMatchObject({ admitted: true })
    const body = await file()
    const saved = await commit({ domain: 'memory',key: 'removed',data: { relativePath: 'removed.md' },body: body.id,hash: body.hash,runtime: instance })
    const removed = await commit({ domain: 'memory',key: 'removed',revision: saved.revision,operation: 'remove',data: {} })
    await reject(removed.operationId,'EACCES')
    expect(await admit(removed.revision)).toMatchObject({ admitted: true })
    await failure(() => commit({ domain: 'memory',key: 'removed',revision: removed.revision,runtime: instance,data: { relativePath: 'removed.md' } }),/deleted/)
    expect((await snapshot()).items.some(row => row.resource_key === 'removed')).toBe(false)
  })

  it('restricts terminal decisions to the leased home and keeps error details non-sensitive', async () => {
    const broken = await commit()
    await failure(() => as(stranger,() => call('assistant_panel_reject',[agent,instance,broken.operationId,'EACCES'])),/account|owner|available|instance/)
    await failure(() => reject(broken.operationId,'permission denied at /private/secret'),/non-sensitive/)
    expect((await pending()).changes).toHaveLength(1)
  })

  it('reads an unprepared account without creating state, messages or device commands', async () => {
    expect(await snapshot()).toEqual({ version: 1,revision: '0',items: [],application: [] })
    expect((await db.query('SELECT count(*)::int AS n FROM identity.assistant_panel_items WHERE assistant_user_id=$1',[agent])).rows[0]!.n).toBe(0)
    expect((await db.query('SELECT count(*)::int AS n FROM identity.gugu_device_commands WHERE user_id=$1',[owner])).rows[0]!.n).toBe(0)
    expect((await db.query('SELECT count(*)::int AS n FROM chat.messages WHERE chat_id=$1',[chat])).rows[0]!.n).toBe(0)
  })

  it('atomically saves current values and ordered deferred changes without waking a host', async () => {
    const saved = await commit()
    expect(saved.status).toBe('pending')
    expect((await snapshot()).items).toEqual([expect.objectContaining({ resource_key: 'current',revision: saved.revision,data: { text: 'Be concise' } })])
    expect((await pending()).changes).toEqual([expect.objectContaining({ operation_id: saved.operationId,status: 'pending' })])
    expect(await admit(saved.revision)).toMatchObject({ admitted: false,domain: 'personality',resourceKey: 'current' })
    await ack(saved.operationId)
    expect(await admit(saved.revision)).toEqual({ admitted: true,revision: saved.revision })
    expect((await db.query('SELECT count(*)::int AS n FROM identity.gugu_device_commands WHERE user_id=$1',[owner])).rows[0]!.n).toBe(0)
  })

  it('is idempotent but rejects reused operation IDs, stale edits and direct DML', async () => {
    const id = randomUUID(), saved = await commit({ id })
    expect(await commit({ id })).toEqual(saved)
    await failure(() => commit({ id,data: { text: 'different' } }),/different request/)
    await failure(() => commit({ data: { text: 'stale' } }),/read it again/)
    await failure(() => as(owner, () => db.query("UPDATE identity.assistant_panel_items SET data='{}' WHERE assistant_user_id=$1",[agent])),/permission denied/)
    await failure(() => as(owner, () => db.query("DELETE FROM identity.assistant_panel_changes WHERE assistant_user_id=$1",[agent])),/permission denied/)
    expect((await pending()).changes).toHaveLength(1)
  })

  it('preserves a committed value and identifies its application failure until retry succeeds', async () => {
    const first = await commit(), second = await commit({ key: 'other',data: { text: 'Second' } })
    expect(await ack(first.operationId,'FILE_WRITE_FAILED')).toMatchObject({ status: 'failed',domain: 'personality',resourceKey: 'current',errorCode: 'FILE_WRITE_FAILED' })
    expect(await admit(second.revision)).toMatchObject({ admitted: false,errorCode: 'FILE_WRITE_FAILED',resourceKey: 'current' })
    await failure(() => ack(second.operationId),/Earlier/)
    await failure(() => ack(first.operationId,'token or raw error'),/non-sensitive/)
    expect((await snapshot()).items.find(i => i.resource_key === 'current')!.data.text).toBe('Be concise')
    expect((await snapshot()).application[0]).toMatchObject({ resourceKey: 'current',status: 'failed',errorCode: 'FILE_WRITE_FAILED' })
    await ack(first.operationId); await ack(first.operationId); await ack(second.operationId)
    expect(await admit(second.revision)).toMatchObject({ admitted: true })
    await commit({ key: 'later',data: { text: 'after the read' } })
    await failure(() => admit(second.revision),/changed before admission/)
  })

  it('isolates owners, personal assistant identities, anonymous callers and resource devices', async () => {
    await commit()
    expect(await as(stranger, () => db.query('SELECT * FROM identity.assistant_panel_items WHERE assistant_user_id=$1',[agent]))).toMatchObject({ rows: [] })
    expect(await as(stranger, () => db.query('SELECT * FROM identity.assistant_panel_changes WHERE assistant_user_id=$1',[agent]))).toMatchObject({ rows: [] })
    await failure(() => as(stranger, () => call('assistant_panel_snapshot',[agent])),/not available/)
    await failure(() => commit({ assistant: ordinary }),/not available/)
    await failure(() => commit({ device: otherDevice }),/not owned/)
    const grants = (await db.query<{ allowed: boolean }>("SELECT has_function_privilege('anon','identity.assistant_panel_snapshot(text)','EXECUTE') AS allowed")).rows[0]!
    expect(grants.allowed).toBe(false)
    expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('authenticated','identity.assistant_panel_lock(text)','EXECUTE') AS allowed")).rows[0]!.allowed).toBe(false)
  })

  it('a published body is never a legacy document import candidate; the guard and the importer read one predicate', async () => {
    const candidates = async () => {
      const ids: string[] = []
      for (let after: string | null = null; ;) {
        const rows = (await db.query<{ id: string }>('SELECT id FROM chat.workspace_document_import_candidates($1,20)',[after])).rows
        ids.push(...rows.map((row) => row.id))
        if (rows.length < 20) return ids
        after = rows.at(-1)!.id
      }
    }
    const pendingBody = await file(), appliedBody = await file(), ordinaryFile = await file()
    const applied = await commit({ domain: 'memory',key: 'applied',data: { relativePath: 'applied.md' },body: appliedBody.id,hash: appliedBody.hash })
    await ack(applied.operationId)
    const saved = await commit({ domain: 'memory',key: 'pending',data: { relativePath: 'pending.md' },body: pendingBody.id,hash: pendingBody.hash })
    const offered = await candidates()
    expect(offered).toContain(ordinaryFile.id)
    expect(offered).not.toContain(pendingBody.id)
    expect(offered).not.toContain(appliedBody.id)
    // What the importer would have done to it: the guard refuses, as before.
    await failure(() => db.query('SELECT chat.workspace_import_document($1,1,$2,$3)',[appliedBody.id,appliedBody.blob,{ text: 'x',content_type: 'text/plain' }]),/immutable/)
    await ack(saved.operationId)
  })

  it('accepts only content-addressed snapshots in the exact owner-assistant DM', async () => {
    const body = await file()
    const saved = await commit({ domain: 'memory',key: 'note',data: { title: 'A note',relativePath: 'note.md' },body: body.id,hash: body.hash })
    expect((await snapshot()).items[0]!.body_item_id).toBe(body.id)
    await failure(() => commit({ domain: 'memory',key: 'mismatch',data: {},body: body.id,hash: 'ff'.repeat(32) }),/matching file hash/)
    const room = randomUUID()
    await db.query("INSERT INTO chat.chats(id,kind,creator_user_id) VALUES($1,'dm',$2)",[room,owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')",[room,owner,stranger])
    const wrong = await file(room)
    await failure(() => commit({ domain: 'memory',key: 'wrong',data: {},body: wrong.id,hash: wrong.hash }),/private folder/)
    await failure(() => commit({ domain: 'files',key: 'shared',data: {},body: body.id,hash: body.hash }),/another resource/)
    await failure(() => db.query('UPDATE chat.workspace_items SET blob_id=$2 WHERE id=$1',[body.id,wrong.blob]),/immutable/)
    await ack(saved.operationId)
  })

  it('revokes all published body revisions and leaves a tombstone that late snapshots cannot resurrect', async () => {
    const old = await file(), current = await file()
    const one = await commit({ domain: 'memory',key: 'remember',data: { title: 'Private',relativePath: 'remember.md' },body: old.id,hash: old.hash })
    await ack(one.operationId)
    const two = await commit({ domain: 'memory',key: 'remember',revision: one.revision,data: { title: 'Private',relativePath: 'remember.md' },body: current.id,hash: current.hash })
    await ack(two.operationId)
    const removed = await commit({ domain: 'memory',key: 'remember',revision: two.revision,operation: 'remove',data: {} })
    expect((await snapshot()).items).toEqual([])
    const row = (await db.query('SELECT * FROM identity.assistant_panel_items WHERE assistant_user_id=$1 AND domain=$2 AND resource_key=$3',[agent,'memory','remember'])).rows[0]!
    expect(row).toMatchObject({ data: {},body_item_id: null,revision: removed.revision })
    expect(row.deleted_at).not.toBeNull()
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=ANY($1::uuid[])',[[old.id,current.id]])).rows).toEqual([])
    expect((await pending()).changes[0]!.payload).toEqual({ before: { relativePath: 'remember.md' },deviceId: device,deleted: true })
    expect((await db.query('SELECT count(*)::int AS n FROM identity.gugu_device_commands WHERE user_id=$1',[owner])).rows[0]!.n).toBe(0)
    await ack(removed.operationId)
    await failure(() => commit({ domain: 'memory',key: 'remember',revision: two.revision,data: {},runtime: instance }),/read it again/)
    await failure(() => commit({ domain: 'memory',key: 'remember',revision: removed.revision,data: {},runtime: instance }),/deleted/)
    expect(await admit(removed.revision)).toMatchObject({ admitted: true })
  })

  it('preserves the task title provider and unread marker in cloud observations', async () => {
    await commit({ domain: 'tasks',key: 'task',runtime: instance,device,data: { sessionId: 'task',title: 'codex (1)',harness: 'codex',unseen: true } })
    expect((await snapshot()).items).toMatchObject([{ data: { harness: 'codex',unseen: true } }])
  })

  it('permits owner supplied replacement content after deletion while rejecting runtime resurrection and stale drafts', async () => {
    const original = await file(), replacement = await file()
    const saved = await commit({ domain: 'memory',key: 'recreated',data: { relativePath: 'note.md' },body: original.id,hash: original.hash })
    const removed = await commit({ domain: 'memory',key: 'recreated',revision: saved.revision,operation: 'remove',data: {} })
    await ack(removed.operationId)
    await failure(() => commit({ domain: 'memory',key: 'recreated',revision: removed.revision,data: { relativePath: 'note.md' },body: replacement.id,hash: replacement.hash,runtime: instance }),/deleted/)
    await failure(() => commit({ domain: 'memory',key: 'recreated',revision: saved.revision,data: { relativePath: 'note.md' },body: replacement.id,hash: replacement.hash }),/read it again/)
    const recreated = await commit({ domain: 'memory',key: 'recreated',revision: removed.revision,data: { relativePath: 'note.md' },body: replacement.id,hash: replacement.hash })
    expect((await pending()).changes).toMatchObject([{ operation_id: recreated.operationId,payload: { recreated: true,bodyItemId: replacement.id } }])
    await ack(recreated.operationId)
    expect(await admit(recreated.revision)).toMatchObject({ admitted: true })
    await commit({ domain: 'memory',key: 'recreated',revision: recreated.revision,operation: 'remove',data: {} })
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[replacement.id])).rows).toEqual([])
  })

  it('supersedes an unacknowledged save before deleting its body and recovers admission', async () => {
    const body = await file()
    const saved = await commit({ domain: 'memory',key: 'not-yet-applied',data: { relativePath: 'not-yet-applied.md' },body: body.id,hash: body.hash })
    const removed = await commit({ domain: 'memory',key: 'not-yet-applied',revision: saved.revision,operation: 'remove',data: {} })
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[body.id])).rows).toEqual([])
    expect((await pending()).changes.map(c => c.operation_id)).toEqual([removed.operationId])
    // A late result from the obsolete save must not resurrect a failure.
    expect(await ack(saved.operationId,'BODY_READ_FAILED')).toMatchObject({ status: 'superseded' })
    await ack(removed.operationId)
    expect(await admit(removed.revision)).toMatchObject({ admitted: true })
  })

  it('recovers from a failed schedule application when the user corrects the same resource', async () => {
    const saved = await commit({ domain: 'schedules',key: 'recover',data: { cron: 'invalid',tz: 'Invalid/Zone',prompt: 'Review' } })
    await ack(saved.operationId,'SCHEDULE_INVALID')
    const fixed = await commit({ domain: 'schedules',key: 'recover',revision: saved.revision,data: { cron: '0 8 * * *',tz: 'Asia/Shanghai',prompt: 'Review' } })
    expect((await pending()).changes.map(c => c.operation_id)).toEqual([fixed.operationId])
    expect(await ack(saved.operationId,'SCHEDULE_INVALID')).toMatchObject({ status: 'superseded' })
    await ack(fixed.operationId)
    expect(await admit(fixed.revision)).toMatchObject({ admitted: true })
  })

  it.each(['personality','schedules'])('erases deleted %s content from every historical payload', async domain => {
    const data = domain === 'personality' ? { text: 'Forgotten private agreement' } : { prompt: 'Forgotten private prompt',cron: '0 8 * * *' }
    const saved = await commit({ domain,key: 'forget-content',data })
    await ack(saved.operationId)
    const removed = await commit({ domain,key: 'forget-content',revision: saved.revision,operation: 'remove',data: {} })
    const history = await as(owner,() => db.query<{ operation_id: string; payload: unknown }>(
      'SELECT operation_id,payload FROM identity.assistant_panel_changes WHERE assistant_user_id=$1 AND domain=$2 AND resource_key=$3',[agent,domain,'forget-content']))
    expect(history.rows.find(row => row.operation_id === saved.operationId)!.payload).toEqual({})
    expect(JSON.stringify(history.rows)).not.toContain('Forgotten')
    expect((await pending()).changes[0]!.operation_id).toBe(removed.operationId)
  })

  it('rejects deletion of a published body through the private folder without silently nulling its reference', async () => {
    const body = await file()
    const saved = await commit({ domain: 'memory',key: 'protected-body',data: { relativePath: 'protected.md' },body: body.id,hash: body.hash })
    await failure(() => as(owner,() => db.query('SELECT chat.workspace_delete_as($1,$2)',[body.id,owner])),/through the panel/)
    expect((await snapshot()).items[0]).toMatchObject({ body_item_id: body.id,revision: saved.revision })
    await commit({ domain: 'memory',key: 'protected-body',revision: saved.revision,operation: 'remove',data: {} })
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[body.id])).rows).toEqual([])
  })

  it('preserves account privacy erasure and releases body guards after its panel state is gone', async () => {
    const old = await file(), current = await file()
    const first = await commit({ domain: 'memory',key: 'erase-account',data: { relativePath: 'private.md' },body: old.id,hash: old.hash })
    await commit({ domain: 'memory',key: 'erase-account',revision: first.revision,data: { relativePath: 'private.md' },body: current.id,hash: current.hash })
    await db.query('DELETE FROM auth.users WHERE id=$1',[owner])
    expect((await db.query('SELECT 1 FROM identity.assistant_panel_items WHERE assistant_user_id=$1',[agent])).rows).toEqual([])
    expect((await db.query('SELECT 1 FROM identity.assistant_panel_changes WHERE assistant_user_id=$1',[agent])).rows).toEqual([])
    await db.query('DELETE FROM chat.chats WHERE id=$1',[chat])
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=ANY($1::uuid[])',[[old.id,current.id]])).rows).toEqual([])
  })

  it.each(['../escape.md','a/../../escape','./note','a/./note','/absolute','C:\\escape','a\\..\\escape','~/escape','%2e%2e/escape','a//note','note/','note\nother'])('rejects unsafe runtime paths: %j', async path => {
    await failure(() => commit({ domain: 'memory',key: 'bad-path',data: { relativePath: path } }),/normalized relative paths/)
    expect((await snapshot()).revision).toBe('0')
  })

  it('moves assistant-owned resources and error markers to the current home without accepting the former publisher', async () => {
    const note = await commit({ domain: 'memory',key: 'moved',data: { relativePath: 'moved.md' },device,runtime: instance })
    const marker = await commit({ domain: 'memory',key: '__collection__',operation: 'prepared',device,runtime: instance,data: { state: 'ready',schemaVersion: 1,itemCount: 1 } })
    const { nextDevice,nextInstance } = await moveHome()
    await failure(() => commit({ domain: 'memory',key: 'moved',revision: note.revision,data: {},runtime: instance }),/required device/)
    await commit({ domain: 'memory',key: 'moved',revision: note.revision,data: { relativePath: 'moved.md' },device: nextDevice,runtime: nextInstance })
    await commit({ domain: 'memory',key: '__collection__',revision: marker.revision,operation: 'error',device: nextDevice,runtime: nextInstance,data: { state: 'error',schemaVersion: 1,errorCode: 'READ_FAILED' } })
    expect((await snapshot()).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource_key: 'moved',device_id: nextDevice }),
      expect.objectContaining({ resource_key: '__collection__',device_id: nextDevice,data: { state: 'error',schemaVersion: 1,errorCode: 'READ_FAILED' } }),
    ]))
  })

  it('refuses unsupported panel edits of non-home device resources while keeping their published metadata readable', async () => {
    const nextDevice = `panel-${randomUUID()}`, nextInstance = randomUUID()
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'other','other','linux')",[nextDevice,owner])
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[nextInstance,nextDevice,owner])
    const published = await commit({ domain: 'integrations',key: 'other-account',device: nextDevice,runtime: nextInstance,data: { configured: true } })
    await failure(() => commit({ domain: 'integrations',key: 'other-account',revision: published.revision,operation: 'disable',data: {} }),/non-home device/)
    expect((await snapshot()).items[0]!.data.configured).toBe(true)
    expect((await pending()).changes).toEqual([])
  })

  it('rejects an individually oversized write before changing state', async () => {
    await failure(() => commit({ data: { text: 'x'.repeat(262144) } }),/256 KiB/)
    expect((await snapshot()).revision).toBe('0')
    expect((await pending()).changes).toEqual([])
  })

  it.each(['snapshot','pending'])('rejects aggregate %s overflow while the preceding complete representation remains readable', async representation => {
    const initial = await commit()
    await ack(initial.operationId)
    if (representation === 'snapshot') {
      await db.query(`INSERT INTO identity.assistant_panel_items(assistant_user_id,owner_user_id,domain,resource_key,data)
        SELECT $1,$2,'personality','fill-' || n,jsonb_build_object('text',repeat('x',255000)) FROM generate_series(1,65) n`,[agent,owner])
    } else {
      await db.query(`INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,domain,resource_key,
        source,operation,expected_item_revision,request_hash,payload,status)
        SELECT gen_random_uuid(),$1,$2,'personality','fill-' || n,'panel','save',0,'fixture',
          jsonb_build_object('data',jsonb_build_object('text',repeat('x',255000))),'pending' FROM generate_series(1,65) n`,[agent,owner])
    }
    await failure(() => commit({ key: 'overflow',data: { text: 'x'.repeat(255000) } }),/complete response budget/)
    expect((await snapshot()).items.some(i => i.resource_key === 'overflow')).toBe(false)
    expect((await pending()).changes.some(c => c.operation_id === initial.operationId)).toBe(false)
  })

  it('prunes terminal receipts after 30 days while retaining revocation and unapplied intent', async () => {
    const body = await file(), replacement = await file()
    const old = await commit({ domain: 'memory',key: 'old-body',data: { relativePath: 'old.md' },body: body.id,hash: body.hash })
    await ack(old.operationId)
    const current = await commit({ domain: 'memory',key: 'old-body',revision: old.revision,data: { relativePath: 'old.md' },body: replacement.id,hash: replacement.hash })
    const tombstone = await commit({ key: 'revoked',operation: 'remove',data: {} })
    await ack(current.operationId); await ack(tombstone.operationId)
    const unapplied = await commit({ key: 'must-remain' })
    await db.query("UPDATE identity.assistant_panel_changes SET created_at=now()-interval '31 days',applied_at=CASE WHEN status='applied' THEN now()-interval '31 days' END WHERE assistant_user_id=$1",[agent])
    await commit({ key: 'prune-trigger' })
    expect((await db.query('SELECT operation_id FROM identity.assistant_panel_changes WHERE operation_id=ANY($1::uuid[])',[[old.operationId,current.operationId,tombstone.operationId]])).rows).toEqual([])
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[body.id])).rows).toEqual([])
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[replacement.id])).rows).toHaveLength(1)
    expect((await pending()).changes.map(c => c.operation_id)).toContain(unapplied.operationId)
    await failure(() => commit({ key: 'revoked',revision: tombstone.revision }),/deleted/)
  })

  it('durably records allowlisted App notices without changing desired resources, sending messages or waking a host', async () => {
    const change = { operationId: randomUUID(),resource: 'projects',operation: 'edited',id: 'project-a',deviceId: device,after: { name: 'New name',path: '/work/project' } }
    const notice = () => as(owner,() => call<Commit>('assistant_panel_notice',[agent,JSON.stringify(change)]))
    const saved = await notice()
    expect(await notice()).toEqual(saved)
    expect((await snapshot()).items).toEqual([])
    expect((await pending()).notices[0]!.payload).toEqual({ notice: change })
    await failure(() => as(stranger,() => call('assistant_panel_notice',[agent,JSON.stringify(change)])),/not available/)
    await failure(() => as(owner,() => call('assistant_panel_notice',[agent,JSON.stringify({ ...change,after: { text: 'Resource body is forbidden' } })])),/unsupported content/)
    await failure(() => as(owner,() => call('assistant_panel_notice',[agent,JSON.stringify({ ...change,operationId: randomUUID(),deviceId: otherDevice })])),/not owned/)
    await failure(() => as(owner,() => call('assistant_panel_notice',[agent,JSON.stringify({ ...change,after: { path: '/work/../outside' } })])),/traversal/)
    await ack(saved.operationId)
    expect(await admit((await snapshot()).revision)).toMatchObject({ admitted: true })
    expect((await db.query('SELECT count(*)::int AS n FROM identity.gugu_device_commands WHERE user_id=$1',[owner])).rows[0]!.n).toBe(0)
    expect((await db.query('SELECT count(*)::int AS n FROM chat.messages WHERE chat_id=$1',[chat])).rows[0]!.n).toBe(0)
  })

  it('keeps failed notice delivery outside mutation ordering, publication guards and admission', async () => {
    const input = { operationId: randomUUID(),resource: 'memory',operation: 'edited',id: 'same-key' }
    const notice = await as(owner,() => call<Commit>('assistant_panel_notice',[agent,JSON.stringify(input)]))
    const observed = await commit({ domain: 'memory',key: 'same-key',runtime: instance,data: { relativePath: 'note.md' } })
    const edit = await commit({ domain: 'memory',key: 'same-key',revision: observed.revision,data: { relativePath: 'note.md' } })
    await as(owner,() => call('assistant_panel_notice',[agent,JSON.stringify({ ...input,operationId: randomUUID() })]))
    expect((await pending()).changes.map(c => c.operation_id)).toEqual([edit.operationId])
    expect((await pending()).notices).toHaveLength(1)
    const newerNotice = (await pending()).notices[0]!
    expect(await ack(newerNotice.operation_id,'NOTICE_APPEND_FAILED')).toMatchObject({ status: 'pending' })
    expect((await db.query('SELECT status,error_code FROM identity.assistant_panel_changes WHERE operation_id=$1',[newerNotice.operation_id])).rows[0])
      .toEqual({ status: 'pending',error_code: null })
    await ack(edit.operationId)
    expect(await admit((await snapshot()).revision)).toMatchObject({ admitted: true })
    expect((await snapshot()).application).toEqual([])
    expect(await ack(notice.operationId)).toMatchObject({ status: 'superseded' })
    // A pending informational notice does not fence a fresh runtime publication.
    await commit({ domain: 'memory',key: 'same-key',revision: edit.revision,runtime: instance,data: { relativePath: 'note.md' } })
  })

  it('bounds offline notices, expires them and never charges them to required mutation budgets', async () => {
    const base = await commit()
    await ack(base.operationId)
    await db.query(`INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,domain,resource_key,
      source,operation,expected_item_revision,request_hash,payload,status)
      SELECT gen_random_uuid(),$1,$2,'personality','large-' || n,'panel','save',0,'fixture',
        jsonb_build_object('data',jsonb_build_object('text',repeat('x',255000))),'pending' FROM generate_series(1,65) n`,[agent,owner])
    for (let n = 0; n < 70; n++) await as(owner,() => call('assistant_panel_notice',[agent,JSON.stringify({
      operationId: randomUUID(),resource: 'projects',operation: 'edited',id: `offline-${n}`,
      after: { name: 'x'.repeat(4000),description: 'x'.repeat(4000),action: 'x'.repeat(4000) },
    })]))
    await commit({ key: 'still-writable',data: { text: 'real owner change' } })
    const together = await pending()
    expect(together.notices).toHaveLength(64)
    expect(JSON.stringify(together).length).toBeGreaterThan(16777216)
    expect(together.changes).toHaveLength(66)
    await db.query("UPDATE identity.assistant_panel_changes SET created_at=now()-interval '8 days' WHERE assistant_user_id=$1 AND operation='notice'",[agent])
    expect((await pending()).notices).toEqual([])
    expect((await pending()).changes).toHaveLength(66)
  },30_000)

  it.each(['memory','integrations'])('preserves original cleanup routing when retrying a failed %s deletion', async domain => {
    const data = domain === 'memory' ? { relativePath: 'still-needs-removal.md' } : { providerId: 'github',accountId: 'account-a',configured: true }
    const saved = await commit({ domain,key: 'retry-delete',data })
    const first = await commit({ domain,key: 'retry-delete',revision: saved.revision,operation: 'remove',data: {} })
    await ack(first.operationId,'LOCAL_DELETE_FAILED')
    const before = (await pending()).changes[0]!.payload
    const retry = await commit({ domain,key: 'retry-delete',revision: first.revision,operation: 'remove',data: {} })
    expect((await pending()).changes).toEqual([expect.objectContaining({ operation_id: retry.operationId,payload: before })])
    await ack(retry.operationId)
    expect(await admit(retry.revision)).toMatchObject({ admitted: true })
  })

  it.each(['save','remove'])('rejects %s of another device resource even when the panel explicitly supplies its home device', async operation => {
    const nextDevice = `panel-${randomUUID()}`, nextInstance = randomUUID()
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'other','other','linux')",[nextDevice,owner])
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[nextInstance,nextDevice,owner])
    const observed = await commit({ domain: 'integrations',key: 'belongs-elsewhere',device: nextDevice,runtime: nextInstance,data: { configured: true } })
    await failure(() => commit({ domain: 'integrations',key: 'belongs-elsewhere',revision: observed.revision,device,operation,
      data: operation === 'remove' ? {} : { configured: false } }),/non-home device/)
    expect((await snapshot()).items[0]).toMatchObject({ device_id: nextDevice,data: { configured: true } })
    await commit({ domain: 'integrations',key: 'belongs-elsewhere',revision: observed.revision,device: nextDevice,runtime: nextInstance,data: { configured: false } })
  })

  it('keeps 50,000 permanent revocations outside complete reads and write budgets', async () => {
    await db.query(`INSERT INTO identity.assistant_panel_items(assistant_user_id,owner_user_id,domain,resource_key,deleted_at)
      SELECT $1,$2,'memory','revoked-' || n,now() FROM generate_series(1,50000) n`,[agent,owner])
    const saved = await commit()
    expect((await snapshot()).items).toEqual([expect.objectContaining({ resource_key: 'current' })])
    await failure(() => commit({ domain: 'memory',key: 'revoked-49999',runtime: instance,data: {} }),/deleted/)
    await ack(saved.operationId)
    expect(await admit(saved.revision)).toMatchObject({ admitted: true })
  },30_000)

  it('looks up a known revoked key with its precise version without exposing the complete revocation set', async () => {
    const removed = await commit({ domain: 'memory',key: 'known-revocation',operation: 'remove',data: {} })
    const read = (key: string) => as(owner,() => call('assistant_panel_resource',[agent,'memory',key]))
    expect(await read('known-revocation')).toMatchObject({ version: 1,item: { resource_key: 'known-revocation',revision: removed.revision,deleted_at: expect.any(String) } })
    expect(await read('missing')).toEqual({ version: 1,item: null })
    expect((await snapshot()).items).toEqual([])
    await failure(() => as(stranger,() => call('assistant_panel_resource',[agent,'memory','known-revocation'])),/not available/)
    await failure(() => as(owner,() => call('assistant_panel_resource',[agent,'control','__head__'])),/Invalid panel resource/)
  })

  it('isolates each cleanup failure and never lets cleanup roll back an acknowledgement', async () => {
    const old: { receipt: Commit; body: Awaited<ReturnType<typeof file>> }[] = []
    for (const key of ['bad-permission','good','bad-payload']) {
      const body = await file(), next = await file()
      const receipt = await commit({ domain: 'memory',key,data: { relativePath: `${key}.md` },body: body.id,hash: body.hash })
      await ack(receipt.operationId)
      const replacement = await commit({ domain: 'memory',key,revision: receipt.revision,data: { relativePath: `${key}.md` },body: next.id,hash: next.hash })
      await ack(replacement.operationId)
      old.push({ receipt,body })
    }
    await db.query('UPDATE chat.workspace_items SET created_by=$2 WHERE id=$1',[old[0]!.body.id,stranger])
    await db.query("UPDATE identity.assistant_panel_changes SET payload=jsonb_set(payload,'{bodyItemId}','\"invalid-uuid\"') WHERE operation_id=$1",[old[2]!.receipt.operationId])
    const waiting = await commit({ key: 'ack-survives-cleanup' })
    await db.query("UPDATE identity.assistant_panel_changes SET created_at=now()-interval '31 days',applied_at=now()-interval '31 days' WHERE operation_id=ANY($1::uuid[])",[old.map(entry => entry.receipt.operationId)])
    expect(await ack(waiting.operationId)).toMatchObject({ status: 'applied' })
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[old[1]!.body.id])).rows).toEqual([])
    const remaining = (await db.query<{ operation_id: string }>('SELECT operation_id FROM identity.assistant_panel_changes WHERE operation_id=ANY($1::uuid[])',[old.map(entry => entry.receipt.operationId)])).rows
    expect(remaining.map(row => row.operation_id).sort()).toEqual([old[0]!.receipt.operationId,old[2]!.receipt.operationId].sort())
    expect(await admit(waiting.revision)).toMatchObject({ admitted: true })
  })

  it('rotates failed cleanup attempts so a permanently failing first batch cannot starve later receipts', async () => {
    await db.query(`INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,domain,resource_key,
      source,operation,expected_item_revision,request_hash,payload,status,created_at,applied_at)
      SELECT gen_random_uuid(),$1,$2,'memory','permanent-failure-' || n,'runtime','save',0,'fixture',
        jsonb_build_object('bodyItemId','invalid-uuid'),'applied',now()-interval '31 days',now()-interval '31 days'
      FROM generate_series(1,100) n`,[agent,owner])
    const body = await file(), receipt = randomUUID()
    await db.query(`INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,domain,resource_key,
      source,operation,expected_item_revision,request_hash,payload,status,created_at,applied_at)
      VALUES($1,$2,$3,'memory','after-failing-batch','runtime','save',0,'fixture',jsonb_build_object('bodyItemId',$4::text),
        'applied',now()-interval '31 days',now()-interval '31 days')`,[receipt,agent,owner,body.id])
    const saved = await commit()
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[body.id])).rows).toHaveLength(1)
    await ack(saved.operationId)
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[body.id])).rows).toEqual([])
    expect((await db.query('SELECT operation_id FROM identity.assistant_panel_changes WHERE operation_id=$1',[receipt])).rows).toEqual([])
  })

  it('withdraws the former home inventory on actual adoption and lets the new home publish a fresh observation', async () => {
    for (const [domain,data] of [['tasks',{ title: 'Old task' }],['capabilities',{ name: 'Old capability' }],
      ['device-notes',{ name: 'Old device note' }],['integrations',{ providerId: 'github',configured: true }]] as const) {
      await commit({ domain,key: 'old-observation',data,runtime: instance,device })
      await commit({ domain,key: `__collection__:${device}`,operation: 'prepared',runtime: instance,device,data: { state: 'ready',schemaVersion: 1,itemCount: 1 } })
    }
    const { nextDevice,nextInstance } = await moveHome()
    expect((await snapshot()).items).toEqual([])
    const stale = (await db.query('SELECT * FROM identity.assistant_panel_items WHERE assistant_user_id=$1 AND domain=$2 AND resource_key=$3',[agent,'capabilities','old-observation'])).rows[0]!
    expect(stale.stale_at).not.toBeNull()
    await commit({ domain: 'capabilities',key: 'old-observation',revision: stale.revision,runtime: nextInstance,data: { name: 'Fresh capability' } })
    expect((await snapshot()).items).toEqual([expect.objectContaining({ device_id: nextDevice,data: { name: 'Fresh capability' },stale_at: null })])
    await commit({ domain: 'tasks',key: '__collection__',operation: 'prepared',device: nextDevice,runtime: nextInstance,data: { state: 'ready',schemaVersion: 1,itemCount: 0 } })
  })

  it('moves still-unapplied owner intent to the new home instead of orphaning it', async () => {
    const saved = await commit({ domain: 'capabilities',key: 'pending-across-move',device,data: { name: 'User change' } })
    const { nextDevice,nextInstance } = await moveHome()
    const state = await as(owner,() => call<{ revision: string; changes: PendingChange[] }>('assistant_panel_pending',[agent,nextInstance]))
    expect(state.changes).toEqual([expect.objectContaining({ operation_id: saved.operationId,device_id: nextDevice,payload: expect.objectContaining({ deviceId: nextDevice }) })])
    expect((await snapshot()).items[0]).toMatchObject({ device_id: nextDevice,data: { name: 'User change' } })
    await as(owner,() => call('assistant_panel_ack',[agent,nextInstance,saved.operationId,null]))
    expect(await as(owner,() => call('assistant_panel_admit',[agent,nextInstance,state.revision]))).toMatchObject({ admitted: true })
  })

  it('allows administrator chat deletion to cascade through referenced bodies', async () => {
    const body = await file()
    await commit({ domain: 'memory',key: 'chat-deleted',data: { relativePath: 'note.md' },body: body.id,hash: body.hash })
    await db.query('DELETE FROM chat.chats WHERE id=$1',[chat])
    expect((await db.query('SELECT id FROM chat.workspace_items WHERE id=$1',[body.id])).rows).toEqual([])
  })

  it.each([
    ['capabilities',{ name: {} }],['capabilities',{ name: '../escape' }],['capabilities',{ name: 'x'.repeat(257) }],
    ['device-notes',{ group: {} }],['device-notes',{ group: '../escape' }],['device-notes',{ group: 'bad\nlabel' }],
    ['capabilities',{ name: '/etc/x' }],['capabilities',{ name: 'C:\\x' }],
    ['device-notes',{ group: '~/private' }],['device-notes',{ group: '\\absolute' }],
    ['voice-notes',{ noteId: '../escape' }],['voice-notes',{ noteId: 5 }],
    ['integrations',{ providerId: '/absolute' }],['integrations',{ providerId: 'a\\b' }],
  ])('validates identifiers and display labels for %s: %j', async (domain,data) => {
    await failure(() => commit({ domain: domain as string,data }),/bounded display labels|safe identifiers/)
    expect((await snapshot()).revision).toBe('0')
  })

  it('rolls back both current state and its queue if validation or body removal fails', async () => {
    const initial = await commit()
    await failure(() => commit({ revision: initial.revision,data: { credentials: 'never store this' } }),/unsupported fields/)
    expect((await snapshot()).revision).toBe(initial.revision)
    expect((await pending()).changes).toHaveLength(1)
    const body = await file()
    const note = await commit({ domain: 'memory',key: 'protected',data: { relativePath: 'protected.md' },body: body.id,hash: body.hash })
    // Revoke the referenced file's deletion permission, without global DDL that
    // could interfere with other integration suites using the same table.
    await db.query('UPDATE chat.workspace_items SET created_by=$2 WHERE id=$1',[body.id,stranger])
    await failure(() => commit({ domain: 'memory',key: 'protected',revision: note.revision,operation: 'remove',data: {} }),/删不了/)
    expect((await snapshot()).items.find(i => i.resource_key === 'protected')!.deleted_at).toBeNull()
    expect((await pending()).changes).toHaveLength(2)
  })

  it('keeps failed preparation distinct from an empty prepared collection and validates its complete count', async () => {
    await failure(() => commit({ domain: 'memory',key: '__collection__',operation: 'prepared',data: { state: 'ready',schemaVersion: 1,itemCount: 0 } }),/match its resource/)
    await failure(() => commit({ domain: 'memory',key: '__collection__',operation: 'prepared',runtime: instance,data: { schemaVersion: 1,itemCount: 0 } }),/invalid/)
    await failure(() => commit({ domain: 'memory',key: '__collection__',operation: 'prepared',runtime: instance,data: { state: 'ready',schemaVersion: 1,itemCount: 1 } }),/complete/)
    const failed = await commit({ domain: 'memory',key: '__collection__',operation: 'error',runtime: instance,data: { state: 'error',schemaVersion: 1,errorCode: 'READ_FAILED' } })
    expect((await snapshot()).items[0]!.data.state).toBe('error')
    await commit({ domain: 'memory',key: '__collection__',operation: 'prepared',runtime: instance,revision: failed.revision,data: { state: 'ready',schemaVersion: 1,itemCount: 0 } })
    expect((await snapshot()).items[0]!.data.state).toBe('ready')
  })

  it('tracks preparation per device without marking another device data complete', async () => {
    const nextDevice = `panel-${randomUUID()}`, nextInstance = randomUUID()
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'other','other','linux')",[nextDevice,owner])
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[nextInstance,nextDevice,owner])
    await commit({ domain: 'device-notes',key: 'first-device',device,runtime: instance,data: { name: 'First' } })
    await commit({ domain: 'device-notes',key: 'second-device',device: nextDevice,runtime: nextInstance,data: { name: 'Second' } })
    await failure(() => commit({ domain: 'device-notes',key: `__collection__:${nextDevice}`,operation: 'prepared',device,runtime: instance,data: { state: 'ready',schemaVersion: 1,itemCount: 1 } }),/identify its resource device/)
    await commit({ domain: 'device-notes',key: `__collection__:${device}`,operation: 'prepared',device,runtime: instance,data: { state: 'ready',schemaVersion: 1,itemCount: 1 } })
    expect((await snapshot()).items.filter(i => i.resource_key.startsWith('__collection__:'))).toEqual([
      expect.objectContaining({ resource_key: `__collection__:${device}`,data: { state: 'ready',schemaVersion: 1,itemCount: 1 } }),
    ])
    const secondRevision = (await snapshot()).items.find(i => i.resource_key === 'second-device')!.revision
    await failure(() => commit({ domain: 'device-notes',key: 'second-device',device,runtime: instance,data: { name: 'Wrong device' },revision: secondRevision }),/another device/)
  })

  it('blocks expired, competing and former-home publishers and never overwrites pending user intent', async () => {
    const saved = await commit()
    await failure(() => commit({ revision: saved.revision,runtime: instance }),/Apply the committed/)
    await ack(saved.operationId)
    const rival = randomUUID()
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[rival,device,owner])
    await failure(() => commit({ key: 'rival',runtime: rival }),/active lease/)
    await db.query("UPDATE identity.runtime_instances SET last_heartbeat_at=now()-interval '5 minutes' WHERE instance_id=$1",[instance])
    await failure(() => pending(),/not a current runtime/)
    await commit({ key: 'rival',runtime: rival })
    const nextDevice = `panel-${randomUUID()}`
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'new','new','linux')",[nextDevice,owner])
    const wrong = randomUUID()
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)',[wrong,nextDevice,owner])
    await failure(() => commit({ key: 'wrong-home',runtime: wrong }),/required device/)
    await db.query("UPDATE identity.agent_provisions SET phase='cancelled' WHERE agent_user_id=$1",[agent])
    await failure(() => commit({ key: 'former-home',runtime: rival }),/not available/)
  })

  it('toggles schedule intent immediately while retaining cron, prompt and time zone', async () => {
    const schedule = await commit({ domain: 'schedules',key: 'daily',data: { title: 'Daily',prompt: 'Review',cron: '0 8 * * *',tz: 'Asia/Shanghai',enabled: true },runtime: instance })
    const stopped = await commit({ domain: 'schedules',key: 'daily',revision: schedule.revision,operation: 'disable',data: {} })
    expect((await snapshot()).items[0]!.data).toMatchObject({ cron: '0 8 * * *',tz: 'Asia/Shanghai',prompt: 'Review',enabled: false })
    expect(await admit(stopped.revision)).toMatchObject({ admitted: false,domain: 'schedules',resourceKey: 'daily' })
    await ack(stopped.operationId)
    expect(await admit(stopped.revision)).toMatchObject({ admitted: true })
  })

  it.each(['edit','publish','admit'])('serializes a committed deletion against a concurrent %s without exposing a half-committed queue', async (action) => {
    const initial = await commit({ domain: 'memory',key: 'race',data: { relativePath: 'race.md' },runtime: instance })
    await db.query('COMMIT')
    const first = new pg.Client({ connectionString: url }), second = new pg.Client({ connectionString: url })
    try {
      await first.connect(); await second.connect()
      for (const client of [first,second]) {
        await client.query('BEGIN')
        await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({ sub: owner,role: 'authenticated' })])
        await client.query('SET LOCAL ROLE authenticated')
      }
      const deletion = (await first.query<{ result: Commit }>(
        "SELECT identity.assistant_panel_commit($1,$2,'memory','race',$3,'remove','{}') AS result",
        [agent,randomUUID(),initial.revision])).rows[0]!.result
      // An independent reader still sees the previous complete state until commit.
      await db.query('BEGIN')
      expect((await snapshot()).items[0]!.deleted_at).toBeNull()
      expect((await db.query('SELECT operation_id FROM identity.assistant_panel_changes WHERE operation_id=$1',[deletion.operationId])).rows).toEqual([])
      await db.query('COMMIT')
      const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      const result = (action === 'admit'
        ? second.query('SELECT identity.assistant_panel_admit($1,$2,$3)',[agent,instance,initial.revision])
        : second.query("SELECT identity.assistant_panel_commit($1,$2,'memory','race',$3,'save','{}',NULL,NULL,NULL,$4)",
          [agent,randomUUID(),initial.revision,action === 'publish' ? instance : null]))
        .then(() => ({ code: 'unexpected-success' }), (error: { code: string }) => ({ code: error.code }))
      await awaitFact('concurrent request waits on the assistant control row',async () => {
        const row = (await db.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',[pid])).rows[0]!
        return row.blocked ? true : undefined
      })
      await first.query('COMMIT')
      expect(await result).toEqual({ code: 'PT409' })
      await second.query('ROLLBACK')
      await db.query('BEGIN')
      const after = await snapshot()
      expect(after.revision).toBe(deletion.revision)
      expect(after.items).toEqual([])
      expect((await pending()).changes.map(c => c.operation_id)).toEqual([deletion.operationId])
      await db.query('COMMIT')
    } finally {
      await first.query('ROLLBACK').catch(() => undefined); await second.query('ROLLBACK').catch(() => undefined)
      await first.end(); await second.end()
      await db.query('ROLLBACK')
      await db.query('DELETE FROM chat.chats WHERE id=$1',[chat])
      await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[[owner,stranger]])
    }
  })

  it('serves the same saved state over the authenticated Data API while anonymous calls and table writes fail', async () => {
    await db.query('COMMIT')
    const endpoint = process.env.GUGU_INTEGRATION_SUPABASE_URL ?? ''
    if (!['127.0.0.1','localhost','[::1]'].includes(new URL(endpoint).hostname)) throw new Error('Panel API tests require the fixture API')
    const options = { auth: { persistSession: false,autoRefreshToken: false,detectSessionInUrl: false },db: { schema: 'identity' } }
    const admin = createClient(endpoint,process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY!,options)
    const client = createClient(endpoint,process.env.VITE_SUPABASE_ANON_KEY!,options)
    try {
      const password = randomUUID()
      expect((await admin.auth.admin.updateUserById(owner,{ password,email_confirm: true })).error).toBeNull()
      expect((await client.auth.signInWithPassword({ email: `${owner}@panel.invalid`,password })).error).toBeNull()
      const empty = await client.rpc('assistant_panel_snapshot',{ p_assistant: agent })
      expect(empty.error).toBeNull()
      expect(empty.data).toEqual({ version: 1,revision: '0',items: [],application: [] })
      const id = randomUUID()
      const input = { p_assistant: agent,p_operation_id: id,p_domain: 'personality',p_resource_key: 'current',
        p_expected_revision: '0',p_operation: 'save',p_data: { text: 'Saved through the panel API' } }
      const saved = await client.rpc('assistant_panel_commit',input)
      expect(saved.error).toBeNull()
      expect(saved.data).toMatchObject({ operationId: id,status: 'pending' })
      expect((await client.rpc('assistant_panel_commit',input)).data).toEqual(saved.data)
      const read = await client.rpc('assistant_panel_snapshot',{ p_assistant: agent })
      expect(read.error).toBeNull()
      expect(read.data.items[0].data).toEqual(input.p_data)
      const lookup = { p_assistant: agent,p_domain: 'personality',p_resource_key: 'current' }
      expect((await client.rpc('assistant_panel_resource',lookup)).data.item.revision).toBe(saved.data.revision)
      const removed = await client.rpc('assistant_panel_commit',{ ...input,p_operation_id: randomUUID(),p_expected_revision: saved.data.revision,p_operation: 'remove',p_data: {} })
      expect(removed.error).toBeNull()
      expect((await client.rpc('assistant_panel_snapshot',{ p_assistant: agent })).data.items).toEqual([])
      expect((await client.rpc('assistant_panel_resource',lookup)).data.item).toMatchObject({ revision: removed.data.revision,deleted_at: expect.any(String) })
      // A stale revision is a business conflict: PostgREST answers 409 PT409 once. Under 40001 it retried the
      // request server-side forever, because a stale revision never resolves by retrying.
      for (const [name,args] of [
        ['assistant_panel_commit',{ ...input,p_operation_id: randomUUID(),p_expected_revision: '0' }],
        ['assistant_panel_admit',{ p_assistant: agent,p_runtime_instance_id: instance,p_expected_revision: '0' }],
      ] as const) {
        const started = performance.now()
        const stale = await client.rpc(name,args)
        expect({ name,status: stale.status,code: stale.error?.code }).toEqual({ name,status: 409,code: 'PT409' })
        expect(performance.now() - started).toBeLessThan(1000)
      }
      expect((await client.from('assistant_panel_items').update({ data: {} }).eq('assistant_user_id',agent)).error?.code).toBe('42501')
      const anonymous = createClient(endpoint,process.env.VITE_SUPABASE_ANON_KEY!,options)
      expect((await anonymous.rpc('assistant_panel_snapshot',{ p_assistant: agent })).error?.code).toBe('42501')
    } finally {
      await client.auth.signOut()
      await db.query('DELETE FROM chat.chats WHERE id=$1',[chat])
      await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[[owner,stranger]])
    }
  })
})
