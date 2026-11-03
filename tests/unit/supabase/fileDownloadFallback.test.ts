import { describe, expect, it, vi } from 'vitest'
import { handleFileDownload } from '../../../supabase/functions/_shared/file-transfer-core'
import { ossObjectStorage } from '../../../supabase/functions/_shared/attachment-object-storage'
import type { AttachmentsDeps } from '../../../supabase/functions/_shared/attachments-core'
import type { AttachmentObjectStorage } from '../../../supabase/functions/_shared/object-storage'

const at = new Date('2026-11-03T00:00:00Z'), request = '11111111-1111-4111-8111-111111111111'
function fixture() {
  const directSign = vi.fn<AttachmentObjectStorage['sign']>(async () => ({ url: 'https://origin.example/same-object?x-oss-signature=fixture', thumbUrl: null, expiresAt: '2026-11-03T00:00:30Z' }))
  const objects = ossObjectStorage({ oss: { region: 'test', bucket: 'fixture', endpointPublic: 'oss.example', endpointInternal: 'internal.example', accessKeyId: 'fixture', accessKeySecret: 'fixture' },
    cdn: { domain: 'cdn.example', authKey: 'fixture', authTtlSeconds: 1800 }, directSign, fetch: vi.fn() })
  const userRpc = vi.fn<AttachmentsDeps['userRpc']>(async () => ({ data: { status: 'ready', bucket_id: 'oss', object_name: 'same-object', download_id: request,
    signed_at: at.toISOString(), expires_at: '2026-11-03T00:01:00Z', content_type: 'application/octet-stream', size_bytes: 10 }, error: null }))
  const deps = { objects, userRpc, serviceRpc: vi.fn(async () => ({ data: { download_link_bits_per_second: 819200 }, error: null })) } as unknown as AttachmentsDeps
  return { deps, directSign, userRpc }
}
describe('authorized CDN and origin download capabilities', () => {
  it('keeps the CDN field and independently signs the same object/reservation at the origin', async () => {
    const f = fixture(), row = await handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request })
    expect(row).toMatchObject({ url: expect.stringContaining('https://cdn.example/same-object?auth_key='),
      origin_url: 'https://origin.example/same-object?x-oss-signature=fixture', origin_expires_at: '2026-11-03T00:00:30Z', expires_at: '2026-11-03T00:01:00Z' })
    expect(f.userRpc).toHaveBeenCalledExactlyOnceWith('file_transfer_download_as', { p_ref: { message_id: 'message' }, p_as: 'reader', p_id: request })
    expect(f.directSign).toHaveBeenCalledExactlyOnceWith('same-object', false, at, { requestId: request, expiresSeconds: 60, trafficBits: 819200, direct: true })
    expect(new URL(String('url' in row && row.url)).searchParams.get('x-oss-signature')).toBeNull()
  })
  it('checks the existing ACL before either signature and does not sign unavailable files', async () => {
    const f = fixture()
    f.userRpc.mockResolvedValueOnce({ data: null, error: { hint: 'file_transfer_denied', message: 'Denied' } })
    await expect(handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request })).rejects.toMatchObject({ status: 403 })
    expect(f.directSign).not.toHaveBeenCalled(); expect(f.deps.serviceRpc).not.toHaveBeenCalled()
    f.userRpc.mockResolvedValueOnce({ data: { status: 'gone' }, error: null })
    expect(await handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request })).toEqual({ status: 'gone' })
    expect(f.directSign).not.toHaveBeenCalled()
  })
  it('does not invent an origin URL if the provider cannot sign a valid capability', async () => {
    const f = fixture(); f.directSign.mockRejectedValueOnce(new Error('origin signing failed'))
    await expect(handleFileDownload(f.deps, 'reader', { ref: { message_id: 'message' }, request_id: request })).rejects.toThrow('origin signing failed')
    expect(f.directSign).toHaveBeenCalledTimes(1)
  })
})
