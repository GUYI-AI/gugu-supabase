import { TeamRefusal } from './team-accounts-contract.ts';
import type { teamAuth, TeamAuthCaller } from './team-accounts-auth.ts';

export interface InvitationMail {
  operationId: string; invitationId: string; to: string; teamName: string; invitationUrl: string; expiresAt: string;
}
export interface InvitationMailer {
  canSend(to: string): boolean;
  send(input: InvitationMail): Promise<{ state: 'accepted' | 'failed' | 'unknown'; reason_code: 'smtp_accepted' | 'smtp_rejected' | 'smtp_result_unknown' }>;
}
interface Dependencies {
  auth: Pick<ReturnType<typeof teamAuth>, 'ensureAnchor' | 'sendEmailCode'>;
  rpc(name: string, args: Record<string, unknown>): Promise<any>;
  clientIp?(request: Request): string | null;
  invitationMailer?: InvitationMailer;
}
export function teamMailFlow(deps: Dependencies) {
  function checked(permit: any) {
    if (!permit || typeof permit.delivery_id !== 'string'
      || !['pending', 'sending', 'accepted', 'failed', 'unknown'].includes(permit.state)
      || typeof permit.claimed !== 'boolean'
      || permit.claimed && typeof permit.lease_token !== 'string') throw new TeamRefusal('dependency_unavailable', 503);
    return permit;
  }
  const args = (action: string, input: Record<string, unknown>, request: Request, caller?: TeamAuthCaller | null) => ({
    p_action: action, p_input: input, p_actor: caller?.id ?? null, p_session: caller?.sessionId ?? null,
    p_client_ip: deps.clientIp?.(request) ?? null,
  });
  const finish = (permit: any, result: { state: string; reason_code: string }) => deps.rpc('team_mail_delivery', {
    p_action: 'finish', p_input: { delivery_id: permit.delivery_id, lease_token: permit.lease_token, ...result },
  });
  return {
    async sendCode(challenge: { challenge_id: string; email: string }, request: Request, caller?: TeamAuthCaller | null) {
      const permit = checked(await deps.rpc('team_mail_delivery', args('claim', { kind: 'code', challenge_id: challenge.challenge_id }, request, caller)));
      if (!permit.claimed) {
        if (permit.state === 'accepted') return;
        throw new TeamRefusal('dependency_unavailable', 503, { challenge_id: challenge.challenge_id,
          delivery: { operation_id: permit.delivery_id, state: permit.state, reason_code: permit.reason_code } });
      }
      let sent = false;
      try { sent = await deps.auth.sendEmailCode(challenge.email); } catch { /* The send result is uncertain, never an automatic retry. */ }
      const result = { state: sent ? 'accepted' : 'unknown', reason_code: sent ? 'code_accepted' : 'code_result_unknown' };
      await finish(permit, result);
      await deps.rpc('team_email_workflow', { p_action: 'sent', p_input: { challenge_id: challenge.challenge_id, sent } });
      if (!sent) throw new TeamRefusal('dependency_unavailable', 503, { challenge_id: challenge.challenge_id,
        delivery: { operation_id: permit.delivery_id, ...result } });
    },
    async sendInvitation(invitation: any, response: Record<string, any>, request: Request, caller: TeamAuthCaller) {
      let permit: any, anchorReady = false;
      try {
        const scope = { kind: 'invitation', invitation_id: invitation.invitation_id };
        permit = checked(await deps.rpc('team_mail_delivery', args('prepare', scope, request, caller)));
        response.delivery = { operation_id: permit.delivery_id, state: permit.state, reason_code: permit.reason_code };
        // Replays use the durable receipt before checking current SMTP settings.
        if (permit.state === 'accepted') return response;
        if (permit.state !== 'pending') {
          throw new TeamRefusal('dependency_unavailable', 503);
        }
        if (!deps.invitationMailer?.canSend(permit.recipient_email)) {
          response.delivery.reason_code = 'mail_not_configured';
          throw new TeamRefusal('dependency_unavailable', 503);
        }
        permit = checked(await deps.rpc('team_mail_delivery', args('claim', scope, request, caller)));
        response.delivery = { operation_id: permit.delivery_id, state: permit.state, reason_code: permit.reason_code };
        if (permit.claimed) {
          let result: { state: 'accepted' | 'failed' | 'unknown'; reason_code: string };
          try {
            if (typeof permit.recipient_email !== 'string' || !(await deps.auth.ensureAnchor(permit.recipient_email))) {
              result = { state: 'failed', reason_code: 'identity_unavailable' };
            } else {
              anchorReady = true;
              result = await deps.invitationMailer!.send({ operationId: permit.delivery_id, invitationId: invitation.invitation_id,
                to: permit.recipient_email, teamName: permit.team_name, invitationUrl: response.invitation_url, expiresAt: permit.expires_at });
            }
          } catch { result = { state: 'unknown', reason_code: 'smtp_result_unknown' }; }
          response.delivery = { operation_id: permit.delivery_id, ...result };
          try { await finish(permit, result); }
          catch {
            // SMTP may already have accepted the message. Do not report a
            // persisted success or turn an acknowledgment failure into resend.
            response.delivery = { operation_id: permit.delivery_id, state: 'unknown', reason_code: 'smtp_result_unknown' };
            throw new TeamRefusal('dependency_unavailable', 503);
          }
        }
        if (response.delivery.state !== 'accepted') throw new TeamRefusal('dependency_unavailable', 503);
        return response;
      } catch (error) {
        const failure = error instanceof TeamRefusal ? error : new TeamRefusal('dependency_unavailable', 503);
        if (!response.delivery) response.delivery = { operation_id: permit?.delivery_id ?? null, state: 'pending', reason_code: failure.code };
        else if (response.delivery.state === 'pending' && !response.delivery.reason_code) response.delivery.reason_code = failure.code;
        const receipt = { ...response };
        if (!anchorReady) {
          // An unprepared recipient must not receive a usable team login link,
          // even in a partial failure response (for example before Google OAuth).
          delete receipt.invitation_url; delete receipt.app_deep_links;
        }
        throw new TeamRefusal(failure.code, failure.status, receipt);
      }
    },
  };
}
