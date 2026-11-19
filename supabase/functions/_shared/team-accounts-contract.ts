/** Community identity contract. Authorization snapshots must come from the
 * database after Auth validates the caller; request bodies never supply them. */
export type TeamRole = 'superadmin' | 'admin' | 'member';
export type MemberState = 'invited' | 'provisioning' | 'active' | 'disabled';
export interface TeamMember {
  id: string; team_id: string; identity_id: string;
  role: TeamRole; state: MemberState; revision: number;
}
export class TeamRefusal extends Error {
  constructor(readonly code: string, readonly status: number, readonly details?: Record<string, unknown>) { super(code); }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WRITE_ACTIONS = ['email_challenge', 'email_verify', 'create', 'sign_in', 'google_sign_in', 'invite',
  'invitation_info', 'accept_invitation', 'set_role', 'disable', 'restore', 'change_email', 'confirm_email_change', 'revocation_result'] as const;
export type TeamWriteAction = typeof WRITE_ACTIONS[number];
type Value = string | number;
export type TeamWriteRequest = { action: TeamWriteAction } & Record<string, Value>;
const allowed: Record<TeamWriteAction, readonly string[]> = {
  email_challenge: ['email', 'purpose', 'team_id', 'invitation_token'],
  email_verify: ['challenge_id', 'code'],
  create: ['name', 'verification_receipt', 'idempotency_key'],
  sign_in: ['verification_receipt', 'team_id'],
  google_sign_in: ['team_id'],
  invite: ['email', 'role', 'idempotency_key'],
  invitation_info: ['invitation_token'],
  accept_invitation: ['invitation_token', 'verification_receipt', 'idempotency_key'],
  set_role: ['member_id', 'role', 'expected_revision', 'idempotency_key'],
  disable: ['member_id', 'handoff_member_id', 'expected_revision', 'idempotency_key'],
  restore: ['member_id', 'expected_revision', 'idempotency_key'],
  change_email: ['member_id', 'new_email', 'expected_revision', 'idempotency_key'],
  confirm_email_change: ['challenge_id', 'code', 'idempotency_key'],
  revocation_result: ['operation_id'],
};
function need(ok: unknown, code = 'invalid_request', status = 400): asserts ok {
  if (!ok) throw new TeamRefusal(code, status);
}
function text(value: unknown, max: number): string {
  need(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value));
  return value;
}
function uuid(value: unknown): string { const s = text(value, 36); need(UUID.test(s)); return s.toLowerCase(); }
function secret(value: unknown): string { const s = text(value, 256); need(/^[A-Za-z0-9_-]{43,256}$/.test(s)); return s; }
export function normalizedTeamEmail(value: unknown): string {
  const s = text(value, 254).trim().toLowerCase();
  need(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s) && s.split('@')[0].length <= 64);
  return s;
}
export function parseTeamWrite(value: unknown): TeamWriteRequest {
  need(value && typeof value === 'object' && !Array.isArray(value));
  const body = value as Record<string, unknown>;
  need(typeof body.action === 'string' && (WRITE_ACTIONS as readonly string[]).includes(body.action));
  const action = body.action as TeamWriteAction;
  // Reject claimed actors/payers/regions rather than silently ignoring a forged
  // scope while returning a result that appears to honor it.
  need(Object.keys(body).every(key => key === 'action' || allowed[action].includes(key)));
  const out: TeamWriteRequest = { action };
  for (const key of allowed[action]) {
    if (body[key] === undefined) continue;
    if (['member_id', 'handoff_member_id', 'team_id', 'challenge_id', 'operation_id'].includes(key)) out[key] = uuid(body[key]);
    else if (['verification_receipt', 'invitation_token'].includes(key)) out[key] = secret(body[key]);
    else if (key === 'expected_revision') {
      need(Number.isSafeInteger(body[key]) && (body[key] as number) > 0); out[key] = body[key] as number;
    } else if (key === 'email' || key === 'new_email') out[key] = normalizedTeamEmail(body[key]);
    else if (key === 'idempotency_key') {
      const s = text(body[key], 128); need(/^[A-Za-z0-9._-]{16,128}$/.test(s)); out[key] = s;
    } else if (key === 'name') { const s = text(body[key], 100).trim(); need(s.length); out[key] = s; }
    else if (key === 'code') { const s = text(body[key], 6); need(/^\d{6}$/.test(s)); out[key] = s; }
    else out[key] = text(body[key], 32);
  }
  const required: Record<TeamWriteAction, readonly string[]> = {
    email_challenge: ['email', 'purpose'], email_verify: ['challenge_id', 'code'],
    create: ['name', 'verification_receipt', 'idempotency_key'], sign_in: ['verification_receipt'], google_sign_in: [],
    invite: ['email', 'role', 'idempotency_key'],
    invitation_info: ['invitation_token'],
    accept_invitation: ['invitation_token', 'verification_receipt', 'idempotency_key'],
    set_role: ['member_id', 'role', 'expected_revision', 'idempotency_key'],
    disable: ['member_id', 'expected_revision', 'idempotency_key'],
    restore: ['member_id', 'expected_revision', 'idempotency_key'],
    change_email: ['member_id', 'new_email', 'expected_revision', 'idempotency_key'],
    confirm_email_change: ['challenge_id', 'code', 'idempotency_key'],
    revocation_result: ['operation_id'],
  };
  need(required[action].every(key => out[key] !== undefined));
  if (action === 'email_challenge') {
    need(['create', 'sign_in', 'accept_invitation'].includes(String(out.purpose)));
    need(out.purpose === 'accept_invitation' ? out.invitation_token !== undefined : out.invitation_token === undefined);
    need(out.purpose !== 'create' || out.team_id === undefined);
  }
  if (action === 'invite') need(out.role === 'member');
  if (action === 'set_role') need(out.role === 'admin' || out.role === 'member');
  return out;
}

export type MemberChange = 'set_role' | 'disable' | 'restore' | 'change_email';
export function authorizeMemberChange(action: MemberChange, actor: TeamMember, target: TeamMember,
  expectedRevision: number): void {
  need(actor.state === 'active', 'membership_disabled', 403);
  need(actor.team_id === target.team_id, 'not_found', 404);
  need(actor.id !== target.id && target.role !== 'superadmin', 'forbidden', 403);
  need(actor.role === 'superadmin' || (actor.role === 'admin' && target.role === 'member'), 'forbidden', 403);
  need(action !== 'set_role' || actor.role === 'superadmin', 'forbidden', 403);
  need(target.revision === expectedRevision, 'version_conflict', 409);
  need(target.state === (action === 'restore' ? 'disabled' : 'active'), 'version_conflict', 409);
}

/** The database resolves the default highest administrator in the same team;
 * choosing a recipient never grants that person old private-chat visibility. */
export function assetRecipient(target: TeamMember, chosen: TeamMember | undefined,
  highestAdministrator: TeamMember): string {
  const recipient = chosen ?? highestAdministrator;
  need(recipient.team_id === target.team_id && recipient.id !== target.id && recipient.state === 'active', 'invalid_recipient', 409);
  if (!chosen) need(recipient.role === 'superadmin', 'invalid_recipient', 409);
  return recipient.id;
}

export function authorizeEmailConfirmation(actor: TeamMember, target: TeamMember, expectedRevision: number): void {
  need(actor.state === 'active' && target.state === 'active', 'membership_disabled', 403);
  need(actor.team_id === target.team_id && actor.id === target.id && actor.identity_id === target.identity_id,
    'original_member_required', 403);
  need(target.revision === expectedRevision, 'version_conflict', 409);
}
