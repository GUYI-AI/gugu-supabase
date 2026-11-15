import { describe, expect, it, vi } from 'vitest'
import { createTeamAccountsHandler, type TeamAccountsDependencies } from '../../../supabase/functions/_shared/team-accounts-core'
const challengeId = '3c939680-61f2-430a-b8e8-b4569cf8a212'
function fixture() {
  const rpc = vi.fn(), auth = { currentCaller: vi.fn().mockResolvedValue(null), sendEmailCode: vi.fn(), verifyEmailCode: vi.fn() }
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
})
