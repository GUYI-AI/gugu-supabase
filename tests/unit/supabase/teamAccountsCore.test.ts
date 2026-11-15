import { describe, expect, it, vi } from 'vitest'
import { createTeamAccountsHandler, type TeamAccountsDependencies } from '../../../supabase/functions/_shared/team-accounts-core'
const challengeId = '3c939680-61f2-430a-b8e8-b4569cf8a212'
function fixture() {
  const rpc = vi.fn(), auth = { currentCaller: vi.fn().mockResolvedValue(null), sendEmailCode: vi.fn(), verifyEmailCode: vi.fn(),
    setBan: vi.fn().mockResolvedValue(undefined), revokeSessions: vi.fn().mockResolvedValue(undefined) }
  const deps = { auth, rpc, revokeModel: vi.fn() } as unknown as TeamAccountsDependencies
  return { handle: createTeamAccountsHandler(deps), rpc, auth }
}
const post = (body: unknown) => new Request('https://backend.example.invalid/functions/v1/team-accounts', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
describe('team member HTTP authorization boundary', () => {
  it('does not reach a server RPC for an anonymous directory read', async () => {
    const f = fixture(), response = await f.handle(new Request('https://backend.example.invalid/functions/v1/team-accounts?action=directory'))
    expect(response.status).toBe(401); expect(f.rpc).not.toHaveBeenCalled()
  })
  it('rejects claimed actors and oversized bodies before invoking dependencies', async () => {
    for (const body of [{ action: 'sign_in', verification_receipt: 'a'.repeat(64), actor_user_id: 'claimed' },
      { action: 'email_challenge', email: 'member@example.invalid', purpose: 'create', padding: 'a'.repeat(5000) }]) {
      const f = fixture(), response = await f.handle(post(body))
      expect(response.status).toBe(400); expect(f.rpc).not.toHaveBeenCalled()
    }
  })
  it('returns only safe challenge fields instead of forwarding the server email and lease', async () => {
    const f = fixture(); f.rpc.mockResolvedValue({ challenge_id: challengeId, expires_at: '2026-11-15T02:00:00Z', email: 'private@example.invalid', lease_token: 'private-lease' })
    f.auth.sendEmailCode.mockResolvedValue(true)
    const response = await f.handle(post({ action: 'email_challenge', email: 'private@example.invalid', purpose: 'create' }))
    expect(response.status).toBe(200)
    const value = await response.json(); expect(value.data).toEqual({ challenge_id: challengeId, expires_at: '2026-11-15T02:00:00Z', resend_after_seconds: 60 })
    expect(JSON.stringify(value)).not.toContain('private@example.invalid'); expect(JSON.stringify(value)).not.toContain('private-lease')
  })
  it('records a failed official send without pretending an email was delivered', async () => {
    const f = fixture(); f.rpc.mockResolvedValue({ challenge_id: challengeId, email: 'private@example.invalid' }); f.auth.sendEmailCode.mockResolvedValue(false)
    const response = await f.handle(post({ action: 'email_challenge', email: 'private@example.invalid', purpose: 'create' }))
    expect(response.status).toBe(503)
    expect(f.rpc).toHaveBeenLastCalledWith('team_email_workflow', { p_action: 'sent', p_input: { challenge_id: challengeId, sent: false } })
  })
  it('refuses an official verification for a different email without minting a receipt', async () => {
    const f = fixture(); f.rpc.mockResolvedValue({ challenge_id: challengeId, email: 'expected@example.invalid', lease_token: 'lease' })
    f.auth.verifyEmailCode.mockResolvedValue({ id: 'synthetic', email: 'other@example.invalid' })
    const response = await f.handle(post({ action: 'email_verify', challenge_id: challengeId, code: '123456' }))
    expect(response.status).toBe(401)
    expect(f.rpc.mock.calls.some(([, args]) => args.p_action === 'verified')).toBe(false)
    expect(f.rpc).toHaveBeenLastCalledWith('team_email_workflow', { p_action: 'rejected', p_input: { challenge_id: challengeId, lease_token: 'lease' } })
  })
  it('keeps restoration disabled until unban and global session revocation both finish', async () => {
    const f = fixture(), order: string[] = [], caller = { id: challengeId, sessionId: challengeId, accountKind: 'team_member' }
    f.auth.currentCaller.mockResolvedValue(caller)
    f.rpc.mockImplementation(async (_name, args) => {
      order.push(args.p_action)
      return args.p_action === 'restore' ? { operation_id: challengeId, operation_state: 'pending', principal_id: challengeId, plan: {} }
        : { membership: { state: 'active' }, requires_sign_in: true }
    })
    f.auth.setBan.mockImplementation(async () => { order.push('unban') })
    f.auth.revokeSessions.mockImplementation(async () => { order.push('global_signout') })
    const request = post({ action: 'restore', member_id: challengeId, expected_revision: 2, idempotency_key: 'restore-original-key' })
    request.headers.set('authorization', 'Bearer synthetic-token')
    const response = await f.handle(request)
    expect(response.status).toBe(200); expect(order).toEqual(['restore', 'unban', 'global_signout', 'restore_finish'])
    expect((await response.json()).data.requires_sign_in).toBe(true)
  })
  it('does not reactivate after failed global signout or repeat Auth mutations for a completed restore', async () => {
    for (const complete of [false, true]) {
      const f = fixture(); f.auth.currentCaller.mockResolvedValue({ id: challengeId, sessionId: challengeId, accountKind: 'team_member' })
      f.rpc.mockResolvedValue({ operation_id: challengeId, operation_state: complete ? 'complete' : 'pending',
        membership: { state: complete ? 'active' : 'disabled' }, principal_id: challengeId, plan: {} })
      f.auth.revokeSessions.mockRejectedValue(Error('private Auth diagnostic'))
      const request = post({ action: 'restore', member_id: challengeId, expected_revision: 2, idempotency_key: 'restore-original-key' })
      request.headers.set('authorization', 'Bearer synthetic-token')
      const response = await f.handle(request)
      expect(response.status).toBe(complete ? 200 : 503)
      expect(f.rpc.mock.calls.some(([, args]) => args.p_action === 'restore_finish')).toBe(false)
      if (complete) { expect(f.auth.setBan).not.toHaveBeenCalled(); expect(f.auth.revokeSessions).not.toHaveBeenCalled() }
      expect(await response.text()).not.toContain('private Auth diagnostic')
    }
  })
})
