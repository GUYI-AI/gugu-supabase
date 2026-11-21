import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  handlers: [] as ((req: Request) => Promise<Response>)[], rpc: vi.fn(), getUser: vi.fn(),
  generateLink: vi.fn(), clientFailure: false,
}))
vi.mock('npm:ali-oss@6.23.0', () => ({ default: class FixtureOss {} }))
vi.mock('npm:@supabase/supabase-js@2.110.9', () => ({ createClient: () => {
  if (fx.clientFailure) throw new Error('synthetic-edge-marker@example.invalid')
  return { rpc: fx.rpc, auth: { admin: { getUserById: fx.getUser, generateLink: fx.generateLink } } }
} }))
const env: Record<string, string> = { SUPABASE_URL: 'http://isolated.invalid', SUPABASE_ANON_KEY: 'fixture-anon', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service' }
vi.stubGlobal('Deno', { env: { get: (key: string) => env[key] }, serve: (handler: (req: Request) => Promise<Response>) => fx.handlers.push(handler) })
await import('../../../supabase/functions/server-login/index.ts')
await import('../../../supabase/functions/attachments/index.ts')

const marker = 'synthetic-edge-marker@example.invalid'
let lines: string[]
beforeEach(() => {
  fx.rpc.mockReset(); fx.getUser.mockReset(); fx.generateLink.mockReset(); fx.clientFailure = false
  fx.rpc.mockResolvedValue({ data: new Date(Date.now() + 600_000).toISOString(), error: null })
  lines = []
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(line => { lines.push(line) })
})
afterEach(() => vi.restoreAllMocks())
const request = (route: string, body: unknown = {}) => new Request(`http://isolated.invalid/${route}?marker=${encodeURIComponent(marker)}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': marker, 'user-agent': marker, referer: marker, authorization: 'Bearer fixture' },
  body: JSON.stringify(body),
})
function safeOutput(event: string) {
  expect(lines.length).toBeGreaterThan(0)
  expect(lines.join('\n')).not.toContain(marker)
  expect(lines.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ service: 'edge', event, reason: event }))
}

describe('deployed community Edge handlers', () => {
  it('starts a login without logging machine identity or the generated user code', async () => {
    const response = await fx.handlers[0](request('server-login/start', { machine: { hostname: marker, user: marker } }))
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    safeOutput('start')
    expect(lines.join('\n')).not.toContain(result.user_code)
    expect(fx.rpc.mock.calls[0][1].p_machine.hostname).toBe(marker)
  })
  it('preserves an RPC failure while omitting its message and details from diagnostics', async () => {
    fx.rpc.mockResolvedValue({ data: null, error: { message: marker, details: marker } })
    expect((await fx.handlers[0](request('server-login/start', { email: marker }))).status).toBe(500)
    safeOutput('start_error')
  })
  it.each(['user', 'link'])('poll failure at %s does not log the approved user or SDK error', async stage => {
    fx.rpc.mockResolvedValue({ data: { result: 'approved', user_id: marker }, error: null })
    fx.getUser.mockResolvedValue(stage === 'user' ? { data: {}, error: { message: marker } }
      : { data: { user: { email: marker } }, error: null })
    fx.generateLink.mockResolvedValue({ data: {}, error: { message: marker } })
    const response = await fx.handlers[0](request('server-login/poll', { device_code: marker }))
    expect(response.status).toBe(500)
    safeOutput(stage === 'user' ? 'poll_user_error' : 'poll_link_error')
  })
  it('preserves the successful poll token response without logging token or user identity', async () => {
    fx.rpc.mockResolvedValue({ data: { result: 'approved', user_id: marker }, error: null })
    fx.getUser.mockResolvedValue({ data: { user: { email: marker } }, error: null })
    fx.generateLink.mockResolvedValue({ data: { properties: { hashed_token: marker } }, error: null })
    const response = await fx.handlers[0](request('server-login/poll', { device_code: marker }))
    expect(await response.json()).toMatchObject({ token_hash: marker, user_id: marker })
    safeOutput('approved')
  })
  it('catches a transport exception without serializing the exception object', async () => {
    fx.rpc.mockRejectedValue(Object.assign(new Error(marker), { name: marker, stack: marker, toJSON: () => marker }))
    const response = await fx.handlers[0](request('server-login/start'))
    expect(response.status).toBe(200) // The existing human-facing error page remains HTML 200.
    safeOutput('unhandled')
  })
  it('returns the existing attachment failure when the SDK throws arbitrary text', async () => {
    fx.clientFailure = true
    const response = await fx.handlers[1](request(`attachments/${marker}`, { email: marker }))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'failed', message: 'attachments failed; try again' })
    safeOutput('failed')
  })
})
