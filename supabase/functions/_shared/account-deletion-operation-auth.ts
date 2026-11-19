import { accountDeletionDependencies } from './account-deletion-auth.ts';
import type { OperationDependencies, OperationReply } from './account-deletion-operation-core.ts';

/** Same verified Auth/official OTP/hard-delete adapter as the reconciliation
 * protocol; only the service-only RPC destination changes. No credential or
 * response body is logged.
 */
export function accountDeletionOperationDependencies(settings: {
  url: string; anonKey: string; serviceKey: string; fetch?: typeof fetch;
}): OperationDependencies {
  const original = accountDeletionDependencies(settings);
  return { ...original, async flow(args): Promise<OperationReply> {
    const response = await (settings.fetch ?? fetch)(settings.url.replace(/\/+$/, '') + '/rest/v1/rpc/account_deletion_operation_flow', {
      method: 'POST', signal: AbortSignal.timeout(5_000),
      headers: { apikey: settings.serviceKey, authorization: 'Bearer ' + settings.serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok || typeof value?.ok !== 'boolean') throw Error('workflow_unavailable');
    return value;
  } };
}
