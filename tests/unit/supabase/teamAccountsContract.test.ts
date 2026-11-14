import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assetRecipient, authorizeMemberChange, parseTeamWrite, TeamRefusal, type TeamMember, type TeamRole } from '../../../supabase/functions/_shared/team-accounts-contract'

const team = randomUUID()
const member = (role: TeamRole = 'member', extra: Partial<TeamMember> = {}): TeamMember => ({ id: randomUUID(), team_id: team, identity_id: randomUUID(), role, state: 'active', revision: 3, ...extra })
const receipt = 'a'.repeat(43), key = randomUUID()
describe('team identity wire contract', () => {
  it('accepts the email, creation, invitation and explicit handoff contracts', () => {
    expect(parseTeamWrite({ action: 'email_challenge', email: ' Person@Example.Invalid ', purpose: 'create' }).email).toBe('person@example.invalid')
    expect(parseTeamWrite({ action: 'create', name: ' Team ', verification_receipt: receipt, idempotency_key: key }).name).toBe('Team')
    expect(parseTeamWrite({ action: 'email_verify', challenge_id: key, code: '123456' }).code).toBe('123456')
    expect(parseTeamWrite({ action: 'invite', email: 'person@example.invalid', role: 'member', idempotency_key: key }).role).toBe('member')
    expect(parseTeamWrite({ action: 'disable', member_id: key, handoff_member_id: team, expected_revision: 3, idempotency_key: key }).handoff_member_id).toBe(team)
  })
  it.each(['actor_id', 'owner_user_id', 'payer_id', 'region', 'is_admin', '__proto__'])('rejects client authority %s instead of pretending to honor it', field => {
    const body = JSON.parse(JSON.stringify({ action: 'create', name: 'Team', verification_receipt: receipt, idempotency_key: key }).slice(0, -1) + `,"${field}":"forged"}`)
    expect(() => parseTeamWrite(body)).toThrow(TeamRefusal)
  })
  it.each([
    { action: 'email_verify', challenge_id: key, code: '12\n456' },
    { action: 'email_challenge', email: 'person@example.invalid', purpose: 'create', team_id: team },
    { action: 'email_challenge', email: 'person@example.invalid', purpose: 'accept_invitation' },
    { action: 'invite', email: 'person@example.invalid', role: 'admin', idempotency_key: key },
    { action: 'set_role', member_id: key, role: 'superadmin', expected_revision: 3, idempotency_key: key },
    { action: 'disable', member_id: key, expected_revision: 0, idempotency_key: key },
    { action: 'disable', member_id: key, expected_revision: 3.2, idempotency_key: key },
    { action: 'create', name: 'Team', verification_receipt: 'short', idempotency_key: key },
  ])('rejects malformed or privilege-changing intent %#', request => {
    expect(() => parseTeamWrite(request)).toThrow(TeamRefusal)
  })
})
describe('team membership boundaries with server-derived snapshots', () => {
  it.each([
    ['superadmin', 'member', true], ['superadmin', 'admin', true], ['superadmin', 'superadmin', false],
    ['admin', 'member', true], ['admin', 'admin', false], ['admin', 'superadmin', false],
    ['member', 'member', false], ['member', 'admin', false], ['member', 'superadmin', false],
  ] as const)('%s may disable %s: %s', (role, targetRole, allowed) => {
    const call = () => authorizeMemberChange('disable', member(role), member(targetRole), 3)
    if (allowed) expect(call).not.toThrow(); else expect(call).toThrow(TeamRefusal)
  })
  it('prevents inactive, self, cross-team and stale-revision mutations', () => {
    const actor = member('superadmin'), target = member()
    expect(() => authorizeMemberChange('disable', { ...actor, state: 'disabled' }, target, 3)).toThrow('membership_disabled')
    expect(() => authorizeMemberChange('disable', actor, actor, 3)).toThrow('forbidden')
    expect(() => authorizeMemberChange('disable', actor, { ...target, team_id: randomUUID() }, 3)).toThrow('not_found')
    expect(() => authorizeMemberChange('disable', actor, target, 2)).toThrow('version_conflict')
    expect(() => authorizeMemberChange('set_role', member('admin'), target, 3)).toThrow('forbidden')
    expect(() => authorizeMemberChange('restore', actor, target, 3)).toThrow('version_conflict')
    expect(() => authorizeMemberChange('restore', actor, { ...target, state: 'disabled' }, 3)).not.toThrow()
  })
  it('defaults handoff to the active highest administrator and rejects out-of-team or disabled recipients', () => {
    const target = member(), highest = member('superadmin'), chosen = member()
    expect(assetRecipient(target, undefined, highest)).toBe(highest.id)
    expect(assetRecipient(target, chosen, highest)).toBe(chosen.id)
    for (const invalid of [target, { ...chosen, state: 'disabled' as const }, { ...chosen, team_id: randomUUID() }]) {
      expect(() => assetRecipient(target, invalid, highest)).toThrow('invalid_recipient')
    }
    expect(() => assetRecipient(target, undefined, chosen)).toThrow('invalid_recipient')
  })
})
