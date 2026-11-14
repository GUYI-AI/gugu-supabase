import type { Caller, DeletionDependencies, FlowArgs, FlowReply } from './account-deletion-core.ts';

interface Settings { url: string; anonKey: string; serviceKey: string; fetch?: typeof fetch }
export function accountDeletionDependencies(settings: Settings): DeletionDependencies {
  const request = settings.fetch ?? fetch;
  const root = settings.url.replace(/\/+$/, '');
  async function call(path: string, method: string, key: string, bearer: string, body?: unknown, timeout = 15_000) {
    const response = await request(root + path, { method, signal: AbortSignal.timeout(timeout),
      headers: { apikey: key, authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, data };
  }
  function sessionId(token: string): string | null {
    try {
      // The exact token is first verified by Auth /user. Decoding here never
      // substitutes for verification; the DB also checks the live session row.
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const value = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
      return typeof value.session_id === 'string' && /^[0-9a-f-]{36}$/i.test(value.session_id) ? value.session_id : null;
    } catch { return null; }
  }
  async function exists(id: string): Promise<'present' | 'absent' | 'unknown'> {
    try {
      const found = await call('/auth/v1/admin/users/' + encodeURIComponent(id), 'GET', settings.serviceKey, settings.serviceKey, undefined, 5_000);
      if (found.status === 404) return 'absent';
      return found.ok && found.data?.id === id ? 'present' : 'unknown';
    } catch { return 'unknown'; }
  }
  return {
    async currentUser(token): Promise<Caller | null> {
      const found = await call('/auth/v1/user', 'GET', settings.anonKey, token, undefined, 5_000);
      if (found.status >= 500) throw new Error('authentication_unavailable');
      const id = sessionId(token), user = found.data;
      return found.ok && typeof user?.id === 'string' && typeof user.email === 'string' && user.email_confirmed_at && id
        ? { id: user.id, email: user.email, sessionId: id } : null;
    },
    async flow(args: FlowArgs): Promise<FlowReply> {
      const response = await call('/rest/v1/rpc/account_deletion_flow', 'POST', settings.serviceKey, settings.serviceKey, args, 5_000);
      if (!response.ok || typeof response.data?.ok !== 'boolean') throw new Error('workflow_unavailable');
      return response.data;
    },
    async sendCode(email) {
      return (await call('/auth/v1/otp', 'POST', settings.anonKey, settings.anonKey, { email, create_user: false })).ok;
    },
    async verifyCode(email, code) {
      const verified = await call('/auth/v1/verify', 'POST', settings.anonKey, settings.anonKey, { type: 'email', email, token: code });
      const data = verified.data;
      if (!verified.ok || typeof data?.access_token !== 'string') return null;
      // Consume and revoke the temporary verification session, never returning
      // any token to the deletion caller or sharing the client's auth storage.
      const revoked = await call('/auth/v1/logout?scope=local', 'POST', settings.anonKey, data.access_token, {});
      if (!revoked.ok && revoked.status !== 401) throw new Error('verification_session_cleanup_failed');
      return typeof data.user?.id === 'string' && typeof data.user.email === 'string'
        ? { id: data.user.id, email: data.user.email } : null;
    },
    async hardDelete(id) {
      const before = await exists(id);
      if (before === 'absent') return 'absent';
      if (before === 'unknown') return 'unknown';
      let definite = false;
      try {
        await call('/auth/v1/admin/users/' + encodeURIComponent(id), 'DELETE', settings.serviceKey,
          settings.serviceKey, { should_soft_delete: false }, 20_000);
        definite = true;
      } catch { /* an uncertain outcome is reconciled without an overlapping retry */ }
      const after = await exists(id);
      if (after === 'absent') return 'absent';
      if (!definite || after === 'unknown') return 'unknown';
      return 'failed';
    },
  };
}
