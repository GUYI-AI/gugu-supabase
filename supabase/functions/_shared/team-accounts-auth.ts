/** Auth is the verification authority. This adapter never stores a session,
 * logs an Auth response or accepts a client-selected principal to impersonate. */
export interface TeamAuthCaller {
  id: string; email: string; sessionId: string; accountKind: string;
  googleVerified: boolean;
}
export interface TeamAuthSession { access_token: string; refresh_token: string; user: { id: string; [key: string]: unknown }; [key: string]: unknown }
export interface PrincipalPlan { principal_id?: string; member_id: string; team_id: string; alias: string; name: string; region: 'cn' | 'hk' }
interface Settings { url: string; anonKey: string; serviceKey: string; fetch?: typeof fetch }
export class TeamAuthUnavailable extends Error { constructor() { super('authentication_unavailable'); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const email = (s: string) => s.trim().toLowerCase();

export function teamAuth(settings: Settings) {
  const request = settings.fetch ?? fetch, base = settings.url.replace(/\/+$/, '');
  async function call(path: string, method: string, key: string, bearer: string, body?: unknown) {
    const response = await request(base + path, { method, signal: AbortSignal.timeout(10_000),
      headers: { apikey: key, authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { ok: response.ok, status: response.status, data: await response.json().catch(() => null) };
  }
  async function logout(token: string, scope: 'local' | 'global' = 'local'): Promise<void> {
    const result = await call('/auth/v1/logout?scope=' + scope, 'POST', settings.anonKey, token, {});
    if (!result.ok && result.status !== 401) throw new TeamAuthUnavailable();
  }
  async function getPrincipal(id: string) {
    if (!UUID.test(id)) throw new TeamAuthUnavailable();
    const result = await call('/auth/v1/admin/users/' + id, 'GET', settings.serviceKey, settings.serviceKey);
    if (!result.ok || result.data?.id !== id) throw new TeamAuthUnavailable();
    return result.data;
  }
  function ownsPlan(user: Record<string, any>, plan: PrincipalPlan): boolean {
    return typeof user.email === 'string' && email(user.email) === email(plan.alias)
      && user.app_metadata?.gugu_account_kind === 'team_member'
      && user.app_metadata?.gugu_team_id === plan.team_id
      && user.app_metadata?.gugu_member_id === plan.member_id
      && user.app_metadata?.gugu_team_region === plan.region;
  }
  async function issue(principalId: string, plan: PrincipalPlan): Promise<TeamAuthSession> {
    const user = await getPrincipal(principalId);
    if (!ownsPlan(user, plan)) throw new TeamAuthUnavailable();
    // generateLink can create an absent user: require the existing principal
    // before calling it, then check both returned and verified subjects again.
    const link = await call('/auth/v1/admin/generate_link', 'POST', settings.serviceKey, settings.serviceKey,
      { type: 'magiclink', email: plan.alias });
    if (!link.ok || link.data?.id !== principalId || typeof link.data?.hashed_token !== 'string') throw new TeamAuthUnavailable();
    const verified = await call('/auth/v1/verify', 'POST', settings.anonKey, settings.anonKey,
      { type: 'email', token_hash: link.data.hashed_token });
    const session = verified.data;
    if (!verified.ok || session?.user?.id !== principalId || !ownsPlan(session.user, plan)
        || typeof session.access_token !== 'string' || typeof session.refresh_token !== 'string') {
      if (typeof session?.access_token === 'string') await logout(session.access_token);
      throw new TeamAuthUnavailable();
    }
    return session;
  }
  return {
    async currentCaller(token: string): Promise<TeamAuthCaller | null> {
      const result = await call('/auth/v1/user', 'GET', settings.anonKey, token);
      if (result.status >= 500) throw new TeamAuthUnavailable();
      const user = result.data;
      if (!result.ok || !UUID.test(user?.id ?? '') || typeof user.email !== 'string' || !user.email_confirmed_at) return null;
      let claims: any;
      try { const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); claims = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='))); }
      catch { return null; }
      if (!UUID.test(claims?.session_id ?? '') || claims.sub !== user.id) return null;
      const googleVerified = Array.isArray(user.identities) && user.identities.some((identity: any) =>
        identity.provider === 'google' && identity.identity_data?.email_verified === true
        && typeof identity.identity_data?.email === 'string' && email(identity.identity_data.email) === email(user.email));
      return { id: user.id, email: email(user.email), sessionId: claims.session_id,
        accountKind: user.app_metadata?.gugu_account_kind ?? 'personal', googleVerified };
    },
    async sendEmailCode(address: string): Promise<boolean> {
      // A new verification-only identity must be marked before its INSERT
      // triggers run. It cannot receive personal registration credits or act as
      // a personal payer. Never rewrite an existing personal account's marker.
      const anchor = await call('/auth/v1/admin/users', 'POST', settings.serviceKey, settings.serviceKey, {
        email: address, email_confirm: false, app_metadata: { gugu_account_kind: 'team_login_anchor' },
      });
      const duplicate = [409, 422].includes(anchor.status)
        && ['email_exists', 'user_already_exists'].includes(anchor.data?.code ?? anchor.data?.error_code);
      if (!anchor.ok && !duplicate) return false;
      if (anchor.ok && (!UUID.test(anchor.data?.id ?? '') || typeof anchor.data?.email !== 'string'
          || email(anchor.data.email) !== email(address)
          || anchor.data.app_metadata?.gugu_account_kind !== 'team_login_anchor')) return false;
      return (await call('/auth/v1/otp', 'POST', settings.anonKey, settings.anonKey, { email: address, create_user: false })).ok;
    },
    async verifyEmailCode(address: string, code: string): Promise<{ id: string; email: string } | null> {
      const verified = await call('/auth/v1/verify', 'POST', settings.anonKey, settings.anonKey,
        { type: 'email', email: address, token: code });
      const session = verified.data;
      if (!verified.ok || typeof session?.access_token !== 'string') return null;
      await logout(session.access_token);
      if (!UUID.test(session.user?.id ?? '') || typeof session.user?.email !== 'string'
          || !session.user.email_confirmed_at || email(session.user.email) !== email(address)) return null;
      return { id: session.user.id, email: email(session.user.email) };
    },
    async createPrincipal(plan: PrincipalPlan): Promise<string> {
      if (plan.principal_id) {
        if (!UUID.test(plan.principal_id)) throw new TeamAuthUnavailable();
        const prior = await call('/auth/v1/admin/users/' + plan.principal_id, 'GET', settings.serviceKey, settings.serviceKey);
        if (prior.ok) {
          if (prior.data?.id !== plan.principal_id || !ownsPlan(prior.data, plan)) throw new TeamAuthUnavailable();
          return plan.principal_id;
        }
        if (prior.status !== 404) throw new TeamAuthUnavailable();
      }
      const created = await call('/auth/v1/admin/users', 'POST', settings.serviceKey, settings.serviceKey, {
        ...(plan.principal_id ? { id: plan.principal_id } : {}),
        email: plan.alias, email_confirm: true, user_metadata: { display_name: plan.name },
        app_metadata: { gugu_account_kind: 'team_member', gugu_team_id: plan.team_id,
          gugu_member_id: plan.member_id, gugu_team_region: plan.region },
      });
      if (!created.ok || !UUID.test(created.data?.id ?? '') || !ownsPlan(created.data, plan)
          || plan.principal_id && created.data.id !== plan.principal_id) throw new TeamAuthUnavailable();
      return created.data.id;
    },
    issueSession: issue,
    logout,
    async setBan(principalId: string, plan: PrincipalPlan, banned: boolean): Promise<void> {
      const user = await getPrincipal(principalId);
      if (!ownsPlan(user, plan)) throw new TeamAuthUnavailable();
      const updated = await call('/auth/v1/admin/users/' + principalId, 'PUT', settings.serviceKey, settings.serviceKey,
        { ban_duration: banned ? '876000h' : 'none' });
      if (!updated.ok || updated.data?.id !== principalId) throw new TeamAuthUnavailable();
    },
    async revokeSessions(principalId: string, plan: PrincipalPlan): Promise<void> {
      // The SQL member gate must already be closed. A temporary official
      // session lets Auth perform its own global sign-out without DB writes.
      const temporary = await issue(principalId, plan);
      await logout(temporary.access_token, 'global');
    },
    async invitationToken(invitationId: string, seed: string): Promise<string> {
      if (!UUID.test(invitationId) || !UUID.test(seed)) throw new TeamAuthUnavailable();
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(settings.serviceKey),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const raw = new Uint8Array(await crypto.subtle.sign('HMAC', key,
        new TextEncoder().encode('gugu-team-invitation-v1:' + invitationId + ':' + seed)));
      return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
  };
}
