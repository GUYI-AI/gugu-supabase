import { describe, expect, it, vi } from 'vitest'
import { createTeamAccountsHandler, type TeamAccountsDependencies } from '../../../supabase/functions/_shared/team-accounts-core'
import { TeamRefusal } from '../../../supabase/functions/_shared/team-accounts-contract'
const challengeId = '3c939680-61f2-430a-b8e8-b4569cf8a212'
function fixture() {
  const rpc = vi.fn(), auth = { currentCaller: vi.fn().mockResolvedValue(null), sendEmailCode: vi.fn(), verifyEmailCode: vi.fn(),
    setBan: vi.fn().mockResolvedValue(undefined), revokeSessions: vi.fn().mockResolvedValue(undefined),
    issueSession: vi.fn(), logout: vi.fn(), createPrincipal: vi.fn(), ensureAnchor: vi.fn().mockResolvedValue(true), invitationToken: vi.fn().mockResolvedValue('a'.repeat(64)) }
  const deps = { auth, rpc, revokeModel: vi.fn(), siteOrigin: 'https://site.example.invalid' } as unknown as TeamAccountsDependencies
  return { handle: createTeamAccountsHandler(deps), rpc, auth }
}
const post = (body: unknown) => new Request('https://backend.example.invalid/functions/v1/team-accounts', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
describe('team member HTTP authorization boundary', () => {
  it('permits the dashboard SDK preflight without an Auth or database side effect', async () => {
    const headers = ['authorization', 'apikey', 'content-type', 'x-client-info', 'x-gugu-credit-unit-version']
    for (const method of ['GET', 'POST']) {
      const f = fixture(), response = await f.handle(new Request('https://backend.example.invalid/functions/v1/team-accounts', {
        method: 'OPTIONS', headers: { Origin: 'https://site.example.invalid', 'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': headers.join(',') },
      }))
      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      const allowed = response.headers.get('access-control-allow-headers')?.split(',').map(value => value.trim())
      for (const header of headers) expect(allowed).toContain(header)
      expect(response.headers.get('access-control-allow-methods')?.split(',').map(value => value.trim())).toContain(method)
      expect(f.auth.currentCaller).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled()
    }
  })
  it('keeps an unauthorized profile response readable to the same cross-origin SDK', async () => {
    const f = fixture(), response = await f.handle(new Request('https://backend.example.invalid/functions/v1/team-accounts?action=profile', {
      headers: { Origin: 'https://site.example.invalid', authorization: 'Bearer invalid', 'x-gugu-credit-unit-version': '2' },
    }))
    expect(response.status).toBe(401)
    expect(response.headers.get('access-control-allow-headers')).toContain('x-gugu-credit-unit-version')
    expect((await response.json()).ok).toBe(false); expect(f.rpc).not.toHaveBeenCalled()
  })
  it('distinguishes an uncreated invitation from an uncertain database acknowledgment', async () => {
    for (const uncertain of [false, true]) {
      const f = fixture(); f.auth.currentCaller.mockResolvedValue({ id: challengeId, sessionId: challengeId, accountKind: 'team_member' })
      f.rpc.mockRejectedValue(new TeamRefusal(uncertain ? 'dependency_unavailable' : 'invitation_limit_reached', uncertain ? 503 : 429))
      const req = post({ action: 'invite', email: 'recipient@example.invalid', role: 'member', idempotency_key: 'original-invitation-key' })
      req.headers.set('authorization', 'Bearer fixture-user')
      const response = await f.handle(req), value = await response.json()
      expect(response.status).toBe(uncertain ? 503 : 429)
      expect(value.data).toMatchObject({ operation_id: null, invitation_created: uncertain ? null : false,
        delivery: { state: uncertain ? 'unknown' : 'pending' } })
      expect(f.auth.ensureAnchor).not.toHaveBeenCalled()
    }
  })
  it('keeps the original operation receipt after creation even when token binding fails', async () => {
    const f = fixture(); f.auth.currentCaller.mockResolvedValue({ id: challengeId, sessionId: challengeId, accountKind: 'team_member' })
    f.rpc.mockImplementation(async (_name, args) => {
      if (args.p_action === 'bind_invitation') throw new TeamRefusal('dependency_unavailable', 503)
      return { invitation_id: challengeId, operation_id: challengeId, seed: challengeId, region: 'cn' }
    })
    const req = post({ action: 'invite', email: 'recipient@example.invalid', role: 'member', idempotency_key: 'original-invitation-key' })
    req.headers.set('authorization', 'Bearer fixture-user')
    const response = await f.handle(req), value = await response.json()
    expect(response.status).toBe(503)
    expect(value.data).toMatchObject({ operation_id: challengeId, invitation_id: challengeId, invitation_created: true, delivery: { state: 'pending' } })
    expect(value.data).not.toHaveProperty('invitation_url'); expect(f.auth.ensureAnchor).not.toHaveBeenCalled()
  })
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
    const f = fixture(); f.rpc.mockImplementation(async (name, args) => name === 'team_mail_delivery'
      ? { delivery_id: challengeId, state: args.p_action === 'claim' ? 'sending' : 'accepted', claimed: args.p_action === 'claim', lease_token: 'private-mail-lease' }
      : { challenge_id: challengeId, expires_at: '2026-11-15T02:00:00Z', email: 'private@example.invalid', lease_token: 'private-lease' })
    f.auth.sendEmailCode.mockResolvedValue(true)
    const response = await f.handle(post({ action: 'email_challenge', email: 'private@example.invalid', purpose: 'create' }))
    expect(response.status).toBe(200)
    const value = await response.json(); expect(value.data).toEqual({ challenge_id: challengeId, expires_at: '2026-11-15T02:00:00Z', resend_after_seconds: 60 })
    expect(JSON.stringify(value)).not.toContain('private@example.invalid'); expect(JSON.stringify(value)).not.toContain('private-lease')
  })
  it('records a failed official send without pretending an email was delivered', async () => {
    const f = fixture(); f.rpc.mockImplementation(async name => name === 'team_mail_delivery'
      ? { delivery_id: challengeId, state: 'sending', claimed: true, lease_token: 'private-mail-lease' }
      : { challenge_id: challengeId, email: 'private@example.invalid' }); f.auth.sendEmailCode.mockResolvedValue(false)
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
  it('refuses a linked Google identity without a fresh official OAuth proof', async () => {
    const f = fixture(); f.auth.currentCaller.mockResolvedValue({ id: challengeId, sessionId: challengeId, accountKind: 'personal', googleVerified: false })
    const request = post({ action: 'google_sign_in' }); request.headers.set('authorization', 'Bearer synthetic-token')
    expect((await f.handle(request)).status).toBe(401); expect(f.rpc).not.toHaveBeenCalled()
  })
  it('exchanges the verified Google bearer for an independently checked team principal', async () => {
    const f = fixture(), principal = '31880bd8-1d6b-47db-9f92-adcaab6496df'
    f.auth.currentCaller.mockResolvedValueOnce({ id: challengeId, sessionId: challengeId, accountKind: 'personal', googleVerified: true })
      .mockResolvedValueOnce({ id: principal, sessionId: principal, accountKind: 'team_member' })
    f.auth.issueSession.mockResolvedValue({ access_token: 'team-session', user: { id: principal } })
    f.rpc.mockImplementation(async name => name === 'team_account_google'
      ? { membership: { id: principal, identity_id: principal }, plan: {} }
      : { membership: { identity_id: principal, state: 'active' }, context: { member_identity_id: principal } })
    const request = post({ action: 'google_sign_in' }); request.headers.set('authorization', 'Bearer synthetic-google')
    const response = await f.handle(request); expect(response.status).toBe(200)
    expect(f.rpc).toHaveBeenNthCalledWith(1, 'team_account_google', { p_actor: challengeId, p_session: challengeId, p_team_id: null })
    expect((await response.json()).data.session.user.id).toBe(principal)
    expect(f.auth.createPrincipal).not.toHaveBeenCalled()
  })
  it('keeps confirmation tied to the original member and performs Auth cleanup after verified email commit', async () => {
    const f = fixture(), order: string[] = []
    f.auth.currentCaller.mockResolvedValue({ id: challengeId, sessionId: challengeId, accountKind: 'team_member' })
    f.auth.verifyEmailCode.mockImplementation(async () => { order.push('official_verify'); return { email: 'new@example.invalid' } })
    f.auth.revokeSessions.mockImplementation(async () => { order.push('global_signout') })
    f.rpc.mockImplementation(async (_name, args) => {
      order.push(args.p_action)
      if (args.p_action === 'email_change_claim') return { stage: 'verify', email: 'new@example.invalid', lease_token: 'lease' }
      if (args.p_action === 'email_change_commit') return { stage: 'auth_cleanup', principal_id: challengeId, plan: {}, operation_id: challengeId }
      return { requires_sign_in: true }
    })
    const request = post({ action: 'confirm_email_change', challenge_id: challengeId, code: '123456', idempotency_key: 'email-original-key' })
    request.headers.set('authorization', 'Bearer original-member-session')
    const response = await f.handle(request); expect(response.status).toBe(200)
    expect(order).toEqual(['email_change_claim', 'official_verify', 'email_change_commit', 'global_signout', 'email_change_finish'])
    expect((await response.json()).data.requires_sign_in).toBe(true)
  })
})
