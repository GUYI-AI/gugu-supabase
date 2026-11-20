import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { handleCommit, type AttachmentsDeps } from '../../../supabase/functions/_shared/attachments-core'
import { ObjectStorageError, type AttachmentObjectStorage } from '../../../supabase/functions/_shared/object-storage'

const user = '11111111-1111-4111-8111-111111111111'
const key = `staging/${user}/22222222-2222-4222-8222-222222222222`
const bytes = new TextEncoder().encode('# replacement')
const digest = createHash('sha256').update(bytes).digest('hex')
const body = { staging_key: key, message_id: 'replacement-message', chat_id: 'group', sender_user_id: user,
  file_name: 'document.md', content_type: 'text/markdown', sha256: digest, size_bytes: bytes.length,
  item_id: '33333333-3333-4333-8333-333333333333', expected_version: 1 }

function fixture() {
  let available = true, verified = false, committed = false
  const events: string[] = []
  const objects = {
    async inspect() {
      events.push('inspect')
      if (!available) throw new ObjectStorageError(404, null, 'not uploaded yet')
      return { bytes, sizeBytes: bytes.length, sha256: digest, revision: 'immutable' }
    },
    async promote() { events.push('copy') },
    async exists() { return true },
  } as AttachmentObjectStorage
  const deps: AttachmentsDeps = {
    objects, fetch: async () => { throw Error('Unexpected network request') },
    textFiles: { maxBytes: 1048576, classify: () => ({ kind: 'document', text: '# replacement', contentType: 'text/markdown' }) },
    userRpc: async (fn) => {
      events.push(fn)
      if (fn === 'workspace_get_as') return { data: [{ kind: 'document' }], error: null }
      if (fn === 'attachment_commit') { committed = true; return { data: [{ id: body.message_id }], error: null } }
      if (fn === 'file_managed_upload_scope' || fn === 'attachment_declare') return { data: null, error: null }
      throw Error(`Unexpected user RPC: ${fn}`)
    },
    serviceRpc: async (fn, args) => {
      events.push(fn)
      if (fn === 'file_managed_upload_for') return { data: { max_bytes: bytes.length }, error: null }
      if (fn === 'file_blob_settle') {
        expect(args).toMatchObject({ p_pending_key: key, p_upload_key: key, p_sha256: digest,
          p_document: { text: '# replacement', content_type: 'text/markdown' } })
        verified = true
        return { data: { status: 'ready', created: false }, error: null }
      }
      throw Error(`Unexpected service RPC: ${fn}`)
    },
    documentReplacement: async (_item, _actor, request) => {
      events.push(request.finish ? 'resume' : 'prepare')
      if (!verified) throw Error('Verified text upload required')
    },
    storageSignedUrl: async () => { throw Error('Unexpected legacy storage read') },
    storageRemove: async () => { throw Error('Unexpected storage deletion') },
    now: () => new Date(), uuid: () => body.message_id, log: () => {},
  }
  return { deps, events, absent() { available = false }, uploaded() { available = true }, committed: () => committed }
}

describe('declared text replacement commit (#378)', () => {
  it('commits uploaded bytes without waiting for the independent finish request', async () => {
    const f = fixture()
    await expect(handleCommit(f.deps, user, body)).resolves.toEqual({ id: body.message_id })
    expect(f.events.filter(event => ['file_blob_settle', 'prepare', 'attachment_commit', 'resume'].includes(event)))
      .toEqual(['file_blob_settle', 'prepare', 'attachment_commit', 'resume'])
  })

  it('keeps a not-yet-uploaded replacement retryable, then accepts the same key and message', async () => {
    const f = fixture(); f.absent()
    await expect(handleCommit(f.deps, user, body)).rejects.toMatchObject({ status: 503, code: 'upload_pending' })
    expect(f.committed()).toBe(false)
    expect(f.events).not.toContain('prepare')
    f.uploaded()
    await expect(handleCommit(f.deps, user, body)).resolves.toEqual({ id: body.message_id })
    expect(f.events.filter(event => event === 'attachment_commit')).toHaveLength(1)
  })
})
