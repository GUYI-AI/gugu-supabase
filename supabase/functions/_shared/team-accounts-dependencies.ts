import { teamAuth } from './team-accounts-auth.ts';
import { TeamRefusal } from './team-accounts-contract.ts';
import type { TeamAccountsDependencies } from './team-accounts-core.ts';
interface Settings { url: string; anonKey: string; serviceKey: string; siteOrigin?: string; fetch?: typeof fetch }
const REFUSALS: Record<string, number> = {
  unauthenticated: 401, verification_required: 401, verification_expired: 401, invalid_code: 401,
  forbidden: 403, membership_disabled: 403, region_mismatch: 403, team_identity_required: 403,
  not_found: 404, invitation_invalid: 404, version_conflict: 409, idempotency_conflict: 409,
  invitation_used: 409, invalid_recipient: 409, rate_limited: 429, invalid_request: 400, dependency_unavailable: 503,
};
export function teamAccountsDependencies(settings: Settings): TeamAccountsDependencies {
  const request = settings.fetch ?? fetch, root = settings.url.replace(/\/+$/, '');
  let siteOrigin: string | undefined;
  if (settings.siteOrigin) {
    const url = new URL(settings.siteOrigin);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw Error('Invalid team site configuration');
    siteOrigin = url.origin;
  }
  async function call(path: string, body: unknown) {
    const response = await request(root + path, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { apikey: settings.serviceKey, authorization: 'Bearer ' + settings.serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify(body) });
    return { ok: response.ok, data: await response.json().catch(() => null) };
  }
  return {
    auth: teamAuth(settings), siteOrigin,
    async rpc(name, args) {
      if (!['team_email_workflow', 'team_account_read', 'team_account_provision', 'team_member_workflow'].includes(name)) throw new TeamRefusal('invalid_request', 400);
      const response = await call('/rest/v1/rpc/' + name, args);
      if (!response.ok) {
        const hint = typeof response.data?.hint === 'string' ? response.data.hint : '';
        if (Object.hasOwn(REFUSALS, hint)) throw new TeamRefusal(hint, REFUSALS[hint]);
        throw new TeamRefusal('dependency_unavailable', 503);
      }
      return response.data;
    },
    async revokeModel(input) {
      const response = await call('/functions/v1/model-access', input), data = response.data?.data;
      return response.ok && response.data?.ok === true && data?.state === 'complete'
        && data.operation_id === input.operation_id && data.new_authorization_denied === true
        && data.gateway_tokens_revoked === true && data.inflight_policy === 'finish_and_settle';
    },
  };
}
