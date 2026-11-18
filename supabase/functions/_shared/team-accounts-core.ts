import { parseTeamWrite, TeamRefusal } from './team-accounts-contract.ts';
import type { teamAuth, TeamAuthCaller, PrincipalPlan } from './team-accounts-auth.ts';
import { teamMailFlow, type InvitationMailer } from './team-mail-flow.ts';

type Auth = ReturnType<typeof teamAuth>;
export interface TeamAccountsDependencies {
  auth: Auth;
  rpc(name: string, args: Record<string, unknown>): Promise<any>;
  revokeModel(input: Record<string, unknown>): Promise<boolean>;
  siteOrigin?: string;
  clientIp?(request: Request): string | null;
  invitationMailer?: InvitationMailer;
}
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'GET, POST, OPTIONS' };
const READS = new Set(['contexts', 'profile', 'directory', 'members']);
const PUBLIC_WRITES = new Set(['email_challenge', 'email_verify', 'create', 'sign_in', 'accept_invitation', 'invitation_info']);
const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
const capability = () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
async function requestBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new TeamRefusal('invalid_request', 400);
  const reader = request.body?.getReader(); if (!reader) throw new TeamRefusal('invalid_request', 400);
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > 4096) { await reader.cancel(); throw new TeamRefusal('invalid_request', 400); } chunks.push(part.value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new TeamRefusal('invalid_request', 400); }
}
function sessionArgs(caller: TeamAuthCaller, input: Record<string, unknown>, action: string) {
  return { p_action: action, p_actor: caller.id, p_session: caller.sessionId, p_input: input };
}
export function createTeamAccountsHandler(deps: TeamAccountsDependencies) {
  const mail = teamMailFlow(deps);
  async function login(prepared: any) {
    const plan: PrincipalPlan = prepared.plan;
    if (!plan || !prepared.membership?.id) throw new TeamRefusal('dependency_unavailable', 503);
    let principal = prepared.membership.identity_id;
    if (!principal) {
      principal = await deps.auth.createPrincipal(plan);
      await deps.rpc('team_account_provision', { p_action: 'activate', p_input: { member_id: prepared.membership.id, principal_id: principal } });
    }
    const session = await deps.auth.issueSession(principal, plan);
    try {
      const caller = await deps.auth.currentCaller(session.access_token);
      if (!caller || caller.id !== principal || caller.accountKind !== 'team_member') throw new TeamRefusal('unauthenticated', 401);
      const profile = await deps.rpc('team_account_read', sessionArgs(caller, {}, 'profile'));
      if (profile.membership?.identity_id !== principal || profile.membership?.state !== 'active') throw new TeamRefusal('membership_disabled', 403);
      return { team: profile.team, membership: profile.membership, context: profile.context, session };
    } catch (error) { await deps.auth.logout(session.access_token); throw error; }
  }
  async function reconcileRevocation(caller: TeamAuthCaller, operation: string) {
    let state = await deps.rpc('team_member_workflow', sessionArgs(caller, { operation_id: operation }, 'revocation_result'));
    if (state.state === 'complete') return state;
    if (typeof state.principal_id !== 'string') throw new TeamRefusal('dependency_unavailable', 503);
    if (!state.checks?.session_followups_stopped) {
      await deps.auth.revokeSessions(state.principal_id, state.plan);
      await deps.rpc('team_member_workflow', sessionArgs(caller, { operation_id: operation, auth_sessions_revoked: true }, 'revocation_checkpoint'));
    }
    if (!state.auth_banned) {
      await deps.auth.setBan(state.principal_id, state.plan, true);
      await deps.rpc('team_member_workflow', sessionArgs(caller, { operation_id: operation, auth_banned: true }, 'revocation_checkpoint'));
    }
    if (!state.checks?.new_model_calls_denied) {
      const ok = await deps.revokeModel({ action: 'revoke_team_member', team_id: state.team_id, member_id: state.member_id,
        revision: state.revision, operation_id: operation });
      if (!ok) throw new TeamRefusal('dependency_unavailable', 503);
      await deps.rpc('team_member_workflow', sessionArgs(caller, { operation_id: operation, model_authorization_revoked: true }, 'revocation_checkpoint'));
    }
    state = await deps.rpc('team_member_workflow', sessionArgs(caller, { operation_id: operation }, 'revocation_result'));
    // Credential revocation and operational asset handoff are separate. Never
    // describe a pending handoff as complete merely because calls are revoked.
    return state;
  }
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const requestId = crypto.randomUUID();
    let isInvitation = false, invitationAttempted = false, invitationReceipt: Record<string, unknown> | undefined;
    try {
      let input: Record<string, any>;
      if (request.method === 'GET') {
        const url = new URL(request.url); input = Object.fromEntries(url.searchParams);
        if (!READS.has(input.action) || Object.keys(input).some(k => !['action', 'state', 'query', 'cursor', 'limit'].includes(k))) throw new TeamRefusal('invalid_request', 400);
        if (input.limit !== undefined) { if (!/^\d{1,3}$/.test(input.limit)) throw new TeamRefusal('invalid_request', 400); input.limit = Number(input.limit); }
      } else if (request.method === 'POST') input = parseTeamWrite(await requestBody(request));
      else return json({ ok: false, error: { code: 'invalid_request', message: 'Method unavailable.' }, request_id: requestId }, 405);
      const { action, ...body } = input;
      isInvitation = action === 'invite';
      const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]{1,8192})$/i)?.[1];
      let caller: TeamAuthCaller | null = null;
      if (!PUBLIC_WRITES.has(action)) {
        if (!token || !(caller = await deps.auth.currentCaller(token))) throw new TeamRefusal('unauthenticated', 401);
      }
      let data: any;
      if (READS.has(action)) data = await deps.rpc('team_account_read', sessionArgs(caller!, body, action));
      else if (action === 'email_challenge') {
        if (body.invitation_token) { body.invitation_digest = await digest(body.invitation_token); delete body.invitation_token; }
        const challenge = await deps.rpc('team_email_workflow', { p_action: 'begin', p_input: body });
        await mail.sendCode(challenge, request);
        data = { challenge_id: challenge.challenge_id, expires_at: challenge.expires_at, resend_after_seconds: 60 };
      } else if (action === 'email_verify') {
        const challenge = await deps.rpc('team_email_workflow', { p_action: 'claim', p_input: { challenge_id: body.challenge_id } });
        let proof = null; try { proof = await deps.auth.verifyEmailCode(challenge.email, body.code); } catch { /* safe refusal below */ }
        if (!proof || proof.email !== challenge.email) {
          await deps.rpc('team_email_workflow', { p_action: 'rejected', p_input: { challenge_id: challenge.challenge_id, lease_token: challenge.lease_token } });
          throw new TeamRefusal('invalid_code', 401);
        }
        const receipt = capability();
        await deps.rpc('team_email_workflow', { p_action: 'verified', p_input: { challenge_id: challenge.challenge_id,
          lease_token: challenge.lease_token, verified_email: proof.email, receipt_digest: await digest(receipt) } });
        data = { verification_receipt: receipt, expires_at: challenge.expires_at };
      } else if (['create', 'sign_in', 'accept_invitation'].includes(action)) {
        body.receipt_digest = await digest(body.verification_receipt); delete body.verification_receipt;
        if (body.invitation_token) { body.invitation_digest = await digest(body.invitation_token); delete body.invitation_token; }
        const prepared = await deps.rpc('team_account_provision', { p_action: action, p_input: body });
        if (prepared.refusal === 'context_required') return json({ ok: false, error: { code: 'context_required', message: 'Choose a team.', contexts: prepared.contexts }, request_id: requestId }, 409);
        data = await login(prepared);
      } else if (action === 'google_sign_in') {
        if (!caller?.googleVerified || caller.accountKind === 'team_member') throw new TeamRefusal('verification_required', 401);
        const prepared = await deps.rpc('team_account_google', { p_actor: caller.id, p_session: caller.sessionId, p_team_id: body.team_id ?? null });
        if (prepared.refusal === 'context_required') return json({ ok: false, error: { code: 'context_required', message: 'Choose a team.', contexts: prepared.contexts }, request_id: requestId }, 409);
        data = await login(prepared);
        try { await deps.auth.logout(token!); }
        catch (error) { await deps.auth.logout(data.session.access_token); throw error; }
      } else if (action === 'invitation_info') {
        data = await deps.rpc('team_member_workflow', { p_action: action, p_actor: null, p_session: null,
          p_input: { invitation_digest: await digest(body.invitation_token) } });
        if (!data) throw new TeamRefusal('invitation_invalid', 404);
      } else if (action === 'invite') {
        const configured = deps.siteOrigin ?? (await deps.rpc('team_account_read', sessionArgs(caller!, {}, 'delivery_settings')))?.site_origin;
        let origin: URL;
        try { origin = new URL(configured); } catch { throw new TeamRefusal('dependency_unavailable', 503); }
        if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
            || !['', '/'].includes(origin.pathname)) throw new TeamRefusal('dependency_unavailable', 503);
        invitationAttempted = true;
        const invitation = await deps.rpc('team_member_workflow', sessionArgs(caller!, body, action));
        if (typeof invitation?.invitation_id !== 'string' || typeof invitation.operation_id !== 'string') throw new TeamRefusal('dependency_unavailable', 503);
        invitationReceipt = { invitation_id: invitation.invitation_id, operation_id: invitation.operation_id, invitation_created: true };
        const opaque = await deps.auth.invitationToken(invitation.invitation_id, invitation.seed);
        await deps.rpc('team_member_workflow', sessionArgs(caller!, { invitation_id: invitation.invitation_id, token_digest: await digest(opaque) }, 'bind_invitation'));
        if (!['cn', 'hk'].includes(invitation.region)) throw new TeamRefusal('dependency_unavailable', 503);
        const fragment = '?region=' + invitation.region + '#invitation_token=' + encodeURIComponent(opaque);
        data = { invitation_id: invitation.invitation_id, state: invitation.state, expires_at: invitation.expires_at,
          operation_id: invitation.operation_id, invitation_created: true,
          invitation_url: origin.origin + '/team/invite' + fragment,
          app_deep_links: { stable: 'gugu://team/invite' + fragment, beta: 'gugu-beta://team/invite' + fragment, dev: 'gugu-dev://team/invite' + fragment } };
        data = await mail.sendInvitation(invitation, data, request, caller!);
      } else if (action === 'set_role') data = await deps.rpc('team_member_workflow', sessionArgs(caller!, body, action));
      else if (action === 'disable') {
        const operation = await deps.rpc('team_member_workflow', sessionArgs(caller!, body, action));
        const revocation = await reconcileRevocation(caller!, operation.operation_id);
        data = { membership: operation.membership, handoff: operation.handoff,
          revocation: { state: revocation.state, operation_id: operation.operation_id } };
      } else if (action === 'revocation_result') {
        const state = await reconcileRevocation(caller!, body.operation_id);
        data = { state: state.state, operation_id: state.operation_id, checks: state.checks };
      } else if (action === 'restore') {
        const operation = await deps.rpc('team_member_workflow', sessionArgs(caller!, body, action));
        if (operation.operation_state === 'complete') data = { membership: operation.membership, requires_sign_in: true };
        else {
          if (!operation.principal_id || !operation.plan) throw new TeamRefusal('dependency_unavailable', 503);
          await deps.auth.setBan(operation.principal_id, operation.plan, false);
          await deps.auth.revokeSessions(operation.principal_id, operation.plan);
          data = await deps.rpc('team_member_workflow', sessionArgs(caller!, { operation_id: operation.operation_id }, 'restore_finish'));
        }
      } else if (action === 'change_email') {
        const pending = await deps.rpc('team_member_workflow', sessionArgs(caller!, body, action));
        const challenge = await deps.rpc('team_email_workflow', { p_action: 'delivery', p_input: { challenge_id: pending.challenge_id } });
        if (challenge.state === 'sending') {
          await mail.sendCode(challenge, request, caller);
        }
        data = { challenge_id: pending.challenge_id, expires_at: pending.expires_at, state: 'pending' };
      } else if (action === 'confirm_email_change') {
        let prepared = await deps.rpc('team_member_workflow', sessionArgs(caller!,
          { challenge_id: body.challenge_id, idempotency_key: body.idempotency_key }, 'email_change_claim'));
        if (prepared.stage === 'verify') {
          let proof = null; try { proof = await deps.auth.verifyEmailCode(prepared.email, body.code); } catch { /* no raw Auth error */ }
          if (!proof || proof.email !== prepared.email) {
            await deps.rpc('team_email_workflow', { p_action: 'rejected', p_input: { challenge_id: body.challenge_id, lease_token: prepared.lease_token } });
            throw new TeamRefusal('invalid_code', 401);
          }
          prepared = await deps.rpc('team_member_workflow', sessionArgs(caller!, { challenge_id: body.challenge_id,
            idempotency_key: body.idempotency_key, lease_token: prepared.lease_token, verified_email: proof.email }, 'email_change_commit'));
        }
        if (prepared.stage !== 'auth_cleanup' || !prepared.principal_id || !prepared.plan) throw new TeamRefusal('dependency_unavailable', 503);
        await deps.auth.revokeSessions(prepared.principal_id, prepared.plan);
        data = await deps.rpc('team_member_workflow', sessionArgs(caller!, { operation_id: prepared.operation_id }, 'email_change_finish'));
      } else throw new TeamRefusal('dependency_unavailable', 503);
      return json({ ok: true, data });
    } catch (error) {
      const refusal = error instanceof TeamRefusal ? error : new TeamRefusal('dependency_unavailable', 503);
      let details = refusal.details;
      if (isInvitation && !details) {
        const unknown = invitationAttempted && !invitationReceipt && refusal.code === 'dependency_unavailable';
        details = { ...(invitationReceipt ?? { operation_id: null, invitation_created: unknown ? null : false }),
          delivery: { operation_id: null, state: unknown ? 'unknown' : 'pending',
            reason_code: unknown ? 'invitation_outcome_unknown' : refusal.code } };
      }
      return json({ ok: false, error: { code: refusal.code, message: 'The operation could not be completed.' },
        ...(details ? { data: details } : {}), request_id: requestId }, refusal.status);
    }
  };
}
