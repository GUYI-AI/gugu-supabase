import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createAccountDeletionEntry } from '../../../supabase/functions/_shared/account-deletion-entry'
import type { DeletionDependencies } from '../../../supabase/functions/_shared/account-deletion-core'
import type { OperationDependencies } from '../../../supabase/functions/_shared/account-deletion-operation-core'

function fixture() {
  const common = { currentUser: vi.fn(), sendCode: vi.fn(), verifyCode: vi.fn(), hardDelete: vi.fn() }
  const legacy: DeletionDependencies = { ...common, flow: vi.fn() }
  const operation: OperationDependencies = { ...common, flow: vi.fn(async () => ({ ok: true,
    operation: { operation_id: randomUUID(), state: 'processing', revision: 1, challenge_generation: 1, request_id: randomUUID(), can_retry: false } })) }
  return { legacy, operation, handle: createAccountDeletionEntry(legacy, operation) }
}
const body = { local_operation_id: randomUUID(), receipt_token: 'a'.repeat(64) }
const request = (path: string, input = body) => new Request('https://fixture.invalid' + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
})
describe('deployed account-deletion version boundary', () => {
  it.each(['/account-deletion/v2/result', '/functions/v1/account-deletion/v2/result', '/v2/result'])('recovers V2 without Auth at %s', async path => {
    const f = fixture(), reply = await f.handle(request(path))
    expect(reply.status).toBe(200)
    expect(f.operation.flow).toHaveBeenCalledOnce()
    expect(f.legacy.flow).not.toHaveBeenCalled()
    expect(f.operation.currentUser).not.toHaveBeenCalled()
    expect(f.operation.hardDelete).not.toHaveBeenCalled()
    expect(await reply.text()).not.toContain(body.receipt_token)
  })
  it.each(['retry', 'unknown', 'v2'])('never falls back for unsupported V2 action %s', async action => {
    const f = fixture()
    expect((await f.handle(request('/account-deletion/v2/' + action))).status).toBe(404)
    expect(f.legacy.flow).not.toHaveBeenCalled(); expect(f.operation.flow).not.toHaveBeenCalled()
    expect(f.legacy.currentUser).not.toHaveBeenCalled()
  })
  it('keeps the legacy receipt domain on its original path', async () => {
    const f = fixture()
    expect((await f.handle(request('/account-deletion/result'))).status).toBe(400)
    expect(f.operation.flow).not.toHaveBeenCalled()
  })
  it('preserves a closed V2 gate and contains dependency errors', async () => {
    const f = fixture()
    vi.mocked(f.operation.flow).mockResolvedValueOnce({ ok: false, error: 'operation_unavailable', status: 503 })
    expect((await f.handle(request('/account-deletion/v2/result'))).status).toBe(503)
    vi.mocked(f.operation.flow).mockRejectedValueOnce(Error('private backend diagnostics'))
    const failed = await f.handle(request('/account-deletion/v2/result'))
    expect(await failed.text()).toBe('{"error":"unavailable"}')
    expect(f.legacy.flow).not.toHaveBeenCalled()
  })
})
