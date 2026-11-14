import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createAccountDeletionHandler, sha256, type DeletionDependencies, type Workflow } from '../../../supabase/functions/_shared/account-deletion-core'
import { accountDeletionDependencies } from '../../../supabase/functions/_shared/account-deletion-auth'

const user = { id: randomUUID(), email: 'person@fixture.invalid', sessionId: randomUUID() }
const policy = randomUUID(), requestId = randomUUID(), lease = randomUUID(), receipt = 'a'.repeat(64)
const workflow = (state: string, mode: 'immediate' | 'pending' = 'immediate'): Workflow => ({
  request_id: requestId, state, mode, expires_at: '2030-01-01T00:00:00Z', delete_after: null,
  last_error: null, can_cancel: false, can_retry: false,
})
function fixture() {
  const deps: DeletionDependencies = {
    currentUser: vi.fn(async () => user), sendCode: vi.fn(async () => true),
    verifyCode: vi.fn(async () => ({ id: user.id, email: user.email })), hardDelete: vi.fn(async () => 'absent' as const),
    isWorker: vi.fn(token => token === 'server-only'), flow: vi.fn(async args => {
      if (args.p_action === 'attempt') return { ok: true, lease_token: lease, request: workflow('verifying') }
      if (args.p_action === 'verified' || args.p_action === 'retry') return { ok: true, request: workflow('processing'), user_id: user.id, lease_token: lease }
      if (args.p_action === 'finish') return { ok: true, request: workflow(args.p_error_code === null ? 'deleted' : args.p_error_code === 'outcome_unknown' ? 'processing' : 'retry_wait') }
      if (args.p_action === 'begin' || args.p_action === 'sent') return { ok: true, request: workflow('challenge') }
      return { ok: true, request: null }
    }),
  }
  const handler = createAccountDeletionHandler(deps)
  const call = (route: string, body: unknown = {}, bearer: string | null = 'user-token') => handler(new Request('http://fixture/account-deletion/' + route, {
    method: route === 'status' ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
    ...(route === 'status' ? {} : { body: JSON.stringify(body) }),
  }))
  return { deps, handler, call }
}
const confirm = { request_id: requestId, receipt_token: receipt, code: '123456', policy_version: policy }

describe('self deletion HTTP boundary', () => {
  it('never selects the request-body identity or exposes server-side lease/identity', async () => {
    const f = fixture()
    const response = await f.call('confirm', { ...confirm, user_id: randomUUID(), email: 'someone-else@fixture.invalid', mode: 'pending' })
    expect(response.status).toBe(200)
    expect(f.deps.verifyCode).toHaveBeenCalledWith(user.email, confirm.code)
    expect(f.deps.hardDelete).toHaveBeenCalledWith(user.id)
    const text = await response.text()
    for (const secret of [confirm.code, lease, user.id, user.email, receipt]) expect(text).not.toContain(secret)
    expect(JSON.parse(text).request.state).toBe('deleted')
  })
  it.each([null, 'expired'])('rejects missing or invalid authenticated callers (%s)', async bearer => {
    const f = fixture(); if (bearer) vi.mocked(f.deps.currentUser).mockResolvedValue(null)
    expect((await f.call('confirm', confirm, bearer)).status).toBe(401)
    expect(f.deps.verifyCode).not.toHaveBeenCalled(); expect(f.deps.hardDelete).not.toHaveBeenCalled()
  })
  it.each(['expired', 'rate_limited', 'policy_changed', 'invalid_proof', 'state_conflict'])('does not consume OTP if workflow rejects %s', async error => {
    const f = fixture(); vi.mocked(f.deps.flow).mockResolvedValue({ ok: false, error, status: 409 })
    expect((await f.call('confirm', confirm)).status).toBe(409)
    expect(f.deps.verifyCode).not.toHaveBeenCalled(); expect(f.deps.hardDelete).not.toHaveBeenCalled()
  })
  it.each([null, { id: randomUUID(), email: user.email }, { id: user.id, email: 'other@fixture.invalid' }])('requires exact verified email/user binding', async identity => {
    const f = fixture(); vi.mocked(f.deps.verifyCode).mockResolvedValue(identity)
    expect((await f.call('confirm', confirm)).status).toBe(422)
    expect(f.deps.hardDelete).not.toHaveBeenCalled()
    expect(f.deps.flow).toHaveBeenCalledWith(expect.objectContaining({ p_action: 'verification_failed', p_lease_token: lease }))
  })
  it('commits pending mode without invoking deletion', async () => {
    const f = fixture(), base = f.deps.flow
    vi.mocked(f.deps.flow).mockImplementation(async args => args.p_action === 'attempt'
      ? { ok: true, lease_token: lease, request: workflow('verifying') }
      : { ok: true, request: workflow('pending', 'pending') })
    expect((await f.call('confirm', confirm)).status).toBe(202)
    expect(base).toHaveBeenCalled(); expect(f.deps.hardDelete).not.toHaveBeenCalled()
  })
  it('returns failure for a definite Auth failure and in-progress for an unknown outcome', async () => {
    const f = fixture(); vi.mocked(f.deps.hardDelete).mockResolvedValue('failed')
    expect((await f.call('confirm', confirm)).status).toBe(503)
    vi.mocked(f.deps.hardDelete).mockResolvedValue('unknown')
    const response = await f.call('confirm', confirm)
    expect(response.status).toBe(202); expect((await response.json()).request.state).toBe('processing')
  })
  it('uses a verified authorization for a retry without verifying the consumed OTP again', async () => {
    const f = fixture()
    expect((await f.call('retry', { request_id: requestId, receipt_token: receipt })).status).toBe(200)
    expect(f.deps.verifyCode).not.toHaveBeenCalled(); expect(f.deps.hardDelete).toHaveBeenCalledOnce()
  })
  it('allows only the receipt capability to read the post-deletion result', async () => {
    const f = fixture()
    expect((await f.call('result', { request_id: requestId, receipt_token: receipt }, null)).status).toBe(200)
    expect(f.deps.currentUser).not.toHaveBeenCalled()
    expect(f.deps.flow).toHaveBeenCalledWith({ p_action: 'result', p_request_id: requestId, p_receipt_digest: await sha256(receipt) })
    expect((await f.call('result', { request_id: requestId }, null)).status).toBe(400)
  })
  it('never sends an OTP for another email or when the workflow is disabled', async () => {
    const f = fixture()
    const response = await f.call('challenge', { policy_version: policy, email: 'other@fixture.invalid' })
    expect(response.status).toBe(201); expect(f.deps.sendCode).toHaveBeenCalledWith(user.email)
    expect((await response.json()).receipt_token).toMatch(/^[a-f0-9]{64}$/)
    vi.mocked(f.deps.flow).mockResolvedValue({ ok: false, error: 'disabled', status: 503 })
    vi.mocked(f.deps.sendCode).mockClear()
    expect((await f.call('challenge', { policy_version: policy })).status).toBe(503)
    expect(f.deps.sendCode).not.toHaveBeenCalled()
  })
  it('contains raw Auth/SQL errors and bounds body size', async () => {
    const f = fixture(); vi.mocked(f.deps.currentUser).mockRejectedValue(new Error('SECRET email OTP password'))
    const response = await f.call('confirm', confirm)
    expect(response.status).toBe(503); expect(await response.text()).toBe('{"error":"unavailable"}')
    expect((await f.call('confirm', { data: 'x'.repeat(5000) })).status).toBe(400)
  })
  it('serializes a bounded worker batch and refuses a user JWT', async () => {
    const f = fixture()
    expect((await f.call('process-due')).status).toBe(401)
    vi.mocked(f.deps.flow).mockImplementation(async args => args.p_action === 'claim_due'
      ? { ok: true, claims: [{ request_id: requestId, user_id: user.id, lease_token: lease }] }
      : args.p_action === 'finish' ? { ok: true, request: workflow('deleted') } : { ok: true })
    const response = await f.call('process-due', {}, 'server-only')
    expect(await response.json()).toEqual({ processed: 5, deleted: 5, deferred: 0 })
    expect(f.deps.hardDelete).toHaveBeenCalledTimes(5)
    expect(f.deps.flow).toHaveBeenLastCalledWith(expect.objectContaining({ p_action: 'worker_release' }))
  })
})

describe('official Auth adapter', () => {
  function adapter(responses: { status: number; body?: unknown }[]) {
    const calls: { url: string; init?: RequestInit }[] = []
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init }); const next = responses.shift()
      if (!next) throw new Error('network outcome unknown')
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status })
    }) as unknown as typeof fetch
    return { deps: accountDeletionDependencies({ url: 'http://auth', anonKey: 'public', serviceKey: 'server', fetch: transport }), calls }
  }
  it('consumes an email OTP then revokes its temporary session, without returning tokens', async () => {
    const f = adapter([{ status: 200, body: { access_token: 'temporary-secret', refresh_token: 'refresh-secret', user } }, { status: 204 }])
    expect(await f.deps.verifyCode(user.email, '123456')).toEqual({ id: user.id, email: user.email })
    expect(JSON.parse(String(f.calls[0].init?.body))).toEqual({ type: 'email', email: user.email, token: '123456' })
    expect(f.calls[1].url).toBe('http://auth/auth/v1/logout?scope=local')
    expect(f.calls[1].init?.headers).toMatchObject({ authorization: 'Bearer temporary-secret' })
  })
  it('requests existing-user OTP only and explicitly hard deletes with server credentials', async () => {
    const f = adapter([{ status: 200 }, { status: 200, body: user }, { status: 200 }, { status: 404 }])
    expect(await f.deps.sendCode(user.email)).toBe(true)
    expect(JSON.parse(String(f.calls[0].init?.body))).toEqual({ email: user.email, create_user: false })
    expect(await f.deps.hardDelete(user.id)).toBe('absent')
    expect(f.calls[2].init?.method).toBe('DELETE')
    expect(JSON.parse(String(f.calls[2].init?.body))).toEqual({ should_soft_delete: false })
    expect(f.calls[2].init?.headers).toMatchObject({ authorization: 'Bearer server', apikey: 'server' })
  })
  it('does not confuse an uncertain deletion or an existing Auth user with success', async () => {
    const f = adapter([{ status: 200, body: user }, { status: 500 }, { status: 200, body: user }])
    expect(await f.deps.hardDelete(user.id)).toBe('failed')
    const g = adapter([{ status: 200, body: user }])
    expect(await g.deps.hardDelete(user.id)).toBe('unknown')
  })
})
