import { isIP } from 'node:net';

export interface TrustedForwardedIpConfiguration {
  fromRight: number;
  minimumItems: number;
}

/** These settings belong to the deployment, never the request body. A trusted
 * proxy chain must be verified before enabling this optional abuse-control key. */
export function trustedForwardedIpConfiguration(get: (name: string) => string | undefined): TrustedForwardedIpConfiguration | null {
  const position = get('TEAM_INVITE_XFF_FROM_RIGHT');
  const minimum = get('TEAM_INVITE_XFF_MIN_HOPS');
  if (!position || !minimum || !/^[0-9]{1,2}$/.test(position) || !/^[0-9]{1,2}$/.test(minimum)) return null;
  const fromRight = Number(position), minimumItems = Number(minimum);
  // The rightmost value is a proxy in the supported nginx -> Kong chain.
  if (fromRight < 2 || minimumItems < fromRight || minimumItems > 32) return null;
  return { fromRight, minimumItems };
}

/** Missing/untrusted IPs fall back to the mandatory non-IP delivery limits.
 * Never infer an end-user IP from X-Real-IP or the leftmost forwarded value. */
export function trustedForwardedClientIp(request: Request, configuration: TrustedForwardedIpConfiguration | null): string | null {
  if (!configuration) return null;
  const { fromRight, minimumItems } = configuration;
  if (!Number.isSafeInteger(fromRight) || !Number.isSafeInteger(minimumItems)
      || fromRight < 2 || minimumItems < fromRight || minimumItems > 32) return null;
  const header = request.headers.get('x-forwarded-for');
  if (!header || header.length > 4096) return null;
  const items = header.split(',');
  if (items.length < minimumItems || items.length > 32) return null;
  const selected = items[items.length - fromRight].trim();
  if (!selected || selected.includes('%')) return null;
  const version = isIP(selected);
  if (version === 4) return selected;
  if (version !== 6) return null;
  // Equivalent IPv6 spellings must share one admission bucket.
  return new URL('http://[' + selected + ']/').hostname.slice(1, -1);
}
