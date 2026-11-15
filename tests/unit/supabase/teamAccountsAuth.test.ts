import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { teamAuth, type PrincipalPlan } from '../../../supabase/functions/_shared/team-accounts-auth'
const plan: PrincipalPlan = { member_id: randomUUID(), team_id: randomUUID(), alias: 'routing@example.invalid', name: 'Test', region: 'cn' }
const principalId = randomUUID()
const user = () => ({ id: principalId, email: plan.alias, email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: {
  gugu_account_kind: 'team_member', gugu_team_id: plan.team_id, gugu_member_id: plan.member_id, gugu_team_region: plan.region,
} })
function adapter(responses: unknown[]) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }))
  return { api: teamAuth({ url: 'https://auth.example.invalid', anonKey: 'public-test', serviceKey: 'server-test', fetch: fetcher as typeof fetch }), fetcher }
}
describe('team official Auth adapter', () => {
  it('uses the raw HTTP generate-link shape and verifies the existing team principal twice', async () => {
    const session = { access_token: 'temporary-test', refresh_token: 'refresh-test', user: user() }
    const { api, fetcher } = adapter([user(), { ...user(), hashed_token: 'opaque-test' }, session])
    expect(await api.issueSession(principalId, plan)).toEqual(session)
    expect(fetcher.mock.calls).toHaveLength(3)
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][]
    expect(JSON.parse(String(calls[2][1].body))).toEqual({ type: 'email', token_hash: 'opaque-test' })
  })
  it('refuses an absent or rebound principal before creating a link', async () => {
    for (const invalid of [{}, { ...user(), app_metadata: { ...user().app_metadata, gugu_team_id: randomUUID() } }]) {
      const { api, fetcher } = adapter([invalid])
      await expect(api.issueSession(principalId, plan)).rejects.toThrow('authentication_unavailable')
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })
  it('locally revokes a verified session with the wrong subject instead of returning it', async () => {
    const { api, fetcher } = adapter([user(), { ...user(), hashed_token: 'opaque-test' }, {
      access_token: 'wrong-subject-test', refresh_token: 'refresh-test', user: { ...user(), id: randomUUID() },
    }, {}])
    await expect(api.issueSession(principalId, plan)).rejects.toThrow('authentication_unavailable')
    expect((fetcher.mock.calls as unknown as [string][])[3][0]).toContain('/logout?scope=local')
  })
  it('discards the official OTP session after verification and returns no credentials', async () => {
    const { api, fetcher } = adapter([{ access_token: 'otp-test', user: { ...user(), email: 'member@example.invalid' } }, {}])
    expect(await api.verifyEmailCode('member@example.invalid', '123456')).toEqual({ id: principalId, email: 'member@example.invalid' })
    expect((fetcher.mock.calls as unknown as [string][])[1][0]).toContain('/logout?scope=local')
  })
  it('requires Auth-verified Google identity data and a matching current session subject', async () => {
    const sessionId = randomUUID(), token = 'header.' + btoa(JSON.stringify({ sub: principalId, session_id: sessionId })) + '.signature'
    for (const [identity, expected] of [
      [{ provider: 'google', identity_data: { email_verified: true, email: plan.alias } }, true],
      [{ provider: 'google', identity_data: { email_verified: false, email: plan.alias } }, false],
      [{ provider: 'google', identity_data: { email_verified: true, email: 'other@example.invalid' } }, false],
      [{ provider: 'email', identity_data: { email_verified: true, email: plan.alias } }, false],
    ] as const) {
      const { api } = adapter([{ ...user(), identities: [identity] }])
      expect((await api.currentCaller(token))?.googleVerified).toBe(expected)
    }
    const { api } = adapter([user()])
    expect(await api.currentCaller('header.' + btoa(JSON.stringify({ sub: randomUUID(), session_id: sessionId })) + '.signature')).toBeNull()
  })
  it('binds invitation proofs to both private seed and invitation id', async () => {
    const { api } = adapter([]), invitation = randomUUID(), seed = randomUUID()
    const token = await api.invitationToken(invitation, seed)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await api.invitationToken(invitation, seed)).toBe(token)
    expect(await api.invitationToken(randomUUID(), seed)).not.toBe(token)
    expect(await api.invitationToken(invitation, randomUUID())).not.toBe(token)
  })
})
