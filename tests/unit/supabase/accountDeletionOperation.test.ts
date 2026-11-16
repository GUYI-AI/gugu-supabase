import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createAccountDeletionOperationHandler, type OperationArgs, type OperationDependencies, type OperationReply } from '../../../supabase/functions/_shared/account-deletion-operation-core'

const owner = { id: randomUUID(), sessionId: randomUUID(), email: 'owner@fixture.invalid' }
const secret = 'a'.repeat(64), operationId = randomUUID(), requestId = randomUUID(), lease = randomUUID()
const operation = (state = 'open') => ({ operation_id: operationId, state, revision: 1, challenge_generation: 1, request_id: requestId, can_retry: false })
const proof = { local_operation_id: randomUUID(), receipt_token: secret, generation: 1, consent_version: 'immediate-forfeit-v1' }
const confirm = { ...proof, confirmation_id: randomUUID(), native_generation: randomUUID(), server_generation: randomUUID(), code: '123456', acknowledge_forfeit: true }
function fixture() {
  const deps: OperationDependencies = {
    currentUser: vi.fn(async () => owner), sendCode: vi.fn(async () => true),
    verifyCode: vi.fn(async () => ({ id: owner.id, email: owner.email })), hardDelete: vi.fn(async () => 'unknown' as const),
    flow: vi.fn(async (args: OperationArgs): Promise<OperationReply> => {
      if (args.p_action === 'claim_confirmation' || args.p_action === 'begin') return { ok: true, operation: operation(), dispatch_required: true, lease_token: lease }
      if (args.p_action === 'verified' || args.p_action === 'execute') return { ok: true, operation: operation('processing'), user_id: owner.id, lease_token: lease,
        request: { request_id: requestId, state: 'processing', expires_at: '2030-01-01T00:00:00Z', can_retry: false, last_error: null } }
      return { ok: true, operation: operation(args.p_action === 'finish' ? 'processing' : 'open') }
    }),
  }
  const handler = createAccountDeletionOperationHandler(deps)
  const call = (route: string, body: unknown, auth = true) => handler(new Request('http://fixture/operation/' + route,
    { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer fixture' } : {}) }, body: JSON.stringify(body) }))
  return { deps, call }
}
describe('closed operation HTTP protocol', () => {
  it('does not mint or return a receipt and binds only the Auth caller', async () => {
    const f = fixture(), response = await f.call('register', { ...proof, user_id: randomUUID(), session_id: randomUUID() })
    expect(response.status).toBe(200)
    expect(f.deps.flow).toHaveBeenCalledWith(expect.objectContaining({ p_user_id: owner.id, p_session_id: owner.sessionId }))
    const text = await response.text()
    for (const value of [secret, owner.email, owner.id, lease]) expect(text).not.toContain(value)
  })
  it('recovers by original operation and pre-persisted capability without live Auth', async () => {
    const f = fixture()
    expect((await f.call('result', proof, false)).status).toBe(200)
    expect(f.deps.currentUser).not.toHaveBeenCalled()
    expect(f.deps.sendCode).not.toHaveBeenCalled(); expect(f.deps.verifyCode).not.toHaveBeenCalled(); expect(f.deps.hardDelete).not.toHaveBeenCalled()
    expect(f.deps.flow).toHaveBeenCalledWith(expect.objectContaining({ p_action: 'result', p_operation_digest: expect.any(String), p_receipt_digest: expect.any(String) }))
  })
  it('never sends another OTP for an idempotent challenge replay', async () => {
    const f = fixture(); vi.mocked(f.deps.flow).mockResolvedValue({ ok: true, operation: operation(), dispatch_required: false })
    expect((await f.call('challenge', proof)).status).toBe(200)
    expect(f.deps.sendCode).not.toHaveBeenCalled()
  })
  it('keeps a lost send outcome uncertain rather than granting a new send', async () => {
    const f = fixture(); vi.mocked(f.deps.sendCode).mockRejectedValue(new Error('private diagnostics'))
    const response = await f.call('challenge', proof)
    expect(response.status).toBe(202)
    expect(f.deps.flow).toHaveBeenLastCalledWith(expect.objectContaining({ p_action: 'sent', p_error_code: 'email_outcome_unknown', p_lease_token: lease }))
    expect(f.deps.sendCode).toHaveBeenCalledOnce()
  })
  it('replays a final confirmation as readback without consuming any new code', async () => {
    const f = fixture(); vi.mocked(f.deps.flow).mockResolvedValue({ ok: true, operation: operation('processing'), dispatch_required: false })
    expect((await f.call('confirm', confirm)).status).toBe(202)
    expect(f.deps.verifyCode).not.toHaveBeenCalled(); expect(f.deps.hardDelete).not.toHaveBeenCalled()
  })
  it('retains an unknown DELETE outcome and never stores the code in RPC arguments', async () => {
    const f = fixture(), response = await f.call('confirm', confirm)
    expect(response.status).toBe(202)
    expect(f.deps.verifyCode).toHaveBeenCalledWith(owner.email, confirm.code)
    expect(f.deps.hardDelete).toHaveBeenCalledOnce()
    for (const [args] of vi.mocked(f.deps.flow).mock.calls) expect(JSON.stringify(args)).not.toContain(confirm.code)
    expect(f.deps.flow).toHaveBeenLastCalledWith(expect.objectContaining({ p_action: 'finish', p_error_code: 'outcome_unknown' }))
  })
  it.each(['state_conflict', 'authorization_expired', 'closure_not_prepared'])('does not delete when execution refuses %s', async error => {
    const f = fixture(), original = f.deps.flow
    f.deps.flow = vi.fn(async args => args.p_action === 'execute' ? { ok: false, error, status: 409 } : original(args))
    expect((await f.call('confirm', confirm)).status).toBe(409)
    expect(f.deps.hardDelete).not.toHaveBeenCalled()
  })
  it('does not substitute restoration for explicit consent, OTP or original identity', async () => {
    const f = fixture()
    expect((await f.call('confirm', { ...confirm, acknowledge_forfeit: false })).status).toBe(400)
    expect((await f.call('confirm', { ...confirm, code: '' })).status).toBe(400)
    vi.mocked(f.deps.verifyCode).mockResolvedValue({ id: randomUUID(), email: owner.email })
    expect((await f.call('confirm', confirm)).status).toBe(422)
    expect(f.deps.hardDelete).not.toHaveBeenCalled()
  })
  it('contains unavailable dependencies and does not fall back to legacy deletion', async () => {
    const f = fixture(); vi.mocked(f.deps.flow).mockRejectedValue(new Error('private diagnostics'))
    const response = await f.call('confirm', confirm)
    expect(response.status).toBe(503); expect(await response.text()).toBe('{"error":"unavailable"}')
    expect(f.deps.hardDelete).not.toHaveBeenCalled()
  })
})
