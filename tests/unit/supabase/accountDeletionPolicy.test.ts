import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createAccountDeletionOperationHandler, type OperationDependencies } from '../../../supabase/functions/_shared/account-deletion-operation-core'
import { sha256 } from '../../../supabase/functions/_shared/account-deletion-core'

const user = { id: randomUUID(), sessionId: randomUUID(), email: 'Owner@fixture.invalid' }
const policy = { protocol_version: 2, available: false, deletion: 'immediate', credit_treatment: 'forfeit_remaining',
  consent_version: 'immediate-forfeit-v1', device_preparation_required: true }
function fixture() {
  const deps: OperationDependencies = {
    currentUser: vi.fn(async () => user), flow: vi.fn(async () => ({ ok: true, policy })),
    sendCode: vi.fn(), verifyCode: vi.fn(), hardDelete: vi.fn(),
  }
  const handler = createAccountDeletionOperationHandler(deps)
  const call = (auth = true, method = 'GET') => handler(new Request('https://fixture.invalid/account-deletion/v2/status',
    { method, headers: auth ? { authorization: 'Bearer fixture' } : {} }))
  return { deps, call }
}
describe('read-only V2 policy transport', () => {
  it.each([false, true])('returns only validated policy with available=%s', async available => {
    const f = fixture()
    vi.mocked(f.deps.flow).mockResolvedValue({ ok: true, policy: { ...policy, available, user_id: user.id, private_value: 'secret' } })
    const response = await f.call()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ policy: { ...policy, available } })
    expect(f.deps.flow).toHaveBeenCalledExactlyOnceWith({ p_action: 'status', p_operation_digest: null, p_receipt_digest: null,
      p_user_id: user.id, p_session_id: user.sessionId, p_email_digest: await sha256(user.email.toLowerCase()) })
    expect(f.deps.sendCode).not.toHaveBeenCalled()
    expect(f.deps.verifyCode).not.toHaveBeenCalled()
    expect(f.deps.hardDelete).not.toHaveBeenCalled()
  })
  it('requires verified Auth and uses no caller-provided identity', async () => {
    const f = fixture()
    expect((await f.call(false)).status).toBe(401)
    expect(f.deps.flow).not.toHaveBeenCalled()
    vi.mocked(f.deps.currentUser).mockResolvedValue(null)
    expect((await f.call()).status).toBe(401)
    expect(f.deps.flow).not.toHaveBeenCalled()
  })
  it.each(['POST', 'PUT', 'DELETE'])('refuses %s before authentication or workflow dispatch', async method => {
    const f = fixture()
    expect((await f.call(true, method)).status).toBe(405)
    expect(f.deps.currentUser).not.toHaveBeenCalled()
    expect(f.deps.flow).not.toHaveBeenCalled()
  })
  it.each([undefined, {}, { ...policy, available: undefined }, { ...policy, protocol_version: 1 },
    { ...policy, consent_version: 'other' }, { ...policy, device_preparation_required: false }])('does not invent a policy from %j', async value => {
    const f = fixture()
    vi.mocked(f.deps.flow).mockResolvedValue({ ok: true, policy: value })
    const response = await f.call()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'unavailable' })
  })
  it('contains backend failures without exposing diagnostics or creating a receipt', async () => {
    const f = fixture()
    vi.mocked(f.deps.flow).mockRejectedValue(Error('private SQL diagnostic'))
    const response = await f.call()
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('{"error":"unavailable"}')
    expect(f.deps.sendCode).not.toHaveBeenCalled()
    expect(f.deps.verifyCode).not.toHaveBeenCalled()
    expect(f.deps.hardDelete).not.toHaveBeenCalled()
  })
})
