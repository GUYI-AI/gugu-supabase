import { describe, expect, it, vi } from 'vitest'
import { handleFileDownload } from '../../../supabase/functions/_shared/file-transfer-core'
import { ossObjectStorage } from '../../../supabase/functions/_shared/attachment-object-storage'
import type { AttachmentsDeps } from '../../../supabase/functions/_shared/attachments-core'
import type { AttachmentObjectStorage } from '../../../supabase/functions/_shared/object-storage'

const at = new Date('2026-11-03T00:00:00Z'), request = '11111111-1111-4111-8111-111111111111'
function fixture(metadata: Record<string, unknown> = {}) {
  const directSign = vi.fn<AttachmentObjectStorage['sign']>(async () => ({ url: 'https://origin.example/same-object?x-oss-signature=fixture', expiresAt: '2026-11-03T00:00:30Z' }))
  const objects = ossObjectStorage({ oss: { region: 'test', bucket: 'fixture', endpointPublic: 'oss.example', endpointInternal: 'internal.example', accessKeyId: 'fixture', accessKeySecret: 'fixture' },
    cdn: { domain: 'cdn.example', authKey: 'fixture', authTtlSeconds: 1800 }, directSign, fetch: vi.fn(), inspector: vi.fn() })
  const userRpc = vi.fn<AttachmentsDeps['userRpc']>(async () => ({ data: { status: 'ready', bucket_id: 'oss', object_name: 'same-object', download_id: request,
    signed_at: at.toISOString(), expires_at: '2026-11-03T00:01:00Z', content_type: 'application/octet-stream', size_bytes: 10, ...metadata }, error: null }))
  const deps = { objects, userRpc, serviceRpc: vi.fn(async () => ({ data: { download_link_bits_per_second: 819200 }, error: null })) } as unknown as AttachmentsDeps
  return { deps, directSign, userRpc }
}
describe('authorized CDN and origin download capabilities', () => {
  it('returns the CDN capability without calling or waiting for the origin signer', async () => {
    const f = fixture(); f.directSign.mockRejectedValue(new Error('origin signing failed'))
    const row = await handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request })
    expect(row).toMatchObject({ url: expect.stringContaining('https://cdn.example/same-object?auth_key='), origin_available: true, expires_at: '2026-11-03T00:01:00Z' })
    expect(row).not.toHaveProperty('origin_url')
    expect(f.directSign).not.toHaveBeenCalled()
    expect(f.userRpc).toHaveBeenCalledExactlyOnceWith('file_transfer_download_as', { p_ref: { message_id: 'message' }, p_as: 'reader', p_id: request })
  })
  it('signs the origin only on explicit fallback through the same ACL and reservation', async () => {
    const f = fixture()
    await handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request })
    expect(f.directSign).not.toHaveBeenCalled()
    const row = await handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request, origin: true })
    expect(row).toMatchObject({ url: 'https://origin.example/same-object?x-oss-signature=fixture', expires_at: '2026-11-03T00:00:30Z' })
    expect(f.userRpc.mock.calls).toEqual(Array(2).fill(['file_transfer_download_as', { p_ref: { message_id: 'message' }, p_as: 'reader', p_id: request }]))
    expect(f.directSign).toHaveBeenCalledExactlyOnceWith('same-object', at, { requestId: request, expiresSeconds: 60, trafficBits: 819200, direct: true })
  })
  it.each(['application/octet-stream', 'image/png'])('can start a new %s read at the origin with one reservation request, untransformed', async contentType => {
    const freshRequest = '22222222-2222-4222-8222-222222222222'
    const f = fixture({ content_type: contentType, download_id: freshRequest })
    f.directSign.mockResolvedValueOnce({ url: 'https://origin.example/same-object?original', expiresAt: '2026-11-03T00:00:30Z' })
    const row = await handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: freshRequest, origin: true })
    expect(row).toMatchObject({ download_id: freshRequest, url: 'https://origin.example/same-object?original', expires_at: '2026-11-03T00:00:30Z' })
    expect(f.userRpc).toHaveBeenCalledExactlyOnceWith('file_transfer_download_as', { p_ref: { message_id: 'message' }, p_as: 'reader', p_id: freshRequest })
    expect(f.directSign).toHaveBeenCalledExactlyOnceWith('same-object', at, { requestId: freshRequest, expiresSeconds: 60, trafficBits: 819200, direct: true })
  })
  it('signs an image preview through its own reader function, the same way', async () => {
    const f = fixture({ content_type: 'image/webp' })
    const row = await handleFileDownload(f.deps, 'reader', { ref: { item_id: request, version: 1 }, request_id: request, preview: true })
    expect(row).toMatchObject({ url: expect.stringContaining('https://cdn.example/same-object?auth_key='), origin_available: true })
    expect(f.userRpc).toHaveBeenCalledExactlyOnceWith('file_preview_download_as', { p_ref: { item_id: request, version: 1 }, p_as: 'reader', p_id: request })
  })
  it('signs temporary ciphertext at the origin directly', async () => {
    const f = fixture({ bucket_id: 'temporary', content_type: 'image/png', width: 640, height: 480 })
    await handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request })
    expect(f.directSign).toHaveBeenCalledExactlyOnceWith('same-object', at, { requestId: request, expiresSeconds: 60, trafficBits: 819200, direct: true })
  })
  it.each([false, true])('checks the ACL and unavailable state before signing (origin=%s)', async origin => {
    const f = fixture({ content_type: 'image/png' })
    f.userRpc.mockResolvedValueOnce({ data: null, error: { hint: 'file_transfer_denied', message: 'Denied' } })
    await expect(handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request, origin })).rejects.toMatchObject({ status: 403 })
    expect(f.directSign).not.toHaveBeenCalled(); expect(f.deps.serviceRpc).not.toHaveBeenCalled()
    f.userRpc.mockResolvedValueOnce({ data: { status: 'gone' }, error: null })
    expect(await handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request, origin })).toEqual({ status: 'gone' })
    expect(f.directSign).not.toHaveBeenCalled()
  })
  it('reports a required fallback signing failure without blocking the first CDN capability', async () => {
    const f = fixture(); f.directSign.mockRejectedValueOnce(new Error('origin signing failed'))
    await expect(handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request })).resolves.toMatchObject({ status: 'ready' })
    await expect(handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request, origin: true })).rejects.toThrow('origin signing failed')
    expect(f.directSign).toHaveBeenCalledTimes(1)
  })
  it('rejects malformed origin requests before authorization and unsupported storage before signing', async () => {
    const f = fixture()
    await expect(handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request, origin: 'true' })).rejects.toMatchObject({ status: 400 })
    expect(f.userRpc).not.toHaveBeenCalled()
    f.userRpc.mockResolvedValueOnce({ data: { status: 'ready', bucket_id: 'workspace' }, error: null })
    await expect(handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request, origin: true })).rejects.toMatchObject({ status: 400 })
    expect(f.directSign).not.toHaveBeenCalled()
  })
})
