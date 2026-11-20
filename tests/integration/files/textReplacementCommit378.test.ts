import { createClient } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleCommit, handleFinish, type AttachmentsDeps } from '../../../supabase/functions/_shared/attachments-core'
import { ObjectStorageError, type AttachmentObjectStorage } from '../../../supabase/functions/_shared/object-storage'
import { WORKSPACE_TEXT_MAX_BYTES, workspaceUploadKind } from '../../../supabase/functions/_shared/document-import-core'
import { Fixture, filesConfig, startFiles, type Running } from './support'

// Run serially: only storage is fake. Verification, authorization, generation
// swaps and publication use the real installed DB and file service.
const api = process.env.GUGU_INTEGRATION_SUPABASE_URL ?? ''
const admin = createClient(api, process.env.GUGU_INTEGRATION_SERVICE_ROLE_KEY ?? '', {
  db: { schema: 'chat' }, auth: { autoRefreshToken: false, persistSession: false },
})
let fx: Fixture, svc: Running, caller: ReturnType<typeof createClient>, user: string, token: string, group: string
let oldLimits: unknown
const blobs: string[] = []
beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(api).hostname)) throw Error('Owned loopback only')
  fx = new Fixture(); await fx.connect()
  oldLimits = (await fx.admin.query("SELECT settings FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*'")).rows[0]?.settings
  const email = `${randomUUID()}@replace378.invalid`, password = randomUUID()
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (result.error) throw result.error
  user = result.data.user!.id
  caller = createClient(api, process.env.VITE_SUPABASE_ANON_KEY ?? '', {
    db: { schema: 'chat' }, auth: { autoRefreshToken: false, persistSession: false },
  })
  const login = await caller.auth.signInWithPassword({ email, password })
  if (login.error) throw login.error
  token = login.data.session!.access_token
  group = await fx.group(user, [])
  const usage = Number((await fx.admin.query("SELECT chat.file_transfer_usage('upload','global','*') AS n")).rows[0].n)
  await fx.admin.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings", [{
    inventory_ready: true, storage_global_bytes: usage + 1000000, storage_account_bytes: 1000000, storage_group_bytes: 1000000,
    download_global_bytes: 1000000, download_account_bytes: 1000000, download_group_bytes: 1000000,
    file_max_bytes: 10000, upload_permit_seconds: 120, upload_edge_seconds: 400, upload_sign_seconds: 900,
    upload_inflight_seconds: 600, sign_window_seconds: 60, sign_account_count: 100, sign_group_count: 100,
  }])
  svc = await startFiles(filesConfig(await fx.filesLogin(), `${api}/auth/v1/.well-known/jwks.json`))
})
afterAll(async () => {
  await svc?.close()
  try {
    if (user) {
      const reservations = (await fx.admin.query('SELECT reservation_id FROM chat.file_transfer_uploads WHERE account_id=$1', [user])).rows.map(row => row.reservation_id)
      blobs.push(...(await fx.admin.query('SELECT blob_id FROM chat.file_blob_uploads WHERE uploader=$1', [user])).rows.map(row => row.blob_id))
      if (group) await fx.admin.query('DELETE FROM chat.chats WHERE id=$1', [group])
      await fx.admin.query('DELETE FROM chat.file_blob_uploads WHERE uploader=$1', [user])
      await fx.admin.query('DELETE FROM chat.file_transfer_uploads WHERE account_id=$1', [user])
      await fx.admin.query('DELETE FROM chat.file_transfer_reservations WHERE id=ANY($1::uuid[])', [reservations])
      await fx.admin.query('DELETE FROM chat.file_transfer_storage WHERE blob_id=ANY($1::uuid[])', [blobs])
      await fx.admin.query('DELETE FROM chat.file_blobs WHERE id=ANY($1::uuid[]) AND created_by=$2', [blobs, user])
      const result = await admin.auth.admin.deleteUser(user)
      if (result.error) throw result.error
    }
  } finally {
    if (oldLimits === undefined) await fx?.admin.query("DELETE FROM chat.file_transfer_limits WHERE scope='global' AND scope_id='*'")
    else await fx.admin.query("UPDATE chat.file_transfer_limits SET settings=$1 WHERE scope='global' AND scope_id='*'", [oldLimits])
    await fx?.cleanup()
  }
})

async function fixture(type = 'text/markdown') {
  const json = type === 'application/json', unique = randomUUID()
  const original = json ? JSON.stringify({ before: unique }) : '# original ' + unique
  const text = json ? JSON.stringify({ after: unique }) : '# replaced ' + unique, bytes = new TextEncoder().encode(text)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const originalKey = `staging/${user}/${randomUUID()}`
  const blob = (await fx.admin.query('SELECT * FROM chat.file_blob_register($1,$2,$3,$4,$5)',
    [user, originalKey, createHash('sha256').update(original).digest('hex'), Buffer.byteLength(original), type])).rows[0].blob_id
  blobs.push(blob)
  const item = randomUUID()
  await fx.admin.query("INSERT INTO chat.workspace_items(id,chat_id,kind,filename,content_type,size_bytes,inline_text,blob_id,created_by) VALUES($1,$2,'document','document',$3,$4,$5,$6,$7)", [item, group, type, Buffer.byteLength(original), original, blob, user])
  await fx.admin.query('INSERT INTO chat.workspace_item_versions(item_id,n,inline_text,blob_id,content_type,size_bytes,made_by) VALUES($1,1,$2,$3,$4,$5,$6)', [item, original, blob, type, Buffer.byteLength(original), user])
  const permit = await caller.rpc('file_managed_upload_as', { p_id: randomUUID(), p_chat: group, p_as: user, p_bytes: bytes.length })
  if (permit.error) throw permit.error
  const key = permit.data.staging_key as string, message = randomUUID()
  let available = true
  const objects = {
    async inspect() {
      if (!available) throw new ObjectStorageError(404, null, 'not uploaded yet')
      return { bytes, sizeBytes: bytes.length, sha256: digest, revision: 'immutable' }
    }, async promote() {}, async exists() { return true },
  } as AttachmentObjectStorage
  const deps: AttachmentsDeps = {
    objects, fetch: async () => { throw Error('Unexpected object network request') },
    textFiles: { maxBytes: WORKSPACE_TEXT_MAX_BYTES, classify: workspaceUploadKind },
    userRpc: async (fn, args) => await caller.rpc(fn, args),
    serviceRpc: async (fn, args) => await admin.rpc(fn, args),
    documentReplacement: async (_item, _actor, body) => {
      const response = await fetch(`${svc.url}/${item}/replace`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json()
      if (!response.ok) throw Object.assign(Error(result.error), { status: response.status })
    },
    storageSignedUrl: async () => { throw Error('Unexpected legacy read') }, storageRemove: async () => { throw Error('Unexpected object removal') },
    now: () => new Date(), uuid: randomUUID, log: () => {},
  }
  const body = { staging_key: key, message_id: message, chat_id: group, sender_user_id: user, item_id: item,
    expected_version: 1, file_name: json ? 'document.json' : 'document.md', content_type: type, sha256: digest, size_bytes: bytes.length }
  const receipt = async () => (await fx.admin.query('SELECT document,item_id,message_id FROM chat.file_blob_uploads WHERE staging_key=$1', [key])).rows[0]
  const verify = async () => {
    const row = (await fx.admin.query('SELECT version,epoch,inline_text FROM chat.workspace_items WHERE id=$1', [item])).rows[0]
    expect(row).toMatchObject({ version: 2, epoch: 1 })
    expect(json ? JSON.parse(row.inline_text) : row.inline_text).toEqual(json ? JSON.parse(text) : text)
    expect((await fx.admin.query('SELECT count(*)::int AS n FROM chat.messages WHERE id=$1', [message])).rows[0].n).toBe(1)
    expect(await receipt()).toMatchObject({ item_id: item, message_id: message })
  }
  return { deps, body, digest, key, item, bytes, type, text, receipt, verify, absent() { available = false }, uploaded() { available = true } }
}

describe('text replacement commit and finish order (#378)', () => {
  it('reproduces the old declare-then-prepare refusal with real RPCs; finish makes the same receipt recoverable', async () => {
    const f = await fixture('application/json')
    const declared = await caller.rpc('attachment_declare', { p_staging_key: f.key, p_sha256: f.digest, p_size_bytes: f.bytes.length, p_content_type: f.type })
    if (declared.error) throw declared.error
    // The predecessor called this immediately after declaration, with no verification.
    const refused = await fetch(`${svc.url}/${f.item}/replace`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ key: f.key, expected: 1, finish: false }) })
    await refused.body?.cancel()
    expect(refused.status).toBe(500)
    expect(await f.receipt()).toMatchObject({ document: null, item_id: null, message_id: null })
    expect((await fx.admin.query('SELECT version FROM chat.workspace_items WHERE id=$1', [f.item])).rows[0].version).toBe(1)
    await handleFinish(f.deps, user, f.body)
    await handleCommit(f.deps, user, f.body)
    await f.verify()
  })

  it.each(['text/markdown', 'application/json'])('finish before declaration cannot strand a %s replacement', async type => {
    const f = await fixture(type)
    await expect(handleFinish(f.deps, user, f.body)).rejects.toMatchObject({ status: 404, code: 'upload_not_found' })
    await handleCommit(f.deps, user, f.body)
    await handleFinish(f.deps, user, f.body)
    await handleCommit(f.deps, user, f.body)
    await f.verify()
  })

  it('commit before bytes stays retryable; concurrent finish and the same commit replace only once', async () => {
    const f = await fixture(); f.absent()
    await expect(handleCommit(f.deps, user, f.body)).rejects.toMatchObject({ status: 503, code: 'upload_pending' })
    expect(await f.receipt()).toMatchObject({ document: null, item_id: null, message_id: null })
    expect((await fx.admin.query('SELECT version FROM chat.workspace_items WHERE id=$1', [f.item])).rows[0].version).toBe(1)
    f.uploaded()
    await Promise.all([handleFinish(f.deps, user, f.body), handleCommit(f.deps, user, f.body)])
    await f.verify()
  })

  it('a commit behind an uncommitted finish sees its verified text after commit', async () => {
    const f = await fixture()
    const declared = await caller.rpc('attachment_declare', { p_staging_key: f.key, p_sha256: f.digest, p_size_bytes: f.bytes.length, p_content_type: f.type })
    if (declared.error) throw declared.error
    const finish = new pg.Client({ connectionString: process.env.GUGU_INTEGRATION_DATABASE_URL })
    await finish.connect()
    let commit: Promise<unknown> | undefined, commitError: unknown
    try {
      await finish.query('BEGIN; SET LOCAL ROLE service_role')
      await finish.query('SELECT chat.file_blob_settle($1,$2,$2,$3,$4,$5,NULL,NULL,$6)', [user, f.key, f.digest, f.bytes.length, f.type, { text: f.text, content_type: f.type }])
      commit = handleCommit(f.deps, user, f.body).catch(error => { commitError = error })
      const holder = Number((await finish.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      const deadline = Date.now() + 5000
      let blocked = false
      while (Date.now() < deadline) {
        blocked = (await fx.admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS yes', [holder])).rows[0].yes
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(blocked, 'the actual commit must queue behind the still-uncommitted finish').toBe(true)
      await finish.query('COMMIT')
      await commit
      if (commitError) throw commitError
      await f.verify()
    } finally { await finish.query('ROLLBACK'); await finish.end(); await commit?.catch(() => {}) }
  })
})
