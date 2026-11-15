import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { TeamRefusal } from '../../../supabase/functions/_shared/team-accounts-contract'
import { teamMailFlow } from '../../../supabase/functions/_shared/team-mail-flow'

function fixture() {
  const id = randomUUID(), invitationId = randomUUID(), lease = randomUUID()
  let state = 'pending'
  const rpc = vi.fn(async (_name: string, args: Record<string, any>) => {
    if (args.p_action === 'finish') state = args.p_input.state
    const claimed = args.p_action === 'claim' && state === 'pending'
    if (claimed) state = 'sending'
    return { delivery_id: id, state, claimed, lease_token: claimed ? lease : null,
      recipient_email: 'recipient@example.invalid', team_name: 'Server team', expires_at: '2026-11-20T00:00:00Z' }
  })
  const auth = { ensureAnchor: vi.fn().mockResolvedValue(true), sendEmailCode: vi.fn().mockResolvedValue(true) }
  const mailer = { canSend: vi.fn().mockReturnValue(true), send: vi.fn().mockResolvedValue({ state: 'accepted', reason_code: 'smtp_accepted' }) }
  const flow = teamMailFlow({ auth, rpc, invitationMailer: mailer })
  const actor = { id: randomUUID(), sessionId: randomUUID(), email: 'admin@example.invalid', accountKind: 'team_member' }
  const request = new Request('https://edge.invalid/', { headers: { 'x-forwarded-for': '203.0.113.99', 'x-real-ip': '203.0.113.98' } })
  const response = () => ({ operation_id: randomUUID(), invitation_created: true, invitation_url: 'https://site.invalid/team/invite#invitation_token=opaque' })
  const invite = () => flow.sendInvitation({ invitation_id: invitationId }, response(), request, actor)
  return { flow, auth, rpc, mailer, id, invitationId, lease, actor, request, response, invite, setState: (next: string) => { state = next } }
}
describe('team mail side effects follow durable admission', () => {
  it('takes the frozen server recipient and sends only after successful admission', async () => {
    const f = fixture(), result = await f.invite()
    expect(result.delivery.state).toBe('accepted')
    expect(f.rpc.mock.calls.map(([, args]) => args.p_action)).toEqual(['prepare', 'claim', 'finish'])
    expect(f.rpc.mock.calls[1][1]).toMatchObject({ p_actor: f.actor.id, p_session: f.actor.sessionId, p_client_ip: null })
    expect(f.rpc.mock.invocationCallOrder[1]).toBeLessThan(f.auth.ensureAnchor.mock.invocationCallOrder[0])
    expect(f.auth.ensureAnchor).toHaveBeenCalledExactlyOnceWith('recipient@example.invalid')
    expect(f.mailer.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: 'recipient@example.invalid', teamName: 'Server team', invitationId: f.invitationId }))
    expect(JSON.stringify(result)).not.toContain(f.lease)
  })
  it('does not send or create an Auth anchor when any quota refuses admission', async () => {
    const f = fixture(), implementation = f.rpc.getMockImplementation()!
    f.rpc.mockImplementation((name, args) => args.p_action === 'claim'
      ? Promise.reject(new TeamRefusal('rate_limited', 429)) : implementation(name, args))
    await expect(f.invite()).rejects.toMatchObject({ status: 429, details: { invitation_created: true, delivery: { state: 'pending', reason_code: 'rate_limited' } } })
    expect(f.auth.ensureAnchor).not.toHaveBeenCalled(); expect(f.mailer.send).not.toHaveBeenCalled()
  })
  it('keeps a receipt but makes no outbound request when mail is unconfigured', async () => {
    const f = fixture(); f.mailer.canSend.mockReturnValue(false)
    await expect(f.invite()).rejects.toMatchObject({ status: 503, details: { invitation_created: true, delivery: { state: 'pending', reason_code: 'mail_not_configured' } } })
    expect(f.rpc.mock.calls.map(([, args]) => args.p_action)).toEqual(['prepare'])
    expect(f.auth.ensureAnchor).not.toHaveBeenCalled(); expect(f.mailer.send).not.toHaveBeenCalled()
    try { await f.invite() } catch (error) { expect((error as TeamRefusal).details).not.toHaveProperty('invitation_url') }
  })
  it('replays a persisted acceptance even if SMTP settings have since closed', async () => {
    const f = fixture(); await f.invite(); f.mailer.canSend.mockReturnValue(false)
    expect((await f.invite()).delivery.state).toBe('accepted')
    expect(f.mailer.send).toHaveBeenCalledTimes(1)
  })
  it.each(['failed', 'unknown', 'sending'])('never automatically resends a persisted %s outcome', async state => {
    const f = fixture(); f.setState(state)
    await expect(f.invite()).rejects.toMatchObject({ details: { invitation_created: true, delivery: { state } } })
    expect(f.auth.ensureAnchor).not.toHaveBeenCalled(); expect(f.mailer.send).not.toHaveBeenCalled()
  })
  it('records uncertain SMTP outcomes and does not expose their diagnostics', async () => {
    const f = fixture(); f.mailer.send.mockRejectedValue(Error('private SMTP diagnostic'))
    await expect(f.invite()).rejects.toMatchObject({ details: { delivery: { state: 'unknown', reason_code: 'smtp_result_unknown' } } })
    await expect(f.invite()).rejects.toMatchObject({ details: { delivery: { state: 'unknown' } } })
    expect(f.mailer.send).toHaveBeenCalledTimes(1)
    expect(f.rpc.mock.calls.at(-2)?.[1].p_input).toMatchObject({ state: 'unknown', reason_code: 'smtp_result_unknown' })
  })
  it('does not turn a lost persistence acknowledgment after SMTP acceptance into a second send', async () => {
    const f = fixture(), implementation = f.rpc.getMockImplementation()!
    f.rpc.mockImplementation((name, args) => args.p_action === 'finish'
      ? Promise.reject(Error('lost persistence acknowledgment')) : implementation(name, args))
    await expect(f.invite()).rejects.toMatchObject({ details: { delivery: { state: 'unknown' } } })
    await expect(f.invite()).rejects.toMatchObject({ details: { delivery: { state: 'sending' } } })
    expect(f.mailer.send).toHaveBeenCalledTimes(1)
  })
  it('never calls SMTP after the identity prerequisite fails', async () => {
    const f = fixture(); f.auth.ensureAnchor.mockResolvedValue(false)
    await expect(f.invite()).rejects.toMatchObject({ details: { delivery: { state: 'failed', reason_code: 'identity_unavailable' } } })
    expect(f.mailer.send).not.toHaveBeenCalled()
    try { await f.invite() } catch (error) { expect((error as TeamRefusal).details).not.toHaveProperty('invitation_url') }
  })
  it('puts official code sends behind the same admission and reuses accepted code receipts', async () => {
    const f = fixture(), challenge = { challenge_id: randomUUID(), email: 'code@example.invalid' }
    await f.flow.sendCode(challenge, f.request)
    await f.flow.sendCode(challenge, f.request)
    expect(f.auth.sendEmailCode).toHaveBeenCalledExactlyOnceWith(challenge.email)
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_client_ip: null, p_input: { kind: 'code', challenge_id: challenge.challenge_id } })
  })
})
