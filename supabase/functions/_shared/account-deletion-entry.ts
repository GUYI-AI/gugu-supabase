import { createAccountDeletionHandler, type DeletionDependencies } from './account-deletion-core.ts';
import { createAccountDeletionOperationHandler, type OperationDependencies } from './account-deletion-operation-core.ts';

/** V2 has a distinct path. An unknown V2 action must never reach a legacy
 * confirmation/retry route, including when a proxy adds its own path prefix.
 * Admission remains controlled by the installed database gates.
 */
export function createAccountDeletionEntry(legacy: DeletionDependencies, operation: OperationDependencies) {
  const oldHandler = createAccountDeletionHandler(legacy);
  const newHandler = createAccountDeletionOperationHandler(operation);
  return (req: Request): Promise<Response> => {
    const segments = new URL(req.url).pathname.split('/').filter(Boolean);
    const tail = segments.slice(segments.lastIndexOf('account-deletion') + 1);
    return tail[0] === 'v2' ? newHandler(req) : oldHandler(req);
  };
}
