import { createAccountDeletionHandler } from '../_shared/account-deletion-core.ts';
import { accountDeletionDependencies } from '../_shared/account-deletion-auth.ts';

const url = Deno.env.get('SUPABASE_URL');
const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !anonKey || !serviceKey) throw new Error('Account deletion configuration is unavailable');
Deno.serve(createAccountDeletionHandler(accountDeletionDependencies({ url, anonKey, serviceKey })));
