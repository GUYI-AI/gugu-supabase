import { createAccountDeletionEntry } from '../_shared/account-deletion-entry.ts';
import { accountDeletionDependencies } from '../_shared/account-deletion-auth.ts';
import { accountDeletionOperationDependencies } from '../_shared/account-deletion-operation-auth.ts';

const url = Deno.env.get('SUPABASE_URL');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !anonKey || !serviceKey) throw new Error('Account deletion configuration is unavailable');
const settings = { url, anonKey, serviceKey };
Deno.serve(createAccountDeletionEntry(accountDeletionDependencies(settings), accountDeletionOperationDependencies(settings)));
