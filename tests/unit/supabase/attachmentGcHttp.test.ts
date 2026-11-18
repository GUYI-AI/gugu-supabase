import { beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ handler: null as null | ((request: Request) => Promise<Response>), rpc: vi.fn(), remove: vi.fn() }))
vi.mock('npm:@supabase/supabase-js@2.110.9', () => ({ createClient: () => ({
  rpc: fixture.rpc, storage: { from: () => ({ remove: fixture.remove }) },
}) }))
vi.mock('npm:ali-oss@6.23.0', () => ({ default: vi.fn() }))
const env: Record<string, string> = { SUPABASE_URL: 'http://kong:8000', SUPABASE_ANON_KEY: 'anon-fixture', SUPABASE_SERVICE_ROLE_KEY: 'service-fixture-only' }
vi.stubGlobal('Deno', { env: { get: (key: string) => env[key] }, serve: (handler: typeof fixture.handler) => { fixture.handler = handler } })
await import('../../../supabase/functions/attachments/index')
const request = (route: string, body: unknown, token = 'service-fixture-only') => new Request('http://isolated/attachments/' + route, {
  method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body),
})
beforeEach(() => { fixture.rpc.mockReset(); fixture.remove.mockReset() })
it('restricts GC configuration and status to the service capability', async () => {
  for (const route of ['gc-configure', 'gc-status']) expect((await fixture.handler!(request(route, {}, 'ordinary-user'))).status).toBe(401)
  expect(fixture.rpc).not.toHaveBeenCalled()
})
it('derives GC credentials at the server and does not accept request replacements', async () => {
  fixture.rpc.mockResolvedValue({ data: { configured: true, enabled: false, batch_limit: 5, concurrency: 1, inflight: 0 }, error: null })
  const response = await fixture.handler!(request('gc-configure', { enabled: false, batch_limit: 5, endpoint: 'https://attacker.invalid', p_key: 'attacker' }))
  expect(response.status).toBe(200)
  expect(fixture.rpc).toHaveBeenCalledExactlyOnceWith('configure_file_blob_gc', {
    p_endpoint: 'http://kong:8000/functions/v1/attachments/gc', p_key: 'service-fixture-only', p_enabled: false, p_batch_limit: 5,
  })
  expect(await response.text()).not.toContain('service-fixture-only')
})
it('cannot delete staging or claim objects while disabled, regardless of HTTP body limit', async () => {
  fixture.rpc.mockResolvedValue({ data: { acquired: false, batch_limit: 5, concurrency: 1 }, error: null })
  const response = await fixture.handler!(request('gc', { limit: 500 }))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ claimed: 0, deleted: 0, failed: 0, staging_deleted: 0 })
  expect(fixture.rpc).toHaveBeenCalledExactlyOnceWith('file_blob_gc_run_begin', {})
  expect(fixture.remove).not.toHaveBeenCalled()
})
