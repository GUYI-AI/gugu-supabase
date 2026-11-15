import { createTeamAccountsHandler } from '../_shared/team-accounts-core.ts';
import { teamAccountsDependencies } from '../_shared/team-accounts-dependencies.ts';
import { trustedForwardedIpConfiguration } from '../_shared/team-client-ip.ts';
const url = Deno.env.get('SUPABASE_URL'), anonKey = Deno.env.get('SUPABASE_ANON_KEY'), serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !anonKey || !serviceKey) throw Error('Team authentication configuration unavailable');
Deno.serve(createTeamAccountsHandler(teamAccountsDependencies({ url, anonKey, serviceKey,
  clientIpConfiguration: trustedForwardedIpConfiguration(name => Deno.env.get(name)) })));
