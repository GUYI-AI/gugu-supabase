import { sha256, type DeletionDependencies, type FlowReply } from './account-deletion-core.ts';

export type OperationArgs = Record<string, string | number | null> & { p_action: string };

export interface OperationReply extends FlowReply {
  operation?: { operation_id: string; state: string; revision: number; challenge_generation: number; request_id: string | null; can_retry: boolean; can_release_preparation?: boolean;
    confirmation?: { confirmation_id: string; state: string; challenge_generation: number; error_code?: string | null } | null };
  dispatch_required?: boolean;
  confirmation_state?: string;
  preparation?: Record<string, unknown>;
}
export interface OperationDependencies extends Omit<DeletionDependencies, 'flow'> {
  flow(args: OperationArgs): Promise<OperationReply>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const consent = 'immediate-forfeit-v1';
const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const fail = (error: string, status: number) => new Response(JSON.stringify({ error }), { status, headers });
function output(reply: OperationReply, status = 200): Response {
  if (!reply.ok) return fail(reply.error ?? 'unavailable', reply.status ?? 503);
  if (!reply.operation || typeof reply.operation.state !== 'string') return fail('unavailable', 503);
  return new Response(JSON.stringify({ operation: reply.operation, ...(reply.preparation ? { preparation: reply.preparation } : {}) }), { status, headers });
}
async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw Error('body');
  const reader = req.body?.getReader(); if (!reader) throw Error('body');
  const parts: Uint8Array[] = []; let size = 0;
  for (;;) {
    const p = await reader.read(); if (p.done) break;
    size += p.value.length; if (size > 4096) { await reader.cancel(); throw Error('body'); }
    parts.push(p.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const p of parts) { bytes.set(p, offset); offset += p.length; }
  const body = JSON.parse(new TextDecoder().decode(bytes));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('body');
  return body;
}
/** V2 HTTP core. The database gate defaults closed. No receipt is minted
 * here: its 32 random bytes must already be held by native operation custody.
 */
export function createAccountDeletionOperationHandler(deps: OperationDependencies) {
  return async (req: Request): Promise<Response> => {
    const route = new URL(req.url).pathname.replace(/\/+$/, '').split('/').at(-1);
    if (route === 'status') {
      if (req.method !== 'GET') return fail('method_not_allowed', 405);
      try {
        const token = req.headers.get('authorization')?.match(/^Bearer ([^\s]{1,8192})$/i)?.[1];
        if (!token) return fail('unauthorized', 401);
        const user = await deps.currentUser(token);
        if (!user) return fail('unauthorized', 401);
        const reply = await deps.flow({ p_action: 'status', p_operation_digest: null, p_receipt_digest: null,
          p_user_id: user.id, p_session_id: user.sessionId, p_email_digest: await sha256(user.email.toLowerCase()) });
        if (!reply.ok) return fail(reply.error ?? 'unavailable', reply.status ?? 503);
        const p = reply.policy;
        if (!p || p.protocol_version !== 2 || typeof p.available !== 'boolean' || p.deletion !== 'immediate'
            || p.credit_treatment !== 'forfeit_remaining' || p.consent_version !== consent || p.device_preparation_required !== true) return fail('unavailable', 503);
        return new Response(JSON.stringify({ policy: { protocol_version: 2, available: p.available, deletion: 'immediate',
          credit_treatment: 'forfeit_remaining', consent_version: consent, device_preparation_required: true } }), { headers });
      } catch { return fail('unavailable', 503); }
    }
    if (!['register', 'challenge', 'confirm', 'result', 'prepare_device', 'read_preparation', 'cancel_preparation', 'cancel'].includes(route ?? '')) return fail('not_found', 404);
    if (req.method !== 'POST') return fail('method_not_allowed', 405);
    let body: Record<string, unknown>;
    try { body = await readBody(req); } catch { return fail('invalid_request', 400); }
    if (typeof body.local_operation_id !== 'string' || !body.local_operation_id || new TextEncoder().encode(body.local_operation_id).length > 256
        || new TextDecoder().decode(new TextEncoder().encode(body.local_operation_id)) !== body.local_operation_id
        || typeof body.receipt_token !== 'string' || !/^[a-f0-9]{64}$/.test(body.receipt_token)) return fail('invalid_request', 400);
    try {
      const binding: OperationArgs = { p_action: 'result',
        p_operation_digest: await sha256('account-deletion-operation-v2:' + body.local_operation_id),
        p_receipt_digest: await sha256('account-deletion-result-v2:' + body.receipt_token) };
      if (route === 'result') return output(await deps.flow(binding));
      const bearer = req.headers.get('authorization')?.match(/^Bearer ([^\s]{1,8192})$/i)?.[1];
      if (!bearer) return fail('unauthorized', 401);
      const user = await deps.currentUser(bearer); if (!user) return fail('unauthorized', 401);
      const identity = { p_user_id: user.id, p_session_id: user.sessionId, p_email_digest: await sha256(user.email.toLowerCase()) };
      const args: OperationArgs = { ...binding, ...identity, p_action: route!, p_consent_version: consent };
      if (route === 'register' || route === 'challenge' || route === 'confirm') {
        if (body.consent_version !== consent) return fail('invalid_request', 400);
      }
      if (route === 'register') return output(await deps.flow(args));
      if (route === 'cancel') {
        if (typeof body.native_generation !== 'string' || !uuid.test(body.native_generation)
            || (body.server_generation !== undefined && body.server_generation !== null
              && (typeof body.server_generation !== 'string' || !uuid.test(body.server_generation)))) return fail('invalid_request', 400);
        return output(await deps.flow({ ...args, p_action: 'cancel_operation', p_native_generation: body.native_generation,
          p_server_generation: typeof body.server_generation === 'string' ? body.server_generation : null }));
      }
      if (route === 'prepare_device' || route === 'read_preparation' || route === 'cancel_preparation') {
        if (typeof body.native_generation !== 'string' || !uuid.test(body.native_generation)) return fail('invalid_request', 400);
        args.p_native_generation = body.native_generation;
        if (route === 'prepare_device') {
          if (typeof body.device_id !== 'string' || !body.device_id || body.device_id.length > 256) return fail('invalid_request', 400);
          args.p_device_id = body.device_id;
        } else {
          if (typeof body.server_generation !== 'string' || !uuid.test(body.server_generation)) return fail('invalid_request', 400);
          args.p_server_generation = body.server_generation;
        }
        return output(await deps.flow(args));
      }
      if (typeof body.generation !== 'number' || !Number.isInteger(body.generation) || body.generation < 1 || body.generation > 2147483647) return fail('invalid_request', 400);
      const generation = body.generation;
      const call = (action: string, more: Record<string, string | number | null> = {}) => deps.flow(
        { ...args, p_action: action, p_generation: generation, ...more });
      if (route === 'challenge') {
        const started = await call('begin');
        if (!started.ok || started.dispatch_required !== true) return output(started);
        if (!started.operation || !started.lease_token || !uuid.test(started.lease_token)) return fail('unavailable', 503);
        let sent = false; try { sent = await deps.sendCode(user.email); } catch { /* unknown never grants resend */ }
        return output(await call('sent', { p_lease_token: started.lease_token, p_error_code: sent ? null : 'email_outcome_unknown' }), sent ? 201 : 202);
      }
      if (body.acknowledge_forfeit !== true || typeof body.code !== 'string' || !/^\d{6,10}$/.test(body.code)
          || typeof body.confirmation_id !== 'string' || !uuid.test(body.confirmation_id)
          || typeof body.native_generation !== 'string' || !uuid.test(body.native_generation)
          || typeof body.server_generation !== 'string' || !uuid.test(body.server_generation)) return fail('invalid_request', 400);
      const intent = { p_confirmation_id: body.confirmation_id, p_native_generation: body.native_generation, p_server_generation: body.server_generation };
      const claimed = await call('claim_confirmation', intent);
      if (!claimed.ok || claimed.dispatch_required !== true) return output(claimed, claimed.operation?.state === 'deleted' ? 200 : 202);
      if (!claimed.lease_token || !uuid.test(claimed.lease_token)) return fail('unavailable', 503);
      let verified: { id: string; email: string } | null = null;
      try { verified = await deps.verifyCode(user.email, body.code); } catch { /* safe fixed result below */ }
      if (!verified || verified.id !== user.id || verified.email.toLowerCase() !== user.email.toLowerCase()) {
        const rejected = await call('verification_failed', { ...intent, p_lease_token: claimed.lease_token });
        const recorded = rejected.operation?.confirmation;
        if (!rejected.ok || !claimed.operation?.operation_id || rejected.operation?.operation_id !== claimed.operation.operation_id
            || rejected.operation.state !== 'open' || recorded?.state !== 'rejected'
            || recorded.confirmation_id !== body.confirmation_id || recorded.challenge_generation !== generation) return fail('unavailable', 503);
        return new Response(JSON.stringify({ error: 'verification_failed', operation: rejected.operation }), { status: 422, headers });
      }
      const ready = await call('verified', { ...intent, p_lease_token: claimed.lease_token });
      if (!ready.ok) return output(ready);
      if (ready.user_id !== user.id || !ready.lease_token || !uuid.test(ready.lease_token)) return fail('unavailable', 503);
      const execution = await call('execute', { ...intent, p_lease_token: ready.lease_token });
      if (!execution.ok) return output(execution);
      if (execution.request?.state === 'deleted') return output(await deps.flow(binding));
      if (execution.user_id !== user.id || execution.lease_token !== ready.lease_token || execution.request?.state !== 'processing') return fail('unavailable', 503);
      let absent = false; try { absent = await deps.hardDelete(user.id) === 'absent'; } catch { /* unknown */ }
      const finished = await call('finish', { ...intent, p_lease_token: ready.lease_token, p_error_code: absent ? null : 'outcome_unknown' });
      return output(finished, finished.operation?.state === 'deleted' ? 200 : 202);
    } catch { return fail('unavailable', 503); }
  };
}
