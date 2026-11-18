import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { invitationMessage, teamInvitationMailer } from '../../../supabase/functions/_shared/team-invitation-mailer'

vi.mock('npm:nodemailer@10.5.0', () => ({ default: { createTransport: () => { throw Error('No implicit SMTP transport in unit tests') } } }))
const settings: Record<string, string> = { TEAM_INVITE_MAIL_ENABLED: 'true', TEAM_INVITE_SMTP_HOST: 'smtp.example.invalid',
  TEAM_INVITE_SMTP_PORT: '2587', TEAM_INVITE_SMTP_USER: 'fixture', TEAM_INVITE_SMTP_PASSWORD: 'fixture',
  TEAM_INVITE_SMTP_FROM: 'sender@example.invalid', TEAM_INVITE_SMTP_TLS_MODE: 'starttls', TEAM_INVITE_TEST_RECIPIENT: 'recipient@example.invalid' }
const input = () => ({ operationId: randomUUID(), invitationId: randomUUID(), to: 'recipient@example.invalid', teamName: 'Team <friends> & "family"',
  invitationUrl: 'https://site.example.invalid/team/invite?region=cn#invitation_token=' + 'a'.repeat(64), expiresAt: '2099-11-20T00:00:00Z' })
function fixture(changes: Record<string, string | undefined> = {}) {
  const env = { ...settings, ...changes }, transport = { sendMail: vi.fn().mockResolvedValue({ accepted: ['recipient@example.invalid'], rejected: [] }), close: vi.fn() }
  const factory = vi.fn().mockReturnValue(transport)
  return { mailer: teamInvitationMailer(k => env[k], factory), factory, transport }
}
describe('server-configured invitation SMTP adapter', () => {
  it.each(['TEAM_INVITE_MAIL_ENABLED', 'TEAM_INVITE_SMTP_HOST', 'TEAM_INVITE_SMTP_PASSWORD'])('never connects with missing %s', async key => {
    const f = fixture({ [key]: undefined })
    expect(f.mailer.canSend(input().to)).toBe(false)
    expect(await f.mailer.send(input())).toEqual({ state: 'failed', reason_code: 'smtp_rejected' })
    expect(f.factory).not.toHaveBeenCalled()
  })
  it.each(['none', 'plaintext', 'opportunistic'])('rejects insecure TLS mode %s', mode => {
    const f = fixture({ TEAM_INVITE_SMTP_TLS_MODE: mode }); expect(f.mailer.canSend(input().to)).toBe(false)
  })
  it('sends only to the approved existing test target and never redirects another recipient', async () => {
    const f = fixture(), other = { ...input(), to: 'other@example.invalid' }
    expect(f.mailer.canSend(other.to)).toBe(false)
    expect(await f.mailer.send(other)).toEqual({ state: 'failed', reason_code: 'recipient_not_allowed' }); expect(f.factory).not.toHaveBeenCalled()
  })
  it.each([undefined, '', '  ', ',', 'recipient@example.invalid,', 'invalid', 'recipient@example.invalid,invalid',
    '*@example.invalid', 'recipient@*.invalid', 'recipient@example..invalid', 'recipient@example.invalid\r\nBcc: other@example.invalid'])('closes the entire missing or malformed list: %j', async value => {
    const f = fixture({ TEAM_INVITE_TEST_RECIPIENT: value, TEAM_INVITE_ALLOW_ALL: 'true' })
    expect(f.mailer.recipientPolicy(input().to)).toBe('blocked')
    expect(f.mailer.canSend(input().to)).toBe(false)
    expect(await f.mailer.send(input())).toEqual({ state: 'failed', reason_code: 'recipient_not_allowed' })
    expect(f.factory).not.toHaveBeenCalled(); expect(f.transport.sendMail).not.toHaveBeenCalled()
  })
  it('normalizes case and outer spaces and allows each complete address in a multi-recipient list', async () => {
    const f = fixture({ TEAM_INVITE_TEST_RECIPIENT: ' Recipient@Example.Invalid , Second@Example.Invalid ' })
    for (const to of [' recipient@EXAMPLE.invalid ', 'SECOND@example.invalid']) {
      const canonical = to.trim().toLowerCase()
      f.transport.sendMail.mockResolvedValue({ accepted: [canonical], rejected: [] })
      expect(f.mailer.recipientPolicy(to)).toBe('allowed')
      expect(await f.mailer.send({ ...input(), to })).toEqual({ state: 'accepted', reason_code: 'smtp_accepted' })
      expect(f.transport.sendMail.mock.calls.at(-1)?.[0].envelope.to).toEqual([canonical])
    }
    expect(f.mailer.recipientPolicy('suffixrecipient@example.invalid')).toBe('blocked')
    expect(f.mailer.recipientPolicy('recipient@sub.example.invalid')).toBe('blocked')
  })
  it.each(['recipient@example.invalid\r\n', 'recipient@example.invalid\nBcc: other@example.invalid', 'recipient@example.invalid,other@example.invalid'])('refuses injected or multiple recipient inputs without opening SMTP', async to => {
    const f = fixture()
    expect(await f.mailer.send({ ...input(), to })).toEqual({ state: 'failed', reason_code: 'recipient_not_allowed' })
    expect(f.factory).not.toHaveBeenCalled()
  })
  it('requires STARTTLS and certificate validation with bounded, nonlogging transport options', async () => {
    const f = fixture()
    expect(await f.mailer.send(input())).toEqual({ state: 'accepted', reason_code: 'smtp_accepted' })
    expect(f.factory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ port: 2587, secure: false, requireTLS: true,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, debug: false, logger: false, transactionLog: false,
      disableFileAccess: true, disableUrlAccess: true }))
    expect(f.transport.close).toHaveBeenCalledTimes(1)
  })
  it('supports explicit implicit TLS without permitting cleartext fallback', async () => {
    const f = fixture({ TEAM_INVITE_SMTP_TLS_MODE: 'implicit_tls' }); await f.mailer.send(input())
    expect(f.factory.mock.calls[0][0]).toMatchObject({ secure: true, requireTLS: false, tls: { rejectUnauthorized: true } })
  })
  it('escapes HTML, uses one fixed envelope and keeps a stable message id', () => {
    const value = input(), first = invitationMessage(value, settings.TEAM_INVITE_SMTP_FROM), second = invitationMessage(value, settings.TEAM_INVITE_SMTP_FROM)
    expect(first.html).toContain('&lt;friends&gt; &amp; &quot;family&quot;')
    expect(first.html).not.toContain('<friends>'); expect(first.text).toContain(value.invitationUrl)
    expect(first.envelope).toEqual({ from: 'sender@example.invalid', to: ['recipient@example.invalid'] })
    expect(first.messageId).toBe(second.messageId); expect(first.messageId).toContain(value.invitationId)
  })
  it.each(['http://site.example.invalid/team/invite?region=cn#invitation_token=', 'https://site.example.invalid/elsewhere?region=cn#invitation_token=',
    'https://site.example.invalid/team/invite?region=cn&region=hk#invitation_token='])('rejects an invalid destination %s before opening SMTP', async prefix => {
    const f = fixture(); expect((await f.mailer.send({ ...input(), invitationUrl: prefix + 'a'.repeat(64) })).state).toBe('failed')
    expect(f.factory).not.toHaveBeenCalled()
  })
  it('rejects mailbox lists and control characters', () => {
    const f = fixture({ TEAM_INVITE_TEST_RECIPIENT: 'one,two@example.invalid' })
    expect(f.mailer.canSend('one,two@example.invalid')).toBe(false)
    expect(() => invitationMessage({ ...input(), teamName: 'Team\r\nInjected' }, settings.TEAM_INVITE_SMTP_FROM)).toThrow()
  })
  it.each(['ETIMEDOUT', 'ECONNECTION'])('distinguishes explicit rejection from a lost final DATA reply (%s)', async code => {
    const rejected = fixture(); rejected.transport.sendMail.mockRejectedValue({ responseCode: 550, command: 'DATA', response: 'private diagnostic' })
    expect(await rejected.mailer.send(input())).toEqual({ state: 'failed', reason_code: 'smtp_rejected' })
    const unknown = fixture(); unknown.transport.sendMail.mockRejectedValue({ code, command: 'DATA', message: 'private diagnostic' })
    expect(await unknown.mailer.send(input())).toEqual({ state: 'unknown', reason_code: 'smtp_result_unknown' })
    expect(unknown.transport.close).toHaveBeenCalledTimes(1)
  })
  it('does not claim acceptance for an unexpected SMTP recipient receipt', async () => {
    const f = fixture(); f.transport.sendMail.mockResolvedValue({ accepted: ['other@example.invalid'], rejected: [] })
    expect((await f.mailer.send(input())).state).toBe('unknown')
  })
})
