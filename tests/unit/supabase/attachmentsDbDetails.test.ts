// The function's database adapters keep PostgREST's `details`: a busy direct upload answers when to ask again.
import { expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ handler: null as null | ((request: Request) => Promise<Response>) }))
vi.mock('npm:@supabase/supabase-js@2.110.9', () => ({ createClient: () => ({
  rpc: async (fn: string) => {
    if (fn === 'attachments_principal') return { data: '11111111-1111-4111-8111-111111111111', error: null, status: 200 }
    if (fn === 'file_managed_upload_prepare') return { data: { max_bytes: 1000, permit_seconds: 7200 }, error: null, status: 200 }
    if (fn === 'file_managed_upload_direct_as') return { data: null, status: 400, error: { code: 'P0001', message: 'These bytes are being uploaded by another request',
      hint: 'file_transfer_upload_in_progress', details: '2026-11-20 10:10:59.61659+00' } }
    return { data: null, error: { message: `no fake for ${fn}` }, status: 500 }
  },
  storage: { from: () => ({}) },
}) }))
vi.mock('npm:ali-oss@6.23.0', () => ({ default: vi.fn() }))
const env: Record<string, string> = { SUPABASE_URL: 'http://kong:8000', SUPABASE_ANON_KEY: 'anon-fixture', SUPABASE_SERVICE_ROLE_KEY: 'service-fixture-only' }
vi.stubGlobal('Deno', { env: { get: (key: string) => env[key] }, serve: (handler: typeof fixture.handler) => { fixture.handler = handler } })
vi.stubGlobal('fetch', async (input: string) => new URL(input).pathname === '/storage/v1/bucket/attachments'
  ? Response.json({ file_size_limit: 1000 }) : new Response('unexpected', { status: 500 }))
await import('../../../supabase/functions/attachments/index')

it('answers a busy direct upload with the time to ask again, from the database detail', async () => {
  const response = await fixture.handler!(new Request('http://isolated/attachments/upload', {
    method: 'POST', headers: { authorization: 'Bearer user-fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: '22222222-2222-4222-8222-222222222222', size_bytes: 300, chat_id: 'c1', content_type: 'application/octet-stream', sha256: 'ab'.repeat(32) }),
  }))
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: 'upload_in_progress', retry_after: '2026-11-20T10:10:59.616Z' })
})
