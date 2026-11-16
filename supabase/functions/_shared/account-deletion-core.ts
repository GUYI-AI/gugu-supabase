export interface Caller { id: string; email: string; sessionId: string }
export interface Workflow {
  request_id: string; state: string; expires_at: string;
  last_error: string | null; can_retry: boolean;
}
export interface FlowReply {
  ok: boolean; error?: string; status?: number; request?: Workflow | null;
  policy?: Record<string, unknown>; lease_token?: string; user_id?: string;
}
export type FlowArgs = Record<string, string | null> & { p_action: string };
export interface DeletionDependencies {
  currentUser(token: string): Promise<Caller | null>;
  flow(args: FlowArgs): Promise<FlowReply>;
  sendCode(email: string): Promise<boolean>;
  verifyCode(email: string, code: string): Promise<{ id: string; email: string } | null>;
  hardDelete(userId: string): Promise<'absent' | 'failed' | 'unknown'>;
}
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
function failure(error: string, status: number): Response { return json({ error }, status); }
function result(reply: FlowReply, status = 200): Response {
  return reply.ok ? json({ ...(reply.policy ? { policy: reply.policy } : {}), request: reply.request ?? null }, status)
    : failure(reply.error ?? 'unavailable', reply.status ?? 503);
}
export async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
function receipt(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('invalid_body');
  const reader = req.body?.getReader();
  if (!reader) throw new Error('invalid_body');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length;
    if (size > 4096) { await reader.cancel(); throw new Error('invalid_body'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('invalid_body');
  return value;
}
function proof(body: Record<string, unknown>): { p_request_id: string; p_receipt_digest: Promise<string> } | null {
  if (typeof body.request_id !== 'string' || !UUID.test(body.request_id)
      || typeof body.receipt_token !== 'string' || !/^[a-f0-9]{64}$/.test(body.receipt_token)) return null;
  return { p_request_id: body.request_id, p_receipt_digest: sha256(body.receipt_token) };
}

export function createAccountDeletionHandler(deps: DeletionDependencies): (req: Request) => Promise<Response> {
  async function execute(requestId: string, userId: string, lease: string): Promise<FlowReply> {
    const authorized = await deps.flow({ p_action: 'execute', p_request_id: requestId, p_lease_token: lease });
    if (!authorized.ok || authorized.request?.state === 'deleted') return authorized;
    if (authorized.request?.state !== 'processing' || authorized.user_id !== userId || authorized.lease_token !== lease) {
      return { ok: false, error: 'unavailable', status: 503 };
    }
    let outcome: 'absent' | 'failed' | 'unknown';
    try { outcome = await deps.hardDelete(userId); } catch { outcome = 'unknown'; }
    return deps.flow({ p_action: 'finish', p_request_id: requestId, p_lease_token: lease,
      p_error_code: outcome === 'absent' ? null : outcome === 'failed' ? 'auth_delete_failed' : 'outcome_unknown' });
  }
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const route = new URL(req.url).pathname.replace(/\/+$/, '').split('/').at(-1);
    if (!['status', 'challenge', 'confirm', 'retry', 'result'].includes(route ?? '')) return failure('not_found', 404);
    if (req.method !== (route === 'status' ? 'GET' : 'POST')) return failure('method_not_allowed', 405);
    try {
      const token = req.headers.get('authorization')?.match(/^Bearer ([^\s]{1,8192})$/i)?.[1];
      let body: Record<string, unknown> = {};
      if (req.method === 'POST') { try { body = await bodyOf(req); } catch { return failure('invalid_request', 400); } }
      // A receipt is an unguessable, narrowly scoped result capability. It is
      // needed when deletion has removed the user's original login session.
      if (route === 'result') {
        const p = proof(body); if (!p) return failure('invalid_request', 400);
        return result(await deps.flow({ p_action: 'result', p_request_id: p.p_request_id, p_receipt_digest: await p.p_receipt_digest }));
      }
      if (!token) return failure('unauthorized', 401);
      const user = await deps.currentUser(token);
      if (!user) return failure('unauthorized', 401);
      const identity = { p_user_id: user.id, p_session_id: user.sessionId };
      if (route === 'status') return result(await deps.flow({ p_action: 'status', ...identity }));
      if (route === 'challenge') {
        if (body.consent_version !== 'immediate-forfeit-v1') return failure('invalid_request', 400);
        const raw = receipt();
        const started = await deps.flow({ p_action: 'begin', ...identity, p_email_digest: await sha256(user.email.toLowerCase()),
          p_receipt_digest: await sha256(raw), p_consent_version: body.consent_version });
        if (!started.ok || !started.request) return result(started);
        let sent = false; try { sent = await deps.sendCode(user.email); } catch { /* no Auth body/error is logged */ }
        const active = await deps.flow({ p_action: 'sent', p_request_id: started.request.request_id, p_error_code: sent ? null : 'email_unavailable' });
        if (!sent) return failure('email_unavailable', 503);
        return active.ok ? json({ request: active.request, receipt_token: raw }, 201) : result(active);
      }
      const p = proof(body); if (!p) return failure('invalid_request', 400);
      const args = { ...identity, p_request_id: p.p_request_id, p_receipt_digest: await p.p_receipt_digest,
        p_email_digest: await sha256(user.email.toLowerCase()) };
      let ready: FlowReply;
      if (route === 'retry') {
        ready = await deps.flow({ p_action: 'retry', ...args });
      } else {
        if (typeof body.code !== 'string' || !/^\d{6,10}$/.test(body.code)
            || body.consent_version !== 'immediate-forfeit-v1' || body.acknowledge_forfeit !== true) return failure('invalid_request', 400);
        const attempt = await deps.flow({ p_action: 'attempt', ...args, p_consent_version: body.consent_version });
        if (!attempt.ok || !attempt.lease_token) return result(attempt);
        let verified: { id: string; email: string } | null = null;
        try { verified = await deps.verifyCode(user.email, body.code); } catch { /* safe failure below */ }
        if (!verified || verified.id !== user.id || verified.email.toLowerCase() !== user.email.toLowerCase()) {
          await deps.flow({ p_action: 'verification_failed', p_request_id: p.p_request_id, p_lease_token: attempt.lease_token });
          return failure('verification_failed', 422);
        }
        ready = await deps.flow({ p_action: 'verified', p_request_id: p.p_request_id, p_lease_token: attempt.lease_token });
      }
      if (!ready.ok || !ready.request) return result(ready);
      if (ready.request.state !== 'processing' || !ready.user_id || !ready.lease_token) return failure('unavailable', 503);
      const finished = await execute(ready.request.request_id, ready.user_id, ready.lease_token);
      if (!finished.ok) return result(finished);
      if (finished.request?.state === 'deleted') return result(finished);
      if (finished.request?.state === 'processing') return result(finished, 202);
      return json({ error: 'auth_delete_failed', request: finished.request ?? null }, 503);
    } catch {
      // Never expose SQL/Auth diagnostics: they may contain identity or tokens.
      return failure('unavailable', 503);
    }
  };
}
