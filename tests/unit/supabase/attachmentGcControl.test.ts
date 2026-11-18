import { expect, it, vi } from 'vitest'
import { handleGc, type AttachmentsDeps } from '../../../supabase/functions/_shared/attachments-core'
import { configureAttachmentGc } from '../../../supabase/functions/_shared/attachment-gc-config'

const token = '11111111-1111-4111-8111-111111111111'
function fixture(acquired = true, count = 5) {
  let active = 0, maxActive = 0
  const remove = vi.fn(async () => { maxActive = Math.max(maxActive, ++active); await Promise.resolve(); active-- })
  const serviceRpc = vi.fn<AttachmentsDeps['serviceRpc']>(async fn => ({ data:
    fn === 'file_blob_gc_run_begin' ? { acquired, token, batch_limit: 5, concurrency: 1 } :
    fn === 'file_blob_gc_run_renew' || fn === 'file_blob_gc_run_end' ? true :
    fn === 'file_blob_gc_run_claim' ? Array.from({ length: count }, (_, n) => ({ blob_id: String(n), claim_token: String(n),
      bucket_id: 'workspace', object_name: 'object/' + n, content_type: 'application/pdf' })) : null, error: null }))
  const deps = { serviceRpc, storageRemove: remove, objects: {}, now: () => new Date('2026-11-14T00:00:00Z'), log: vi.fn() } as unknown as AttachmentsDeps
  return { deps, serviceRpc, remove, maxActive: () => maxActive }
}
it.each(['kick', 'file-accept'] as const)('keeps the %s entry and staging cleanup closed when no consumer is admitted', async entry => {
  const f = fixture(false), staging = vi.fn()
  expect(await handleGc(f.deps, entry, staging)).toEqual({ claimed: 0, deleted: 0, failed: 0 })
  expect(f.serviceRpc.mock.calls.map(([fn]) => fn)).toEqual(['file_blob_gc_run_begin'])
  expect(f.remove).not.toHaveBeenCalled(); expect(staging).not.toHaveBeenCalled()
})
it('uses the database-owned bound and deletes sequentially under one consumer token', async () => {
  const f = fixture(), staging = vi.fn()
  expect(await handleGc(f.deps, 'kick', staging)).toEqual({ claimed: 5, deleted: 5, failed: 0 })
  expect(f.serviceRpc).toHaveBeenCalledWith('file_blob_gc_run_claim', { p_token: token })
  expect(f.remove).toHaveBeenCalledTimes(5); expect(f.maxActive()).toBe(1)
  expect(staging).not.toHaveBeenCalled()
  expect(f.serviceRpc).toHaveBeenLastCalledWith('file_blob_gc_run_end', { p_token: token })
})
it('refuses an oversized server claim before any object deletion', async () => {
  const f = fixture(true, 6)
  await expect(handleGc(f.deps)).rejects.toMatchObject({ status: 503 })
  expect(f.remove).not.toHaveBeenCalled()
  expect(f.serviceRpc).toHaveBeenLastCalledWith('file_blob_gc_run_end', { p_token: token })
})
it('counts expired multipart uploads in the same five-candidate budget as blobs and staging', async () => {
  const f = fixture(true, 2), rpc = f.deps.serviceRpc, staging = vi.fn()
  let active = 0, peak = 0
  const abandon = vi.fn(async () => { peak = Math.max(peak, ++active); await Promise.resolve(); active-- })
  f.deps.objects = { parts: { abandon } } as unknown as NonNullable<AttachmentsDeps['objects']>
  const claim = vi.fn(async (fn: string, args: Record<string, unknown>) => fn === 'file_managed_upload_parts_claim'
    ? { data: Array.from({ length: 3 }, (_, n) => ({ staging_key: 'staging/' + n, account_id: 'account', upload_id: String(n) })), error: null }
    : rpc(fn, args))
  f.deps.serviceRpc = claim
  await handleGc(f.deps, 'kick', staging)
  expect(claim).toHaveBeenCalledWith('file_managed_upload_parts_claim', { p_limit: 3 })
  expect(abandon).toHaveBeenCalledTimes(3)
  expect(peak).toBe(1)
  expect(staging).not.toHaveBeenCalled()
})
it('refuses an oversized multipart claim before abandoning any multipart upload', async () => {
  const f = fixture(true, 2), rpc = f.deps.serviceRpc, abandon = vi.fn()
  f.deps.objects = { parts: { abandon } } as unknown as NonNullable<AttachmentsDeps['objects']>
  f.deps.serviceRpc = async (fn, args) => fn === 'file_managed_upload_parts_claim'
    ? { data: Array.from({ length: 4 }, () => ({})), error: null } : rpc(fn, args)
  await expect(handleGc(f.deps)).rejects.toMatchObject({ status: 503 })
  expect(abandon).not.toHaveBeenCalled()
})
it('shares the remaining budget with staging and stops when the consumer is revoked', async () => {
  const f = fixture(true, 2), staging = vi.fn(async (remaining: number, guard: () => Promise<void>) => {
    expect(remaining).toBe(3); await guard()
  })
  await handleGc(f.deps, 'kick', staging)
  expect(staging).toHaveBeenCalledOnce()
  const g = fixture(), rpc = g.deps.serviceRpc
  g.deps.serviceRpc = (fn, args) => fn === 'file_blob_gc_run_renew' ? Promise.resolve({ data: false, error: null }) : rpc(fn, args)
  await expect(handleGc(g.deps, 'file-accept')).rejects.toMatchObject({ status: 503 })
  expect(g.remove).not.toHaveBeenCalled()
})
it('configures only the server URL and capability, rejecting omitted or invalid controls', async () => {
  const rpc = vi.fn<AttachmentsDeps['serviceRpc']>(async () => ({ data: { configured: true }, error: null }))
  await configureAttachmentGc(rpc, 'http://kong:8000/', 'synthetic-service-capability', {
    enabled: false, batch_limit: 5, endpoint: 'https://foreign.invalid', p_key: 'foreign', limit: 500,
  })
  expect(rpc).toHaveBeenCalledExactlyOnceWith('configure_file_blob_gc', {
    p_endpoint: 'http://kong:8000/functions/v1/attachments/gc', p_key: 'synthetic-service-capability', p_enabled: false, p_batch_limit: 5,
  })
  for (const body of [{}, { enabled: 'false', batch_limit: 5 }, { enabled: false, batch_limit: 500 }]) {
    await expect(configureAttachmentGc(rpc, 'http://kong:8000', 'synthetic', body)).rejects.toMatchObject({ status: 400 })
  }
  rpc.mockResolvedValue({ data: null, error: { message: 'sensitive-fixture-canary' } })
  await expect(configureAttachmentGc(rpc, 'http://kong:8000', 'synthetic', { enabled: false, batch_limit: 5 }))
    .rejects.toMatchObject({ message: 'Attachment GC configuration failed' })
})
